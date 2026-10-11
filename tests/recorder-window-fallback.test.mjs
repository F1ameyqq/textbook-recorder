import test from 'node:test';
import assert from 'node:assert/strict';
import {activateRecorderPage,readRecorderWindowState} from '../src/browser-focus.mjs';

const denied = () => new Error('browserContext.newCDPSession: Protocol error (Target.attachToBrowserTarget): {"code":-32000,"message":"Not allowed"}');
const pageFor = (error = denied()) => ({context:()=>({newCDPSession:async()=>{throw error;}}),bringToFront:async()=>{throw new Error('Unexpected foreground activation');}});

test('extension browser-session denial uses guarded Windows minimization only',async()=>{
  const page=pageFor(),calls=[];let guards=0;
  await activateRecorderPage(page,'background',{windowMode:'minimized',platform:'win32',guard:async()=>{guards++;},windowController:async(target,action,guard)=>{
    assert.equal(target,page);await guard();calls.push(action);return {windowId:'1234',windowState:'minimized',backend:'win32'};
  }});
  assert.deepEqual(calls,['minimize']);assert.ok(guards>=4);
});

test('extension window read uses read-only Windows state action',async()=>{
  const page=pageFor(),calls=[];
  const result=await readRecorderWindowState(page,async()=>{},{platform:'win32',windowController:async(target,action)=>{
    assert.equal(target,page);calls.push(action);return {windowId:'1234',windowState:'minimized',backend:'win32'};
  }});
  assert.deepEqual(calls,['read']);assert.equal(result.windowState,'minimized');
});

test('unexpected protocol errors and non-Windows platforms never invoke fallback',async()=>{
  for(const [error,platform] of [[new Error('Disconnected'),'win32'],[new Error('Browser.getWindowBounds: Not allowed'),'win32'],[denied(),'linux']]){
    let calls=0;
    await assert.rejects(activateRecorderPage(pageFor(error),'background',{windowMode:'minimized',platform,windowController:async()=>{calls++;}}),error);
    assert.equal(calls,0);
  }
});

test('window identification failures and unconfirmed minimization stop without foreground fallback',async()=>{
  await assert.rejects(activateRecorderPage(pageFor(),'background',{windowMode:'minimized',platform:'win32',windowController:async()=>{throw new Error('Window identity not unique');}}),/identity not unique/u);
  await assert.rejects(activateRecorderPage(pageFor(),'background',{windowMode:'minimized',platform:'win32',windowController:async()=>({windowState:'normal'})}),/未保持最小化/u);
});

test('changed page guard prevents Windows fallback before any window action',async()=>{
  let guards=0,calls=0;
  await assert.rejects(activateRecorderPage(pageFor(),'background',{windowMode:'minimized',platform:'win32',guard:async()=>{if(++guards===2)throw new Error('Wrong book');},windowController:async()=>{calls++;}}),/Wrong book/u);
  assert.equal(calls,0);
});

test('background normal never invokes Windows window control',async()=>{
  let calls=0;
  await activateRecorderPage(pageFor(),'background',{windowMode:'normal',platform:'win32',windowController:async()=>{calls++;}});
  assert.equal(calls,0);
});
