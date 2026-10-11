import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {HISTORICAL_Q61_PROFILE as pinned,validateHistoricalNetworkRecovery,validHistoricalNetworkRecoveryProof} from '../src/historical-network-recovery.mjs';

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
    const job={id,action:'execute',terminal:true,startedAt:at(start),finishedAt:at(end),timings:isPrior?timings(anchors.slice(0,6),0):[...timings(anchors.slice(6),6),{phase:'append-ui',taskId:failedTask.id,startedAt:at(480),finishedAt:at(500)}],result:{bookId,manifestPath,statePath:isPrior?'data/prior.state.json':'data/failed.state.json',stateStatus:run.status,uncertain:!isPrior,counts:isPrior?{completed:12}:{completed:8,failed:1},...(isPrior?{}:{pendingWrite:{status:'pending',phase:pending.phase,task:{id:failedTask.id},evidencePath:pending.evidencePath}})}};
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
  profile.pendingSha256=sha(input.pendingBytes);profile.failedJobSha256=sha(input.failedBatch.jobBytes);profile.failedStateSha256=sha(input.failedBatch.stateBytes);
  return {input,profile};
}

test('replay accepts the complete original ledger and all original anchors without network response bodies; it cannot unlock anything',()=>{
  const f=fixture(),before=JSON.stringify(f),result=validateHistoricalNetworkRecovery(f.input,{profile:f.profile});
  assert.equal(result.valid,true,result.errors.join('; '));assert.equal(result.proof.anchors.length,14);
  assert.equal(result.proof.lastSaveIndex,14);assert.equal(result.proof.priorRecordIds.length,8);
  assert.equal(result.proof.writeUnlocked,undefined);assert.equal(result.proof.outcome,undefined);
  assert.equal(JSON.stringify(f),before);assert.equal(validHistoricalNetworkRecoveryProof(result.proof,{bookId:pinned.bookId,taskId:pinned.taskId}),false);
});

for(const [name,mutate] of [
  ['another SAVE after q60, even with unknown body and failed response',f=>rewrite(f,'historyBytes',h=>{h.rows.push({...h.rows.at(-1),index:h.rows.length,requestGuid:'request@late',method:'POST',pathname:'/edushop/textbook/myproducecommit/editshiti',hasResponse:false,status:null,failed:true});h.ledgerCount++;h.ledgerCountAfter++;})],
  ['truncated ledger',f=>rewrite(f,'historyBytes',h=>{h.rows.shift();h.rows.forEach((r,i)=>r.index=i);h.ledgerCount--;h.ledgerCountAfter--;})],
  ['missing a SAVE anchor',f=>rewrite(f,'historyBytes',h=>{h.rows.splice(1,1);h.rows.forEach((r,i)=>r.index=i);h.ledgerCount--;h.ledgerCountAfter--;})],
  ['late new requests during export',f=>rewrite(f,'historyBytes',h=>h.ledgerCountAfter++)],
  ['SDK hash changed',f=>rewrite(f,'historyBytes',h=>h.coreSha256='f'.repeat(64))],
  ['connection changed',f=>rewrite(f,'historyBytes',h=>h.originalConnectionCount++)],
  ['wrong page frame',f=>rewrite(f,'historyBytes',h=>h.rows[2].frameGuid='other')],
  ['duplicate request identity',f=>rewrite(f,'historyBytes',h=>h.rows[2].requestGuid=h.rows[1].requestGuid)],
  ['SAVE under an incorrect node',f=>rewrite(f,'historyBytes',h=>h.rows[3].save.nodeID++)],
  ['wrong SAVE source',f=>rewrite(f,'historyBytes',h=>h.rows[3].save.mainPicNum++)],
  ['invalid SAVE timestamp',f=>rewrite(f,'historyBytes',h=>h.rows[3].timing.startTime=0)],
  ['SAVE outside original append timing',f=>rewrite(f,'historyBytes',h=>h.rows[3].timing.startTime-=10000)],
  ['capture before fresh read',f=>rewrite(f,'historyBytes',h=>h.capturedAt=at(650))],
  ['request observer missing',f=>rewrite(f,'historyBytes',h=>h.tabObserverCount=0)],
  ['the original disposable collection was disposed',f=>rewrite(f,'lifetimeBytes',l=>l.disposableCount=0)],
  ['original request handler is no longer attached',f=>rewrite(f,'lifetimeBytes',l=>l.ownedRequestListenerStillAttached=false)],
  ['loaded request handler differs from original SDK',f=>rewrite(f,'lifetimeBytes',l=>l.handleRequestSha256='f'.repeat(64))],
  ['page was collected from original transport',f=>rewrite(f,'lifetimeBytes',l=>l.pageCollected=true)],
  ['the old MCP connection closed',f=>rewrite(f,'lifetimeBytes',l=>l.connectionClosed=true)],
  ['lifetime inspection is from a different ledger',f=>rewrite(f,'lifetimeBytes',l=>l.historySha256='f'.repeat(64))],
  ['known pending save receipt',f=>rewrite(f,'pendingBytes',p=>p.receipt={shitiID:999})],
  ['nonzero pending counter',f=>rewrite(f,'pendingBytes',p=>p.observedSaveRequests=1)],
  ['changed full prior answer',f=>rewrite(f,'freshScopeBytes',s=>Object.values(s)[0].records[0].answer='<p>changed</p>')],
  ['changed prior record order',f=>rewrite(f,'freshScopeBytes',s=>Object.values(s)[0].records.reverse())],
  ['target already found',f=>rewrite(f,'freshReadbackBytes',r=>r.readback.status='found')],
  ['readonly verification wrote',f=>rewrite(f,'freshScopeJobBytes',j=>j.result.writePerformed=true)],
  ['an original anchor intention is missing',f=>f.input.anchorPendingBytes.pop()],
  ['anchor is duplicated',f=>f.input.anchorPendingBytes[1]=f.input.anchorPendingBytes[0]],
  ['existing network receipt disagrees',f=>rewrite(f,'historyBytes',h=>h.rows[1].receipt={errno:0,shitiID:999,seqIndex:3,haveAnswer:true})],
  ['raw manifest changed',f=>{f.input.failedBatch.manifestBytes=Buffer.concat([f.input.failedBatch.manifestBytes,Buffer.from(' ')]);}],
  ['failed task already holds saved confirmation',f=>{const s=JSON.parse(f.input.failedBatch.stateBytes);s.tasks.at(-1).recoveryConfirmation={recordId:99};f.input.failedBatch.stateBytes=bytes(s);}],
])test(name+' cannot qualify historical recovery',()=>{
  const f=fixture();mutate(f);f.profile.historySha256=sha(f.input.historyBytes);
  // Keep unrelated fixture hashes coherent so semantic checks are exercised.
  if(name!=='lifetime inspection is from a different ledger')rewrite(f,'lifetimeBytes',l=>l.historySha256=f.profile.historySha256);
  f.profile.lifetimeSha256=sha(f.input.lifetimeBytes);
  const result=validateHistoricalNetworkRecovery(f.input,{profile:f.profile});assert.equal(result.valid,false);assert.equal(result.proof,null);assert.ok(result.errors.length);
});

test('the public internal-proof checker requires bound fresh confirmation, original profile and raw evidence hashes',()=>{
  const f=fixture(),candidate=validateHistoricalNetworkRecovery(f.input,{profile:f.profile}).proof;
  candidate.bundleSha256='c'.repeat(64);
  candidate.freshConfirmation={schemaVersion:1,kind:'fresh-read-after-frozen-network-history',checkedAt:at(810),nodeID:pinned.nodeID,priorRecordIds:copy(candidate.priorRecordIds),priorRecordsUnchanged:true,targetMissing:true,noNewSaveObserved:true,evidencePath:'data/recovery.json'};
  const binding={bookId:pinned.bookId,taskId:pinned.taskId,target:pinned.target,manifestSha256:f.profile.manifestSha256,manifestHash:candidate.manifestHash,profile:f.profile};
  assert.equal(validHistoricalNetworkRecoveryProof(candidate,binding),true);
  const productionBinding={...binding};delete productionBinding.profile;
  assert.equal(validHistoricalNetworkRecoveryProof(candidate,productionBinding),false,'Production checks must reject a fixture profile candidate');
  for(const change of [p=>delete p.freshConfirmation,p=>p.freshConfirmation.noNewSaveObserved=false,p=>p.freshConfirmation.checkedAt=at(790),p=>p.freshConfirmation.priorRecordIds.reverse(),p=>p.source.pages=[18],p=>p.bundleSha256=null,p=>p.manifestSha256='f'.repeat(64),p=>p.anchors[0]=null]){const changed=copy(candidate);change(changed);assert.equal(validHistoricalNetworkRecoveryProof(changed,binding),false);}
});

for(const [name,change] of [
  ['known original failure SAVE count',p=>p.observedSaveRequests=1],
  ['known original failure receipt',p=>p.receipt={shitiID:999}],
  ['original failure receipt conflict',p=>p.receiptConflict=true],
  ['different original failure node',p=>p.nodeID=123],
  ['different original failure start time',p=>p.startedAt=at(482)],
])test(name+' cannot be erased by a zero-counter pending file',()=>{
  const f=fixture(),job=JSON.parse(f.input.failedBatch.jobBytes);change(job.result.pendingWrite);
  f.input.failedBatch.jobBytes=bytes(job);f.profile.failedJobSha256=sha(f.input.failedBatch.jobBytes);
  assert.equal(JSON.parse(f.input.pendingBytes).observedSaveRequests,0);
  const result=validateHistoricalNetworkRecovery(f.input,{profile:f.profile});assert.equal(result.valid,false);assert.equal(result.proof,null);
});

for(const [name,key] of [['pending','pendingBytes'],['original failed job','jobBytes'],['original failed state','stateBytes']])test(name+' raw bytes are pinned independently of an amended bundle hash',()=>{
  const f=fixture();if(key==='pendingBytes')f.input[key]=Buffer.concat([f.input[key],Buffer.from(' ')]);else f.input.failedBatch[key]=Buffer.concat([f.input.failedBatch[key],Buffer.from(' ')]);
  assert.equal(validateHistoricalNetworkRecovery(f.input,{profile:f.profile}).valid,false);
});
