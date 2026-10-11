import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { existingWorkspacePath } from './recorder-config.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const uuid=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/u.test(value);
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
const assert=(condition,message)=>{if(!condition)throw new Error(message);};

export function validBeforePlusProof(proof,{bookId,taskId,target,manifestSha256,manifestHash}={}){
  const sourceOnly=proof?.kind==='source-navigation-failed-before-append-ui'&&proof.phase==='source-pages'&&proof.noDraftCreated===true&&proof.noEditorInsertionReached===true;
  const answerOnly=proof?.kind==='answer-only-draft-failed-before-stem-insertion'&&proof.phase==='answer-native-paste-readback'&&proof.noStemInsertionReached===true&&hash(proof.pendingSha256);
  return Boolean(proof?.schemaVersion===1&&(sourceOnly||answerOnly)
    && proof.bookId===bookId&&proof.taskId===taskId
    && uuid(proof.failureCommandId)&&uuid(proof.baselineCommandId)
    && ['failureSha256','baselineSha256','manifestSha256','manifestHash'].every(key=>hash(proof[key]))
    && (target===undefined||isDeepStrictEqual(proof.target,target))
    && (manifestSha256===undefined||proof.manifestSha256===manifestSha256)
    && (manifestHash===undefined||proof.manifestHash===manifestHash));
}

/** Narrow read-only recovery for an original source-page failure before a draft
 * or write intent exists. It must preserve the exact exported pre-write list. */
export async function recoverPreAppendSourceFailure(adapter,{root,dataDir,context,task,failureCommandId,baselineCommandId,evidencePath,pendingPath}){
  assert(uuid(failureCommandId)&&uuid(baselineCommandId),'提前失败恢复必须绑定两个原命令ID');
  const read=async filename=>{const file=await existingWorkspacePath(root,filename),bytes=await fs.readFile(file);return {file,bytes,value:JSON.parse(bytes)};};
  const failed=await read(path.join(dataDir,'jobs',failureCommandId,'job-result.json'));
  const preflight=await read(path.join(dataDir,'jobs',failureCommandId,'preflight.json'));
  const probe=await read(path.join(dataDir,'jobs',baselineCommandId,'job-result.json'));
  const baseline=await read(path.join(dataDir,'jobs',baselineCommandId,'scope-records.json'));
  const manifest=await read(context.manifestPath),failure=failed.value,prior=baseline.value,entry=context.state.tasks[0];
  const answerOnly=Boolean(pendingPath),phase=answerOnly?'answer-native-paste-readback':'source-pages';
  const pending=answerOnly?await read(pendingPath):null;
  assert(context.manifest.tasks.length===1&&context.manifest.tasks[0].id===task.id&&context.state.tasks.length===1
    &&entry.taskId===task.id&&entry.status==='failed'&&entry.attempts===1&&!entry.receipt&&!entry.recoveryConfirmation
    &&String(entry.lastError??'').startsWith('写入未完成确认: ['+phase+']'),'只有原单题插入正文之前的明确失败可按此路径核对');
  assert(failure.id===failureCommandId&&failure.action==='execute'&&failure.terminal===true&&!failure.error
    &&failure.result?.bookId===adapter.bookId&&failure.result.statePath===context.statePath
    &&failure.result.manifestPath===context.manifestPath&&failure.result.stateStatus==='failed'
    &&(answerOnly?failure.result.pendingWrite?.phase===phase&&failure.result.pendingWrite.task?.id===task.id&&failure.result.pendingWrite.evidencePath===pending.file:failure.result.pendingWrite===null)&&failure.result.counts?.failed===1
    &&failure.timings?.at(-1)?.phase==='append-ui'&&failure.timings.at(-1).taskId===task.id
    &&preflight.value.manifestPath===manifest.file&&preflight.value.manifestSha256===sha(manifest.bytes)
    &&preflight.value.valid===true&&preflight.value.readyForExecution===true,'原失败执行或题单哈希没有完整绑定');
  if(answerOnly)assert(pending.value.kind==='new-system-append-recovery'&&pending.value.status==='pending'
    &&pending.value.bookId===adapter.bookId&&pending.value.phase===phase&&pending.value.created===true
    &&pending.value.observedSaveRequests===0&&pending.value.receipt===null&&isDeepStrictEqual(pending.value.task,task)
    &&isDeepStrictEqual(pending.value.priorRecords,prior.records),'答案阶段意图不能证明正文插入尚未开始');
  assert(probe.value.id===baselineCommandId&&probe.value.action==='probe'&&probe.value.terminal===true&&!probe.value.error
    &&probe.value.result?.writePerformed===false&&probe.value.result.recordsPath===baseline.file
    &&prior.bookId===adapter.bookId&&prior.chapterLabel===task.target.chapterLabel&&prior.sectionLabel===task.target.sectionLabel
    &&Array.isArray(prior.records)&&prior.records.length===task.target.record-1
    &&Date.parse(prior.at)<Date.parse(failure.startedAt),'缺少失败前的原目录完整基线');
  assert(!adapter._pendingWrite&&!adapter._uncertain,'存在保存意图或未知编辑，不能按提前失败核对');
  const found=await adapter.read(task,{refresh:true});
  assert(found.status==='missing'&&found.count===prior.records.length&&adapter._nodeID===prior.nodeID
    &&isDeepStrictEqual(adapter._directoryRecords,prior.records),'刷新后目标题或原有记录、来源、顺序已变化');
  const beforePlusFailure={schemaVersion:1,kind:answerOnly?'answer-only-draft-failed-before-stem-insertion':'source-navigation-failed-before-append-ui',bookId:adapter.bookId,
    taskId:task.id,target:structuredClone(task.target),phase,...(answerOnly?{noStemInsertionReached:true,pendingSha256:sha(pending.bytes)}:{noDraftCreated:true,noEditorInsertionReached:true}),
    failureCommandId,baselineCommandId,failureSha256:sha(failed.bytes),baselineSha256:sha(baseline.bytes),
    manifestSha256:sha(manifest.bytes),manifestHash:context.state.manifestHash};
  const result={...found,recovery:{outcome:'not_saved',writeUnlocked:true,taskId:task.id,bookId:adapter.bookId,
    recordId:null,nodeID:prior.nodeID,priorRecordIds:prior.records.map(row=>row.shitiID),priorRecordsUnchanged:true,
    targetRecordUnique:false,fullContentCompared:false,liveNoSaveRequests:false,beforePlusFailure,evidencePath}};
  await fs.writeFile(evidencePath,JSON.stringify({...result,checkedAt:new Date().toISOString()},null,2),{flag:'wx'});
  return result;
}
