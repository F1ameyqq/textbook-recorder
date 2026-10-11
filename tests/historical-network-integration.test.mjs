import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {HISTORICAL_Q61_PROFILE as pinned,validateHistoricalNetworkRecovery,validHistoricalNetworkRecoveryProof} from '../src/historical-network-recovery.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {NewSystemAdapter,readHistoricalNetworkEvidence} from '../src/new-system-adapter.mjs';
import {validateRecorderCommand,recorderBookUrl} from '../src/recorder-config.mjs';
import {installPersistentBridge} from '../src/persistent-recorder-bridge.mjs';
import {createNewSystemRun} from '../src/new-system-core.mjs';

const bytes=value=>Buffer.from(JSON.stringify(value));
const sha=value=>createHash('sha256').update(value).digest('hex');
const copy=structuredClone;
const base=Date.parse('2026-10-11T02:00:00Z');
const at=seconds=>new Date(base+seconds*1000).toISOString();
const rewrite=(f,key,change)=>{const value=JSON.parse(f.input[key]);change(value);f.input[key]=bytes(value);};

function fixture(){
  const profile=copy(pinned),bookId=profile.bookId;
  const task=(id,record,nodeID,mainPicNum,answerPicNum)=>({id,target:{chapterLabel:'专题五 句子',sectionLabel:nodeID===9909932?'必刷训练1 辨析病句':nodeID===9909933?'必刷训练2 修改病句':'必刷训练3 辨析并修改病句',record},source:{pages:[mainPicNum],answerPages:[answerPicNum]},stem:{blocks:[{type:'text',text:'Q'}]},answer:{blocks:[{type:'text',text:'A'}]},review:{status:'approved',issues:[]}});
  const previous=Array.from({length:6},(_,i)=>task('previous-'+i,i%4+1,9909931,13,74));
  const anchors=profile.anchorTaskIds.map((id,i)=>task(id,i<2?i+3:i<6?i-1:i-5,profile.anchorNodeIDs[i],i<2?14:i<6?15:i<11?16:17,i===0?74:i===13?76:75));
  const failedTask=task(profile.taskId,9,profile.nodeID,17,76);
  const anchorTimes=anchors.map((_,i)=>i<6?10+i*30:240+(i-6)*30);
  const receipt=(t,id,time)=>({bookId,seqIndex:t.target.record,shitiID:id,mainPicNum:t.source.pages[0],answerPicNum:t.source.answerPages[0],request:{bookId,seqIndex:t.target.record,mainPicNum:t.source.pages[0],answerPicNum:t.source.answerPages[0]},response:{status:200,body:{errno:0,errmsg:'success',data:{seqIndex:t.target.record,shitiID:id,haveAnswer:true}}},reloadReadback:{schemaVersion:1,kind:'new-system-reload-readback',taskId:t.id,bookId,recordId:id,checkedAt:at(time+6),readback:{status:'found',bookId,recordId:id,target:t.target,count:t.target.record,source:t.source,stem:{html:'<p>Q</p>'},answer:{html:'<p>A</p>'}}}});
  const completed=(t,id,time)=>({taskId:t.id,status:'completed',receipt:receipt(t,id,time),attempts:1,recoveryRequired:false,lastError:null});
  const records=(t,nodeID,ids)=>ids.map((id,i)=>({seqIndex:i+1,shitiID:id,nodeID,mainPicNum:t.source.pages[0],answerPicNum:t.source.answerPages[0],question:'<p>Q</p>',answer:'<p>A</p>',haveAnswer:true}));
  const state=(tasks,status)=>({schemaVersion:1,kind:'new-system-run',id:'fixture',bookId,source:'production',manifestHash:'a'.repeat(64),status,tasks});
  const priorManifest={schemaVersion:1,kind:'new-system-batch',bookId,source:'production',tasks:[...previous,...anchors.slice(0,6)]};
  const failedManifest={schemaVersion:1,kind:'new-system-batch',bookId,source:'production',tasks:[...anchors.slice(6),failedTask]};
  const priorState=state([...previous.map((t,i)=>completed(t,100+i,-120)),...anchors.slice(0,6).map((t,i)=>completed(t,profile.anchorRecordIds[i],anchorTimes[i]))],'completed');
  const failedState=state([...anchors.slice(6).map((t,i)=>completed(t,profile.anchorRecordIds[i+6],anchorTimes[i+6])),{taskId:failedTask.id,status:'failed',receipt:null,attempts:1,recoveryRequired:true,lastError:'写入未完成确认: [save-business-receipt] timeout'}],'failed');
  const pending={schemaVersion:1,kind:'new-system-append-recovery',status:'pending',bookId,nodeID:profile.nodeID,task:failedTask,priorRecords:records(anchors[6],profile.nodeID,profile.anchorRecordIds.slice(6)),phase:'save-business-receipt',created:true,observedSaveRequests:0,receipt:null,startedAt:at(481),evidencePath:'data/original.pending.json'};
  // Sources differ among the original eight; the exact baseline retains each.
  pending.priorRecords.forEach((r,i)=>{r.mainPicNum=anchors[i+6].source.pages[0];r.answerPicNum=anchors[i+6].source.answerPages[0];});
  const pendingAnchors=anchors.map((t,i)=>({schemaVersion:1,kind:'new-system-append-recovery',status:'completed',phase:'completed',created:true,bookId,nodeID:profile.anchorNodeIDs[i],task:t,priorRecords:records(t,profile.anchorNodeIDs[i],Array.from({length:t.target.record-1},(_,n)=>500+i*10+n)),observedSaveRequests:1,receipt:receipt(t,profile.anchorRecordIds[i],anchorTimes[i]),startedAt:at(anchorTimes[i]+1)}));
  const timings=(tasks,offset)=>tasks.map((t,i)=>({phase:'append-ui',taskId:t.id,startedAt:at(anchorTimes[i+offset]),finishedAt:at(anchorTimes[i+offset]+4)}));
  const makeBatch=(manifest,run,id,start,end,isPrior)=>{
    const manifestBytes=bytes(manifest),manifestPath=isPrior?'data/prior.json':'data/failed.json';
    const job={id,action:'execute',terminal:true,startedAt:at(start),finishedAt:at(end),timings:isPrior?timings(anchors.slice(0,6),0):[...timings(anchors.slice(6),6),{phase:'append-ui',taskId:failedTask.id,startedAt:at(480),finishedAt:at(500)}],result:{bookId,manifestPath,statePath:isPrior?'data/prior.state.json':'data/failed.state.json',stateStatus:run.status,uncertain:!isPrior,counts:isPrior?{completed:12}:{completed:8,failed:1},...(isPrior?{}:{pendingWrite:copy(pending)})}};
    return {jobBytes:bytes(job),preflightBytes:bytes({manifestPath,manifestSha256:sha(manifestBytes),valid:true,readyForExecution:true}),manifestBytes,stateBytes:bytes(run)};
  };
  const row=(index,seconds,pathname,save)=>({index,method:save?'POST':'GET',origin:'https://easylearn.baidu.com',pathname,resourceType:save?'xhr':'document',requestGuid:'request@'+index,frameGuid:profile.frameGuid,pageGuid:profile.pageGuid,timing:{startTime:base+seconds*1000,responseStart:10,responseEnd:20},hasResponse:true,status:200,failed:false,...(save?{save,postDataSha256:'b'.repeat(64),receiptUnavailable:true}:{})});
  const rows=[row(0,0.02,'/edu-shop-web/'),...anchors.map((t,i)=>row(i+1,anchorTimes[i]+2,'/edushop/textbook/myproducecommit/editshiti',{bookId,nodeID:profile.anchorNodeIDs[i],seqIndex:t.target.record,shitiID:null,mainPicNum:t.source.pages[0],answerPicNum:t.source.answerPages[0]})),row(15,602,'/edushop/textbook/detail/shitilist'),row(16,702,'/edushop/textbook/detail/shitilist')];
  const history={schemaVersion:1,kind:'existing-mcp-network-history',bookId,bindingId:profile.bindingId,pageGuid:profile.pageGuid,mcpPid:profile.mcpPid,originalServicePid:profile.servicePid,originalConnectionCount:profile.connectionCount,sdkVersion:profile.sdkVersion,coreSha256:profile.coreSha256,exportScriptSha256:profile.exportScriptSha256,capturedAt:at(800),finishedAt:at(801),pageUrl:'https://easylearn.baidu.com/edu-shop-web/#/content-manager/teaching-content?textbookID='+bookId,ledgerCount:rows.length,ledgerCountAfter:rows.length,tabObserverCount:1,crashed:false,consoleLogStartTime:base,pageBound:true,pageUnchanged:true,consoleLogStopped:false,recoveryAuthorizedByExport:false,bridgeJobId:'missing-read',rows};
  const lifetime={schemaVersion:1,kind:'original-mcp-tab-lifetime-inspection',inspectedAt:at(802),mcpPid:profile.mcpPid,pageGuid:profile.pageGuid,bindingId:profile.bindingId,pageClosed:false,pageCollected:false,connectionClosed:false,browserConnected:true,contextClosed:false,disposableCount:11,ownedRequestDisposableCount:1,ownedRequestEmitterMatches:true,ownedRequestListenerStillAttached:true,...profile.runtimeHashes,consoleLogStartTime:base,consoleLogStopped:false,crashed:false,ledgerCount:rows.length,saveRequests:14,bridgeJobId:'missing-read',bridgeRunning:false,historySha256:sha(bytes(history)),coreSha256:profile.coreSha256};
  const scope={chapterLabel:failedTask.target.chapterLabel,sectionLabel:failedTask.target.sectionLabel,nodeID:pending.nodeID,serverSnapshotAt:at(600),at:at(605),records:copy(pending.priorRecords)};
  const scopeJob={id:'scope-read',action:'verify',terminal:true,startedAt:at(599),finishedAt:at(606),result:{bookId,writePerformed:false,manifestPath:'data/failed.json',counts:{skipped_existing:8,pending:1}}};
  const readback={bookId,taskId:failedTask.id,serverSnapshotAt:at(700),at:at(705),readback:{status:'missing',bookId,target:failedTask.target,count:8,recordId:null}};
  const readbackJob={id:'missing-read',action:'readback',terminal:true,startedAt:at(699),finishedAt:at(706),result:{bookId,taskId:failedTask.id,status:'missing',writePerformed:false}};
  const input={historyBytes:bytes(history),lifetimeBytes:bytes(lifetime),priorBatch:makeBatch(priorManifest,priorState,profile.priorCommandId,0,180,true),failedBatch:makeBatch(failedManifest,failedState,profile.failureCommandId,230,501,false),pendingBytes:bytes(pending),anchorPendingBytes:pendingAnchors.map(bytes),freshScopeBytes:bytes({[JSON.stringify([scope.chapterLabel,scope.sectionLabel])]:scope}),freshScopeJobBytes:bytes(scopeJob),freshReadbackBytes:bytes(readback),freshReadbackJobBytes:bytes(readbackJob)};
  profile.priorManifestSha256=sha(input.priorBatch.manifestBytes);profile.manifestSha256=sha(input.failedBatch.manifestBytes);profile.historySha256=sha(input.historyBytes);profile.lifetimeSha256=sha(input.lifetimeBytes);
  profile.pendingSha256=sha(input.pendingBytes);profile.failedStateSha256=sha(input.failedBatch.stateBytes);profile.failedJobSha256=sha(input.failedBatch.jobBytes);
  return {input,profile};
}

// All documents and editor content here are synthetic; no platform is opened.
async function integration(t){
  const f=fixture(),root=await fs.mkdtemp(path.join(os.tmpdir(),'textbook-historical-integration-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const dataDir=path.join(root,'data/persistent-executor'),pendingPath=path.join(dataDir,'new-system-recovery/original.pending.json');
  const pending=JSON.parse(f.input.pendingBytes),failedJob=JSON.parse(f.input.failedBatch.jobBytes);
  pending.evidencePath=pendingPath;failedJob.result.pendingWrite.evidencePath=pendingPath;
  f.input.pendingBytes=bytes(pending);f.input.failedBatch.jobBytes=bytes(failedJob);
  f.profile.pendingSha256=sha(f.input.pendingBytes);f.profile.failedStateSha256=sha(f.input.failedBatch.stateBytes);f.profile.failedJobSha256=sha(f.input.failedBatch.jobBytes);
  const core=Buffer.from('synthetic SDK source'),sdk=bytes({version:f.profile.sdkVersion});
  f.profile.coreSha256=sha(core);
  for(const key of ['historyBytes','lifetimeBytes']){const value=JSON.parse(f.input[key]);value.coreSha256=f.profile.coreSha256;f.input[key]=bytes(value);}
  f.profile.historySha256=sha(f.input.historyBytes);
  const lifetime=JSON.parse(f.input.lifetimeBytes);lifetime.historySha256=f.profile.historySha256;f.input.lifetimeBytes=bytes(lifetime);f.profile.lifetimeSha256=sha(f.input.lifetimeBytes);
  const write=async(file,raw)=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,raw);};
  await write(path.join(root,'node_modules/playwright-core/lib/coreBundle.js'),core);await write(path.join(root,'node_modules/playwright-core/package.json'),sdk);
  const ref=async(name,raw)=>{const file=path.join(root,'data/frozen',name+'.json');await write(file,raw);return {path:path.relative(root,file),sha256:sha(raw)};};
  const batch=async(name,raw)=>Object.fromEntries(await Promise.all(Object.entries(raw).map(async([key,value])=>[key.replace('Bytes',''),await ref(name+'.'+key,value)])));
  const files={history:await ref('history',f.input.historyBytes),lifetime:await ref('lifetime',f.input.lifetimeBytes),priorBatch:await batch('prior',f.input.priorBatch),failedBatch:await batch('failed',f.input.failedBatch),pending:await ref('pending',f.input.pendingBytes),anchorPending:await Promise.all(f.input.anchorPendingBytes.map((raw,i)=>ref('anchor'+i,raw))),freshScope:await ref('scope',f.input.freshScopeBytes),freshScopeJob:await ref('scopeJob',f.input.freshScopeJobBytes),freshReadback:await ref('readback',f.input.freshReadbackBytes),freshReadbackJob:await ref('readbackJob',f.input.freshReadbackJobBytes)};
  const manifestPath=path.join(root,'data/original.manifest.json'),statePath=path.join(root,'data/original.state.json'),bundlePath=path.join(root,'data/frozen/bundle.json'),output=path.join(root,'data/recovery-output.json');
  await write(manifestPath,f.input.failedBatch.manifestBytes);await write(statePath,f.input.failedBatch.stateBytes);await write(pendingPath,f.input.pendingBytes);await write(bundlePath,bytes({schemaVersion:1,kind:'historical-network-recovery-evidence',files}));
  const browser=new EventEmitter();browser.isConnected=()=>true;const browserContext=new EventEmitter();browserContext.browser=()=>browser;
  const page=new EventEmitter();page.context=()=>browserContext;page.isClosed=()=>false;
  const adapter=new NewSystemAdapter({page,baseDir:root,dataDir,source:'fixture'});adapter.bookId=f.profile.bookId;adapter.guard=async()=>{};
  adapter.read=async(task,{refresh})=>{assert.equal(refresh,true);adapter._nodeID=pending.nodeID;adapter._directoryRecords=copy(pending.priorRecords);return {status:'missing',bookId:pending.bookId,target:copy(task.target),count:8};};
  const context={manifestPath,statePath,baseDir:root,manifest:JSON.parse(f.input.failedBatch.manifestBytes),state:JSON.parse(f.input.failedBatch.stateBytes)};
  const options={root,context,pendingPath,historicalNetworkEvidencePath:bundlePath,evidencePath:output,validatorProfile:f.profile,promote:async(_result,check)=>{check();return async()=>{};}};
  return {...f,root,files,adapter,page,browser,browserContext,context,options,output,pendingPath,bundlePath,task:pending.task,pending};
}
const save=()=>({method:()=> 'POST',url:()=> 'https://easylearn.baidu.com/edushop/textbook/myproducecommit/editshiti'});

test('historical route reads a hashed closed bundle and publishes only an independently qualified durable proof',async t=>{
  const f=await integration(t),before=f.page.listeners('request').length;let promoted=false;
  f.options.promote=async(result,check)=>{assert.equal(f.adapter._uncertain,true);assert.equal(result.recovery.liveNoSaveRequests,false);check();promoted=true;return async()=>{};};
  const result=await f.adapter.reconcileHistoricalNetwork(f.task,f.options);
  assert.equal(promoted,true);assert.equal(result.recovery.writeUnlocked,true);assert.equal(f.adapter._uncertain,false);
  assert.equal(result.recovery.historicalNetworkProof.observerLifetimeQualified,true);
  assert.equal(validHistoricalNetworkRecoveryProof(result.recovery.historicalNetworkProof,{bookId:f.profile.bookId,taskId:f.profile.taskId,profile:f.profile}),true);
  assert.equal(JSON.parse(await fs.readFile(f.pendingPath)).recovery.outcome,'not_saved');
  assert.equal(JSON.parse(await fs.readFile(f.output)).recovery.writeUnlocked,true);assert.equal(f.page.listeners('request').length,before);
});

for(const phase of ['read','pending-persist','core-checkpoint','audit-persist'])test('late SAVE at '+phase+' keeps unknown and never reports an unlock',async t=>{
  const f=await integration(t);let rollback=false,promoted=false;
  if(phase==='read'){const read=f.adapter.read;f.adapter.read=async(...args)=>{const result=await read(...args);f.page.emit('request',save());return result;};}
  if(phase==='pending-persist'){const persist=f.adapter._persistPendingWrite.bind(f.adapter);let once=true;f.adapter._persistPendingWrite=async(...args)=>{await persist(...args);if(once){once=false;f.page.emit('request',save());}};}
  f.options.promote=async(_result,check)=>{promoted=true;if(phase==='core-checkpoint'){f.page.emit('request',save());try{check();}catch(error){rollback=true;throw error;}}return async()=>{rollback=true;};};
  // A callback-triggered asynchronous request after its own return remains
  // observed while the result audit is being written.
  if(phase==='audit-persist')f.options.promote=async()=>{promoted=true;queueMicrotask(()=>f.page.emit('request',save()));return async()=>{rollback=true;};};
  await assert.rejects(f.adapter.reconcileHistoricalNetwork(f.task,f.options),/保存请求|观察改变/);
  assert.equal(f.adapter._uncertain,true);assert.equal(f.adapter._busy,false);
  if(phase!=='read'){assert.equal(JSON.parse(await fs.readFile(f.pendingPath)).recovery.outcome,'unknown');assert.equal(JSON.parse(await fs.readFile(f.output)).recovery.writeUnlocked,false);}
  if(['core-checkpoint','audit-persist'].includes(phase)){assert.equal(promoted,true);assert.equal(rollback,true);}
});

for(const [name,change] of [
  ['frozen raw hash',async f=>fs.appendFile(path.join(f.root,f.files.history.path),' ')],
  ['current original state',async f=>fs.appendFile(f.context.statePath,' ')],
  ['current original pending',async f=>fs.appendFile(f.pendingPath,' ')],
  ['actual SDK source',async f=>fs.appendFile(path.join(f.root,'node_modules/playwright-core/lib/coreBundle.js'),'changed')],
  ['actual SDK version',async f=>fs.writeFile(path.join(f.root,'node_modules/playwright-core/package.json'),bytes({version:'different'}))],
  ['missing lifetime',async f=>{const bundle=JSON.parse(await fs.readFile(f.bundlePath));delete bundle.files.lifetime;await fs.writeFile(f.bundlePath,bytes(bundle));}],
  ['out-of-root reference',async f=>{const bundle=JSON.parse(await fs.readFile(f.bundlePath));bundle.files.history.path='../outside.json';await fs.writeFile(f.bundlePath,bytes(bundle));}],
  ['existing live request count',async f=>{f.adapter._pendingWrite={...copy(f.pending),observedSaveRequests:1};}],
  ['known live receipt',async f=>{f.adapter._pendingWrite={...copy(f.pending),receipt:{shitiID:999}};}],
  ['changed full prior content',async f=>{const read=f.adapter.read;f.adapter.read=async(...args)=>{const result=await read(...args);f.adapter._directoryRecords[0].answer+='changed';return result;};}],
  ['browser disconnected during fresh read',async f=>{const read=f.adapter.read;f.adapter.read=async(...args)=>{const result=await read(...args);f.browser.emit('disconnected');return result;};}],
])test('historical route rejects '+name,async t=>{
  const f=await integration(t);let promoted=false;f.options.promote=async()=>{promoted=true;return async()=>{};};await change(f);
  await assert.rejects(f.adapter.reconcileHistoricalNetwork(f.task,f.options));assert.equal(promoted,false);assert.equal(f.adapter._uncertain,true);
});

test('original state changes during refresh fail before a program checkpoint',async t=>{
  const f=await integration(t),read=f.adapter.read;f.adapter.read=async(...args)=>{const result=await read(...args);await fs.appendFile(f.context.statePath,' ');return result;};
  await assert.rejects(f.adapter.reconcileHistoricalNetwork(f.task,f.options),/已改变/);
});

test('a state edit during pending persistence cannot be overwritten by a stale program checkpoint',async t=>{
  const f=await integration(t),persist=f.adapter._persistPendingWrite.bind(f.adapter);let changed=false,promoted=false;
  f.adapter._persistPendingWrite=async(...args)=>{await persist(...args);if(!changed){changed=true;await fs.appendFile(f.context.statePath,' ');}};
  f.options.promote=async()=>{promoted=true;return async()=>{};};
  await assert.rejects(f.adapter.reconcileHistoricalNetwork(f.task,f.options),/已改变/);assert.equal(promoted,false);assert.equal(f.adapter._uncertain,true);
});

test('bridge durable state check restores the original failed task when a SAVE arrives during its atomic checkpoint',async t=>{
  const f=await integration(t),target=copy(pinned.target),manifest={schemaVersion:1,kind:'new-system-batch',bookId:pinned.bookId,source:'production',tasks:Array.from({length:9},(_,i)=>({id:i===8?pinned.taskId:'synthetic-'+i,target:{...target,record:i+1},source:copy(pinned.source),stem:{blocks:[{type:'text',text:'求甲乙两量的和。'+i}]},answer:{blocks:[{type:'text',text:'2'}]},answerRequirement:{kind:'question',evidence:'求甲乙两量的和。'},answerStatus:'provided',review:{status:'approved',issues:[],checks:{sourceText:true,answerMatch:true,wholeQuestion:true,format:true}}})),coverage:{pages:[{page:17,candidates:Array.from({length:9},(_,i)=>({id:'candidate-'+i,type:'question',decision:'include',taskIds:[i===8?pinned.taskId:'synthetic-'+i]}))}]}};
  const state=createNewSystemRun(manifest,{baseDir:f.root});state.status='failed';
  state.tasks.forEach((entry,i)=>Object.assign(entry,{status:i===8?'failed':'completed',attempts:1,recoveryRequired:i===8,receipt:i===8?null:{shitiID:pinned.anchorRecordIds[i+6]},lastError:i===8?'original unknown':null}));
  await fs.writeFile(f.context.manifestPath,bytes(manifest));await fs.writeFile(f.context.statePath,bytes(state));
  const candidate=validateHistoricalNetworkRecovery(f.input,{profile:f.profile}).proof;
  Object.assign(candidate,{manifestSha256:pinned.manifestSha256,manifestHash:state.manifestHash,historySha256:pinned.historySha256,lifetimeSha256:pinned.lifetimeSha256,coreSha256:pinned.coreSha256,bundleSha256:'c'.repeat(64)});candidate.failedHashes.manifest=pinned.manifestSha256;
  Object.assign(candidate,{pendingSha256:pinned.pendingSha256,stateSha256:pinned.failedStateSha256});candidate.failedHashes.state=pinned.failedStateSha256;candidate.failedHashes.job=pinned.failedJobSha256;
  candidate.freshConfirmation={schemaVersion:1,kind:'fresh-read-after-frozen-network-history',checkedAt:new Date().toISOString(),nodeID:pinned.nodeID,priorRecordIds:copy(candidate.priorRecordIds),targetMissing:true,priorRecordsUnchanged:true,noNewSaveObserved:true,evidencePath:f.output};
  const result={status:'missing',bookId:pinned.bookId,target,count:8,recovery:{outcome:'not_saved',writeUnlocked:true,bookId:pinned.bookId,taskId:pinned.taskId,recordId:null,nodeID:pinned.nodeID,priorRecordIds:copy(candidate.priorRecordIds),priorRecordsUnchanged:true,liveNoSaveRequests:false,historicalNetworkProof:candidate,evidencePath:f.output}};
  let late=false;
  const active={source:'production',connect:async()=>{},_uncertain:true,pendingWrite:copy(f.pending),reconcileHistoricalNetwork:async(_task,options)=>options.promote(result,()=>{const disk=JSON.parse(readFileSync(f.context.statePath));if(disk.tasks.at(-1).attempts===0){late=true;throw new Error('synthetic late SAVE during state checkpoint');}})};
  const page={url:()=>recorderBookUrl(pinned.bookId),bringToFront:async()=>{},evaluate:async()=>true};
  const bridge=await installPersistentBridge({page,config:{root:f.root,bookId:pinned.bookId,focusMode:'foreground'},adapterFactory:()=>active});
  bridge.start({id:'historical-late-state',action:'reconcile',args:{manifest:f.context.manifestPath,state:f.context.statePath,taskId:pinned.taskId,pendingPath:f.pendingPath,historicalNetworkEvidencePath:f.bundlePath}});
  for(let i=0;i<100&&!bridge.status().job.terminal;i++)await new Promise(resolve=>setTimeout(resolve,5));
  const job=bridge.status().job,stored=JSON.parse(await fs.readFile(f.context.statePath));
  assert.equal(job.terminal,true);assert.match(job.error,/late SAVE/);assert.equal(late,true);
  assert.equal(stored.tasks.at(-1).status,'failed');assert.equal(stored.tasks.at(-1).attempts,1);assert.equal(stored.tasks.at(-1).recoveryRequired,true);
  assert.equal(stored.tasks.at(-1).recoveryHistory.at(-1).outcome,'unknown');assert.deepEqual(stored.tasks.slice(0,8),state.tasks.slice(0,8));
});

test('typed historical args require all original bindings and forbid caller proofs or mixed recovery routes',()=>{
  const root=os.tmpdir(),args={manifest:'data/original.json',state:'data/original.state.json',pendingPath:'data/original.pending.json',taskId:pinned.taskId,historicalNetworkEvidencePath:'data/bundle.json'};
  assert.equal(validateRecorderCommand({action:'reconcile',args},root).args.historicalNetworkEvidencePath,args.historicalNetworkEvidencePath);
  for(const altered of [{...args,state:undefined},{...args,pendingPath:undefined},{...args,historicalNetworkProof:{}},{...args,preStemFailureCommandId:'53637a7f-5314-4c8e-b0a8-c53537efce3f',baselineProbeCommandId:'53637a7f-5314-4c8e-b0a8-c53537efce3f'}])assert.throws(()=>validateRecorderCommand({action:'reconcile',args:altered},root));
  assert.throws(()=>validateRecorderCommand({action:'execute',args},root));
});
