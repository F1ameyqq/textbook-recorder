import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {insertReviewedEditorHtml} from '../src/browser-editor-command.mjs';
import {requireRecorderDocumentReady} from '../src/browser-document-state.mjs';
import {NewSystemAdapter} from '../src/new-system-adapter.mjs';

const workerFlag='--headless-background-normal-worker';
const resultPrefix='HEADLESS_BACKGROUND_NORMAL_RESULT:';
const tracePrefix='HEADLESS_BACKGROUND_NORMAL_TRACE:';
const reviewedHtml='<p>reviewed A <sub>2</sub> and <sup>3</sup></p>';
const executableForTest=()=>[chromium.executablePath(),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(filename=>existsSync(filename));

async function trace(name,action){
  console.error(`${tracePrefix}begin:${name}`);
  try{return await action();}finally{console.error(`${tracePrefix}end:${name}`);}
}

function protocolSegment(stderr,name){
  const start=`${tracePrefix}begin:${name}`,end=`${tracePrefix}end:${name}`;
  assert.equal(stderr.split(start).length,2,`missing/duplicate trace start: ${name}`);
  assert.equal(stderr.split(end).length,2,`missing/duplicate trace end: ${name}`);
  return stderr.slice(stderr.indexOf(start)+start.length,stderr.indexOf(end));
}

async function browserWorker(executablePath){
  // This launch owns a disposable profile. No persistent context, production
  // browser attachment, headful window, platform route or service is involved.
  const browser=await chromium.launch({executablePath,headless:true,args:[
    '--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run',
    '--disable-default-apps','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost',
    '--proxy-server=http://127.0.0.1:9']});
  try{
    const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1100,height:800}});
    const networkRequests=[];
    await context.route('**/*',async route=>{networkRequests.push(route.request().url());await route.abort('blockedbyclient');});
    const fixturePage=async name=>{
      const page=await context.newPage();
      await page.setContent(`<!doctype html><html><head><title>local ${name}</title><style>
body{margin:40px;font:16px sans-serif}.editor{width:700px;min-height:90px;padding:12px;border:2px solid #333;margin-bottom:30px}
</style></head><body data-local-fixture="${name}"><div id="target" class="editor" contenteditable="true"></div>
<div id="sentinel" class="editor" contenteditable="true">unchanged ${name}</div><span id="outside">outside selection</span></body></html>`);
      await page.evaluate(()=>{
        window.fixtureCounters={commands:0,clipboard:0,syntheticEvents:0,frameworkWrites:0,commandFocus:[]};
        const exec=document.execCommand.bind(document);
        document.execCommand=(...args)=>{
          window.fixtureCounters.commands++;
          window.fixtureCounters.commandFocus.push({focused:document.hasFocus(),active:document.activeElement.id});
          return exec(...args);
        };
        const forbiddenClipboard=()=>{window.fixtureCounters.clipboard++;throw new Error('Local fixture forbids clipboard/permissions');};
        Object.defineProperty(navigator,'clipboard',{configurable:true,get:forbiddenClipboard});
        Object.defineProperty(navigator,'permissions',{configurable:true,get:forbiddenClipboard});
        EventTarget.prototype.dispatchEvent=function(){window.fixtureCounters.syntheticEvents++;throw new Error('Local fixture forbids fabricated events');};
        const framework=new Proxy({},{set(){window.fixtureCounters.frameworkWrites++;throw new Error('Local fixture forbids framework mutation');}});
        for(const editor of document.querySelectorAll('.editor'))Object.defineProperty(editor,'__vue__',{value:framework});
      });
      // Playwright otherwise emulates focus=true for every page. Disable that
      // default through CDP; document.hasFocus itself remains native/unmodified.
      const session=await context.newCDPSession(page);
      await session.send('Emulation.setFocusEmulationEnabled',{enabled:false});
      await session.detach();
      return page;
    };
    const guard=page=>async()=>{
      assert.equal(page.url(),'about:blank','only owned about:blank pages are permitted');
      assert.equal(await page.locator('body[data-local-fixture]').count(),1);
    };
    const snapshot=page=>page.evaluate(()=>{
      const selection=window.getSelection();
      return {target:document.querySelector('#target').innerHTML,sentinel:document.querySelector('#sentinel').innerHTML,
        active:document.activeElement.id,selection:selection?{anchor:selection.anchorNode?.textContent,anchorOffset:selection.anchorOffset,
          focus:selection.focusNode?.textContent,focusOffset:selection.focusOffset,collapsed:selection.isCollapsed}:null};
    });
    const forbidForeground=page=>{page.bringToFront=async()=>{throw new Error('Background operation attempted foreground activation');};};
    const options=page=>({focusMode:'background',windowMode:'normal',timeoutMs:3000,guard:guard(page)});

    const a=await fixturePage('A');
    await a.locator('#target').focus();
    const aScope=await snapshot(a);
    const b=await fixturePage('B');
    await b.bringToFront();
    await b.locator('#sentinel').focus();
    const bBefore=await snapshot(b);
    const entry=await a.evaluate(()=>({visible:document.visibilityState,focused:document.hasFocus(),active:document.activeElement.id,
      nativeFocusMethod:Function.prototype.toString.call(document.hasFocus),ownFocusMethod:Object.hasOwn(document,'hasFocus')}));
    assert.equal(entry.visible,'visible');assert.equal(entry.focused,false);
    assert.equal(entry.active,'target');assert.equal(entry.ownFocusMethod,false);assert.match(entry.nativeFocusMethod,/\[native code\]/u);
    assert.deepEqual(await snapshot(a),aScope,'the unrelated page taking focus must preserve A editor/selection');
    forbidForeground(a);forbidForeground(b);
    const adapter=new NewSystemAdapter({page:a,source:'fixture',inputMode:'browser-command',focusMode:'background',windowMode:'normal',timeout:3000});
    adapter.guard=guard(a); // The synthetic page is deliberately never a book URL.
    const positive=await trace('native-unfocused-positive',async()=>{
      const readiness=await adapter._requireDocumentFocus('local native unfocused entry');
      assert.equal(readiness.hasFocus,false);assert.equal(readiness.windowState,'normal');assert.ok(readiness.windowId>0);
      const insertion=await insertReviewedEditorHtml(a,'#target',reviewedHtml,options(a));
      return {readiness,insertion};
    });
    assert.deepEqual(await snapshot(b),bBefore,'only the supplied target page may receive input');
    assert.equal(await a.locator('#target').innerText(),'reviewed A 2 and 3');
    assert.equal(await a.locator('#target sub').innerText(),'2');assert.equal(await a.locator('#target sup').innerText(),'3');
    const positiveCounters=await a.evaluate(()=>window.fixtureCounters);
    assert.equal(positiveCounters.commands,1);assert.equal(positiveCounters.syntheticEvents,0);
    assert.equal(positiveCounters.clipboard,0);assert.equal(positiveCounters.frameworkWrites,0);

    const rejected=[];
    const rejectCase=async(name,{before,afterPress,errorPattern,windowState}={})=>{
      const page=await fixturePage(name);forbidForeground(page);
      const sentinelBefore=await page.locator('#sentinel').innerHTML();
      if(before)await before(page);
      if(afterPress){
        const locate=page.locator.bind(page);
        page.locator=(...args)=>{
          const locator=locate(...args),press=locator.press.bind(locator);
          locator.press=async(...pressArgs)=>{await press(...pressArgs);await afterPress(page);};
          return locator;
        };
      }
      const originalCDP=context.newCDPSession.bind(context);
      if(windowState){
        // A precise window-receipt fault injection, not a fake DOM focus result.
        context.newCDPSession=async target=>{
          const session=await originalCDP(target),send=session.send.bind(session);
          if(target===page)session.send=async(method,...args)=>{
            const result=await send(method,...args);
            return method==='Browser.getWindowForTarget'?{...result,bounds:{...result.bounds,windowState}}:result;
          };
          return session;
        };
      }
      let error;
      try{
        await trace(name,async()=>{
          try{await insertReviewedEditorHtml(page,'#target','<p>must not be inserted</p>',options(page));}
          catch(value){error=value;}
        });
      }finally{context.newCDPSession=originalCDP;}
      assert.ok(error,`${name} must reject before editing`);assert.match(error.message,errorPattern);
      const counters=await page.evaluate(()=>({...window.fixtureCounters,target:document.querySelector('#target').innerHTML}));
      assert.equal(counters.commands,0,`${name} must make zero insertHTML calls`);assert.equal(counters.target,'');
      assert.equal(counters.clipboard,0);assert.equal(counters.syntheticEvents,0);assert.equal(counters.frameworkWrites,0);
      assert.equal(await page.locator('#sentinel').innerHTML(),sentinelBefore);
      rejected.push({name,error:error.message,commands:counters.commands});await page.close();
    };
    const cover=page=>page.evaluate(()=>{
      const overlay=document.createElement('div');overlay.style.cssText='position:fixed;inset:0;z-index:9999;background:white';document.body.append(overlay);
    });
    await rejectCase('covered-before-pointer',{before:cover,errorPattern:/covered/u});
    await rejectCase('covered-after-keyboard',{afterPress:cover,errorPattern:/covered before insertion/u});
    await rejectCase('lost-active-editor-after-keyboard',{afterPress:page=>page.evaluate(()=>document.querySelector('#target').blur()),errorPattern:/selection is not confined/u});
    await rejectCase('selection-outside-after-keyboard',{afterPress:page=>page.evaluate(()=>{
      const range=document.createRange();range.selectNodeContents(document.querySelector('#outside'));range.collapse(true);
      const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
      if(document.activeElement.id!=='target')throw new Error('Selection fault must preserve the active editor');
    }),errorPattern:/selection is not confined/u});
    await rejectCase('hidden-editor',{before:page=>page.evaluate(()=>{document.querySelector('#target').style.display='none';}),errorPattern:/not visible/u});
    await rejectCase('noneditable-after-keyboard',{afterPress:page=>page.evaluate(()=>{document.querySelector('#target').contentEditable='false';}),errorPattern:/selection is not confined/u});
    await rejectCase('nonunique-editor',{before:page=>page.evaluate(()=>document.body.append(document.querySelector('#target').cloneNode(true))),errorPattern:/exactly one/u});
    await rejectCase('hidden-background-document',{afterPress:page=>page.evaluate(()=>Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'})),errorPattern:/document.*hidden/u});
    await rejectCase('minimized-receipt-in-normal-mode',{windowState:'minimized',errorPattern:/正常窗口/u});

    // Foreground still refuses the exact same native-unfocused entry state.
    const foreground=await fixturePage('foreground-entry');await foreground.locator('#target').focus();
    const stealing=await fixturePage('foreground-stealer');await stealing.locator('#sentinel').focus();
    assert.equal(await foreground.evaluate(()=>document.hasFocus()),false);
    await assert.rejects(requireRecorderDocumentReady(foreground,{focusMode:'foreground',windowMode:'normal',guard:guard(foreground)}),/lost DOM focus/u);
    assert.equal((await foreground.evaluate(()=>window.fixtureCounters)).commands,0);

    // Headless native mouse input grants widget focus. A separate explicit
    // fault injection exercises the final synchronous no-focus acceptance;
    // it is not presented as the native multipage positive above.
    const finalFault=await fixturePage('final-focus-fault');forbidForeground(finalFault);
    const locate=finalFault.locator.bind(finalFault);
    finalFault.locator=(...args)=>{
      const locator=locate(...args),press=locator.press.bind(locator);
      locator.press=async(...pressArgs)=>{await press(...pressArgs);await finalFault.evaluate(()=>{document.hasFocus=()=>false;});};
      return locator;
    };
    const finalFaultResult=await trace('final-focus-fault',()=>insertReviewedEditorHtml(finalFault,'#target','<p>fault-injected unfocused callback</p>',options(finalFault)));
    assert.equal((await finalFault.evaluate(()=>window.fixtureCounters)).commandFocus[0].focused,false);
    assert.equal(networkRequests.length,0);
    return {entry,positive,positiveCounters,rejected,foregroundRejected:true,finalFaultResult,networkRequests,browserVersion:browser.version(),
      limits:['Native headless input grants widget focus; native false is proven at the actual adapter/readiness entry.',
        'Final-callback focus loss, hidden-document and minimized-window receipts are explicitly labelled fault injections.',
        'No Windows foreground-containment, production save, platform page or connected browser was tested.']};
  }finally{await browser.close();}
}

async function runWorker(executablePath){
  const environment={...process.env,DEBUG:'pw:protocol'};delete environment.NODE_TEST_CONTEXT;
  const child=spawn(process.execPath,[fileURLToPath(import.meta.url),workerFlag,executablePath],{env:environment,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',value=>{stdout+=value;});child.stderr.on('data',value=>{stderr+=value;});
  const exitCode=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
  assert.equal(exitCode,0,`local headless worker failed: ${stderr.slice(-10000)}`);
  const line=stdout.split(/\r?\n/u).find(value=>value.startsWith(resultPrefix));assert.ok(line,'worker must return actual browser results');
  return {result:JSON.parse(line.slice(resultPrefix.length)),stderr};
}

if(process.argv[2]===workerFlag){
  try{console.log(resultPrefix+JSON.stringify(await browserWorker(process.argv[3])));}
  catch(error){console.error(error.stack);process.exitCode=1;}
}else{
  test('owned headless background/normal input accepts native unfocused entry and preserves safety guards',{timeout:60000},async t=>{
    const executablePath=executableForTest();
    if(!executablePath){t.skip('No existing Chromium/Edge executable; no download or headful launch attempted');return;}
    const {result,stderr}=await runWorker(executablePath);
    await t.test('real unrelated page takes focus while native hasFocus stays unmodified',()=>{
      assert.equal(result.entry.focused,false);assert.equal(result.entry.visible,'visible');assert.equal(result.entry.active,'target');
      assert.equal(result.entry.ownFocusMethod,false);assert.match(result.entry.nativeFocusMethod,/\[native code\]/u);
      assert.equal(result.positive.readiness.hasFocus,false);assert.equal(result.positive.readiness.windowState,'normal');
    });
    await t.test('trusted page-scoped editing uses real normal window without activation or fabricated events',()=>{
      assert.equal(result.positive.insertion.succeeded,true);assert.equal(result.positive.insertion.selectionVerified,true);
      assert.ok(result.positive.insertion.inputEvents.some(event=>event.type==='input'&&event.isTrusted===true));
      const protocol=protocolSegment(stderr,'native-unfocused-positive');
      assert.match(protocol,/"method":"Input\.dispatchMouseEvent"/u);assert.match(protocol,/"method":"Input\.dispatchKeyEvent"/u);
      assert.match(protocol,/"method":"Browser\.getWindowForTarget"/u);assert.doesNotMatch(protocol,/"method":"Page\.bringToFront"/u);
      assert.doesNotMatch(protocol,/"method":"Browser\.setWindowBounds"/u);
      assert.equal(result.positiveCounters.commands,1);assert.equal(result.positiveCounters.syntheticEvents,0);assert.equal(result.networkRequests.length,0);
    });
    for(const rejected of result.rejected)await t.test(`${rejected.name} refuses input without foreground fallback`,()=>{
      assert.equal(rejected.commands,0);assert.doesNotMatch(protocolSegment(stderr,rejected.name),/"method":"Page\.bringToFront"/u);
    });
    await t.test('foreground still rejects native unfocused documents',()=>assert.equal(result.foregroundRejected,true));
    await t.test('explicit final-callback focus fault accepts only the still-active target editor',()=>{
      assert.equal(result.finalFaultResult.succeeded,true);assert.doesNotMatch(protocolSegment(stderr,'final-focus-fault'),/"method":"Page\.bringToFront"/u);
    });
    t.diagnostic(JSON.stringify({browserVersion:result.browserVersion,nativeEntry:result.entry.focused,commandFocus:result.positiveCounters.commandFocus,limits:result.limits}));
  });

  for(const windowState of ['normal','maximized','fullscreen'])test(`document snapshot policy accepts ${windowState} receipt without DOM focus`,async()=>{
    // Pure receipt policy test, separate from the real native-unfocused browser
    // positive above. This snapshot fixture does not prove real window state.
    const snapshot={url:'about:blank',timeOrigin:100,visibilityState:'visible',hasFocus:false,readyState:'complete',prerendering:false,usable:true};
    const page={evaluate:async()=>({...snapshot})};
    const result=await requireRecorderDocumentReady(page,{focusMode:'background',windowMode:'normal',guard:async()=>{},windowReader:async()=>({windowId:123,windowState})});
    assert.equal(result.hasFocus,false);assert.equal(result.windowState,windowState);assert.equal(result.windowId,123);
  });
}
