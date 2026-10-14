import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {NewSystemAdapter} from '../src/new-system-adapter.mjs';
import {recorderBookUrl} from '../src/recorder-config.mjs';
import {waitForRecorderDocumentReady} from '../src/browser-document-state.mjs';

const BOOK=101,url=recorderBookUrl(BOOK),task={id:'synthetic-directory',target:{chapterLabel:'合成章',sectionLabel:'合成节',record:1}};
function fixture({visibilityState='visible',windowState='normal',windowMode='normal',readyState='complete',usable=true}={}){
  const events=[],page=new EventEmitter(),context=new EventEmitter(),browser=new EventEmitter();
  page.url=()=>url;page.isClosed=()=>false;page.context=()=>context;context.browser=()=>browser;browser.isConnected=()=>true;
  context.newCDPSession=async()=>({send:async()=>{events.push('window-read');return {windowId:7,bounds:{windowState}};},detach:async()=>{}});
  page.evaluate=async fn=>{
    if(fn.name==='recorderDocumentSnapshot'){events.push('document-read');return {url,timeOrigin:100,visibilityState,hasFocus:false,readyState,prerendering:false,usable};}
    events.push('scope-read');return {chapterLabel:'',sectionLabel:''};
  };
  page.locator=()=>{events.push('chapter-wait');throw new Error('synthetic reached ordinary directory wait');};
  page.reload=async()=>{events.push('reload');};
  const adapter=new NewSystemAdapter({page,inputMode:'browser-command',focusMode:'background',windowMode,directoryTimeout:60000});adapter.bookId=BOOK;
  adapter._click=async()=>{events.push('click');};
  // The configured policy has its own tests; this double observes that the
  // newly added check uses the real document/window reader before the wait.
  adapter._activate=async()=>{events.push('window-policy');};
  return {adapter,events};
}

for(const [name,state,pattern] of [
  ['hidden normal document',{visibilityState:'hidden'},/background document is hidden/u],
  ['incorrect actual window',{windowState:'minimized'},/正常窗口/u],
])test(name+' stops before long chapter waits, clicks or navigation',async()=>{
  const {adapter,events}=fixture(state);await assert.rejects(adapter.directory(task),pattern);
  assert.ok(events.includes('document-read'));assert.equal(events.some(event=>['chapter-wait','scope-read','click','reload'].includes(event)),false);
  assert.equal(adapter._directoryKey,null);assert.equal(adapter._nodeID,null);assert.deepEqual(adapter._directoryRecords,[]);
});

test('a visible bound background document proceeds to the unchanged directory checks',async()=>{
  const {adapter,events}=fixture();await assert.rejects(adapter.directory(task),/ordinary directory wait/u);
  assert.ok(events.indexOf('window-read')<events.indexOf('chapter-wait'));assert.ok(events.includes('scope-read'));assert.equal(events.includes('click'),false);
});

test('an explicitly minimized bound document retains its existing hidden-document rule',async()=>{
  const {adapter,events}=fixture({visibilityState:'hidden',windowState:'minimized',windowMode:'minimized'});
  await assert.rejects(adapter.directory(task),/ordinary directory wait/u);assert.ok(events.indexOf('window-read')<events.indexOf('chapter-wait'));assert.equal(events.includes('click'),false);
});

test('a genuinely hidden loading document stops without spending its readiness deadline',async()=>{
  const {adapter,events}=fixture({visibilityState:'hidden',readyState:'loading',usable:false}),started=Date.now();
  await assert.rejects(adapter.directory(task),/background document is hidden/u);assert.ok(Date.now()-started<500);
  assert.deepEqual(events,['window-policy','document-read']);
});

test('a loading document with incorrect actual window stops before polling for readiness',async()=>{
  const {adapter,events}=fixture({windowState:'minimized',readyState:'loading',usable:false});
  await assert.rejects(adapter.directory(task),/正常窗口/u);assert.equal(events.filter(event=>event==='document-read').length,1);
  assert.equal(events.includes('chapter-wait'),false);
});

test('a document that remains loading is bounded and reports its real last readiness state',async()=>{
  const {adapter,events}=fixture({readyState:'loading',usable:false}),started=Date.now();
  await assert.rejects(waitForRecorderDocumentReady(adapter.page,{timeoutMs:70,pollMs:10}),error=>
    error.code==='DOCUMENT_READINESS_TIMEOUT'&&error.documentReadiness.lastState.readyState==='loading'&&error.documentReadiness.lastState.usable===false);
  assert.ok(Date.now()-started<500);assert.equal(events.includes('chapter-wait'),false);
});

test('readiness waiting refuses a replaced document instead of adopting a later ready page',async()=>{
  const {adapter}=fixture({readyState:'loading',usable:false}),evaluate=adapter.page.evaluate;let reads=0;
  adapter.page.evaluate=async fn=>{const state=await evaluate(fn);if(fn.name==='recorderDocumentSnapshot'&&++reads>1)return {...state,timeOrigin:101,readyState:'complete',usable:true};return state;};
  await assert.rejects(waitForRecorderDocumentReady(adapter.page,{timeoutMs:500,pollMs:10}),/changed during readiness/u);
});

test('an exhausted background directory budget cannot start another long target wait',async()=>{
  const {adapter,events}=fixture();adapter.directoryTimeout=80;adapter.timeout=70;
  adapter._scopeMatches=async()=>{await new Promise(resolve=>setTimeout(resolve,90));return false;};
  adapter.page.locator=()=>({filter:()=>({evaluateAll:async()=>{events.push('chapter-wait');return {count:1,visible:true};}})});
  await assert.rejects(adapter.directory(task),error=>error.code==='TARGET_VISIBILITY_TIMEOUT'&&error.visibilityDiagnostic.budgetExhausted===true);
  assert.equal(events.includes('chapter-wait'),false);assert.equal(events.includes('click'),false);
});
