import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {validateRecorderConfig,loadRecorderConfig,validateRecorderCommand} from '../src/recorder-config.mjs';
import {PersistentRecorderSession} from '../src/persistent-recorder-session.mjs';
import {recorderRequest} from '../scripts/recorder-control.mjs';
import {startRecorderService} from '../scripts/run-recorder-service.mjs';

const args={manifest:'data/jobs/synthetic/roundtrip.json',state:'data/jobs/synthetic/roundtrip-state.json'};
const draftActions=['draft-roundtrip','draft-roundtrip-restore'];
async function fixture(t,overrides={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'recorder-draft-controls-test-')),cleanups=[];
  t.after(async()=>{for(const cleanup of cleanups)await cleanup();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('recorder-draft-controls-test-'));await fs.rm(root,{recursive:true,force:true});});
  const config={bookId:701,port:8907,browserBackend:'headless',browserProfileDir:'data/browser-profiles/synthetic',focusMode:'background',windowMode:'headless',readOnly:false,...overrides};
  if(config.browserBackend==='extension')delete config.browserProfileDir;
  await fs.mkdir(path.join(root,'config'));await fs.writeFile(path.join(root,'config/recorder.json'),JSON.stringify(config));
  const loaded=await loadRecorderConfig(root),sessionPath=path.join(await fs.realpath(root),'data/persistent-executor/session.json');
  const control={schemaVersion:1,bookId:loaded.bookId,pid:90007,port:loaded.port,browserBackend:loaded.browserBackend??'extension',browserProfileDir:loaded.browserProfileDir??null,focusMode:loaded.focusMode,windowMode:loaded.windowMode,readOnly:loaded.readOnly??false,sessionPath,key:'e'.repeat(64)};
  await fs.mkdir(path.dirname(sessionPath),{recursive:true});await fs.writeFile(path.join(path.dirname(sessionPath),'control.json'),JSON.stringify(control));
  return {root,loaded,control,cleanups};
}

test('draft roundtrip accepts exactly manifest/state with no replacement, limit, task or continuation grant',()=>{
  for(const action of draftActions){
    assert.deepEqual(validateRecorderCommand({action,args},process.cwd()),{action,args});
    const invalid=[{}, {manifest:args.manifest}, {state:args.state}, {...args,manifest:''}, {...args,state:''}, {...args,manifest:1}, {...args,state:false}, {...args,taskId:'original-task'}, {...args,limit:1}, {...args,replacement:'new content'}, {...args,code:'arbitrary action'}];
    for(const value of invalid)assert.throws(()=>validateRecorderCommand({action,args:value},process.cwd()));
    assert.throws(()=>validateRecorderCommand({action,args,continuationGuard:{schemaVersion:1,previousTerminalId:null,pauseGeneration:0,connectionCount:1,phase:'initial'}},process.cwd()));
    assert.throws(()=>validateRecorderCommand({action,args:{...args,state:'../other-state.json'}},process.cwd()));
  }
});
test('taskless reconcile is only syntactically available for the exact manifest/state pair',()=>{
  assert.deepEqual(validateRecorderCommand({action:'reconcile',args},process.cwd()),{action:'reconcile',args});
  for(const value of [{manifest:args.manifest},{...args,pendingPath:'data/pending.json'},{...args,historicalNetworkEvidencePath:'data/history.json'},{...args,preAppendFailureCommandId:'12345678-1234-1234-1234-123456789abc',baselineProbeCommandId:'22345678-1234-1234-1234-123456789abc'}])assert.throws(()=>validateRecorderCommand({action:'reconcile',args:value},process.cwd()));
  assert.equal(validateRecorderCommand({action:'reconcile',args:{manifest:args.manifest,taskId:'original-task'}},process.cwd()).args.taskId,'original-task');
});
test('config cannot weaken a headless draft worker into foreground or normal-window mode',()=>{
  for(const changes of [{focusMode:'foreground'},{windowMode:'normal'},{windowMode:'minimized'}])assert.throws(()=>validateRecorderConfig({bookId:701,browserBackend:'headless',readOnly:false,...changes}),/headless|minimized/u);
});
test('controller denies draft roundtrip for read-only and extension modes without any HTTP dispatch',async t=>{
  const variants=[{readOnly:true},{browserBackend:'extension',windowMode:'normal',readOnly:false},{browserBackend:'extension',windowMode:'minimized',readOnly:false}];
  for(const variant of variants)await t.test(JSON.stringify(variant),async child=>{
    const f=await fixture(child,variant);let dispatched=0;
    for(const action of draftActions)await assert.rejects(recorderRequest(f.root,{action,args},{fetchImpl:async()=>{dispatched++;throw new Error('Mode rejection must precede HTTP dispatch');}}),/readOnly|headless|独立/u);
    assert.equal(dispatched,0);
  });
});
test('session denies draft roundtrip in ineligible modes before review, IDs or browser connection',async t=>{
  for(const variant of [{readOnly:true},{browserBackend:'extension',windowMode:'normal',readOnly:false}])await t.test(JSON.stringify(variant),async child=>{
    const f=await fixture(child,variant);let connects=0;
    const session=new PersistentRecorderSession({...f.loaded,root:f.root,connect:async()=>{connects++;throw new Error('Draft mode rejection must happen before connection');}});await session.initialize();
    for(const [index,action] of draftActions.entries())await assert.rejects(session.command({id:'synthetic-prohibited-draft-'+index,action,args}),/readOnly|headless|独立/u);
    assert.equal(connects,0);assert.deepEqual(session.state.seenIds,[]);assert.equal(session.state.pending,null);assert.equal(session.state.writeBlocked,false);
  });
});
test('raw local controller cannot bypass draft mode checks and never opens a browser',async t=>{
  for(const variant of [{readOnly:true},{browserBackend:'extension',windowMode:'normal',readOnly:false}])await t.test(JSON.stringify(variant),async child=>{
    const f=await fixture(child,variant);await fs.unlink(path.join(f.root,'data/persistent-executor/control.json'));let connects=0;
    const service=await startRecorderService({root:f.root,port:0,resourceLeaseDirectory:path.join(f.root,'test-global-leases'),connect:async()=>{connects++;throw new Error('Synthetic raw draft rejection must not connect');},log:()=>{}});f.cleanups.push(()=>service.shutdown());
    const control=JSON.parse(await fs.readFile(service.controlFile,'utf8'));
    for(const action of draftActions){
      const response=await fetch('http://127.0.0.1:'+control.port+'/command',{method:'POST',headers:{'x-recorder-key':control.key,'Content-Type':'application/json'},body:JSON.stringify({action,args})});
      assert.equal(response.status,409);const result=await response.json();assert.match(result.error,/readOnly|headless|独立/u);assert.equal(result.status.pending,null);assert.equal(result.status.connection,'disconnected');assert.equal(result.status.writeBlocked,false);assert.equal(connects,0);
    }
  });
});
test('a cold write session cannot obtain a restore grant or create a connection',async t=>{
  const f=await fixture(t);let connects=0;
  const session=new PersistentRecorderSession({...f.loaded,root:f.root,connect:async()=>{connects++;throw new Error('A cold session must not create a restore connection');}});await session.initialize();
  await assert.rejects(session.command({action:'draft-roundtrip-restore',args}));
  assert.equal(connects,0);assert.equal(session.state.writeBlocked,false);assert.equal(session.state.pending,null);assert.deepEqual(session.state.seenIds,[]);
});
test('taskless reconcile cannot use an ordinary textbook manifest to obtain a browser connection',async t=>{
  const f=await fixture(t);await fs.mkdir(path.join(f.root,'data/jobs/synthetic'),{recursive:true});
  const ordinary={schemaVersion:1,kind:'new-system-batch',bookId:701,source:'production',tasks:[]};
  await fs.writeFile(path.join(f.root,args.manifest),JSON.stringify(ordinary));await fs.writeFile(path.join(f.root,args.state),'{}');let connects=0;
  const session=new PersistentRecorderSession({...f.loaded,root:f.root,connect:async()=>{connects++;throw new Error('An ordinary manifest cannot grant taskless reconciliation');}});await session.initialize();
  await assert.rejects(session.command({action:'reconcile',args}),/draft-runtime-roundtrip|taskId|专用|草稿/u);
  assert.equal(connects,0);assert.equal(session.state.pending,null);assert.deepEqual(session.state.seenIds,[]);
});
