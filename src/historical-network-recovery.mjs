import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {verifyNewSystemSave} from './new-system-core.mjs';

const SITE='https://easylearn.baidu.com';
const SAVE_PATH='/edushop/textbook/myproducecommit/editshiti';
const LIST_PATH='/edushop/textbook/detail/shitilist';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const positive=n=>Number.isSafeInteger(n)&&n>0;
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
const timestamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?Date.parse(value):NaN;
const requireProof=(condition,message)=>{if(!condition)throw new Error(message);};
const anchorIds=['q-146965-t9-03','q-146965-t9-04',...Array.from({length:4},(_,i)=>`q-146965-t10-0${i+1}`),...Array.from({length:8},(_,i)=>`q-146965-t11-0${i+1}`)];

/** Independent pins for this original interrupted command, never inferred from
 * the supplied ledger. A different case requires its own reviewed profile. */
export const HISTORICAL_Q61_PROFILE=Object.freeze({
  bookId:146965,taskId:'q-146965-t11-09',nodeID:9909934,
  target:Object.freeze({chapterLabel:'专题五 句子',sectionLabel:'必刷训练3 辨析并修改病句',record:9}),
  source:Object.freeze({pages:Object.freeze([17]),answerPages:Object.freeze([76])}),
  servicePid:58608,mcpPid:33308,connectionCount:37,
  bindingId:'b8155e18-0bab-4a36-8efb-af362c2b226b',
  pageGuid:'page@66a7a69571ce2c0796ff1118b9b8bf6f',
  frameGuid:'frame@fe9ce8d4786e4b95f8679ef89eba7583',
  sdkVersion:'1.64.0-alpha-1790635538000',
  coreSha256:'0734c2598dd6f9423a9351f64956a47174137d5a00969407e9243e7d7017c8fb',
  exportScriptSha256:'48025d37f8306a7b892bd2a16e131d09f4e7f45df92aaba829d2d8171db02a5d',
  historySha256:'c58a3d42a12f6dec43e20d54bd586e0b3c46c47f64be322a207d3828ccc0f757',
  lifetimeSha256:'38f0edf537fa9142b965eb6c1d402bafe743540201b9d68e08d23e3713dd46c0',
  runtimeHashes:Object.freeze({requestHandlerSourceSha256:'85ed957d5e3b93952f7cab3ec80ec81214c68e9482cc07b2bda59a0894f545b6',
    tabConstructorSha256:'d047b14a30bee9805c84693d5500342e4b36d832343d67e2843644b9fed4c36c',
    handleRequestSha256:'7e56d72e70fd3e6d3334c88b58f605a98ca32a91e96f2f1a35d0fe5a6def806b',
    disposeSha256:'85bfb4bb71e710db0ad707e9b5460c3ec161d40335edddd12f99fa482b1e9021'}),
  priorCommandId:'34da2bcb-8b9c-4df9-8b5f-107d5a91cd8f',
  failureCommandId:'53637a7f-5314-4c8e-b0a8-c53537efce3f',
  priorManifestSha256:'720dcf497fac9bf17262e855e953fcdab53af895d3e31f7a83c0391ee8053405',
  manifestSha256:'623e41768a8b70262936d4b9302a4410f846f12f32c7263d4fe2aad76f5f204d',
  pendingSha256:'2e27b030dde4a6a7af92e0934220815105fac6ace5562e758dcfa0547b7e2ca6',
  failedStateSha256:'2ea73a72b32b06f66c14a55b00b4a4ca1ee04e01da6e9dc78fb05dd3ee8af95e',
  failedJobSha256:'b4bac851db03dbfc1d58179dfe601962a6245d5c2a76905d1fcbfd4cd844f66e',
  anchorTaskIds:Object.freeze(anchorIds),
  anchorRecordIds:Object.freeze([57011049,57011052,57011055,57011056,57011058,57011061,57011098,57011100,57011110,57011116,57011122,57011124,57011131,57011134]),
  anchorNodeIDs:Object.freeze([9909932,9909932,9909933,9909933,9909933,9909933,...Array(8).fill(9909934)]),
});

function document(bytes,name){
  requireProof(typeof bytes==='string'||Buffer.isBuffer(bytes),'Missing raw evidence bytes: '+name);
  return {value:JSON.parse(bytes.toString()),sha256:sha(bytes)};
}

function batch(input,profile,prior){
  const parts=Object.fromEntries(['job','preflight','manifest','state'].map(name=>[name,document(input?.[name+'Bytes'],(prior?'prior.':'failed.')+name)]));
  const {job,preflight,manifest,state}=Object.fromEntries(Object.entries(parts).map(([key,doc])=>[key,doc.value]));
  if(!prior)requireProof(parts.job.sha256===profile.failedJobSha256&&parts.state.sha256===profile.failedStateSha256,'Original failed command or state raw bytes changed');
  requireProof(job.id===(prior?profile.priorCommandId:profile.failureCommandId)&&job.action==='execute'&&job.terminal===true&&!job.error
    &&job.result?.bookId===profile.bookId&&Number.isFinite(timestamp(job.startedAt))&&timestamp(job.finishedAt)>timestamp(job.startedAt),'Original execute command is not bound');
  requireProof(parts.manifest.sha256===(prior?profile.priorManifestSha256:profile.manifestSha256)
    &&preflight.manifestPath===job.result.manifestPath&&preflight.manifestSha256===parts.manifest.sha256
    &&preflight.valid===true&&preflight.readyForExecution===true,'Original raw manifest or preflight binding changed');
  requireProof(manifest.bookId===profile.bookId&&manifest.source==='production'&&Array.isArray(manifest.tasks)&&manifest.tasks.length===(prior?12:9)
    &&manifest.tasks.every(t=>t.review?.status==='approved'&&Array.isArray(t.review.issues)&&t.review.issues.length===0)
    &&state.bookId===profile.bookId&&state.kind==='new-system-run'&&state.schemaVersion===1&&hash(state.manifestHash)
    &&state.source==='production'&&Array.isArray(state.tasks)&&state.tasks.length===manifest.tasks.length
    &&state.tasks.every((entry,i)=>entry.taskId===manifest.tasks[i].id),'Original manifest/state scope changed');
  requireProof(prior?job.result.stateStatus==='completed'&&state.status==='completed'&&job.result.counts?.completed===12
    :job.result.stateStatus==='failed'&&state.status==='failed'&&job.result.uncertain===true&&job.result.counts?.completed===8&&job.result.counts?.failed===1,'Original execution outcome changed');
  return {job,manifest,state,hashes:Object.fromEntries(Object.entries(parts).map(([name,doc])=>[name,doc.sha256]))};
}

function validRecords(records,nodeID,count){
  return Array.isArray(records)&&records.length===count&&new Set(records.map(r=>r.shitiID)).size===count
    &&records.every((r,i)=>r.seqIndex===i+1&&positive(r.shitiID)&&r.nodeID===nodeID&&positive(r.mainPicNum)&&positive(r.answerPicNum)
      &&typeof r.question==='string'&&typeof r.answer==='string'&&r.haveAnswer===true);
}

function freshCommand(bytes,bookId,action){
  const doc=document(bytes,'fresh '+action+' command'),job=doc.value;
  requireProof(typeof job.id==='string'&&job.action===action&&job.terminal===true&&!job.error&&job.result?.bookId===bookId
    &&job.result.writePerformed===false&&Number.isFinite(timestamp(job.startedAt))&&timestamp(job.finishedAt)>=timestamp(job.startedAt),'Fresh readonly command is invalid');
  return doc;
}

/** Pure replay of frozen raw documents. This creates only a historical
 * candidate: no adapter, browser, state, pending file, or write lock is changed.
 * A caller must still prove a current fresh list and continuity through its
 * durable reconciliation. Network receipt bodies may have been disposed; the
 * positive anchors use the original accepted receipts plus request identity,
 * original append timing, and subsequent server reload identity instead. */
export function validateHistoricalNetworkRecovery(input,{profile=HISTORICAL_Q61_PROFILE}={}){
  try{
    requireProof(profile.anchorTaskIds?.length===14&&profile.anchorRecordIds?.length===14&&profile.anchorNodeIDs?.length===14,'A complete independently pinned anchor profile is required');
    const historyDoc=document(input.historyBytes,'history'),history=historyDoc.value;
    requireProof(historyDoc.sha256===profile.historySha256,'Frozen original ledger raw bytes changed');
    requireProof(history.schemaVersion===1&&history.kind==='existing-mcp-network-history'&&history.bookId===profile.bookId
      &&history.originalServicePid===profile.servicePid&&history.mcpPid===profile.mcpPid&&history.originalConnectionCount===profile.connectionCount
      &&history.bindingId===profile.bindingId&&history.pageGuid===profile.pageGuid&&history.sdkVersion===profile.sdkVersion
      &&history.coreSha256===profile.coreSha256&&history.exportScriptSha256===profile.exportScriptSha256,'Original MCP process, connection, page, SDK or exporter identity differs');
    requireProof(history.pageBound===true&&history.pageUnchanged===true&&history.crashed===false&&history.tabObserverCount===1
      &&history.consoleLogStopped===false&&Number.isFinite(history.consoleLogStartTime)&&history.consoleLogStartTime>0
      &&history.recoveryAuthorizedByExport===false,'Original Tab observation is incomplete');
    const url=new URL(history.pageUrl);
    requireProof(url.origin===SITE&&url.pathname==='/edu-shop-web/'&&url.hash.startsWith('#/content-manager/teaching-content?')
      &&Number(new URLSearchParams(url.hash.split('?')[1]).get('textbookID'))===profile.bookId,'Original book page URL differs');
    const capturedAt=timestamp(history.capturedAt),finishedAt=timestamp(history.finishedAt),rows=history.rows;
    requireProof(Number.isFinite(capturedAt)&&finishedAt>=capturedAt&&Array.isArray(rows)&&rows.length>0
      &&history.ledgerCount===rows.length&&history.ledgerCountAfter===rows.length,'Ledger changed or its capture is incomplete');
    requireProof(rows[0].origin===SITE&&rows[0].pathname==='/edu-shop-web/'&&rows[0].method==='GET'&&rows[0].resourceType==='document'
      &&rows[0].timing?.startTime>=history.consoleLogStartTime&&rows[0].timing.startTime-history.consoleLogStartTime<1000,'The original collector startup boundary is missing');
    const lifetimeDoc=document(input.lifetimeBytes,'original Tab lifetime'),lifetime=lifetimeDoc.value;
    requireProof(lifetimeDoc.sha256===profile.lifetimeSha256&&lifetime.schemaVersion===1&&lifetime.kind==='original-mcp-tab-lifetime-inspection'
      &&timestamp(lifetime.inspectedAt)>=finishedAt&&lifetime.mcpPid===profile.mcpPid&&lifetime.pageGuid===profile.pageGuid&&lifetime.bindingId===profile.bindingId
      &&lifetime.historySha256===historyDoc.sha256&&lifetime.coreSha256===profile.coreSha256
      &&lifetime.pageClosed===false&&lifetime.pageCollected===false&&lifetime.connectionClosed===false&&lifetime.contextClosed===false&&lifetime.browserConnected===true
      &&lifetime.disposableCount===11&&lifetime.ownedRequestDisposableCount===1&&lifetime.ownedRequestEmitterMatches===true&&lifetime.ownedRequestListenerStillAttached===true
      &&lifetime.consoleLogStartTime===history.consoleLogStartTime&&lifetime.consoleLogStopped===false&&lifetime.crashed===false
      &&lifetime.ledgerCount===rows.length&&lifetime.saveRequests===14&&lifetime.bridgeJobId===history.bridgeJobId&&lifetime.bridgeRunning===false
      &&Object.entries(profile.runtimeHashes).every(([key,value])=>lifetime[key]===value),'Original Tab listener lifetime, loaded methods or transport continuity cannot be qualified');
    const guids=new Set();
    for(const [index,row] of rows.entries()){
      requireProof(row.index===index&&typeof row.method==='string'&&/^[A-Z]+$/u.test(row.method)&&typeof row.origin==='string'&&typeof row.pathname==='string'
        &&typeof row.requestGuid==='string'&&row.requestGuid.length>0&&!guids.has(row.requestGuid)&&row.pageGuid===profile.pageGuid&&row.frameGuid===profile.frameGuid
        &&Number.isFinite(row.timing?.startTime)&&row.timing.startTime>=history.consoleLogStartTime&&row.timing.startTime<=capturedAt
        &&typeof row.hasResponse==='boolean'&&typeof row.failed==='boolean','Ledger indexes, request identity, page/frame or timestamps are incomplete');
      guids.add(row.requestGuid);
      requireProof(!row.save||(row.origin===SITE&&row.pathname===SAVE_PATH&&row.method==='POST'),'A save row was classified under a different endpoint');
    }
    const saves=rows.filter(row=>row.origin===SITE&&row.pathname===SAVE_PATH&&row.method==='POST');
    requireProof(saves.length===14,'The complete ledger must contain exactly the 14 known SAVE POSTs; another SAVE cannot prove absence');
    const prior=batch(input.priorBatch,profile,true),failed=batch(input.failedBatch,profile,false),pendingDoc=document(input.pendingBytes,'pending'),pending=pendingDoc.value;
    requireProof(pendingDoc.sha256===profile.pendingSha256,'Original interrupted intention raw bytes changed');
    const task=failed.manifest.tasks.at(-1),entry=failed.state.tasks.at(-1);
    requireProof(task.id===profile.taskId&&isDeepStrictEqual(task.target,profile.target)&&isDeepStrictEqual(task.source,profile.source)
      &&pending.schemaVersion===1&&pending.kind==='new-system-append-recovery'
      &&pending.status==='pending'&&pending.bookId===profile.bookId&&pending.nodeID===profile.nodeID&&pending.phase==='save-business-receipt'
      &&pending.created===true&&pending.observedSaveRequests===0&&pending.receipt===null&&isDeepStrictEqual(pending.task,task)
      &&validRecords(pending.priorRecords,pending.nodeID,8)&&entry.status==='failed'&&entry.attempts===1&&entry.recoveryRequired===true
      &&entry.receipt===null&&!entry.recoveryConfirmation&&String(entry.lastError??'').startsWith('写入未完成确认: [save-business-receipt]')
      &&failed.job.result.pendingWrite?.task?.id===task.id&&failed.job.result.pendingWrite.phase===pending.phase
      &&failed.job.result.pendingWrite.evidencePath===pending.evidencePath,'Original interrupted save intention is not intact');
    // The original job durably recorded only this four-field summary; absence
    // of its counter is not zero-request evidence. Preserve that exact job
    // hash, and reject any known positive/conflicting receipt or observation.
    const reported=failed.job.result.pendingWrite;
    requireProof(reported.status==='pending'&&reported.receipt==null&&reported.receiptConflict!==true
      &&(reported.observedSaveRequests===undefined||reported.observedSaveRequests===0)
      &&(reported.nodeID===undefined||reported.nodeID===pending.nodeID)
      &&(reported.startedAt===undefined||reported.startedAt===pending.startedAt)
      &&(Object.keys(reported.task).length===1||isDeepStrictEqual(reported.task,pending.task)), 'Original failure reports a save, conflicting receipt or different intention identity');
    const failureTiming=failed.job.timings?.filter(t=>t.phase==='append-ui'&&t.taskId===task.id);
    requireProof(failureTiming?.length===1&&timestamp(failureTiming[0].startedAt)<=timestamp(pending.startedAt)
      &&timestamp(pending.startedAt)<=timestamp(failureTiming[0].finishedAt)&&timestamp(failureTiming[0].finishedAt)<=timestamp(failed.job.finishedAt)
      &&timestamp(failed.job.finishedAt)<capturedAt,'Interrupted command time is not fully covered');
    requireProof(Array.isArray(input.anchorPendingBytes)&&input.anchorPendingBytes.length===14,'All 14 original completed intentions are required');
    const anchorDocs=input.anchorPendingBytes.map((bytes,i)=>document(bytes,'anchor '+i));
    const anchorMap=new Map(anchorDocs.map(doc=>[doc.value.task?.id,doc]));
    requireProof(anchorMap.size===14,'Completed anchor intentions are duplicated');
    const anchors=[];
    for(let i=0;i<14;i++){
      const original=i<6?prior:failed,id=profile.anchorTaskIds[i],taskIndex=original.manifest.tasks.findIndex(t=>t.id===id),anchorTask=original.manifest.tasks[taskIndex],saved=original.state.tasks[taskIndex];
      const intentDoc=anchorMap.get(id),intent=intentDoc?.value,row=saves[i],timings=original.job.timings?.filter(t=>t.phase==='append-ui'&&t.taskId===id),reload=saved?.receipt?.reloadReadback;
      requireProof(anchorTask&&saved?.status==='completed'&&saved.recoveryRequired===false&&saved.attempts===1
        &&saved.receipt?.shitiID===profile.anchorRecordIds[i]&&verifyNewSystemSave(anchorTask,saved.receipt,{bookId:profile.bookId}).ok
        &&reload?.kind==='new-system-reload-readback'&&reload.taskId===id&&reload.bookId===profile.bookId&&reload.recordId===saved.receipt.shitiID
        &&reload.readback?.status==='found'&&reload.readback.bookId===profile.bookId&&reload.readback.recordId===saved.receipt.shitiID
        &&reload.readback.source?.pages?.[0]===anchorTask.source.pages[0]&&reload.readback.source?.answerPages?.[0]===anchorTask.source.answerPages[0], 'A positive anchor lacks its original accepted save and server reload');
      requireProof(intent?.schemaVersion===1&&intent.kind==='new-system-append-recovery'&&intent.status==='completed'&&intent.phase==='completed'
        &&intent.created===true&&intent.bookId===profile.bookId&&intent.nodeID===profile.anchorNodeIDs[i]&&intent.observedSaveRequests===1
        &&isDeepStrictEqual(intent.task,anchorTask)&&validRecords(intent.priorRecords,intent.nodeID,anchorTask.target.record-1)
        &&intent.receipt?.shitiID===saved.receipt.shitiID&&verifyNewSystemSave(anchorTask,intent.receipt,{bookId:profile.bookId}).ok,'Original completed anchor intention differs');
      requireProof(row.hasResponse===true&&row.status===200&&row.failed===false&&hash(row.postDataSha256)
        &&row.save?.bookId===profile.bookId&&row.save.nodeID===intent.nodeID&&row.save.seqIndex===anchorTask.target.record&&row.save.shitiID===null
        &&row.save.mainPicNum===anchorTask.source.pages[0]&&row.save.answerPicNum===anchorTask.source.answerPages[0]
        &&Number.isFinite(row.timing.responseStart)&&Number.isFinite(row.timing.responseEnd)&&row.timing.responseStart>=0&&row.timing.responseEnd>=row.timing.responseStart
        &&timings?.length===1&&row.timing.startTime>=timestamp(timings[0].startedAt)&&row.timing.startTime<=timestamp(timings[0].finishedAt)
        &&row.timing.startTime>=timestamp(intent.startedAt)&&row.timing.startTime+row.timing.responseEnd<=timestamp(reload.checkedAt)
        &&(i===0||row.index>saves[i-1].index&&row.timing.startTime>saves[i-1].timing.startTime),'Network SAVE anchors do not replay their original request identity and time');
      if(row.receipt)requireProof(row.receipt.errno===0&&row.receipt.shitiID===saved.receipt.shitiID&&row.receipt.seqIndex===anchorTask.target.record&&row.receipt.haveAnswer===true,'Available network receipt conflicts with the original accepted receipt');
      if(i>=6)requireProof(pending.priorRecords[i-6].shitiID===saved.receipt.shitiID&&pending.priorRecords[i-6].mainPicNum===anchorTask.source.pages[0]
        &&pending.priorRecords[i-6].answerPicNum===anchorTask.source.answerPages[0],'Original failed intention lost an accepted prior record');
      anchors.push({taskId:id,recordId:saved.receipt.shitiID,nodeID:intent.nodeID,requestGuid:row.requestGuid,index:row.index,postDataSha256:row.postDataSha256,intentSha256:intentDoc.sha256});
    }
    const last=saves.at(-1),noSaveFrom=timestamp(failureTiming[0].startedAt);
    requireProof(last.timing.startTime+last.timing.responseEnd<noSaveFrom&&rows.every(row=>!(row.origin===SITE&&row.pathname===SAVE_PATH&&row.method==='POST'&&row.index>last.index)),'A SAVE POST reaches the interrupted task interval');
    const scopeDoc=document(input.freshScopeBytes,'fresh scope'),scopeJobDoc=document(input.freshScopeJobBytes,'fresh scope command'),scopeJob=scopeJobDoc.value;
    let scope;
    if(scopeJob.action==='verify'){
      requireProof(Object.keys(scopeDoc.value).length===1&&scopeJob.result?.counts?.skipped_existing===8&&scopeJob.result.counts.pending===1
        &&scopeJob.result.manifestPath===failed.job.result.manifestPath,'Readonly verification did not cover the original eight records');
      scope=scopeDoc.value[JSON.stringify([task.target.chapterLabel,task.target.sectionLabel])];
      freshCommand(input.freshScopeJobBytes,profile.bookId,'verify');
    }else{scope=scopeDoc.value;freshCommand(input.freshScopeJobBytes,profile.bookId,'probe');requireProof(scope.bookId===profile.bookId,'Fresh scope book differs');}
    const readbackDoc=document(input.freshReadbackBytes,'fresh missing readback'),readbackJobDoc=freshCommand(input.freshReadbackJobBytes,profile.bookId,'readback'),readbackJob=readbackJobDoc.value,read=readbackDoc.value;
    requireProof(scope?.chapterLabel===task.target.chapterLabel&&scope.sectionLabel===task.target.sectionLabel&&scope.nodeID===pending.nodeID
      &&isDeepStrictEqual(scope.records,pending.priorRecords),'Fresh scope changed a prior record, source, order or full content');
    requireProof(read.bookId===profile.bookId&&read.taskId===task.id&&read.readback?.status==='missing'&&read.readback.bookId===profile.bookId
      &&read.readback.count===8&&(read.readback.recordId===null||read.readback.recordId===undefined)&&isDeepStrictEqual(read.readback.target,task.target)
      &&readbackJob.result.taskId===task.id&&readbackJob.result.status==='missing','Fresh readback does not prove the original target missing');
    for(const [snapshot,job] of [[scope,scopeJob],[read,readbackJob]]){
      requireProof(timestamp(job.startedAt)>=timestamp(failed.job.finishedAt)&&timestamp(snapshot.serverSnapshotAt)>=timestamp(job.startedAt)
        &&timestamp(snapshot.at)>=timestamp(snapshot.serverSnapshotAt)&&timestamp(snapshot.at)<=timestamp(job.finishedAt)&&timestamp(job.finishedAt)<=capturedAt
        &&rows.some(row=>row.origin===SITE&&row.pathname===LIST_PATH&&row.hasResponse===true&&row.status===200&&!row.failed
          &&row.timing.startTime>=timestamp(snapshot.serverSnapshotAt)&&row.timing.startTime<=timestamp(snapshot.at)),'A real readonly directory refresh is not covered by the original ledger');
    }
    return {valid:true,errors:[],proof:{schemaVersion:1,kind:'frozen-original-mcp-no-save-network-history',historicalOnly:true,
      bookId:profile.bookId,taskId:task.id,target:structuredClone(task.target),source:structuredClone(task.source),nodeID:pending.nodeID,manifestHash:failed.state.manifestHash,
      manifestSha256:failed.hashes.manifest,failureCommandId:failed.job.id,priorCommandId:prior.job.id,
      bindingId:profile.bindingId,pageGuid:profile.pageGuid,originalServicePid:profile.servicePid,mcpPid:profile.mcpPid,originalConnectionCount:profile.connectionCount,
      sdkVersion:profile.sdkVersion,coreSha256:profile.coreSha256,exportScriptSha256:profile.exportScriptSha256,
      lifetimeSha256:lifetimeDoc.sha256,lifetimeInspectedAt:lifetime.inspectedAt,observerLifetimeQualified:true,runtimeHashes:structuredClone(profile.runtimeHashes),
      historySha256:historyDoc.sha256,pendingSha256:pendingDoc.sha256,stateSha256:failed.hashes.state,priorHashes:prior.hashes,failedHashes:failed.hashes,
      freshScopeSha256:scopeDoc.sha256,freshScopeJobSha256:scopeJobDoc.sha256,freshReadbackSha256:readbackDoc.sha256,freshReadbackJobSha256:readbackJobDoc.sha256,
      anchors,ledgerCount:rows.length,lastSaveIndex:last.index,noSaveFrom:new Date(noSaveFrom).toISOString(),noSaveThrough:history.capturedAt,
      priorRecordIds:pending.priorRecords.map(r=>r.shitiID),priorRecordsUnchanged:true,networkNoSaveAfterLastAnchor:true}};
  }catch(error){return {valid:false,errors:[String(error.message)],proof:null};}
}

/** Shape/binding check for the internal proof after the loader has replayed raw
 * files and the adapter has attached its actual fresh durable confirmation.
 * This does not validate an arbitrary supplied JSON file or replace replay. */
export function validHistoricalNetworkRecoveryProof(proof,{bookId,taskId,target,manifestSha256,manifestHash,profile=HISTORICAL_Q61_PROFILE}={}){
  // Profile injection is for isolated fixture tests. Production adapters,
  // core/session checks and typed recorder arguments use the pinned default.
  const p=profile,f=proof?.freshConfirmation;
  return Boolean(proof?.schemaVersion===1&&proof.kind==='frozen-original-mcp-no-save-network-history'&&proof.historicalOnly===true
    &&proof.bookId===p.bookId&&proof.taskId===p.taskId&&proof.nodeID===p.nodeID&&isDeepStrictEqual(proof.target,p.target)&&isDeepStrictEqual(proof.source,p.source)
    &&proof.bookId===bookId&&proof.taskId===taskId&&(target===undefined||isDeepStrictEqual(proof.target,target))
    &&proof.failureCommandId===p.failureCommandId&&proof.priorCommandId===p.priorCommandId
    &&proof.originalServicePid===p.servicePid&&proof.mcpPid===p.mcpPid&&proof.originalConnectionCount===p.connectionCount
    &&proof.bindingId===p.bindingId&&proof.pageGuid===p.pageGuid&&proof.sdkVersion===p.sdkVersion&&proof.coreSha256===p.coreSha256&&proof.exportScriptSha256===p.exportScriptSha256
    &&proof.historySha256===p.historySha256
    &&proof.lifetimeSha256===p.lifetimeSha256&&proof.observerLifetimeQualified===true&&isDeepStrictEqual(proof.runtimeHashes,p.runtimeHashes)
    &&timestamp(proof.lifetimeInspectedAt)>=timestamp(proof.noSaveThrough)
    &&proof.manifestSha256===p.manifestSha256&&(manifestSha256===undefined||proof.manifestSha256===manifestSha256)
    &&hash(proof.manifestHash)&&(manifestHash===undefined||proof.manifestHash===manifestHash)
    &&['pendingSha256','stateSha256','historySha256','bundleSha256','freshScopeSha256','freshScopeJobSha256','freshReadbackSha256','freshReadbackJobSha256'].every(k=>hash(proof[k]))
    &&proof.failedHashes?.manifest===proof.manifestSha256&&proof.failedHashes?.state===proof.stateSha256
    &&proof.pendingSha256===p.pendingSha256&&proof.stateSha256===p.failedStateSha256&&proof.failedHashes?.job===p.failedJobSha256
    &&proof.priorRecordsUnchanged===true&&proof.networkNoSaveAfterLastAnchor===true
    &&Number.isSafeInteger(proof.ledgerCount)&&proof.ledgerCount>=14&&Number.isSafeInteger(proof.lastSaveIndex)&&proof.lastSaveIndex>=13&&proof.lastSaveIndex<proof.ledgerCount
    &&Number.isFinite(timestamp(proof.noSaveFrom))&&timestamp(proof.noSaveThrough)>timestamp(proof.noSaveFrom)
    &&Array.isArray(proof.anchors)&&proof.anchors.length===14&&proof.anchors.every((a,i)=>a&&typeof a==='object'&&a.taskId===p.anchorTaskIds[i]&&a.recordId===p.anchorRecordIds[i]
      &&a.nodeID===p.anchorNodeIDs[i]&&typeof a.requestGuid==='string'&&a.requestGuid.length>0&&hash(a.postDataSha256)&&hash(a.intentSha256)
      &&Number.isSafeInteger(a.index)&&a.index>=0&&(i===0||a.index>proof.anchors[i-1].index))
    &&proof.anchors.at(-1).index===proof.lastSaveIndex&&isDeepStrictEqual(proof.priorRecordIds,p.anchorRecordIds.slice(6))
    &&f?.schemaVersion===1&&f.kind==='fresh-read-after-frozen-network-history'&&timestamp(f.checkedAt)>=timestamp(proof.lifetimeInspectedAt)
    &&f.nodeID===proof.nodeID&&isDeepStrictEqual(f.priorRecordIds,proof.priorRecordIds)&&f.priorRecordsUnchanged===true&&f.targetMissing===true&&f.noNewSaveObserved===true
    &&typeof f.evidencePath==='string'&&f.evidencePath.length>0);
}
