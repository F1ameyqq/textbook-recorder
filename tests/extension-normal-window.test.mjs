import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {installExtensionRecorderWindowBridge} from '../src/extension-window-state.mjs';

const extensionId='abcdefghijklmnopabcdefghijklmnop';
const bookUrl='https://example.test/books/146965';
const helperUrl=`chrome-extension://${extensionId}/status.html`;
const clone=value=>structuredClone(value);

// Offline Chrome API simulation. Every await exposes before/after hooks so a
// fault can occur before an action, after its real effect, or at receipt return.
function fixture({before,after,originalState='minimized'}={}){
  const events=[],tabs=new Map([
    [10,{id:10,url:bookUrl,windowId:30,active:true}],
    [11,{id:11,url:'https://example.test/protected-work',windowId:31,active:true}],
    [12,{id:12,url:helperUrl,windowId:30,active:false}],
  ]),windows=new Map([
    [30,{id:30,state:originalState,focused:false}],
    [31,{id:31,state:'normal',focused:true}],
  ]);
  const bookSession={tabId:10,sessionId:'pw-tab-book',targetInfo:{targetId:'target-book',url:bookUrl},childSessions:new Set(['child-frame'])};
  const model={_knownTabs:new Map([...tabs].map(([id,row])=>[id,{...row}])),_tabSessions:new Map([[10,bookSession]])};
  const impl={delegate:{_targetId:'target-book',_mainFrameSession:{_client:{_sessionId:'pw-tab-book'}}}};
  let closed=false,pageUrl=bookUrl,timeOrigin=1000,helperId,runtimeId=extensionId;
  let nextTabId=100;
  const browser={close:async()=>{events.push({kind:'browser-close'});}};
  const context={browser:()=>browser,close:async()=>{events.push({kind:'context-close'});}};
  browser.contexts=()=>[context];
  const page={context:()=>context,isClosed:()=>closed,url:()=>pageUrl,
    _connection:{toImpl:input=>{assert.equal(input,page);return impl;}},
    evaluate:async(fn,arg)=>step('page-evaluate',{},()=>vm.runInNewContext(`(${fn.toString()})(__arg)`,
      {__arg:arg,location:{href:pageUrl},performance:{timeOrigin},document:{readyState:'complete',prerendering:false}})),
  };
  const step=async(kind,data,operation)=>{
    const event={kind,...data};events.push(event);await before?.(event,f);
    let result=await operation();const replacement=await after?.(event,f,result);
    if(replacement!==undefined)result=replacement;
    return result;
  };
  const windowReceipt=(id,populate=false)=>{
    if(!windows.has(id))throw new Error('Synthetic missing window');
    const result=clone(windows.get(id));
    if(populate)result.tabs=[...tabs.values()].filter(tab=>tab.windowId===id).map(clone);
    return result;
  };
  model._sendToExtension=async(method,args)=>step('relay',{method,args:clone(args)},()=>{
    if(method==='chrome.tabs.create'){
      assert.deepEqual(args,[{url:helperUrl,active:false,windowId:30}]);
      helperId=nextTabId++;
      const tab={id:helperId,url:helperUrl,windowId:30,active:false};tabs.set(helperId,tab);model._knownTabs.set(helperId,{...tab});return clone(tab);
    }
    if(method==='chrome.tabs.remove'){
      assert.deepEqual(args,[helperId],'Cleanup may remove only the exact newly owned helper');
      tabs.delete(helperId);model._knownTabs.delete(helperId);model._tabSessions.delete(helperId);return {};
    }
    throw new Error(`Forbidden extension relay: ${method}`);
  });
  model._attachTab=async tabId=>step('attach',{tabId},()=>{
    assert.equal(tabId,helperId);
    const session={tabId,sessionId:'pw-tab-helper',targetInfo:{targetId:'target-helper',url:helperUrl},childSessions:new Set()};
    model._tabSessions.set(tabId,session);return session;
  });
  model.sendCommand=async(sessionId,method,params)=>step('runtime',{sessionId,method,params:clone(params)},async()=>{
    assert.equal(sessionId,'pw-tab-helper');assert.equal(method,'Runtime.evaluate');assert.equal(params.returnByValue,true);
    assert.doesNotMatch(params.expression,/localStorage|sessionStorage|document\.|console\.|tabs\.(query|update)|windows\.(getCurrent|getLastFocused|remove)|drawAttention/u);
    const chrome={runtime:{id:runtimeId},tabs:{
      get:async tabId=>step('tab-get',{tabId},()=>{if(!tabs.has(tabId))throw new Error('Synthetic missing tab');return clone(tabs.get(tabId));}),
      move:async(tabId,options)=>step('tab-move',{tabId,options:clone(options)},()=>{
        throw new Error('Read-only normal preparation must never move a tab');
      }),
    },windows:{
      get:async(windowId,options)=>step('window-get',{windowId,options:clone(options)},()=>{
        assert.ok(options?.populate===true||options?.populate===false);assert.deepEqual(Object.keys(options),['populate']);
        return windowReceipt(windowId,options.populate);
      }),
      create:async options=>step('window-create',{options:clone(options)},()=>{
        throw new Error('Read-only normal preparation must never create a window');
      }),
      update:async()=>{events.push({kind:'forbidden-window-update'});throw new Error('No existing window may be restored, minimized or focused');},
    }};
    try{return {result:{value:clone(await vm.runInNewContext(params.expression,{chrome,location:{href:tabs.get(helperId)?.url}}))}};}
    catch(cause){return {exceptionDetails:{text:cause.message}};}
  });
  const f={browser,context,page,impl,model,tabs,windows,events,bookSession,
    get helperId(){return helperId;},set closed(value){closed=value;},set pageUrl(value){pageUrl=value;},
    set timeOrigin(value){timeOrigin=value;},set runtimeId(value){runtimeId=value;},
    counts(kind,method){return events.filter(event=>event.kind===kind&&(method===undefined||event.method===method)).length;},
    install(){return installExtensionRecorderWindowBridge({browser,model,extensionId});},
    prepare(bridge,guardMutation=async()=>{events.push({kind:'mutation-guard'});}){
      return bridge.prepareNormalWindow(page,{guardMutation});
    },
    moveTogether(windowId=40){
      windows.set(windowId,{id:windowId,state:'normal',focused:false});
      tabs.get(10).windowId=windowId;tabs.get(10).active=true;
      tabs.get(helperId).windowId=windowId;tabs.get(helperId).active=false;
    },
  };
  return f;
}

function assertProtected(f){
  assert.equal(f.tabs.get(11).windowId,31);assert.equal(f.tabs.get(11).active,true);
  assert.deepEqual(f.windows.get(31),{id:31,state:'normal',focused:true});
  assert.equal(f.tabs.get(12).url,helperUrl);assert.equal(f.tabs.get(12).windowId,30);
  assert.equal(f.counts('forbidden-window-update'),0);
  assert.equal(f.tabs.has(10),true);
}

function assertNoWindowMutation(f){
  assert.equal(f.counts('window-create'),0);assert.equal(f.counts('tab-move'),0);
  assert.equal(f.counts('mutation-guard'),0);assert.equal(f.counts('forbidden-window-update'),0);
  for(const event of f.events.filter(event=>event.kind==='runtime')){
    // manage('read') shares an expression with its existing minimize action;
    // the update branch is constant-false here. Its actual calls are counted
    // above. Preparation must never even send create/move/remove expressions.
    assert.doesNotMatch(event.params.expression,/chrome\.windows\.(create|remove)|chrome\.tabs\.move/u);
  }
}

async function readyFixture(options){
  const f=fixture(options),bridge=f.install();await bridge.manage(f.page,'read');
  // Offline fixture setup represents a window already isolated by its owner.
  // The bridge itself never executes the relocation performed by this helper.
  f.moveTogether();return {f,bridge};
}

const reusedReceipt={tabId:10,windowId:40,windowState:'normal',bookTabActive:true,helperTabActive:false,
  windowFocused:false,created:false,documentTimeOrigin:1000};

test('strict read-only preparation reuses the live exact two-tab normal window without calling a supplied guard',async()=>{
  const {f,bridge}=await readyFixture();assert.equal(Object.isFrozen(bridge),true);
  assert.deepEqual(await f.prepare(bridge),reusedReceipt);
  assert.equal(f.model._knownTabs.get(10).windowId,30,'cached placement deliberately stays stale');
  assert.deepEqual(await bridge.manage(f.page,'read'),{tabId:10,windowId:40,windowState:'normal'});
  assert.equal(f.counts('relay','chrome.tabs.create'),1);assert.equal(f.counts('attach'),1);
  assert.equal(f.windows.get(30).state,'minimized');assertProtected(f);assertNoWindowMutation(f);
});

test('strict read-only reuse needs no mutation guard',async()=>{
  const {f,bridge}=await readyFixture();
  assert.deepEqual(await bridge.prepareNormalWindow(f.page),reusedReceipt);
  assertProtected(f);assertNoWindowMutation(f);
});

test('not-ready shared/minimized window fails closed with zero window actions and no retry',async()=>{
  const f=fixture(),bridge=f.install();
  await assert.rejects(f.prepare(bridge),/not be moved|not ready|not confirmed/u);
  assertNoWindowMutation(f);assertProtected(f);assert.equal(f.windows.get(30).state,'minimized');
  const operations=f.events.length;
  await assert.rejects(f.prepare(bridge),/unavailable/u);await assert.rejects(bridge.manage(f.page,'read'),/unavailable/u);
  assert.equal(f.events.length,operations,'failed bridge must issue no more reads or actions');
  assert.equal(f.counts('relay','chrome.tabs.create'),1);
});

test('each non-ready live condition rejects without any create, move, update, guard or retry',async t=>{
  const changes={
    minimized:f=>{f.windows.get(40).state='minimized';},maximized:f=>{f.windows.get(40).state='maximized';},
    focused:f=>{f.windows.get(40).focused=true;},bookInactive:f=>{f.tabs.get(10).active=false;},
    helperActive:f=>{f.tabs.get(f.helperId).active=true;},helperWrongWindow:f=>{f.tabs.get(f.helperId).windowId=30;},
    extraForeignTab:f=>{f.tabs.set(20,{id:20,url:'https://example.test/user-work',windowId:40,active:false});},
    foreignBookURL:f=>{f.tabs.get(10).url='https://example.test/books/other';},
  };
  for(const[name,change]of Object.entries(changes))await t.test(name,async()=>{
    const {f,bridge}=await readyFixture();change(f);
    await assert.rejects(f.prepare(bridge));assertNoWindowMutation(f);assertProtected(f);
    const operations=f.events.length;await assert.rejects(f.prepare(bridge),/unavailable/u);assert.equal(f.events.length,operations);
  });
});

test('Page URL/session/target/timeOrigin drift during the populated read rejects the existing window',async t=>{
  for(const field of ['url','session','target','timeOrigin'])await t.test(field,async()=>{
    const {f,bridge}=await readyFixture({after:async(event,f)=>{
      if(event.kind!=='window-get'||event.options.populate!==true)return;
      if(field==='url')f.pageUrl='https://example.test/books/other';
      if(field==='session')f.impl.delegate._mainFrameSession._client._sessionId='new-session';
      if(field==='target')f.impl.delegate._targetId='new-target';
      if(field==='timeOrigin')f.timeOrigin=1001;
    }});
    await assert.rejects(f.prepare(bridge));assertNoWindowMutation(f);assertProtected(f);
    await assert.rejects(f.prepare(bridge),/unavailable/u);
  });
});

test('foreign helper origin/runtime/session/target cannot authorize read-only reuse',async t=>{
  for(const field of ['origin','runtimeId','sessionObject','targetId'])await t.test(field,async()=>{
    const {f,bridge}=await readyFixture();
    if(field==='origin')f.tabs.get(f.helperId).url='https://example.test/user-work';
    if(field==='runtimeId')f.runtimeId='ponmlkjihgfedcbaponmlkjihgfedcbap';
    if(field==='sessionObject')f.model._tabSessions.set(f.helperId,{...f.model._tabSessions.get(f.helperId)});
    if(field==='targetId')f.model._tabSessions.get(f.helperId).targetInfo.targetId='foreign-helper';
    await assert.rejects(f.prepare(bridge));assertNoWindowMutation(f);assertProtected(f);
    await assert.rejects(f.prepare(bridge),/unavailable/u);
  });
});

test('lost read response fails closed and never retries or changes any tab/window',async()=>{
  const {f,bridge}=await readyFixture({after:async event=>{
    if(event.kind==='window-get'&&event.options.populate===true)throw new Error('Synthetic lost read response');
  }});
  await assert.rejects(f.prepare(bridge));assertNoWindowMutation(f);assertProtected(f);
  const operations=f.events.length;await assert.rejects(f.prepare(bridge),/unavailable/u);assert.equal(f.events.length,operations);
  assert.equal(f.tabs.get(10).windowId,40);assert.equal(f.tabs.get(f.helperId).windowId,40);
});

test('a second legitimate top-level book Page cannot replace the first read-only binding',async()=>{
  const {f,bridge}=await readyFixture();await f.prepare(bridge);
  const secondImpl={delegate:{_targetId:'target-other-book',_mainFrameSession:{_client:{_sessionId:'pw-tab-other-book'}}}};
  f.tabs.set(20,{id:20,url:bookUrl,windowId:30,active:true});f.model._knownTabs.set(20,{...f.tabs.get(20)});
  f.model._tabSessions.set(20,{tabId:20,sessionId:'pw-tab-other-book',targetInfo:{targetId:'target-other-book',url:bookUrl},childSessions:new Set()});
  const secondPage={context:()=>f.context,isClosed:()=>false,url:()=>bookUrl,evaluate:f.page.evaluate,
    _connection:{toImpl:page=>{assert.equal(page,secondPage);return secondImpl;}},
  };
  let callbacks=0;
  await assert.rejects(bridge.prepareNormalWindow(secondPage,{guardMutation:async()=>{callbacks++;}}));
  assert.equal(callbacks,0);assertNoWindowMutation(f);assertProtected(f);assert.equal(f.tabs.get(20).windowId,30);
});

test('cleanup after read-only reuse removes only its own helper and keeps every book/window',async()=>{
  const {f,bridge}=await readyFixture();await f.prepare(bridge);const owned=f.helperId;
  assert.deepEqual(await bridge.cleanup(),{removed:true});
  assert.equal(f.tabs.has(owned),false);assert.equal(f.tabs.get(10).windowId,40);assert.equal(f.tabs.has(12),true);
  for(const id of [30,31,40])assert.equal(f.windows.has(id),true);
  assert.equal(f.counts('relay','chrome.tabs.remove'),1);assertNoWindowMutation(f);assertProtected(f);
  assert.deepEqual(await bridge.cleanup(),{removed:false,reason:'already-attempted'});
});
