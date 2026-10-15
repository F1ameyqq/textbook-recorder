import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { PersistentRecorderSession } from '../src/persistent-recorder-session.mjs';
import { recorderBookUrl } from '../src/recorder-config.mjs';

function fixture() {
  const events=[];
  const page={url:()=>recorderBookUrl(100001),isClosed:()=>false,__textbookRecorderSessionPage:'binding-one'};
  const context={pages:()=>[page]};page.context=()=>context;
  page.__persistentRecorder={status:()=>({bookId:100001,focusMode:'background',windowMode:'minimized'}),cleanupWindowHelper:async()=>{events.push('window-cleanup');return {bookId:100001,cleanup:{removed:true}};}};
  const session=Object.create(PersistentRecorderSession.prototype);
  Object.assign(session,{bookId:100001,readOnly:false,focusMode:'background',windowMode:'minimized',pageBindingId:'binding-one',windowHelperCleanupSupported:true,state:{pending:null},busy:false,closing:false,closed:false,dead:false,binding:true,statusPromise:null});
  session.connection={client:{callTool:async({name,arguments:args})=>{assert.equal(name,'browser_run_code_unsafe');const result=await vm.runInNewContext(`(${args.code})(page)`,{page,URL,URLSearchParams});return {content:[{type:'text',text:JSON.stringify(result)}]};}},close:async()=>events.push('mcp-close')};
  session.cleanupOwnedTab=async()=>events.push('book-tab-cleanup');session.persist=async()=>{assert.equal(session.state.windowHelperCleanup.removed,true);events.push('persist');};
  return {session,events};
}

test('real typed cleanup dispatch completes before book cleanup and transport close',async()=>{
  const {session,events}=fixture();
  const result=await session.close();
  assert.deepEqual(events,['window-cleanup','book-tab-cleanup','persist','mcp-close']);
  assert.deepEqual(result.windowHelperCleanup,{removed:true});
});

test('a pending command forbids helper cleanup and transport shutdown',async()=>{
  const {session,events}=fixture();session.state.pending={id:'pending-one'};
  await assert.rejects(session.close(),/任务未确认终止/u);assert.deepEqual(events,[]);
});
