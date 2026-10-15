import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {PersistentRecorderSession} from '../src/persistent-recorder-session.mjs';
import {installPersistentBridge} from '../src/persistent-recorder-bridge.mjs';
import {createNewSystemRun} from '../src/new-system-core.mjs';
import {recorderBookUrl} from '../src/recorder-config.mjs';

const BOOK=101,sha=value=>createHash('sha256').update(value).digest('hex');
const defer=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function manifest(){return {schemaVersion:1,kind:'new-system-batch',bookId:BOOK,source:'production',tasks:[1,2].map(record=>({id:'synthetic-'+record,target:{chapterLabel:'合成章',sectionLabel:'合成节',record},source:{pages:[1],answerPages:[9]},stem:{blocks:[{type:'text',text:'求甲乙两量的和。'+record}]},answer:{blocks:[{type:'text',parts:['2','3']}]},answerRequirement:{kind:'question',evidence:'求甲乙两量的和。'},answerStatus:'provided',review:{status:'approved',issues:[],checks:{sourceText:true,answerMatch:true,wholeQuestion:true,format:true}}})),coverage:{pages:[{page:1,candidates:[1,2].map(record=>({id:'candidate-'+record,type:'question',decision:'include',taskIds:['synthetic-'+record]}))}]}};}
async function fixture(t,{unknown=false,terminal=true}={}){
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'recorder-status-terminal-')),root=await fs.realpath(temporary),remote=defer();
  const value=manifest(),manifestPath=path.join(root,'data/batch.json'),statePath=path.join(root,'data/run.json'),pendingPath=path.join(root,'data/intent.json');
  await fs.mkdir(path.dirname(manifestPath),{recursive:true});const manifestBytes=JSON.stringify(value);await fs.writeFile(manifestPath,manifestBytes);
  const session=new PersistentRecorderSession({root,bookId:BOOK,focusMode:'foreground',statusTimeoutMs:20,alive:()=>true});await session.initialize();
  const submitted=Date.now()-1000,at=offset=>new Date(submitted+offset).toISOString();
  const run=createNewSystemRun(value,{baseDir:path.dirname(manifestPath)});run.status='failed';run.updatedAt=at(500);Object.assign(run.tasks[0],{status:'failed',lastError:'回读失败: synthetic hidden'});
  if(unknown)Object.assign(run.tasks[0],{attempts:1,recoveryRequired:true,lastError:'synthetic save result unknown'});
  await fs.writeFile(statePath,JSON.stringify(run));await fs.writeFile(pendingPath,JSON.stringify({schemaVersion:1,bookId:BOOK,task:value.tasks[0],status:'pending'}));
  const pending={id:'synthetic-command',action:'execute',args:{manifest:'data/batch.json',state:'data/run.json'},servicePid:60001,at:at(0)};
  const job={id:pending.id,action:'execute',bookId:BOOK,servicePid:pending.servicePid,running:false,terminal:true,startedAt:at(100),finishedAt:at(700),result:{bookId:BOOK,manifestPath,statePath,stateStatus:'failed',uncertain:unknown,pendingWrite:unknown?{task:{id:value.tasks[0].id},evidencePath:pendingPath}:null,writePerformed:true}};
  const jobPath=path.join(root,'data/persistent-executor/jobs',pending.id,'job-result.json');await fs.mkdir(path.dirname(jobPath),{recursive:true});
  const writeJob=async()=>{const temp=jobPath+'.tmp';await fs.writeFile(temp,JSON.stringify(job));await fs.rename(temp,jobPath);};if(terminal)await writeJob();
  Object.assign(session.state,{pending,seenIds:[pending.id],writeBlocked:true,blockedContext:{manifest:manifestPath,state:statePath,manifestSha256:sha(manifestBytes),taskId:null,pendingPath:null},connectionCount:1,pauseControl:{schemaVersion:1,generation:5,paused:true}});
  session.connection={servicePid:60001,close:async()=>{}};session.binding=true;session.pageBindingId='synthetic-binding';session.bind=async()=>{};
  let statusCalls=0,starts=0;session.invokeBridge=async(action,payload)=>{if(action==='status'){statusCalls++;return remote.promise;}if(action==='start'){starts++;return {bookId:BOOK,id:payload.id,started:true};}throw new Error('unexpected fake action');};
  t.after(async()=>{remote.resolve({bookId:BOOK,job:null});await delay(5);assert.equal(path.dirname(temporary),path.resolve(os.tmpdir()));assert.ok(path.basename(temporary).startsWith('recorder-status-terminal-'));await fs.rm(temporary,{recursive:true,force:true});});
  return {root,session,value,run,pending,job,jobPath,manifestPath,statePath,pendingPath,remote,writeJob,get statusCalls(){return statusCalls;},get starts(){return starts;}};
}

test('a hung status closes only a bound zero-attempt initial-read failure and preserves pause',async t=>{
  const f=await fixture(t),before=await fs.readFile(f.statePath),began=Date.now(),result=await f.session.status();
  assert.ok(Date.now()-began<1000);assert.equal(result.statusSource,'local-terminal');assert.equal(result.pending,null);assert.equal(result.writeBlocked,false);
  assert.deepEqual(result.pauseControl,{schemaVersion:1,generation:5,paused:true});assert.equal(result.last.result.noWriteProof.kind,'terminated-before-append');
  assert.equal(result.last.result.noWriteProof.commandId,f.pending.id);assert.equal(result.last.localTerminalProof.jobSha256,sha(await fs.readFile(f.jobPath)));
  assert.deepEqual(await fs.readFile(f.statePath),before);assert.equal(f.statusCalls,1);assert.equal(f.starts,0);
});

const invalidCases={
  'missing terminal file':async f=>fs.unlink(f.jobPath),
  'different command':async f=>{f.job.id='different-command';await f.writeJob();},
  'different action':async f=>{f.job.action='verify';await f.writeJob();},
  'different book':async f=>{f.job.result.bookId=BOOK+1;await f.writeJob();},
  'different child':async f=>{f.job.servicePid++;await f.writeJob();},
  'unfinished job':async f=>{f.job.running=true;await f.writeJob();},
  'invalid timestamp':async f=>{f.job.finishedAt='invalid';await f.writeJob();},
  'start before submission':async f=>{f.job.startedAt=new Date(Date.parse(f.pending.at)-1).toISOString();await f.writeJob();},
  'state newer than terminal':async f=>{f.run.updatedAt=new Date(Date.parse(f.job.finishedAt)+1).toISOString();await fs.writeFile(f.statePath,JSON.stringify(f.run));},
  'different result paths':async f=>{f.job.result.statePath=f.manifestPath;await f.writeJob();},
  'changed approved bytes':async f=>fs.writeFile(f.manifestPath,JSON.stringify(f.value,null,2)),
  'changed run hash':async f=>{f.run.manifestHash='0'.repeat(64);await fs.writeFile(f.statePath,JSON.stringify(f.run));},
  'reordered tasks':async f=>{f.run.tasks.reverse();await fs.writeFile(f.statePath,JSON.stringify(f.run));},
  'missing continuation acceptance':async f=>{f.pending.continuationGuard={previousTerminalId:null,pauseGeneration:5,connectionCount:1,phase:'initial'};},
};
for(const [name,alter] of Object.entries(invalidCases))test('local terminal refuses '+name,async t=>{
  const f=await fixture(t);await alter(f);const result=await f.session.status();assert.ok(result.localTerminalError);assert.equal(result.pending.id,f.pending.id);assert.equal(result.writeBlocked,true);assert.equal(f.starts,0);
});

test('unknown save local terminal retires the command but retains the exact official recovery lock',async t=>{
  const f=await fixture(t,{unknown:true}),result=await f.session.status();assert.equal(result.pending,null);assert.equal(result.writeBlocked,true);
  assert.equal(result.blockedContext.taskId,'synthetic-1');assert.equal(result.blockedContext.pendingPath,f.pendingPath);assert.equal(result.last.result.noWriteProof,undefined);
  await assert.rejects(f.session.command({action:'execute',args:f.pending.args}),/原远端状态|写入锁/u);assert.equal(f.starts,0);
});
test('a generic write label or uncertain result cannot prove zero writes',async t=>{
  const f=await fixture(t);f.job.result.uncertain=true;await f.writeJob();const result=await f.session.status();assert.equal(result.pending.id,f.pending.id);assert.equal(result.writeBlocked,true);assert.equal(result.last,null);
});
test('a receipt or one append attempt prevents the zero-write fallback',async t=>{
  for(const row of [{attempts:1},{receipt:{shitiID:1001}},{recoveryConfirmation:{kind:'synthetic'}}]){
    const f=await fixture(t);Object.assign(f.run.tasks[0],row);await fs.writeFile(f.statePath,JSON.stringify(f.run));const result=await f.session.status();assert.equal(result.pending.id,f.pending.id);assert.equal(result.writeBlocked,true);
  }
});
test('a late remote reply cannot overwrite a newer command or pause after local terminal',async t=>{
  const f=await fixture(t);await f.session.status();const newer={id:'newer-read',action:'probe',args:{},servicePid:60001,at:new Date().toISOString()};
  f.session.state.pending=newer;f.session.state.last={id:'newer-last'};f.session.state.pauseControl={schemaVersion:1,generation:6,paused:true};
  f.remote.resolve({bookId:BOOK,job:f.job,continuationFence:{schemaVersion:1,previousTerminalId:f.pending.id,pauseGeneration:0,paused:false}});await delay(5);
  assert.equal(f.session.state.pending,newer);assert.equal(f.session.state.last.id,'newer-last');assert.equal(f.session.state.pauseControl.generation,6);assert.equal(f.session.state.pauseControl.paused,true);
});
test('timed-out status is not submitted again and no new writer enters its transport queue',async t=>{
  const f=await fixture(t);await f.session.status();await f.session.status();assert.equal(f.statusCalls,1);
  await assert.rejects(f.session.command({id:'new-write',action:'execute',args:f.pending.args}),/原远端状态/u);assert.equal(f.starts,0);
  f.remote.resolve({bookId:BOOK,job:f.job});await delay(5);assert.equal(f.session.statusOperation,null);
});
test('a later SDK timeout does not prove the server status settled or release the writer barrier',async t=>{
  const f=await fixture(t),sdk=defer();f.session.invokeBridge=async()=>{await sdk.promise;throw new Error('MCP SDK request timed out');};
  await f.session.status();sdk.resolve();await delay(5);assert.equal(f.session.statusOperation.expired,true);
  await assert.rejects(f.session.command({id:'after-sdk-timeout',action:'execute',args:f.pending.args}),/原远端状态/u);assert.equal(f.starts,0);
});
test('a dispatched transport error before the deadline also retains the writer barrier',async t=>{
  const f=await fixture(t);f.session.invokeBridge=async()=>{throw new Error('SDK connection response lost');};
  const result=await f.session.status();assert.ok(result.error);assert.equal(f.session.statusOperation.expired,true);
  f.session.state.pending=null;await assert.rejects(f.session.command({id:'after-early-error',action:'execute',args:f.pending.args}),/原远端状态/u);assert.equal(f.starts,0);
});

const completedErrors={
  'MCP tool error':{isError:true,content:[{type:'text',text:'synthetic completed tool error'}]},
  'unparseable bridge response':{content:[{type:'text',text:'synthetic non-JSON response'}]},
  'wrong book bridge response':{structuredContent:{bookId:BOOK+1,job:null}},
};
for(const [name,response] of Object.entries(completedErrors))test(name+' releases only its returned transport barrier',async t=>{
  const f=await fixture(t,{unknown:true});f.session.invokeBridge=PersistentRecorderSession.prototype.invokeBridge.bind(f.session);
  f.session.connection.client={callTool:async()=>response};const pending=f.session.state.pending,blocked=structuredClone(f.session.state.blockedContext),pause=structuredClone(f.session.state.pauseControl);
  const result=await f.session.status();assert.ok(result.error);assert.equal(f.session.statusOperation,null);assert.equal(f.session.lastStatusRequest.state,'settled');assert.equal(f.session.lastStatusRequest.transportReturned,true);
  assert.equal(f.session.state.pending,pending);assert.equal(f.session.state.writeBlocked,true);assert.deepEqual(f.session.state.blockedContext,blocked);assert.deepEqual(f.session.state.pauseControl,pause);assert.equal(f.session.state.last,null);
});

test('a completed status tool error does not strand the next read-only command',async t=>{
  const f=await fixture(t);f.session.state.pending=null;f.session.state.writeBlocked=false;f.session.state.blockedContext=null;let calls=0,starts=0;
  f.session.invokeBridge=PersistentRecorderSession.prototype.invokeBridge.bind(f.session);
  f.session.connection.client={callTool:async request=>{calls++;if(calls===1)return completedErrors['MCP tool error'];if(request.arguments.code.includes('.start(')){starts++;return {structuredContent:{bookId:BOOK,id:'after-completed-error',started:true}};}return {structuredContent:{bookId:BOOK,job:null}};}};
  assert.ok((await f.session.status()).error);const result=await f.session.command({id:'after-completed-error',action:'probe',args:{}});assert.equal(starts,1);assert.equal(result.pending.id,'after-completed-error');assert.equal(f.session.statusOperation,null);
});

test('a late completed error releases only the original transport without merging newer state',async t=>{
  const f=await fixture(t),response=defer();f.session.invokeBridge=PersistentRecorderSession.prototype.invokeBridge.bind(f.session);f.session.connection.client={callTool:async()=>response.promise};
  await f.session.status();const newer={id:'newer-local',action:'probe',args:{},servicePid:60001,at:new Date().toISOString()};f.session.state.pending=newer;f.session.state.last={id:'newer-last'};f.session.state.pauseControl={schemaVersion:1,generation:6,paused:true};
  response.resolve(completedErrors['MCP tool error']);await delay(5);assert.equal(f.session.statusOperation,null);assert.equal(f.session.state.pending,newer);assert.equal(f.session.state.last.id,'newer-last');assert.equal(f.session.state.pauseControl.generation,6);assert.equal(f.session.state.writeBlocked,false);
});

test('a completed reply from a changed transport identity cannot release the original barrier',async t=>{
  for(const change of [session=>{session.connection={servicePid:60002};},session=>{session.state.connectionCount++;},session=>{session.pageBindingId='different-binding';}]){
    const f=await fixture(t),response=defer();f.session.invokeBridge=PersistentRecorderSession.prototype.invokeBridge.bind(f.session);f.session.connection.client={callTool:async()=>response.promise};
    await f.session.status();change(f.session);response.resolve(completedErrors['unparseable bridge response']);await delay(5);assert.equal(f.session.statusOperation.expired,true);assert.equal(f.session.statusOperation.transportReturned,undefined);assert.equal(f.starts,0);
  }
});

test('an SDK rejection still blocks when the real call path receives no completed response',async t=>{
  const f=await fixture(t);f.session.invokeBridge=PersistentRecorderSession.prototype.invokeBridge.bind(f.session);f.session.connection.client={callTool:async()=>{throw new Error('synthetic SDK timeout');}};
  assert.ok((await f.session.status()).error);assert.equal(f.session.statusOperation.expired,true);assert.equal(f.session.statusOperation.transportReturned,undefined);assert.equal(f.session.state.writeBlocked,true);
});

test('status diagnostics are a pure allowlisted snapshot',async t=>{
  const f=await fixture(t);f.session.statusOperation={...f.session.statusIdentity(),expired:true,dispatched:true,startedMs:Date.now()-30,startedAt:new Date().toISOString(),privateResponse:'secret raw response',controlKey:'secret key'};
  const snapshot=f.session.snapshot();assert.equal(snapshot.statusRequest.state,'blocked');assert.equal(snapshot.statusRequest.servicePid,60001);assert.equal(snapshot.statusRequest.transportReturned,false);assert.equal(f.statusCalls,0);assert.doesNotMatch(JSON.stringify(snapshot.statusRequest),/secret|bindingId|privateResponse|controlKey/u);
});
test('a stale reply from another connection cannot release an expired transport barrier',async t=>{
  const f=await fixture(t);await f.session.status();f.session.connection={servicePid:60002};f.remote.resolve({bookId:BOOK,job:f.job});await delay(5);
  assert.equal(f.session.statusOperation.expired,true);await assert.rejects(f.session.command({action:'execute',args:f.pending.args}),/原远端状态/u);assert.equal(f.starts,0);
});
test('close sends no cleanup or transport close until the blocked owned child is confirmed dead',async t=>{
  const f=await fixture(t);await f.session.status();let closed=0,cleaned=0;f.session.connection.close=async()=>{closed++;};f.session.cleanupOwnedTab=async()=>{cleaned++;};
  await assert.rejects(f.session.close(),/原远端状态未确认结束/u);assert.equal(closed,0);assert.equal(cleaned,0);
  f.session.alive=()=>false;f.session.dead=true;assert.equal((await f.session.close()).closed,true);assert.equal(closed,1);
});
test('cold-connect timeout refuses unknown PID cleanup and records a later established owned connection',async t=>{
  const f=await fixture(t),connecting=defer();let cleaned=0,closed=0;f.session.state.pending=null;f.session.connection=null;f.session.alive=pid=>Number.isSafeInteger(pid);
  f.session.cleanupOwnedTab=async()=>{cleaned++;};f.session.connect=async()=>{await connecting.promise;f.session.connection={servicePid:60002,close:async()=>{closed++;}};f.session.state.connectionCount++;f.session.pageBindingId='cold-binding';};
  await f.session.status({connect:true});assert.equal(f.session.statusOperation.connection,null);await assert.rejects(f.session.close(),/原远端状态未确认结束/u);assert.equal(cleaned,0);assert.equal(closed,0);
  connecting.resolve();await delay(5);assert.equal(f.session.statusOperation.connection,f.session.connection);assert.equal(f.session.statusOperation.connection.servicePid,60002);
  await assert.rejects(f.session.close(),/原远端状态未确认结束/u);assert.equal(cleaned,0);f.session.alive=()=>false;assert.equal((await f.session.close()).closed,true);assert.equal(closed,1);
});
test('a retained status barrier permits only a confirmed dead original child and a new connection',async t=>{
  const f=await fixture(t);await f.session.status();f.session.alive=()=>false;f.session.dead=true;
  f.session.bind=async()=>{if(!f.session.dead)return;f.session.connection={servicePid:60002};f.session.dead=false;f.session.state.connectionCount++;f.session.pageBindingId='new-binding';};
  f.session.invokeBridge=async()=>({bookId:BOOK,job:null});const result=await f.session.status({connect:false});assert.equal(result.connectionCount,2);assert.equal(f.session.statusOperation,null);assert.equal(f.starts,0);
});
test('a status timing out while a new command is prepared returns a typed no-start proof',async t=>{
  const f=await fixture(t);f.session.state.pending=null;f.session.state.writeBlocked=false;f.session.state.blockedContext=null;
  const review=f.session.reviewedContext.bind(f.session),reviewGate=defer(),reviewEntered=defer();f.session.reviewedContext=async args=>{reviewEntered.resolve();await reviewGate.promise;return review(args);};
  const status=f.session.status(),command=f.session.command({id:'raced-write',action:'execute',args:f.pending.args});await reviewEntered.promise;await status;reviewGate.resolve();
  const result=await command;assert.equal(result.rejected,'status-inflight');assert.equal(result.pending,null);assert.equal(result.writeBlocked,false);assert.equal(f.starts,0);
});
test('connection or pause changes while remote status waits suppress its terminal merge',async t=>{
  for(const change of [session=>{session.connection={servicePid:60002};},session=>{session.state.connectionCount++;},session=>{session.pageBindingId='changed';},session=>{session.state.pauseControl.generation++;}]){
    const f=await fixture(t),waiting=f.session.status();await delay(1);change(f.session);f.remote.resolve({bookId:BOOK,job:f.job});const result=await waiting;assert.equal(result.pending,f.pending);assert.equal(result.writeBlocked,true);assert.equal(result.last,null);
  }
});
test('dead-child proof finishing after status deadline cannot retire the pending command',async t=>{
  const f=await fixture(t,{terminal:false}),proof=defer(),entered=defer();f.session.alive=()=>false;f.session.connection.servicePid=60002;
  f.session.noWriteFailureProof=async()=>{entered.resolve();return proof.promise;};f.remote.resolve({bookId:BOOK,job:null});const waiting=f.session.status();await entered.promise;
  const result=await waiting;assert.equal(result.pending,f.pending);proof.resolve({kind:'terminated-before-append'});await delay(5);assert.equal(f.session.state.pending,f.pending);assert.equal(f.session.state.writeBlocked,true);
});
test('a previous task receipt does not label a new initial read as saved-record readback',async t=>{
  const f=await fixture(t),page={url:()=>recorderBookUrl(BOOK),bringToFront:async()=>{},evaluate:async()=>true};
  const adapter={source:'production',bookId:BOOK,connect:async()=>{},_pendingWrite:{task:{id:'previous-task'},receipt:{shitiID:1000}},read:async()=>{throw new Error('synthetic initial hidden');},append:async()=>{throw new Error('must not append');}};
  const bridge=await installPersistentBridge({page,config:{root:f.root,bookId:BOOK,focusMode:'foreground'},adapterFactory:()=>adapter});
  bridge.start({id:'phase-command',action:'execute',args:f.pending.args});const until=Date.now()+3000;let job;do{job=bridge.status().job;if(job?.terminal)break;await delay(5);}while(Date.now()<until);
  assert.equal(job.terminal,true);assert.ok(job.timings.some(row=>row.phase==='fresh-prewrite-read'&&row.taskId==='synthetic-1'));assert.ok(!job.timings.some(row=>row.phase==='saved-record-readback'));
  assert.equal(job.bookId,BOOK);assert.equal(job.servicePid,process.pid);
});
