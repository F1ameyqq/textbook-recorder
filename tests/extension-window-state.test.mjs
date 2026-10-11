import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { installExtensionRecorderWindowBridge } from '../src/extension-window-state.mjs';

const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const bookUrl = 'https://example.test/books/146965';
const helperUrl = `chrome-extension://${extensionId}/status.html`;

function fixture({ before, after, pendingNavigation = false } = {}) {
  const events = [], tabs = new Map([
    [10, { id:10, url:bookUrl, windowId:30, active:false }],
    [11, { id:11, url:'https://example.test/protected-work', windowId:31, active:true }],
    [12, { id:12, url:helperUrl, windowId:30, active:false }],
  ]), windows = new Map([
    [30, { id:30, state:'normal' }],
    [31, { id:31, state:'normal' }],
  ]);
  const bookSession = { tabId:10, sessionId:'pw-tab-book', targetInfo:{ targetId:'target-book', url:bookUrl }, childSessions:new Set(['child-frame']) };
  const model = { _knownTabs:new Map([...tabs].map(([id, row]) => [id, { ...row }])), _tabSessions:new Map([[10, bookSession]]) };
  const impl = { delegate:{ _targetId:'target-book', _mainFrameSession:{ _client:{ _sessionId:'pw-tab-book' } } } };
  let closed = false, transportClosed = false, pageUrl = bookUrl, helperId, nextId = 100, runtimeId = extensionId;
  const browser = { closes:0, closeArgs:null, async close(...args) {
    events.push({kind:'original-browser-close',helperPresent:tabs.has(helperId)});
    this.closes++; this.closeArgs=args; transportClosed=true; return 'browser-closed';
  } };
  const context = { browser:() => browser, closes:0, closeArgs:null, async close(...args) {
    events.push({kind:'original-context-close',helperPresent:tabs.has(helperId)});
    this.closes++; this.closeArgs=args; transportClosed=true; return 'context-closed';
  } };
  browser.contexts=()=>[context];
  const page = { context:() => context, isClosed:() => closed, url:() => pageUrl, _connection:{ toImpl:input => { assert.equal(input,page); return impl; } } };
  const step = async (kind, data, operation) => {
    const event = { kind, ...data }; events.push(event);
    await before?.(event, f);
    let result = await operation();
    const changed = await after?.(event, f, result);
    if (changed !== undefined) result = changed;
    return result;
  };
  const clone = value => structuredClone(value);
  model._sendToExtension = async (method, args) => step('relay', { method, args:clone(args) }, () => {
    if(transportClosed)throw new Error('Synthetic transport already disconnected');
    if (method === 'chrome.tabs.create') {
      assert.equal(args.length,1);
      assert.deepEqual(args[0], { url:helperUrl, active:false, windowId:30 });
      helperId = nextId++;
      const tab = { id:helperId, url:helperUrl, windowId:30, active:false };
      tabs.set(helperId,tab); model._knownTabs.set(helperId,{ ...tab });
      return pendingNavigation ? { ...tab, url:'about:blank', pendingUrl:helperUrl } : { ...tab };
    }
    if (method === 'chrome.tabs.remove') {
      assert.equal(args.length,1); assert.equal(args[0],helperId,'Only the freshly owned helper may be removed');
      tabs.delete(args[0]); model._knownTabs.delete(args[0]); model._tabSessions.delete(args[0]);
      return {};
    }
    throw new Error(`Forbidden relay operation: ${method}`);
  });
  model._attachTab = async tabId => step('attach', { tabId }, () => {
    assert.equal(tabId,helperId);
    const session = { tabId, sessionId:'pw-tab-helper', targetInfo:{ targetId:'target-helper', url:helperUrl }, childSessions:new Set() };
    model._tabSessions.set(tabId,session); return session;
  });
  model.sendCommand = async (sessionId, method, params) => step('runtime', { sessionId, method, params:clone(params) }, async () => {
    if(transportClosed)throw new Error('Synthetic transport already disconnected');
    assert.equal(sessionId,'pw-tab-helper'); assert.equal(method,'Runtime.evaluate');
    assert.equal(params.returnByValue,true);
    assert.doesNotMatch(params.expression,/localStorage|sessionStorage|document\.|console\.|tabs\.query|tabs\.update|windows\.(getCurrent|getLastFocused|create|remove)|focused|drawAttention/u);
    const chrome = {
      runtime:{ id:runtimeId },
      tabs:{ get:async tabId => step('tab-get', { tabId }, () => { if (!tabs.has(tabId)) throw new Error('Synthetic missing tab'); return clone(tabs.get(tabId)); }) },
      windows:{
        get:async (windowId, options) => step('window-get', { windowId, options }, () => {
          assert.deepEqual(clone(options),{ populate:false });
          if (!windows.has(windowId)) throw new Error('Synthetic missing window'); return clone(windows.get(windowId));
        }),
        update:async (windowId, options) => step('window-update', { windowId, options }, () => {
          assert.equal(windowId,30); assert.deepEqual(clone(options),{ state:'minimized' });
          windows.get(windowId).state = 'minimized'; return clone(windows.get(windowId));
        }),
      },
    };
    try { return { result:{ value:clone(await vm.runInNewContext(params.expression,{ chrome, location:{ href:tabs.get(helperId)?.url } })) } }; }
    catch (cause) { return { exceptionDetails:{ text:cause.message } }; }
  });
  const f = { browser, page, context, impl, model, tabs, windows, events, bookSession,
    get helperId(){return helperId;}, set closed(value){closed=value;}, set pageUrl(value){pageUrl=value;}, set runtimeId(value){runtimeId=value;},
    counts(kind, method){return events.filter(row => row.kind===kind && (method===undefined || row.method===method)).length;},
    install(){return installExtensionRecorderWindowBridge({ browser, model, extensionId });},
  };
  return f;
}

test('fixed extension helper is inactive, reused, and returns only live tab/window state', async () => {
  const f=fixture(), bridge=f.install();
  assert.equal(f.browser.__textbookRecorderWindowBridge,bridge); assert.equal(Object.isFrozen(bridge),true);
  assert.deepEqual(await bridge.manage(f.page,'read'),{tabId:10,windowId:30,windowState:'normal'});
  assert.deepEqual(await bridge.manage(f.page,'minimize'),{tabId:10,windowId:30,windowState:'minimized'});
  assert.deepEqual(await bridge.manage(f.page,'minimize'),{tabId:10,windowId:30,windowState:'minimized'});
  assert.equal(f.counts('relay','chrome.tabs.create'),1); assert.equal(f.counts('attach'),1); assert.equal(f.counts('window-update'),1);
  assert.equal(f.windows.get(31).state,'normal'); assert.equal(f.tabs.get(11).active,true);
  assert.equal(f.tabs.get(12).url,helperUrl); assert.equal(f.tabs.get(f.helperId).active,false);
});

test('initial about:blank with the exact own pending URL is accepted without navigating or selecting a tab', async () => {
  const f=fixture({pendingNavigation:true}), bridge=f.install();
  assert.deepEqual(await bridge.manage(f.page,'read'),{tabId:10,windowId:30,windowState:'normal'});
  assert.equal(f.counts('relay','chrome.tabs.create'),1);
});

test('invalid creation receipts are never attached, adopted, or cleaned up by URL', async t => {
  const cases = {
    active:row=>({...row,active:true}), window:row=>({...row,windowId:31}), id:row=>({...row,id:0}),
    foreign:row=>({...row,url:'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcbap/status.html'}),
    redirected:row=>({...row,url:'https://example.test/user-work',pendingUrl:helperUrl}),
    missingOrigin:row=>({...row,url:'about:blank'}),
  };
  for(const[name,change]of Object.entries(cases))await t.test(name,async()=>{
    const f=fixture({after:async(event,_f,result)=>event.kind==='relay'&&event.method==='chrome.tabs.create'?change(result):undefined}),bridge=f.install();
    await assert.rejects(bridge.manage(f.page,'minimize'),/creation not confirmed/u);
    assert.equal(f.counts('attach'),0);assert.equal(f.counts('runtime'),0);assert.equal(f.counts('window-update'),0);
    assert.deepEqual(await bridge.cleanup(),{removed:false,reason:'identity-unconfirmed'});
    assert.equal(f.counts('relay','chrome.tabs.remove'),0);assert.equal(f.tabs.has(12),true);assert.equal(f.tabs.has(f.helperId),true);
  });
});

test('helper attachment must supply nonempty top-level target and session identities before Runtime evaluation', async t => {
  for(const field of ['targetId','sessionId'])await t.test(field,async()=>{
    const f=fixture({after:async(event,_f,session)=>{
      if(event.kind!=='attach')return;
      if(field==='targetId')delete session.targetInfo.targetId;
      if(field==='sessionId')session.sessionId='';
    }}),bridge=f.install();
    await assert.rejects(bridge.manage(f.page,'read'));
    assert.equal(f.counts('runtime'),0);
    const cleanup=await bridge.cleanup();assert.equal(cleanup.removed,false);
    assert.equal(f.counts('relay','chrome.tabs.remove'),0);assert.equal(f.tabs.has(12),true);
  });
});

test('untrusted actions and foreign, closed, missing, ambiguous or child-only Page bindings never create a helper', async t => {
  const cases = {
    action:f=>{}, foreign:f=>{f.context.browser=()=>({});}, closed:f=>{f.closed=true;}, missing:f=>{f.model._tabSessions.clear();},
    duplicate:f=>{f.model._tabSessions.set(20,{...f.bookSession,tabId:20});},
    child:f=>{f.impl.delegate._mainFrameSession._client._sessionId='child-frame';},
    target:f=>{f.impl.delegate._targetId='another-target';},
    url:f=>{f.pageUrl='http://example.test/books/146965';},
    unavailableImpl:f=>{f.page._connection.toImpl=()=>{throw new Error('Unavailable');};},
  };
  for (const [name, change] of Object.entries(cases)) await t.test(name,async()=>{
    const f=fixture(); change(f); const bridge=f.install();
    await assert.rejects(bridge.manage(f.page,name==='action'?'activate':'minimize'));
    assert.equal(f.counts('relay','chrome.tabs.create'),0); assert.equal(f.counts('window-update'),0);
  });
});

test('changed Page identity during create or attach prevents Runtime window operations', async t => {
  for (const phase of ['create','attach']) for (const field of ['url','session','target']) await t.test(`${phase}:${field}`,async()=>{
    const f=fixture({after:async(event,f)=>{
      if (!(phase==='create'&&event.kind==='relay'&&event.method==='chrome.tabs.create'||phase==='attach'&&event.kind==='attach')) return;
      if(field==='url')f.pageUrl='https://example.test/books/other';
      if(field==='session')f.impl.delegate._mainFrameSession._client._sessionId='new-session';
      if(field==='target')f.impl.delegate._targetId='new-target';
    }}), bridge=f.install();
    await assert.rejects(bridge.manage(f.page,'minimize'));
    assert.equal(f.counts('window-update'),0); assert.equal(f.counts('runtime'),0);
    await assert.rejects(bridge.manage(f.page,'read'),/unavailable/u);
    assert.equal(f.counts('relay','chrome.tabs.create'),1);
  });
});

test('stale placement, moved or activated helper, and actual book URL changes cannot authorize minimization', async t => {
  for (const change of ['stalePlacement','helperWindow','helperActive','bookURL']) await t.test(change,async()=>{
    const f=fixture({after:async(event,f)=>{
      if(event.kind!=='attach')return;
      if(change==='stalePlacement')f.tabs.get(10).windowId=31;
      if(change==='helperWindow')f.tabs.get(f.helperId).windowId=31;
      if(change==='helperActive')f.tabs.get(f.helperId).active=true;
      if(change==='bookURL')f.tabs.get(10).url='https://example.test/books/other';
    }}), bridge=f.install();
    await assert.rejects(bridge.manage(f.page,'minimize'));
    assert.equal(f.counts('window-update'),0);
    assert.equal(f.windows.get(31).state,'normal');
  });
});

test('book movement between live Chrome API checks rejects before the window update', async () => {
  let bookGets=0;
  const f=fixture({before:async(event,f)=>{if(event.kind==='tab-get'&&event.tabId===10&&++bookGets===2)f.tabs.get(10).windowId=31;}}), bridge=f.install();
  await assert.rejects(bridge.manage(f.page,'minimize'));
  assert.equal(f.counts('window-update'),0); assert.equal(f.windows.get(30).state,'normal'); assert.equal(f.windows.get(31).state,'normal');
});

test('helper origin and same-connection session identity are rechecked on every operation', async t => {
  for (const change of ['origin','runtimeId','sessionObject','targetId','sessionId']) await t.test(change,async()=>{
    const f=fixture(), bridge=f.install(); await bridge.manage(f.page,'read');
    if(change==='origin')f.tabs.get(f.helperId).url='https://example.test/foreign';
    if(change==='runtimeId')f.runtimeId='ponmlkjihgfedcbaponmlkjihgfedcba';
    if(change==='sessionObject')f.model._tabSessions.set(f.helperId,{...f.model._tabSessions.get(f.helperId)});
    if(change==='targetId')f.model._tabSessions.get(f.helperId).targetInfo.targetId='replaced-target';
    if(change==='sessionId')f.model._tabSessions.get(f.helperId).sessionId='replaced-session';
    await assert.rejects(bridge.manage(f.page,'minimize'));
    assert.equal(f.counts('window-update'),0); assert.equal(f.counts('relay','chrome.tabs.create'),1);
  });
});

test('lost create, attach, or Runtime responses never retry creation and preserve unconfirmed state', async t => {
  for (const phase of ['create','attach','runtime']) await t.test(phase,async()=>{
    let thrown=false;
    const f=fixture({after:async event=>{
      const hit=phase==='create'&&event.kind==='relay'&&event.method==='chrome.tabs.create'||phase==='attach'&&event.kind==='attach'||phase==='runtime'&&event.kind==='runtime';
      if(hit&&!thrown){thrown=true;throw new Error('Synthetic lost response');}
    }}), bridge=f.install();
    await assert.rejects(bridge.manage(f.page,'minimize'));
    await assert.rejects(bridge.manage(f.page,'read'),/unavailable/u);
    assert.equal(f.counts('relay','chrome.tabs.create'),1); assert.equal(f.counts('window-update'),0);
    const cleanup=await bridge.cleanup();
    assert.equal(cleanup.removed,phase==='runtime');
    assert.equal(f.tabs.has(10),true); assert.equal(f.tabs.has(11),true); assert.equal(f.tabs.has(12),true);
    if(phase!=='runtime')assert.equal(f.tabs.has(f.helperId),true);
  });
});

test('invalid or missing Runtime proofs reject without returning a verified receipt', async t => {
  const good={tabId:10,windowId:30,windowState:'normal'};
  const cases={extra:{...good,title:'Do not export'},wrongTab:{...good,tabId:11},zeroWindow:{...good,windowId:0},stringWindow:{...good,windowId:'30'},unsafeWindow:{...good,windowId:Number.MAX_SAFE_INTEGER+1},state:{...good,windowState:'unknown'},null:null};
  for(const[name,value]of Object.entries(cases))await t.test(name,async()=>{
    const f=fixture({after:async(event,_f,result)=>event.kind==='runtime'&&typeof result?.result?.value==='object'?{result:{value}}:undefined}),bridge=f.install();
    await assert.rejects(bridge.manage(f.page,'read'),/invalid window proof/u);
    await assert.rejects(bridge.manage(f.page,'read'),/unavailable/u);
  });
  for(const value of [{},{result:{}},{result:{value:good},exceptionDetails:{text:'Failed'}}])await t.test(JSON.stringify(value),async()=>{
    const f=fixture({after:async(event,_f,result)=>event.kind==='runtime'&&typeof result?.result?.value==='object'?value:undefined}),bridge=f.install();
    await assert.rejects(bridge.manage(f.page,'read'),/did not return proof/u);
  });
});

test('minimize receipt must confirm the actual minimized state, and lost post-action response is never retried', async t => {
  for(const lose of [false,true])await t.test(lose?'lost response':'unverified state',async()=>{
    const f=fixture({after:async(event,_f,result)=>{
      if(event.kind!=='runtime'||typeof result?.result?.value!=='object')return;
      if(lose)throw new Error('Synthetic lost post-action response');
      return {result:{value:{...result.result.value,windowState:'normal'}}};
    }}),bridge=f.install();
    await assert.rejects(bridge.manage(f.page,'minimize'));
    assert.equal(f.counts('window-update'),1);
    await assert.rejects(bridge.manage(f.page,'minimize'),/unavailable/u);
    assert.equal(f.counts('window-update'),1); assert.equal(f.counts('relay','chrome.tabs.create'),1);
  });
});

test('a delayed native minimization is confirmed with pure reads on the same window and a single update', async () => {
  let pending = false, observations = 0;
  const f=fixture({after:async(event,f)=>{
    if(event.kind==='window-update') { pending=true; f.windows.get(30).state='normal'; }
    if(pending && event.kind==='window-get' && ++observations===4) f.windows.get(30).state='minimized';
  }}),bridge=f.install();
  assert.deepEqual(await bridge.manage(f.page,'minimize'),{tabId:10,windowId:30,windowState:'minimized'});
  assert.ok(observations>=4);assert.equal(f.counts('window-update'),1);assert.equal(f.counts('relay','chrome.tabs.create'),1);
  assert.equal(f.tabs.get(11).active,true);assert.equal(f.windows.get(31).state,'normal');
});

test('invalid initial proof never triggers a read-only confirmation and exports only a fixed reason', async () => {
  const f=fixture({after:async(event,_f,result)=>event.kind==='runtime'&&typeof result?.result?.value==='object'
    ?{result:{value:{...result.result.value,windowState:'private arbitrary state'}}}:undefined}),bridge=f.install();
  await assert.rejects(bridge.manage(f.page,'minimize'),error=>error.message==='Recorder extension window bridge: invalid window proof (window-state)');
  assert.equal(f.counts('runtime'),2);assert.equal(f.counts('window-update'),1);
});

test('identity loss or malformed proof during confirmation stops without a second update', async t => {
  for(const change of ['identity','receipt'])await t.test(change,async()=>{
    let proofCalls=0;
    const f=fixture({after:async(event,f,result)=>{
      if(event.kind!=='runtime'||typeof result?.result?.value!=='object')return;
      proofCalls++;
      if(proofCalls===1)return {result:{value:{...result.result.value,windowState:'normal'}}};
      if(change==='identity')f.impl.delegate._mainFrameSession._client._sessionId='changed-session';
      else return {result:{value:{...result.result.value,windowId:0}}};
    }}),bridge=f.install();
    await assert.rejects(bridge.manage(f.page,'minimize'));
    assert.equal(proofCalls,2);assert.equal(f.counts('window-update'),1);
    await assert.rejects(bridge.manage(f.page,'minimize'),/unavailable/u);
    assert.equal(f.counts('window-update'),1);
  });
});

test('a hanging read has a bounded confirmation deadline and its late response cannot revive the bridge', async () => {
  let calls=0, finish;
  const f=fixture({after:async(event,_f,result)=>{
    if(event.kind!=='runtime'||typeof result?.result?.value!=='object')return;
    if(++calls===1)return {result:{value:{...result.result.value,windowState:'normal'}}};
    return new Promise(resolve=>{finish=()=>resolve(result);});
  }}),bridge=f.install(),started=performance.now();
  await assert.rejects(bridge.manage(f.page,'minimize'),/minimization-confirmation-timeout/u);
  assert.ok(performance.now()-started<1600);assert.equal(calls,2);assert.equal(f.counts('window-update'),1);
  finish();await new Promise(resolve=>setTimeout(resolve,10));
  await assert.rejects(bridge.manage(f.page,'read'),/unavailable/u);
  assert.equal(calls,2);assert.equal(f.counts('window-update'),1);
});

test('a response delivered after an event-loop stall cannot pass the monotonic deadline', async () => {
  let calls=0;
  const f=fixture({after:async(event,_f,result)=>{
    if(event.kind!=='runtime'||typeof result?.result?.value!=='object')return;
    if(++calls===1)return {result:{value:{...result.result.value,windowState:'normal'}}};
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1050);
    return result;
  }}),bridge=f.install();
  await assert.rejects(bridge.manage(f.page,'minimize'),/minimization-confirmation-timeout/u);
  await assert.rejects(bridge.manage(f.page,'read'),/unavailable/u);
  assert.equal(calls,2);assert.equal(f.counts('window-update'),1);
});

test('cleanup removes only its exact owned helper and is attempted once', async () => {
  const f=fixture(),bridge=f.install(); await bridge.manage(f.page,'read');
  assert.deepEqual(await bridge.cleanup(),{removed:true});
  assert.deepEqual(await bridge.cleanup(),{removed:false,reason:'already-attempted'});
  assert.equal(f.counts('relay','chrome.tabs.remove'),1);
  assert.equal(f.tabs.has(10),true);assert.equal(f.tabs.has(11),true);assert.equal(f.tabs.has(12),true);
  await assert.rejects(bridge.manage(f.page,'read'),/unavailable/u);
});

test('cleanup retains changed helper identity and never retries an uncertain removal', async t => {
  for(const change of ['url','session','lostRemoval','lostAfterRemoval'])await t.test(change,async()=>{
    const f=fixture({before:async event=>{if(change==='lostRemoval'&&event.kind==='relay'&&event.method==='chrome.tabs.remove')throw new Error('Synthetic lost removal');},after:async event=>{if(change==='lostAfterRemoval'&&event.kind==='relay'&&event.method==='chrome.tabs.remove')throw new Error('Synthetic lost removal receipt');}}),bridge=f.install();
    await bridge.manage(f.page,'read');
    if(change==='url')f.tabs.get(f.helperId).url='https://example.test/user-work';
    if(change==='session')f.model._tabSessions.set(f.helperId,{...f.model._tabSessions.get(f.helperId)});
    const result=await bridge.cleanup();assert.equal(result.removed,false);
    assert.equal(f.tabs.has(f.helperId),change!=='lostAfterRemoval');assert.equal(f.tabs.has(10),true);assert.equal(f.tabs.has(12),true);
    await bridge.cleanup();assert.equal(f.counts('relay','chrome.tabs.remove'),change.startsWith('lost')?1:0);
  });
});

test('concurrent manage and close refuse while an operation is in flight without closing the browser', async () => {
  let release, reached;
  const entered=new Promise(resolve=>{reached=resolve;}),blocked=new Promise(resolve=>{release=resolve;});
  const f=fixture({before:async event=>{if(event.kind==='relay'&&event.method==='chrome.tabs.create'){reached();await blocked;}}}),bridge=f.install();
  const first=bridge.manage(f.page,'read');await entered;
  await assert.rejects(bridge.manage(f.page,'read'),/unavailable/u);
  await assert.rejects(f.context.close(),/still running/u);assert.equal(f.context.closes,0);
  await assert.rejects(f.browser.close(),/still running/u);assert.equal(f.browser.closes,0);
  release();await first;
  assert.equal(await f.browser.close('synthetic'), 'browser-closed');
  assert.equal(f.browser.closes,1);assert.deepEqual(f.browser.closeArgs,['synthetic']);assert.equal(f.counts('relay','chrome.tabs.remove'),1);
});

test('MCP context-before-browser disposal removes the owned helper while the transport is still connected', async () => {
  const f=fixture(),bridge=f.install();await bridge.manage(f.page,'read');
  assert.equal(f.tabs.has(f.helperId),true);
  assert.equal(await f.context.close('MCP-context-dispose'),'context-closed');
  assert.equal(await f.browser.close('MCP-browser-dispose'),'browser-closed');
  const remove=f.events.findIndex(event=>event.kind==='relay'&&event.method==='chrome.tabs.remove');
  const contextClose=f.events.findIndex(event=>event.kind==='original-context-close');
  const browserClose=f.events.findIndex(event=>event.kind==='original-browser-close');
  assert.ok(remove>=0&&remove<contextClose&&contextClose<browserClose);
  assert.equal(f.events[contextClose].helperPresent,false);assert.equal(f.events[browserClose].helperPresent,false);
  assert.equal(f.events.slice(contextClose+1).some(event=>event.kind==='runtime'||event.kind==='relay'),false);
  assert.equal(f.counts('relay','chrome.tabs.remove'),1);assert.equal(f.context.closes,1);assert.equal(f.browser.closes,1);
  assert.deepEqual(f.context.closeArgs,['MCP-context-dispose']);assert.deepEqual(f.browser.closeArgs,['MCP-browser-dispose']);
  assert.equal(f.tabs.has(10),true);assert.equal(f.tabs.has(11),true);assert.equal(f.tabs.has(12),true);
});

test('MCP disposal retains a helper whose identity changed and closes without guessing another tab', async () => {
  const f=fixture(),bridge=f.install();await bridge.manage(f.page,'read');
  f.tabs.get(f.helperId).url='https://example.test/user-work';
  await f.context.close();await f.browser.close();
  assert.equal(f.tabs.has(f.helperId),true);assert.equal(f.counts('relay','chrome.tabs.remove'),0);
  assert.equal(f.context.closes,1);assert.equal(f.browser.closes,1);
  assert.equal(f.tabs.has(10),true);assert.equal(f.tabs.has(12),true);
});
