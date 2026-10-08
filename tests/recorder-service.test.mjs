import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {validateRecorderConfig,loadRecorderConfig,validateRecorderCommand,assertRecorderPage,recorderBookUrl} from '../src/recorder-config.mjs';
import {PersistentRecorderSession} from '../src/persistent-recorder-session.mjs';
import {installPersistentBridge} from '../src/persistent-recorder-bridge.mjs';
import {expectedEditor,renderEditorHtml,createNewSystemRun} from '../src/new-system-core.mjs';
import {startRecorderService} from '../scripts/run-recorder-service.mjs';
import {runReviewedBatch} from '../scripts/run-reviewed-batch-service.mjs';

const BOOK=101,copy=structuredClone;
async function workspace(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'recorder-share-test-'));t.after(async()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('recorder-share-test-'));await fs.rm(root,{recursive:true,force:true});});return root;}
function manifest(){return {schemaVersion:1,kind:'new-system-batch',bookId:BOOK,source:'production',tasks:[1,2].map(record=>({id:'synthetic-'+record,target:{chapterLabel:'合成章',sectionLabel:'合成节',record},source:{pages:[1],answerPages:[9]},stem:{blocks:[{type:'text',text:'求甲乙两量的和。'+record}]},answer:{blocks:[{type:'text',parts:['2','3']}]},answerRequirement:{kind:'question',evidence:'求甲乙两量的和。'},answerStatus:'provided',review:{status:'approved',issues:[],checks:{sourceText:true,answerMatch:true,wholeQuestion:true,format:true}}})),coverage:{pages:[{page:1,candidates:[1,2].map(record=>({id:'candidate-'+record,type:'question',decision:'include',taskIds:['synthetic-'+record]}))}]}};}
async function putManifest(root,value=manifest()){await fs.mkdir(path.join(root,'data'),{recursive:true});await fs.writeFile(path.join(root,'data/batch.json'),JSON.stringify(value));return {manifest:'data/batch.json',state:'data/run.json'};}
async function fakeSession(t,{handleStart,failTransport=false}={}){
  const root=await workspace(t),args=await putManifest(root),starts=[],connections=[];let job=null,live=new Set(),connects=0;
  const connect=async()=>{connects++;const callbacks=[];const servicePid=60000+connects;live.add(servicePid);const connection={servicePid,authConfigured:true,onClosed:fn=>callbacks.push(fn),disconnect:()=>callbacks.forEach(fn=>fn()),close:async()=>{live.delete(servicePid);callbacks.forEach(fn=>fn());},client:{listTools:async()=>({tools:[{name:'browser_tabs',inputSchema:{properties:{action:{enum:['list','select']}}}},{name:'browser_run_code_unsafe',inputSchema:{properties:{code:{type:'string'}}}}]}),callTool:async({name,arguments:input})=>{
    if(name==='browser_tabs')return {structuredContent:input.action==='list'?{tabs:[{index:0,url:recorderBookUrl(BOOK)}]}:{bookId:BOOK}};
    const match=input.code.match(/page\.__persistentRecorder\.(\w+)\((.*)\); \}/u);assert.ok(match);if(match[1]==='status')return {structuredContent:{bookId:BOOK,job:copy(job)}};if(match[1]==='pause')return {structuredContent:{bookId:BOOK,stopRequested:true}};
    const command=JSON.parse(match[2]);starts.push(command);if(failTransport)throw new Error('transport result lost');job={id:command.id,action:command.action,running:true,terminal:false};const result=handleStart?await handleStart(command,root):{bookId:BOOK,uncertain:false};if(result!==undefined)job={...job,running:false,terminal:true,result};return {structuredContent:{bookId:BOOK,id:command.id,started:true}};
  }}};connections.push(connection);return connection;};
  const session=new PersistentRecorderSession({root,bookId:BOOK,connect,alive:pid=>live.has(pid),resolveAuth:async()=>({authConfigured:true})});await session.initialize();return {root,args,session,starts,connections,get connects(){return connects;},setJob:value=>{job=value;}};
}

test('bookId is required; fixed origin and default browser-command are enforced',()=>{
  assert.throws(()=>validateRecorderConfig({}));assert.throws(()=>new PersistentRecorderSession({root:process.cwd()}));
  assert.deepEqual(validateRecorderConfig({bookId:BOOK}),{schemaVersion:1,bookId:BOOK,port:8789,origin:'https://easylearn.baidu.com',inputMode:'browser-command'});
  for(const value of [{bookId:BOOK,origin:'https://example.com'},{bookId:BOOK,inputMode:'native-paste'},{bookId:BOOK,port:0}])assert.throws(()=>validateRecorderConfig(value));
  assertRecorderPage(recorderBookUrl(BOOK),BOOK);assert.throws(()=>assertRecorderPage(recorderBookUrl(BOOK+1),BOOK));assert.throws(()=>assertRecorderPage(recorderBookUrl(BOOK)+'&textbookID='+BOOK,BOOK));
});
test('typed commands reject historical repairs, arbitrary script and escaped file paths',()=>{
  for(const command of [{action:'repair-existing'},{action:'execute',args:{manifest:'../batch.json'}},{action:'probe',args:{code:'save()'}},{action:'reconcile',args:{manifest:'data/batch.json'}}])assert.throws(()=>validateRecorderCommand(command,process.cwd()));
});
test('local review failure rejects execute before an MCP connection',async t=>{
  const fake=await fakeSession(t),bad=manifest();bad.tasks[0].answerRequirement=null;await putManifest(fake.root,bad);
  await assert.rejects(fake.session.command({action:'execute',args:fake.args}),/校验失败/u);assert.equal(fake.connects,0);assert.equal(fake.starts.length,0);await fake.session.close();
});
test('an unapproved batch stays available for local preview but cannot connect for execute',async t=>{
  const fake=await fakeSession(t),pending=manifest();pending.tasks[0].review.status='pending';await putManifest(fake.root,pending);
  await assert.rejects(fake.session.command({action:'execute',args:fake.args}),/校验失败/u);assert.equal(fake.connects,0);await fake.session.close();
});
test('one Client is kept after a business failure, and command IDs are consumed once',async t=>{
  const fake=await fakeSession(t,{handleStart:async()=>({bookId:BOOK,stateStatus:'failed',uncertain:false})});
  const result=await fake.session.command({id:'once',action:'execute',args:fake.args});assert.equal(result.writeBlocked,false);await fake.session.command({id:'probe-after',action:'probe'});assert.equal(fake.connects,1);
  await assert.rejects(fake.session.command({id:'once',action:'execute',args:fake.args}),/已使用/u);assert.equal(fake.starts.length,2);await fake.session.close();
});
test('unknown save is persisted across restart and another batch/task cannot unlock it',async t=>{
  const fake=await fakeSession(t,{handleStart:async command=>command.action==='execute'?{bookId:BOOK,uncertain:true,pendingWrite:{task:{id:'synthetic-1'},evidencePath:path.join(fake.root,'data/pending.json')}}:{bookId:BOOK,writePerformed:false}});
  const result=await fake.session.command({id:'unknown',action:'execute',args:fake.args});assert.equal(result.writeBlocked,true);
  await assert.rejects(fake.session.command({action:'execute',args:fake.args}),/写入锁/u);
  await assert.rejects(fake.session.command({action:'reconcile',args:{...fake.args,taskId:'synthetic-2'}}),/原失败/u);
  await fake.session.close();const restarted=new PersistentRecorderSession({root:fake.root,bookId:BOOK});await restarted.initialize();assert.equal(restarted.state.writeBlocked,true);assert.equal(restarted.state.blockedContext.taskId,'synthetic-1');await restarted.close();
});
test('a bound successful readonly reconciliation unlocks, incomplete proof does not',async t=>{
  let complete=false;const fake=await fakeSession(t,{handleStart:async(command,root)=>command.action==='execute'?{bookId:BOOK,uncertain:true,pendingWrite:{task:{id:'synthetic-1'}}}:{bookId:BOOK,taskId:'synthetic-1',manifestPath:path.join(root,'data/batch.json'),statePath:path.join(root,'data/run.json'),writePerformed:false,uncertain:false,recovery:{outcome:'saved',writeUnlocked:complete,taskId:'synthetic-1',bookId:BOOK,priorRecordsUnchanged:true,targetRecordUnique:true,fullContentCompared:true,recordId:1001}}});
  await fake.session.command({action:'execute',args:fake.args});await fake.session.command({action:'reconcile',args:{...fake.args,taskId:'synthetic-1'}});assert.equal(fake.session.state.writeBlocked,true);
  complete=true;await fake.session.command({action:'reconcile',args:{...fake.args,taskId:'synthetic-1'}});assert.equal(fake.session.state.writeBlocked,false);await fake.session.close();
});
test('transport timeout retains the exact pending command and never dispatches it again',async t=>{
  const fake=await fakeSession(t,{failTransport:true}),result=await fake.session.command({id:'lost-result',action:'execute',args:fake.args});assert.equal(result.writeBlocked,true);assert.equal(result.pending.id,'lost-result');
  await fake.session.status();assert.equal(fake.starts.length,1);await assert.rejects(fake.session.command({action:'execute',args:fake.args}),/尚未终止/u);await assert.rejects(fake.session.close(),/未确认终止/u);
  const restored=new PersistentRecorderSession({root:fake.root,bookId:BOOK});await restored.initialize();assert.equal(restored.state.pending.id,'lost-result');assert.equal(restored.state.writeBlocked,true);
  fake.setJob({id:'lost-result',terminal:true,result:{uncertain:true,pendingWrite:{task:{id:'synthetic-1'}}}});await fake.session.status();await fake.session.close();
});
test('reconnecting a dead reader keeps the old command ID and does not submit it again',async t=>{
  const fake=await fakeSession(t);await fake.session.command({id:'read-only',action:'probe'});fake.connections[0].disconnect();await fake.session.status();assert.equal(fake.connects,2);assert.equal(fake.starts.length,1);await fake.session.close();
});

async function terminal(bridge){const deadline=Date.now()+5000;while(Date.now()<deadline){const result=bridge.status();if(result.job?.terminal)return result.job;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('owned fake job did not finish');}
test('verify refreshes once per scope while preserving per-record content/image comparisons and timing',async t=>{
  const root=await workspace(t),value=manifest(),args=await putManifest(root,value),reads=[];const page={url:()=>recorderBookUrl(BOOK),bringToFront:async()=>{}};
  const active={source:'production',bookId:BOOK,_directoryKey:null,_directoryRecords:[1,2].map(seqIndex=>({seqIndex,shitiID:1000+seqIndex,nodeID:50,question:'synthetic',answer:'synthetic',mainPicNum:1,answerPicNum:9,haveAnswer:true})),_nodeID:50,connect:async()=>{},_scopeMatches:async()=>true,read:async(task,options)=>{reads.push({record:task.target.record,refresh:options.refresh});active._directoryKey=JSON.stringify([task.target.chapterLabel,task.target.sectionLabel]);return {status:'found',bookId:BOOK,target:task.target,count:2,recordId:1000+task.target.record,source:task.source,stem:{...expectedEditor(task.stem,root),html:renderEditorHtml(task.stem,root)},answer:{...expectedEditor(task.answer,root),html:renderEditorHtml(task.answer,root)}};},append:async()=>{throw new Error('verify must never append');}};
  const original=active.read,bridge=await installPersistentBridge({page,config:{root,bookId:BOOK},adapterFactory:()=>active});bridge.start({id:'owned-verify',action:'verify',args});const job=await terminal(bridge);
  assert.equal(job.error,undefined);assert.equal(job.result.stateStatus,'completed');assert.deepEqual(reads,[{record:1,refresh:true},{record:2,refresh:false}]);assert.equal(active.read,original);assert.ok(job.timings.some(row=>row.phase==='verify-record'&&row.elapsedMs>=0));
  const rows=(await fs.readFile(job.result.readbackEvidence,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(rows.length,2);assert.equal(rows[0].serverSnapshotAt,rows[1].serverSnapshotAt);assert.equal(rows[1].readback.answer.text,'2'+'\u00a0'.repeat(8)+'3');
});
test('local controller stays disconnected for GET status and rejects web-origin/control bypasses',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'recorder-share-test-'));await fs.mkdir(path.join(root,'config'));await fs.writeFile(path.join(root,'config/recorder.json'),JSON.stringify({bookId:BOOK}));assert.equal((await loadRecorderConfig(root)).bookId,BOOK);
  const service=await startRecorderService({root,port:0,connect:async()=>{throw new Error('This test must not connect a browser');},log:()=>{}});t.after(async()=>{await service.shutdown();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('recorder-share-test-'));await fs.rm(root,{recursive:true,force:true});});const control=JSON.parse(await fs.readFile(service.controlFile,'utf8')),url='http://127.0.0.1:'+control.port;
  assert.equal((await fetch(url+'/status')).status,403);
  const headers={'x-recorder-key':control.key};const response=await fetch(url+'/status',{headers});assert.equal(response.status,200);assert.equal((await response.json()).connection,'disconnected');
  assert.equal((await fetch(url+'/command',{method:'POST',headers:{...headers,'Content-Type':'application/json',Origin:'https://example.com'},body:JSON.stringify({action:'probe'})})).status,403);
  assert.equal((await fetch(url+'/command',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({action:'repair-existing'})})).status,409);
  assert.equal(service.session.connection,null);
});

async function configFile(root){await fs.mkdir(path.join(root,'config'),{recursive:true});await fs.writeFile(path.join(root,'config/recorder.json'),JSON.stringify({bookId:BOOK}));}
async function junction(root,relative,outside){const file=path.join(root,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.symlink(outside,file,process.platform==='win32'?'junction':'dir');}
test('session methods themselves reject an external runtime junction before reading or writing',async t=>{
  const root=await workspace(t),outside=await workspace(t);await fs.writeFile(path.join(outside,'session.json'),'outside sentinel, not JSON');await junction(root,'data/persistent-executor',outside);let connects=0;
  const session=new PersistentRecorderSession({root,bookId:BOOK,connect:async()=>{connects++;throw new Error('must not connect');}});
  await assert.rejects(session.initialize(),/项目|目录|链接/u);await assert.rejects(session.persist(),/项目|目录|链接/u);await assert.rejects(session.connect(),/项目|目录|链接/u);
  assert.equal(connects,0);assert.deepEqual(await fs.readdir(outside),['session.json']);assert.equal(await fs.readFile(path.join(outside,'session.json'),'utf8'),'outside sentinel, not JSON');
});
test('service refuses an external lock-directory junction without making a lease or controller',async t=>{
  const root=await workspace(t),outside=await workspace(t);await configFile(root);await fs.writeFile(path.join(outside,'sentinel.txt'),'preserve');await junction(root,'data/new-system-browser',outside);
  await assert.rejects(startRecorderService({root,port:0,connect:async()=>{throw new Error('must not connect');},log:()=>{}}),/项目|目录|链接/u);
  assert.deepEqual(await fs.readdir(outside),['sentinel.txt']);assert.equal(await fs.readFile(path.join(outside,'sentinel.txt'),'utf8'),'preserve');
});
test('bridge rejects an external adapter-recovery directory before adapter construction',async t=>{
  const root=await workspace(t),outside=await workspace(t);await junction(root,'data/persistent-executor/new-system-recovery',outside);let constructed=0;
  const page={url:()=>recorderBookUrl(BOOK),bringToFront:async()=>{}},bridge=await installPersistentBridge({page,config:{root,bookId:BOOK},adapterFactory:()=>{constructed++;throw new Error('must not construct');}});
  bridge.start({id:'recovery-junction',action:'probe'});const job=await terminal(bridge);assert.ok(job.error);assert.equal(constructed,0);assert.deepEqual(await fs.readdir(outside),[]);
});
test('an external per-job junction is refused by the atomic writer, independently of service entry',async t=>{
  const root=await workspace(t),outside=await workspace(t),args=await putManifest(root);await junction(root,'data/persistent-executor/jobs/atomic-junction',outside);let constructed=0;
  const page={url:()=>recorderBookUrl(BOOK),bringToFront:async()=>{}},bridge=await installPersistentBridge({page,config:{root,bookId:BOOK},adapterFactory:()=>{constructed++;throw new Error('must not construct');}});
  bridge.start({id:'atomic-junction',action:'verify',args});const job=await terminal(bridge);assert.ok(job.error);assert.ok(job.evidenceError);assert.equal(constructed,0);assert.deepEqual(await fs.readdir(outside),[]);
});
test('bounded stopped runs are successful supervision outcomes, with limit versus pause recorded',async t=>{
  for(const reason of ['limit','pause']){
    const root=await workspace(t),value=manifest();await configFile(root);await putManifest(root,value);const run=createNewSystemRun(value,{baseDir:root});run.status='stopped';run.tasks[0].status='skipped_existing';await fs.writeFile(path.join(root,'data/run.json'),JSON.stringify(run));
    const request=async(_root,command)=>({bookId:BOOK,pending:null,writeBlocked:false,connectionCount:1,last:{id:command.id,result:{stopReason:reason}},recovery:{required:false}});
    const result=await runReviewedBatch(['--manifest=data/batch.json','--state=data/run.json','--action=execute','--limit=1'],{root,request,log:()=>{}});
    assert.equal(result.ok,true);assert.equal(result.stoppedNormally,true);assert.equal(result.limitReached,reason==='limit');assert.equal(result.paused,reason==='pause');
  }
});
