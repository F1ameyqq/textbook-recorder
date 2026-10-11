import test from 'node:test';
import assert from 'node:assert/strict';
import { requireRecorderDocumentReady, assertRecorderDocumentSnapshot } from '../src/browser-document-state.mjs';

const snapshot = () => ({url:'https://example.test/book/146965',timeOrigin:100,visibilityState:'hidden',hasFocus:false,readyState:'complete',prerendering:false,usable:true});
const fixture = () => { let state=snapshot(); const calls=[]; const page={evaluate:async()=>{calls.push('document');return {...state};}};
  return {page,calls,set:value=>{state={...state,...value};},guard:async()=>{calls.push('guard');},windowReader:async target=>{assert.equal(target,page);calls.push('window-read');return {windowId:'123',windowState:'minimized'};}}; };

test('minimized mode accepts actual hidden/unfocused documents only with verified owned window',async()=>{
  const f=fixture(); const result=await requireRecorderDocumentReady(f.page,{...f,focusMode:'background',windowMode:'minimized'});
  assert.equal(result.minimized,true);assert.equal(result.visibilityState,'hidden');assert.equal(result.hasFocus,false);assert.equal(result.windowId,'123');
  assert.deepEqual(f.calls,['guard','document','window-read','guard','document']);
});
test('foreground keeps document visibility and focus requirements',async()=>{
  for(const state of [{visibilityState:'hidden',hasFocus:true},{visibilityState:'visible',hasFocus:false}]){const f=fixture();f.set(state);await assert.rejects(requireRecorderDocumentReady(f.page,{...f,focusMode:'foreground'}),/hidden or has lost DOM focus/);assert.ok(!f.calls.includes('window-read'));}
});
test('normal background accepts an unfocused visible document only with a verified normal window',async()=>{
  for(const windowState of ['normal','maximized','fullscreen']){
    const f=fixture();f.set({visibilityState:'visible'});
    const result=await requireRecorderDocumentReady(f.page,{...f,focusMode:'background',windowMode:'normal',windowReader:async()=>({windowId:123,windowState})});
    assert.equal(result.hasFocus,false);assert.equal(result.minimized,false);assert.equal(result.windowState,windowState);assert.equal(result.windowId,123);
  }
});
test('normal background rejects hidden documents and minimized, absent or invalid window identity',async()=>{
  const hidden=fixture();await assert.rejects(requireRecorderDocumentReady(hidden.page,{...hidden,focusMode:'background',windowReader:async()=>({windowId:123,windowState:'normal'})}),/background document is hidden/u);
  for(const receipt of [{windowId:123,windowState:'minimized'},{windowId:null,windowState:'normal'},{windowId:'0',windowState:'normal'},{windowId:123,windowState:'unknown'}]){
    const f=fixture();f.set({visibilityState:'visible'});await assert.rejects(requireRecorderDocumentReady(f.page,{...f,focusMode:'background',windowReader:async()=>receipt}),/没有可确认的正常窗口/u);
  }
});
test('normal background rejects a replaced or newly hidden document during its window read',async()=>{
  for(const state of [{url:'https://example.test/book/999'},{timeOrigin:101},{visibilityState:'hidden'}]){
    const f=fixture();f.set({visibilityState:'visible'});
    await assert.rejects(requireRecorderDocumentReady(f.page,{...f,focusMode:'background',windowReader:async()=>{f.set(state);return {windowId:123,windowState:'normal'};}}),/document changed|document became hidden/u);
  }
});
test('restored, absent or ambiguous window identity stops minimized input',async()=>{
  for(const receipt of [{windowId:12,windowState:'normal'},{windowId:null,windowState:'minimized'},{windowId:'0',windowState:'minimized'}]){
    const f=fixture();await assert.rejects(requireRecorderDocumentReady(f.page,{...f,focusMode:'background',windowMode:'minimized',windowReader:async()=>receipt}),/未保持最小化/);
  }
});
test('navigation or document replacement during window discovery stops input',async()=>{
  for(const mutation of [{url:'https://example.test/book/999'},{timeOrigin:101}]){const f=fixture();await assert.rejects(requireRecorderDocumentReady(f.page,{...f,focusMode:'background',windowMode:'minimized',windowReader:async()=>{f.set(mutation);return {windowId:1,windowState:'minimized'};}}),/document changed/);}
});
test('wrong book guard stops before even reading window identity',async()=>{
  const f=fixture();await assert.rejects(requireRecorderDocumentReady(f.page,{...f,focusMode:'background',windowMode:'minimized',guard:async()=>{throw new Error('wrong book');}}),/wrong book/);assert.deepEqual(f.calls,[]);
});
test('unloaded or prerendered documents stop even with minimized mode',async()=>{
  for(const mutation of [{readyState:'loading'},{prerendering:true},{usable:false},{visibilityState:'prerender'}]){const f=fixture();f.set(mutation);await assert.rejects(requireRecorderDocumentReady(f.page,{...f,focusMode:'background',windowMode:'minimized'}),/not ready/);assert.ok(!f.calls.includes('window-read'));}
});
test('document binding cannot be reused after reload',()=>{const before=snapshot();assert.throws(()=>assertRecorderDocumentSnapshot({...before,timeOrigin:200},before),/document changed/);});
