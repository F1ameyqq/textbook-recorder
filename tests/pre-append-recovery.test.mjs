import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {recoverPreAppendSourceFailure,validBeforePlusProof} from '../src/pre-append-recovery.mjs';
import {createNewSystemRun,reconcileNewSystemRun} from '../src/new-system-core.mjs';

async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'recorder-before-plus-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const dataDir=path.join(root,'data'),failureCommandId='11111111-1111-1111-1111-111111111111',baselineCommandId='22222222-2222-2222-2222-222222222222';
  const task={id:'approved',target:{chapterLabel:'chapter',sectionLabel:'section',record:2},source:{pages:[8],answerPages:[72]},stem:{blocks:[{type:'text',text:'question'}]},answer:{blocks:[{type:'text',text:'answer'}]},review:{status:'approved',issues:[]}};
  const manifest={schemaVersion:1,kind:'new-system-batch',bookId:100001,source:'fixture',tasks:[task]};
  const state=createNewSystemRun(manifest);Object.assign(state.tasks[0],{status:'failed',attempts:1,recoveryRequired:true,lastError:'写入未完成确认: [source-pages] timed out'});state.status='failed';
  const manifestPath=path.join(root,'manifest.json'),statePath=path.join(root,'state.json');const context={manifest,state,manifestPath,statePath};
  const records=[{seqIndex:1,shitiID:1,nodeID:4,question:'<p>old</p>',answer:'<p>old answer</p>',mainPicNum:8,answerPicNum:72,haveAnswer:true}];
  const baselinePath=path.join(dataDir,'jobs',baselineCommandId,'scope-records.json');
  const baseline={bookId:100001,chapterLabel:'chapter',sectionLabel:'section',nodeID:4,at:'2026-10-10T00:00:00Z',records};
  const failed={id:failureCommandId,action:'execute',terminal:true,startedAt:'2026-10-10T00:01:00Z',timings:[{phase:'append-ui',taskId:task.id}],result:{bookId:100001,statePath,manifestPath,stateStatus:'failed',pendingWrite:null,counts:{failed:1}}};
  const probe={id:baselineCommandId,action:'probe',terminal:true,result:{writePerformed:false,recordsPath:baselinePath}};
  const put=async(file,value)=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(value));};
  await put(manifestPath,manifest);await put(baselinePath,baseline);await put(path.join(dataDir,'jobs',failureCommandId,'job-result.json'),failed);
  await put(path.join(dataDir,'jobs',failureCommandId,'preflight.json'),{manifestPath,manifestSha256:createHash('sha256').update(await fs.readFile(manifestPath)).digest('hex'),valid:true,readyForExecution:true});
  await put(path.join(dataDir,'jobs',baselineCommandId,'job-result.json'),probe);
  const adapter={bookId:100001,_pendingWrite:null,_uncertain:false,_nodeID:4,_directoryRecords:structuredClone(records),read:async(value,options)=>{assert.equal(value,task);assert.equal(options.refresh,true);return {status:'missing',bookId:100001,target:structuredClone(task.target),count:1};}};
  const args={root,dataDir,context,task,failureCommandId,baselineCommandId,evidencePath:path.join(root,'evidence.json')};return {adapter,args,context,task,records,put,failed,baseline};
}
test('original before-Plus source failure is recovered only after a full unchanged fresh list; no save receipt invented',async t=>{
  const f=await fixture(t),result=await recoverPreAppendSourceFailure(f.adapter,f.args);
  assert.equal(result.recovery.liveNoSaveRequests,false);assert.equal(result.recovery.beforePlusFailure.noDraftCreated,true);
  assert.ok(validBeforePlusProof(result.recovery.beforePlusFailure,{bookId:100001,taskId:f.task.id,target:f.task.target,manifestHash:f.context.state.manifestHash}));
  const restored=reconcileNewSystemRun({manifest:f.context.manifest,state:f.context.state,taskId:f.task.id,recovery:result});
  assert.equal(restored.tasks[0].status,'pending');assert.equal(restored.tasks[0].attempts,0);assert.equal(restored.tasks[0].receipt,null);assert.ok(restored.tasks[0].recoveryHistory[0].beforePlusFailure);
});
for(const [name,mutate] of [
  ['post-Plus failure',f=>{f.context.state.tasks[0].lastError='写入未完成确认: [save-business-receipt] timed out';}],
  ['existing write intent',f=>{f.adapter._pendingWrite={created:false};}],
  ['unknown editing',f=>{f.adapter._uncertain=true;}],
  ['changed old answer',f=>{f.adapter._directoryRecords[0].answer='changed';}],
  ['existing saved receipt',f=>{f.context.state.tasks[0].receipt={shitiID:2};}],
])test(name+' cannot use pre-append recovery',async t=>{const f=await fixture(t);mutate(f);await assert.rejects(recoverPreAppendSourceFailure(f.adapter,f.args));await assert.rejects(fs.stat(f.args.evidencePath),{code:'ENOENT'});});
test('proof cannot be reused for another book, target or manifest',async t=>{const f=await fixture(t),result=await recoverPreAppendSourceFailure(f.adapter,f.args),proof=result.recovery.beforePlusFailure;for(const change of [{bookId:999},{taskId:'other'},{target:{...f.task.target,record:3}},{manifestHash:'a'.repeat(64)}])assert.equal(validBeforePlusProof(proof,{bookId:100001,taskId:f.task.id,target:f.task.target,manifestHash:f.context.state.manifestHash,...change}),false);});

async function answerFixture(t){
  const f=await fixture(t),pendingPath=path.join(f.args.root,'original.pending.json');
  const pending={kind:'new-system-append-recovery',status:'pending',bookId:100001,phase:'answer-native-paste-readback',created:true,observedSaveRequests:0,receipt:null,task:f.task,priorRecords:f.records};
  f.context.state.tasks[0].lastError='写入未完成确认: [answer-native-paste-readback] timed out';
  f.failed.result.pendingWrite={phase:pending.phase,task:{id:f.task.id},evidencePath:pendingPath};
  const update=async()=>{await f.put(pendingPath,pending);await f.put(path.join(f.args.dataDir,'jobs',f.args.failureCommandId,'job-result.json'),f.failed);};
  await update();return {...f,pending,update,args:{...f.args,pendingPath}};
}
test('answer-only draft failure before stem insertion retains an independent original-intent hash and no fabricated receipt',async t=>{
  const f=await answerFixture(t),result=await recoverPreAppendSourceFailure(f.adapter,f.args);
  assert.equal(result.recovery.beforePlusFailure.kind,'answer-only-draft-failed-before-stem-insertion');assert.equal(result.recovery.beforePlusFailure.noStemInsertionReached,true);
  assert.equal(result.recovery.liveNoSaveRequests,false);
  const restored=reconcileNewSystemRun({manifest:f.context.manifest,state:f.context.state,taskId:f.task.id,recovery:result});assert.equal(restored.tasks[0].status,'pending');assert.equal(restored.tasks[0].receipt,null);
});
for(const [name,change] of [
  ['stem insertion reached',p=>{p.phase='stem-native-paste-readback';}],
  ['save request observed',p=>{p.observedSaveRequests=1;}],
  ['save receipt exists',p=>{p.receipt={shitiID:2};}],
  ['task changed',p=>{p.task={...p.task,id:'other'};}],
])test(name+' refuses answer-only recovery',async t=>{const f=await answerFixture(t);change(f.pending);await f.update();await assert.rejects(recoverPreAppendSourceFailure(f.adapter,f.args));});
