import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {PersistentRecorderSession} from '../src/persistent-recorder-session.mjs';
import {installPersistentBridge} from '../src/persistent-recorder-bridge.mjs';
import {recorderCommandFingerprint,validateReadonlyTerminalJob} from '../src/recorder-terminal-evidence.mjs';
import {summarizeRecorderStatus} from '../src/recorder-status-summary.mjs';
import {recorderBookUrl} from '../src/recorder-config.mjs';

const BOOK=101,sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const defer=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const manifest=()=>({schemaVersion:1,kind:'new-system-batch',bookId:BOOK,source:'production',
  tasks:[{id:'synthetic-1',target:{chapterLabel:'合成章',sectionLabel:'合成节',record:1},source:{pages:[1],answerPages:[9]},
    stem:{blocks:[{type:'text',text:'求甲乙两量的和。'}]},answer:{blocks:[{type:'text',text:'2'}]},
    answerRequirement:{kind:'question',evidence:'求甲乙两量的和。'},answerStatus:'provided',
    review:{status:'approved',issues:[],checks:{sourceText:true,answerMatch:true,wholeQuestion:true,format:true}}}],
  coverage:{pages:[{page:1,candidates:[{id:'synthetic-candidate',type:'question',decision:'include',taskIds:['synthetic-1']}]}]}});

async function fixture(t,{action='probe',locked=false,error=false}={}){
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'recorder-readonly-terminal-')),root=await fs.realpath(temporary),remote=defer();
  const session=new PersistentRecorderSession({root,bookId:BOOK,statusTimeoutMs:15,alive:()=>true});await session.initialize();
  const manifestPath=path.join(root,'data/batch.json'),statePath=path.join(root,'data/run.json'),bytes=JSON.stringify(manifest());
  await fs.mkdir(path.dirname(manifestPath),{recursive:true});await fs.writeFile(manifestPath,bytes);
  const args=action==='probe'?{chapterLabel:'合成章',sectionLabel:'合成节',exportRecords:true}:action==='collect'?{from:1,to:2,output:'data/jobs/synthetic'}
    : {manifest:'data/batch.json',state:'data/run.json',...(['readback','reconcile'].includes(action)?{taskId:'synthetic-1'}:{limit:1})};
  const context={manifest:manifestPath,state:statePath,manifestSha256:sha(bytes)},submitted=Date.now()-1000,at=offset=>new Date(submitted+offset).toISOString();
  const pending={id:'synthetic-read',action,args,servicePid:60001,at:at(0),...(!['probe','collect'].includes(action)?{reviewContext:context}:{})};
  const job={id:pending.id,action,bookId:BOOK,servicePid:pending.servicePid,commandSha256:recorderCommandFingerprint(pending),running:false,terminal:true,
    startedAt:at(100),finishedAt:at(700),phase:'terminal',phaseTaskId:null,
    timings:[{phase:'fresh-readback',taskId:'synthetic-1',elapsedMs:321}],
    result:{bookId:BOOK,writePerformed:false,...(!['probe','collect'].includes(action)?{manifestPath,statePath}:{})}};
  if(['readback','reconcile'].includes(action))job.result.taskId='synthetic-1';
  if(action==='reconcile')job.result.recovery={outcome:'saved',writeUnlocked:true,taskId:'synthetic-1',bookId:BOOK,recordId:5001};
  if(error){job.error='synthetic readback failed';job.result={uncertain:false,pendingWrite:null};}
  const jobPath=path.join(root,'data/persistent-executor/jobs',pending.id,'job-result.json');await fs.mkdir(path.dirname(jobPath),{recursive:true});
  const writeJob=async()=>{const temp=jobPath+'.tmp';await fs.writeFile(temp,JSON.stringify(job));await fs.rename(temp,jobPath);};await writeJob();
  Object.assign(session.state,{pending,seenIds:[pending.id],writeBlocked:locked,blockedContext:locked?{...context,taskId:'synthetic-1',pendingPath:'data/intent.json'}:null,
    connectionCount:1,pauseControl:{schemaVersion:1,generation:4,paused:true}});
  session.connection={servicePid:60001};session.binding=true;session.pageBindingId='synthetic-binding';session.bind=async()=>{};
  let calls=0;session.invokeBridge=async()=>{calls++;return remote.promise;};
  t.after(async()=>{remote.resolve({bookId:BOOK,job:null});await delay(3);assert.equal(path.dirname(temporary),path.resolve(os.tmpdir()));assert.ok(path.basename(temporary).startsWith('recorder-readonly-terminal-'));await fs.rm(temporary,{recursive:true,force:true});});
  return {root,session,pending,job,jobPath,writeJob,remote,manifestPath,statePath,get calls(){return calls;}};
}

for(const action of ['probe','collect','verify','readback','reconcile'])test(action+' terminates from exact local evidence without another browser status',async t=>{
  const f=await fixture(t,{action,locked:action==='reconcile'}),before=structuredClone(f.session.state.blockedContext),result=await f.session.status();
  assert.equal(result.statusSource,'local-terminal');assert.equal(result.pending,null);assert.equal(result.last.localTerminalProof.kind,'bound-readonly-terminal');
  assert.equal(result.last.localTerminalProof.jobSha256,sha(await fs.readFile(f.jobPath)));
  if(f.pending.reviewContext){assert.equal(result.last.localTerminalProof.manifestSha256,f.pending.reviewContext.manifestSha256);assert.equal(result.last.localTerminalProof.manifestPath,f.manifestPath);assert.equal(result.last.localTerminalProof.statePath,f.statePath);}
  assert.deepEqual(result.pauseControl,{schemaVersion:1,generation:4,paused:true});assert.deepEqual(result.blockedContext,before);
  assert.equal(result.writeBlocked,action==='reconcile');assert.equal(f.calls,1);assert.equal(f.session.statusOperation.expired,true);
  await assert.rejects(f.session.command({id:'must-not-start',action:'probe',args:{}}),/原远端状态/u);assert.equal(f.calls,1);
  const summary=summarizeRecorderStatus(result);assert.equal(summary.statusSource,'local-terminal');
  assert.deepEqual(summary.job.terminalDiagnostic,{commandId:f.pending.id,action,statusSource:'local-terminal',phase:'fresh-readback',taskId:'synthetic-1',phaseElapsedMs:321,
    finishedAt:f.job.finishedAt,writeBlocked:action==='reconcile',transportBlocked:true});
  f.session.reviewedContext=async()=>{throw new Error('settled terminal must not be reviewed again');};
  const repeated=await f.session.status();assert.equal(repeated.statusSource,'local-terminal');assert.equal(repeated.error,undefined);assert.equal(repeated.pending,null);assert.equal(f.calls,1);
});

test('a terminal read-only failure is reported as failed while retaining the original recovery lock',async t=>{
  const f=await fixture(t,{action:'reconcile',locked:true,error:true}),blocked=structuredClone(f.session.state.blockedContext),result=await f.session.status();
  assert.equal(result.pending,null);assert.equal(result.last.error,'synthetic readback failed');assert.equal(result.writeBlocked,true);assert.deepEqual(result.blockedContext,blocked);
  const summary=summarizeRecorderStatus(result);assert.equal(summary.job.error,'synthetic readback failed');assert.equal(summary.job.terminalDiagnostic.phase,'fresh-readback');
});

const invalidCases={
  'missing command fingerprint':async f=>{delete f.job.commandSha256;await f.writeJob();},
  'different original scope':async f=>{f.pending.args.sectionLabel='另一合成节';},
  'different original task':async f=>{f.pending.args.taskId='synthetic-2';},
  'different book':async f=>{f.job.bookId++;await f.writeJob();},
  'different child':async f=>{f.job.servicePid++;await f.writeJob();},
  'different result book':async f=>{f.job.result.bookId++;await f.writeJob();},
  'claims a platform write':async f=>{f.job.result.writePerformed=true;await f.writeJob();},
  'different result task':async f=>{f.job.result.taskId='other';await f.writeJob();},
  'different result path':async f=>{f.job.result.statePath=f.manifestPath;await f.writeJob();},
  'missing dispatch review binding':async f=>{delete f.pending.reviewContext;},
  'changed frozen manifest':async f=>{await fs.writeFile(f.manifestPath,JSON.stringify(manifest(),null,2));},
  'unfinished evidence':async f=>{f.job.running=true;await f.writeJob();},
  'evidence failure':async f=>{f.job.evidenceError='not durable';await f.writeJob();},
  'finished before submission':async f=>{f.job.finishedAt=new Date(Date.parse(f.pending.at)-1).toISOString();await f.writeJob();},
};
for(const [name,alter] of Object.entries(invalidCases))test('read-only terminal refuses '+name,async t=>{
  const f=await fixture(t,{action:'reconcile',locked:true});await alter(f);const result=await f.session.status();
  assert.equal(result.pending.id,f.pending.id);assert.equal(result.writeBlocked,true);assert.ok(result.localTerminalError);assert.equal(result.last,null);
  assert.ok(summarizeRecorderStatus(result).localTerminalError);
});

test('changing manifest bytes during terminal evidence review cannot retire the command',async t=>{
  const f=await fixture(t,{action:'readback'}),review=f.session.reviewedContext.bind(f.session);
  f.session.reviewedContext=async args=>{const context=await review(args);await fs.appendFile(f.manifestPath,'\n');return context;};
  const result=await f.session.status();assert.equal(result.pending.id,f.pending.id);assert.ok(result.localTerminalError);
});

test('a late old response cannot overwrite the locally recorded terminal failure or pause',async t=>{
  const f=await fixture(t,{action:'readback',error:true});await f.session.status();const last=f.session.state.last;
  f.remote.resolve({bookId:BOOK,job:{...f.job,error:null},continuationFence:{schemaVersion:1,previousTerminalId:null,pauseGeneration:0,paused:false}});await delay(3);
  assert.equal(f.session.state.last,last);assert.equal(f.session.state.last.error,'synthetic readback failed');assert.equal(f.session.state.pauseControl.paused,true);
});

test('complete-record-repair remains outside the read-only terminal route',()=>{
  assert.throws(()=>validateReadonlyTerminalJob({}, {action:'complete-record-repair'} ,{bookId:BOOK}),/不支持只读/u);
});

test('bridge-produced read-only terminal evidence binds the exact original parameters',async t=>{
  const f=await fixture(t),page={url:()=>recorderBookUrl(BOOK)},adapter={connect:async()=>{},read:async()=>{},_directoryRecords:[]};
  const bridge=await installPersistentBridge({page,config:{root:f.root,bookId:BOOK,focusMode:'background'},adapterFactory:()=>adapter});
  const args={chapterLabel:'合成章',sectionLabel:'合成节'};bridge.start({id:'bridge-read',action:'probe',args});
  const until=Date.now()+3000;let job;do{job=bridge.status().job;if(job?.terminal)break;await delay(3);}while(Date.now()<until);
  assert.equal(job.terminal,true);assert.equal(job.commandSha256,recorderCommandFingerprint({action:'probe',args:{sectionLabel:'合成节',chapterLabel:'合成章'}}));
  const persisted=JSON.parse(await fs.readFile(path.join(f.root,'data/persistent-executor/jobs/bridge-read/job-result.json'),'utf8'));
  assert.equal(persisted.commandSha256,job.commandSha256);assert.equal(persisted.result.writePerformed,false);
});
