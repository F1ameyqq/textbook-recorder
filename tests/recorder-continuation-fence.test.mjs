import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {installPersistentBridge} from '../src/persistent-recorder-bridge.mjs';
import {PersistentRecorderSession} from '../src/persistent-recorder-session.mjs';
import {expectedEditor,renderEditorHtml} from '../src/new-system-core.mjs';
import {recorderBookUrl,validateRecorderCommand} from '../src/recorder-config.mjs';

const BOOK=101,copy=structuredClone;
const initialGuard=(fence,connectionCount=1)=>({schemaVersion:1,previousTerminalId:fence.previousTerminalId,pauseGeneration:fence.pauseGeneration,phase:'initial',connectionCount});
const limitGuard=(fence,connectionCount=1)=>({...initialGuard(fence,connectionCount),phase:'limit'});
async function terminal(bridge){const deadline=Date.now()+5000;for(;;){const job=bridge.status().job;if(job?.terminal)return job;if(Date.now()>deadline)throw new Error('Synthetic bridge did not finish');await new Promise(resolve=>setTimeout(resolve,5));}}
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'recorder-continuation-fence-'));t.after(async()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('recorder-continuation-fence-'));await fs.rm(root,{recursive:true,force:true});});
  const tasks=[1,2].map(record=>({id:'synthetic-'+record,target:{chapterLabel:'Synthetic chapter',sectionLabel:'Synthetic section',record},source:{pages:[1],answerPages:[9]},stem:{blocks:[{type:'text',text:'Synthetic question '+record}]},answer:{blocks:[{type:'text',text:'Synthetic answer '+record}]},answerRequirement:{kind:'question',evidence:'Synthetic question'},answerStatus:'provided',review:{status:'approved',issues:[],checks:{sourceText:true,answerMatch:true,wholeQuestion:true,format:true}}}));
  const manifest={schemaVersion:1,kind:'new-system-batch',bookId:BOOK,source:'production',tasks,coverage:{pages:[{page:1,candidates:tasks.map(task=>({id:'candidate-'+task.id,type:'question',decision:'include',taskIds:[task.id]}))}]}};
  await fs.writeFile(path.join(root,'batch.json'),JSON.stringify(manifest));const records=new Map(),starts=[];let appends=0;
  const adapter={source:'production',bookId:BOOK,_uncertain:false,connect:async()=>{},read:async task=>records.get(task.target.record)??{status:'missing',bookId:BOOK,target:task.target,count:records.size},append:async task=>{
    appends++;const editor=side=>({...expectedEditor(task[side],root),html:renderEditorHtml(task[side],root)}),recordId=1000+task.target.record;
    records.set(task.target.record,{status:'found',bookId:BOOK,target:task.target,source:task.source,count:records.size+1,recordId,stem:editor('stem'),answer:editor('answer')});
    return {bookId:BOOK,seqIndex:task.target.record,shitiID:recordId,mainPicNum:1,answerPicNum:9,request:{bookId:BOOK,seqIndex:task.target.record,mainPicNum:1,answerPicNum:9},response:{status:200,body:{errno:0,errmsg:'success',data:{seqIndex:task.target.record,shitiID:recordId,haveAnswer:true}}}};
  }};
  const page={url:()=>recorderBookUrl(BOOK),bringToFront:async()=>{}},bridge=await installPersistentBridge({page,config:{root,bookId:BOOK},adapterFactory:()=>adapter});
  const args={manifest:'batch.json',state:'run.json',limit:1};
  return {root,args,bridge,adapter,starts,get appends(){return appends;}};
}
async function replaceBridge(f){const page={url:()=>recorderBookUrl(BOOK),bringToFront:async()=>{}};f.bridge=await installPersistentBridge({page,config:{root:f.root,bookId:BOOK},adapterFactory:()=>f.adapter});}
async function sessionFor(f,{pauseOnStart=false,oldProtocol=false,mutateStart=value=>value,mutateStatus=value=>value,loseStart=false,losePauseResponse=false,onPause=async()=>{}}={}){
  const callbacks=[],connection={servicePid:60001,authConfigured:true,onClosed:callback=>callbacks.push(callback),close:async()=>callbacks.forEach(callback=>callback()),client:{listTools:async()=>({tools:[{name:'browser_tabs',inputSchema:{properties:{action:{enum:['list','select']}}}},{name:'browser_run_code_unsafe',inputSchema:{properties:{code:{type:'string'}}}}]}),callTool:async({name,arguments:input})=>{
    if(name==='browser_tabs')return {structuredContent:{tabs:[{index:0,url:recorderBookUrl(BOOK)}]}};
    const match=input.code.match(/page\.__persistentRecorder\.(\w+)\((.*)\); \}/u);assert.ok(match);const action=match[1],payload=match[2]?JSON.parse(match[2]):undefined;let value;
    if(action==='start'){f.starts.push(payload);if(pauseOnStart)f.bridge.pause();if(loseStart)throw new Error('Synthetic transport result lost');value=await mutateStart(f.bridge.start(payload));}
    else if(action==='status'){value=copy(f.bridge.status());if(oldProtocol)delete value.continuationFence;value=mutateStatus(value);}
    else if(action==='pause'){await onPause(payload);if(losePauseResponse==='before')throw new Error('Synthetic pause result lost');value=f.bridge.pause(payload);if(losePauseResponse)throw new Error('Synthetic pause result lost');}
    else value=f.bridge[action](payload);
    return {structuredContent:value};
  }}};
  const session=new PersistentRecorderSession({root:f.root,bookId:BOOK,connect:async()=>connection,alive:()=>true,resolveAuth:async()=>({authConfigured:true})});await session.initialize();return session;
}

test('continuation guards reject unknown fields, invalid identities, and non-execute commands',()=>{
  const command={action:'execute',args:{manifest:'batch.json'},continuationGuard:{schemaVersion:1,previousTerminalId:null,pauseGeneration:0,phase:'initial',connectionCount:1}};
  assert.deepEqual(validateRecorderCommand(command,process.cwd()).continuationGuard,command.continuationGuard);
  for(const change of [guard=>{guard.schemaVersion=2;},guard=>{guard.previousTerminalId='../id';},guard=>{guard.pauseGeneration=-1;},guard=>{guard.phase='resume';},guard=>{guard.connectionCount=0;},guard=>{delete guard.connectionCount;},guard=>{guard.extra=true;}]){const invalid=copy(command);change(invalid.continuationGuard);assert.throws(()=>validateRecorderCommand(invalid,process.cwd()),/continuationGuard/u);}
  assert.throws(()=>validateRecorderCommand({...command,action:'probe',args:{}},process.cwd()),/仅允许用于 execute/u);
});

test('the first guarded execution accepts null previous id and proves the accepted fence',async t=>{
  const f=await fixture(t),guard=initialGuard(f.bridge.status().continuationFence),started=f.bridge.start({id:'first',action:'execute',args:f.args,continuationGuard:guard});
  assert.equal(started.started,true);assert.deepEqual(started.continuationGuardAccepted,{...guard,bookId:BOOK,commandId:'first'});
  const job=await terminal(f.bridge);assert.equal(job.result.stopReason,'limit');assert.equal(job.result.uncertain,false);assert.deepEqual(job.continuationGuardAccepted,started.continuationGuardAccepted);
  const second=f.bridge.start({id:'second',action:'execute',args:f.args,continuationGuard:limitGuard(f.bridge.status().continuationFence)});assert.equal(second.started,true);await terminal(f.bridge);assert.equal(f.appends,2);
});

test('an initial guard can bind an earlier read-only terminal command',async t=>{
  const f=await fixture(t);f.bridge.start({id:'prior-probe',action:'probe'});await terminal(f.bridge);
  const guard=initialGuard(f.bridge.status().continuationFence);assert.equal(guard.previousTerminalId,'prior-probe');assert.equal(f.bridge.start({id:'first-execute',action:'execute',args:f.args,continuationGuard:guard}).started,true);await terminal(f.bridge);
});

test('pause after a terminal limit stop rejects both stale and freshly read automatic guards',async t=>{
  const f=await fixture(t);f.bridge.start({id:'first',action:'execute',args:f.args,continuationGuard:initialGuard(f.bridge.status().continuationFence)});await terminal(f.bridge);
  const stale=limitGuard(f.bridge.status().continuationFence),paused=f.bridge.pause();assert.equal(paused.continuationFence.pauseGeneration,1);assert.equal(paused.continuationFence.paused,true);assert.equal(f.bridge.status().job.stopRequested,true);
  for(const guard of [stale,limitGuard(f.bridge.status().continuationFence)]){const rejected=f.bridge.start({id:'rejected-'+guard.pauseGeneration,action:'execute',args:f.args,continuationGuard:guard});assert.equal(rejected.started,false);assert.equal(rejected.rejected,'continuation-fence');assert.equal(rejected.writePerformed,false);assert.equal(rejected.uncertain,false);}
  assert.equal(f.appends,1);
});

test('a pause between the final status check and start is rejected atomically',async t=>{
  const f=await fixture(t),guard=initialGuard(f.bridge.status().continuationFence);f.bridge.pause();
  const rejected=f.bridge.start({id:'paused-before-submit',action:'execute',args:f.args,continuationGuard:guard});assert.equal(rejected.rejected,'continuation-fence');assert.equal(f.bridge.status().job,null);assert.equal(f.appends,0);
});

test('read-only commands preserve the pause latch and only an explicit ordinary execute resumes',async t=>{
  const f=await fixture(t);f.bridge.pause();f.bridge.start({id:'inspect-after-pause',action:'probe'});await terminal(f.bridge);
  const fence=f.bridge.status().continuationFence;assert.equal(fence.paused,true);assert.equal(fence.pauseGeneration,1);
  assert.equal(f.bridge.start({id:'automatic-after-inspection',action:'execute',args:f.args,continuationGuard:initialGuard(fence)}).rejected,'continuation-fence');
  assert.equal(f.bridge.start({id:'manual-resume',action:'execute',args:f.args}).started,true);await terminal(f.bridge);assert.equal(f.bridge.status().continuationFence.paused,false);assert.equal(f.bridge.status().continuationFence.pauseGeneration,1);assert.equal(f.appends,1);
});

test('limit guards cannot use a read-only terminal or a completed batch as limit evidence',async t=>{
  const f=await fixture(t);f.bridge.start({id:'probe-only',action:'probe'});await terminal(f.bridge);assert.equal(f.bridge.start({id:'not-a-limit',action:'execute',args:f.args,continuationGuard:limitGuard(f.bridge.status().continuationFence)}).rejected,'continuation-fence');
  f.bridge.start({id:'complete-all',action:'execute',args:{...f.args,limit:2}});await terminal(f.bridge);assert.equal(f.bridge.start({id:'after-complete',action:'execute',args:f.args,continuationGuard:limitGuard(f.bridge.status().continuationFence)}).rejected,'continuation-fence');assert.equal(f.appends,2);
});

test('session forwards strict guards, exposes fences, and retains the accepted terminal proof',async t=>{
  const f=await fixture(t),session=await sessionFor(f),before=await session.status({connect:true}),guard=initialGuard(before.continuationFence);
  const first=await session.command({id:'guarded-first',action:'execute',args:f.args,continuationGuard:guard});assert.deepEqual(f.starts[0].continuationGuard,guard);
  assert.equal(first.error,undefined);await terminal(f.bridge);const completed=await session.status();assert.equal(completed.pending,null);assert.equal(completed.writeBlocked,false);assert.deepEqual(completed.last.continuationGuardAccepted,{...guard,bookId:BOOK,commandId:'guarded-first'});assert.equal(completed.continuationFence.previousTerminalId,'guarded-first');await session.close();
});

test('a typed atomic rejection withdraws only this new session intent and preserves the consumed id',async t=>{
  const f=await fixture(t),session=await sessionFor(f,{pauseOnStart:true}),before=await session.status({connect:true});
  const result=await session.command({id:'rejected-on-dispatch',action:'execute',args:f.args,continuationGuard:initialGuard(before.continuationFence)});
  assert.equal(result.rejected,'continuation-fence');assert.equal(result.pending,null);assert.equal(result.writeBlocked,false);assert.equal(result.blockedContext,null);assert.ok(session.state.seenIds.includes('rejected-on-dispatch'));assert.equal(f.appends,0);
  const saved=JSON.parse(await fs.readFile(session.statePath,'utf8'));assert.equal(saved.pending,null);assert.equal(saved.writeBlocked,false);await session.close();
});

test('an already changed fence or an old bridge is refused before dispatching any write intent',async t=>{
  for(const mode of ['paused','old-bridge'])await t.test(mode,async child=>{
    const f=await fixture(child),session=await sessionFor(f,{oldProtocol:mode==='old-bridge'});const before=await session.status({connect:true}),guard=initialGuard(f.bridge.status().continuationFence);if(mode==='paused')f.bridge.pause();
    await assert.rejects(session.command({id:'never-sent',action:'execute',args:f.args,continuationGuard:guard}),/未提交任务/u);assert.equal(f.starts.length,0);assert.equal(session.state.pending,null);assert.equal(session.state.writeBlocked,false);assert.equal(before.pending,null);await session.close();
  });
});

test('missing acceptance proof or a lost transport response keeps pending and the write lock',async t=>{
  for(const mode of ['missing-proof','lost-response'])await t.test(mode,async child=>{
    const f=await fixture(child),session=await sessionFor(f,{loseStart:mode==='lost-response',mutateStart:value=>{const result=copy(value);delete result.continuationGuardAccepted;return result;}});const before=await session.status({connect:true});
    const result=await session.command({id:'unknown-start',action:'execute',args:f.args,continuationGuard:initialGuard(before.continuationFence)});assert.ok(result.error);assert.equal(result.pending.id,'unknown-start');assert.equal(result.writeBlocked,true);assert.equal(f.starts.length,1);
    if(mode==='missing-proof')await terminal(f.bridge);
  });
});

test('a rejection with the wrong command identity cannot clear a pending write intent',async t=>{
  const f=await fixture(t),session=await sessionFor(f,{pauseOnStart:true,mutateStart:value=>({...value,id:'different-command'})});const before=await session.status({connect:true});
  const result=await session.command({id:'correct-command',action:'execute',args:f.args,continuationGuard:initialGuard(before.continuationFence)});assert.equal(result.pending.id,'correct-command');assert.equal(result.writeBlocked,true);assert.ok(result.error);assert.equal(f.appends,0);
});

test('missing terminal acceptance proof does not promote a guarded task to safe completion',async t=>{
  const f=await fixture(t),session=await sessionFor(f,{mutateStatus:value=>{if(value.job?.terminal)delete value.job.continuationGuardAccepted;return value;}});const before=await session.status({connect:true});
  await session.command({id:'terminal-proof-required',action:'execute',args:f.args,continuationGuard:initialGuard(before.continuationFence)});await terminal(f.bridge);const result=await session.status();assert.match(result.error,/终止结果缺少/u);assert.equal(result.pending.id,'terminal-proof-required');assert.equal(result.writeBlocked,true);
});

test('pause is persisted before bridge dispatch and synchronization does not increment it twice',async t=>{
  const f=await fixture(t);let session,observed;
  session=await sessionFor(f,{onPause:async payload=>{observed=JSON.parse(await fs.readFile(session.statePath,'utf8')).pauseControl;assert.equal(payload.pauseGeneration,1);}});
  const paused=await session.command({action:'pause'});assert.deepEqual(observed,{schemaVersion:1,generation:1,paused:true});assert.equal(paused.continuationFence.pauseGeneration,1);assert.equal(f.bridge.status().continuationFence.pauseGeneration,1);await session.close();
});

test('a lost pause response leaves the durable latch set both before and after bridge acceptance',async t=>{
  for(const losePauseResponse of ['before','after'])await t.test(losePauseResponse,async child=>{
    const f=await fixture(child),session=await sessionFor(f,{losePauseResponse});await session.status({connect:true});
    await assert.rejects(session.command({action:'pause'}),/pause result lost/u);const persisted=JSON.parse(await fs.readFile(session.statePath,'utf8'));assert.deepEqual(persisted.pauseControl,{schemaVersion:1,generation:1,paused:true});
    await session.command({id:'inspect-lost-pause',action:'probe'});await terminal(f.bridge);const inspected=await session.status();assert.equal(inspected.pauseControl.paused,true);
    await assert.rejects(session.command({id:'auto-after-lost-pause',action:'execute',args:f.args,continuationGuard:initialGuard(inspected.continuationFence,inspected.connectionCount)}),/未提交任务/u);assert.equal(f.appends,0);await session.close();
  });
});

test('read-only inspection after connection loss or service restart restores the durable pause into a new bridge',async t=>{
  for(const mode of ['reconnect','restart'])await t.test(mode,async child=>{
    const f=await fixture(child);let session=await sessionFor(f);await session.command({action:'pause'});
    if(mode==='restart'){await session.close();session=await sessionFor(f);}else await session.connection.close();
    await replaceBridge(f);assert.equal(f.bridge.status().continuationFence.paused,false);
    await session.command({id:'inspect-'+mode,action:'probe'});await terminal(f.bridge);const inspected=await session.status();assert.equal(inspected.connectionCount,2);assert.deepEqual(inspected.pauseControl,{schemaVersion:1,generation:1,paused:true});assert.equal(inspected.continuationFence.paused,true);assert.equal(f.bridge.status().continuationFence.pauseGeneration,1);
    await assert.rejects(session.command({id:'auto-'+mode,action:'execute',args:f.args,continuationGuard:initialGuard(inspected.continuationFence,inspected.connectionCount)}),/未提交任务/u);assert.equal(f.appends,0);assert.equal(session.state.pending,null);assert.equal(session.state.writeBlocked,false);await session.close();
  });
});

test('legacy sessions default to an unpaused generation zero and malformed pause state fails closed',async t=>{
  const f=await fixture(t),original=await sessionFor(f);await original.persist();const saved=JSON.parse(await fs.readFile(original.statePath,'utf8'));delete saved.pauseControl;await fs.writeFile(original.statePath,JSON.stringify(saved));
  const restored=await sessionFor(f);assert.deepEqual(restored.snapshot().pauseControl,{schemaVersion:1,generation:0,paused:false});for(const invalid of [null,{schemaVersion:1,generation:-1,paused:false}]){saved.pauseControl=invalid;await fs.writeFile(original.statePath,JSON.stringify(saved));await assert.rejects(sessionFor(f),/持久暂停控制无效/u);}
});

test('higher remote pause generations are persisted and synchronization never clears an existing latch',async t=>{
  const f=await fixture(t);f.bridge.pause({pauseGeneration:7});const session=await sessionFor(f),status=await session.status({connect:true});assert.deepEqual(status.pauseControl,{schemaVersion:1,generation:7,paused:true});
  f.bridge.syncPause({schemaVersion:1,generation:0,paused:false});assert.equal(f.bridge.status().continuationFence.paused,true);assert.equal(f.bridge.status().continuationFence.pauseGeneration,7);assert.deepEqual(JSON.parse(await fs.readFile(session.statePath,'utf8')).pauseControl,status.pauseControl);await session.close();
});

test('only an accepted ordinary execute at the same generation durably resumes a pause',async t=>{
  const f=await fixture(t),session=await sessionFor(f);await session.command({action:'pause'});await session.command({id:'explicit-resume',action:'execute',args:f.args});await terminal(f.bridge);const resumed=await session.status();
  assert.deepEqual(resumed.pauseControl,{schemaVersion:1,generation:1,paused:false});assert.deepEqual(resumed.last.pauseResumeAccepted,{schemaVersion:1,pauseGeneration:1,bookId:BOOK,commandId:'explicit-resume'});assert.deepEqual(JSON.parse(await fs.readFile(session.statePath,'utf8')).pauseControl,resumed.pauseControl);assert.equal(f.appends,1);await session.close();
});

test('a newer pause during an accepted ordinary start response cannot be cleared by the old acceptance',async t=>{
  const f=await fixture(t);let session;
  session=await sessionFor(f,{mutateStart:async value=>{if(value.started&&value.pauseResumeAccepted)await session.command({action:'pause'});return value;}});await session.command({action:'pause'});
  await session.command({id:'resume-before-new-pause',action:'execute',args:f.args});await terminal(f.bridge);const status=await session.status();assert.deepEqual(status.pauseControl,{schemaVersion:1,generation:2,paused:true});assert.equal(status.last.pauseResumeAccepted.pauseGeneration,1);assert.deepEqual(JSON.parse(await fs.readFile(session.statePath,'utf8')).pauseControl,status.pauseControl);await session.close();
});

test('a pause received during local review invalidates an ordinary execute already in preparation',async t=>{
  const f=await fixture(t),session=await sessionFor(f);await session.status({connect:true});let entered,release;const enteredPromise=new Promise(resolve=>entered=resolve),wait=new Promise(resolve=>release=resolve),review=session.reviewedContext.bind(session);
  session.reviewedContext=async args=>{entered();await wait;return review(args);};const submitting=session.command({id:'review-before-new-pause',action:'execute',args:f.args});await enteredPromise;await session.command({action:'pause'});release();const rejected=await submitting;
  assert.equal(rejected.rejected,'pause-fence');assert.equal(rejected.pending,null);assert.equal(rejected.writeBlocked,false);assert.deepEqual(rejected.pauseControl,{schemaVersion:1,generation:1,paused:true});assert.equal(f.starts.length,0);assert.equal(f.appends,0);await session.close();
});

test('a pause immediately before ordinary bridge acceptance returns proven no-start without retaining a write intent',async t=>{
  const f=await fixture(t),session=await sessionFor(f,{pauseOnStart:true});await session.status({connect:true});const rejected=await session.command({id:'resume-with-racing-pause',action:'execute',args:f.args});
  assert.equal(rejected.rejected,'pause-fence');assert.equal(rejected.pending,null);assert.equal(rejected.writeBlocked,false);assert.equal(rejected.pauseControl.paused,true);assert.equal(f.appends,0);await session.close();
});

test('a guarded dispatch refuses a connection changed after its last status check before any write',async t=>{
  const f=await fixture(t),session=await sessionFor(f),before=await session.status({connect:true}),persist=session.persist.bind(session);let reconnect=true;
  session.persist=async()=>{await persist();if(reconnect&&session.state.pending?.id==='guard-before-reconnect'){reconnect=false;await session.connection.close();await replaceBridge(f);}};
  const rejected=await session.command({id:'guard-before-reconnect',action:'execute',args:f.args,continuationGuard:initialGuard(before.continuationFence,before.connectionCount)});
  assert.equal(rejected.rejected,'continuation-fence');assert.equal(rejected.connectionCount,2);assert.equal(rejected.pending,null);assert.equal(rejected.writeBlocked,false);assert.equal(f.starts.length,0);assert.equal(f.appends,0);await session.close();
});
