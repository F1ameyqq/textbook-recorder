import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {recorderRequest,main} from '../scripts/recorder-control.mjs';

async function workspace(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'recorder-local-status-'));
  t.after(async()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('recorder-local-status-'));await fs.rm(root,{recursive:true,force:true});});
  await fs.mkdir(path.join(root,'config'));await fs.mkdir(path.join(root,'data/persistent-executor'),{recursive:true});
  await fs.writeFile(path.join(root,'config/recorder.json'),JSON.stringify({bookId:101}));
  await fs.writeFile(path.join(root,'data/persistent-executor/control.json'),JSON.stringify({schemaVersion:1,bookId:101,port:8789,key:'a'.repeat(64)}));return root;
}
test('local status uses only authenticated local health and retains lock/pause identity',async t=>{
  const root=await workspace(t),calls=[];
  const snapshot={bookId:101,pending:{id:'original',action:'execute'},writeBlocked:true,pauseControl:{generation:2,paused:true}};
  const value=await recorderRequest(root,{action:'status'},{local:true,fetchImpl:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>snapshot};}});
  assert.equal(calls.length,1);assert.equal(calls[0].url,'http://127.0.0.1:8789/health');assert.equal(calls[0].options.method,'GET');assert.equal(calls[0].options.body,undefined);
  assert.equal(value.statusSource,'local-health');assert.equal(value.writeBlocked,true);assert.equal(value.pending.id,'original');assert.deepEqual(value.pauseControl,snapshot.pauseControl);
});
test('normal status continues using the original remote-status path',async t=>{
  const root=await workspace(t);let requested;
  const value=await recorderRequest(root,{action:'status'},{fetchImpl:async url=>{requested=url;return {ok:true,json:async()=>({bookId:101})};}});
  assert.equal(requested,'http://127.0.0.1:8789/status');assert.equal(value.statusSource,undefined);
});
test('local polling cannot establish a connection, control another action or await acceptance',async t=>{
  const root=await workspace(t);let calls=0;
  for(const argv of [['connect-status','--local'],['probe','--local'],['status','--local','--wait']])await assert.rejects(main(argv,{root,request:async()=>{calls++;},log:()=>{}}),/local/u);
  await assert.rejects(recorderRequest(root,{action:'pause'},{local:true,fetchImpl:async()=>{calls++;}}),/local/u);assert.equal(calls,0);
});
test('a wrong local service identity cannot masquerade as the configured book',async t=>{
  const root=await workspace(t);await assert.rejects(recorderRequest(root,{action:'status'},{local:true,fetchImpl:async()=>({ok:true,json:async()=>({bookId:202})})}),/身份/u);
});
test('a changed headless profile refuses control before contacting an existing service',async t=>{
  const root=await workspace(t);await fs.writeFile(path.join(root,'config/recorder.json'),JSON.stringify({bookId:101,browserBackend:'headless'}));let calls=0;
  await assert.rejects(recorderRequest(root,{action:'pause'},{fetchImpl:async()=>{calls++;}}),/profile|backend/u);assert.equal(calls,0);
});
test('a stale port refuses even a read-only local request',async t=>{
  const root=await workspace(t);await fs.writeFile(path.join(root,'config/recorder.json'),JSON.stringify({bookId:101,port:8790}));let calls=0;
  await assert.rejects(recorderRequest(root,{action:'status'},{local:true,fetchImpl:async()=>{calls++;}}),/配置/u);assert.equal(calls,0);
});
