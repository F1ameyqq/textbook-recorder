import test from 'node:test';
import assert from 'node:assert/strict';
import {requireRecorderDocumentReady} from '../src/browser-document-state.mjs';

const snapshot={url:'https://example.test/owned-editor',timeOrigin:1234,visibilityState:'visible',hasFocus:false,readyState:'complete',prerendering:false,usable:true};
function fixture(proof){
  let reads=0;
  const page={evaluate:async()=>{reads++;return {...snapshot};},bringToFront:()=>{throw new Error('No activation in a read-only readiness check');}};
  return {page,windowReader:async()=>proof,get reads(){return reads;}};
}

test('normal-window diagnostic distinguishes missing state, minimized window and invalid ID without relaxing guards',async t=>{
  const cases=[['missing',{windowId:22},true,'missing'],['minimized',{windowId:'22',windowState:'minimized'},true,'minimized'],['invalid ID',{windowId:0,windowState:'normal'},false,'normal']];
  for(const [name,proof,validId,state]of cases)await t.test(name,async()=>{
    const f=fixture(proof);
    await assert.rejects(requireRecorderDocumentReady(f.page,{focusMode:'background',windowMode:'normal',windowReader:f.windowReader}),error=>error.message===`指定教材页没有可确认的正常窗口，停止输入 (window-proof validId=${validId},state=${state})`);
    assert.equal(f.reads,1,'Rejected proof stops before the second document read');
  });
});

test('window diagnostic exports only fixed state enums, never arbitrary proof values',async()=>{
  for(const proof of [undefined,{windowId:22,windowState:null},{windowId:'private-ID',windowState:'https://private.test/?token=do-not-export'},{windowId:22,windowState:{secret:'do-not-export'}}]){
    const f=fixture(proof);
    await assert.rejects(requireRecorderDocumentReady(f.page,{focusMode:'background',windowReader:f.windowReader}),error=>/\(window-proof validId=(?:true|false),state=(?:missing|invalid)\)$/u.test(error.message)&&!/(?:private|token|secret|do-not-export)/u.test(error.message));
  }
});

test('minimized mode keeps its original error prefix and exact minimized requirement',async()=>{
  const f=fixture({windowId:22,windowState:'maximized'});
  await assert.rejects(requireRecorderDocumentReady(f.page,{focusMode:'background',windowMode:'minimized',windowReader:f.windowReader}),error=>error.message==='指定教材页的窗口未保持最小化，停止输入 (window-proof validId=true,state=maximized)');
});

test('accepted normal, maximized and fullscreen proofs keep the existing document checks',async()=>{
  for(const state of ['normal','maximized','fullscreen']){
    const f=fixture({windowId:22,windowState:state});
    const result=await requireRecorderDocumentReady(f.page,{focusMode:'background',windowReader:f.windowReader});
    assert.equal(result.windowState,state);assert.equal(result.hasFocus,false);assert.equal(f.reads,2);
  }
});
