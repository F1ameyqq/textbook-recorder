import {createHash} from 'node:crypto';

const READ_ONLY_ACTIONS=new Set(['probe','collect','verify','readback','reconcile']);
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
  ? Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,canonical(value[key])])):value;

/** Fingerprint the validated original command, never an inferred phase or result. */
export function recorderCommandFingerprint({action,args={},continuationGuard}){
  return createHash('sha256').update(JSON.stringify(canonical({action,args,...(continuationGuard?{continuationGuard}:{})}))).digest('hex');
}

/** Read-only terminal evidence may retire a command; it never clears a write lock. */
export function validateReadonlyTerminalJob(job,pending,{bookId,now=Date.now()}={}){
  if(!pending||!READ_ONLY_ACTIONS.has(pending.action))throw new Error('当前动作不支持只读本地终止收尾');
  const submitted=Date.parse(pending.at),started=Date.parse(job?.startedAt),finished=Date.parse(job?.finishedAt);
  if(job?.id!==pending.id||job.action!==pending.action||job.bookId!==bookId||job.servicePid!==pending.servicePid
    ||job.running!==false||job.terminal!==true||job.commandSha256!==recorderCommandFingerprint(pending)
    ||![submitted,started,finished].every(Number.isFinite)||started<submitted||finished<started||finished>now)
    throw new Error('只读终止证据的命令、参数、书籍、子服务或时间不匹配');
  if(job.evidenceError)throw new Error('只读终止证据持久化未确认');
  if(job.result?.bookId!==undefined&&job.result.bookId!==bookId||job.result?.writePerformed===true)
    throw new Error('只读终止结果的书籍或写入范围不匹配');
  if(!job.error&&(job.result?.bookId!==bookId||job.result.writePerformed!==false))
    throw new Error('只读终止结果缺少本书及未写入证明');
  const context=pending.reviewContext;
  if(['verify','readback','reconcile'].includes(pending.action)){
    if(!context||typeof context.manifest!=='string'||typeof context.state!=='string'||!/^[a-f0-9]{64}$/u.test(context.manifestSha256??''))
      throw new Error('只读终止命令缺少派发前题单和进度绑定');
    if(!job.error&&(['verify','reconcile'].includes(pending.action))
      &&(job.result.manifestPath!==context.manifest||job.result.statePath!==context.state))
      throw new Error('只读终止结果不属于原题单和进度');
    if(['readback','reconcile'].includes(pending.action)&&!job.error&&job.result.taskId!==pending.args.taskId)
      throw new Error('只读终止结果不属于原题目');
  }
  return {kind:'bound-readonly-terminal',schemaVersion:1,commandId:pending.id,action:pending.action,
    bookId,servicePid:pending.servicePid,commandSha256:job.commandSha256,startedAt:job.startedAt,finishedAt:job.finishedAt};
}

/** Small diagnostics preserve the last work phase after the terminal marker. */
export function recorderTerminalDiagnostic(job,{statusSource='local-terminal',writeBlocked=false,transportBlocked=false}={}){
  const timing=Array.isArray(job?.timings)?[...job.timings].reverse().find(row=>row&&row.phase!=='terminal'):null;
  const result={commandId:job?.id,action:job?.action,statusSource,
    phase:timing?.phase??job?.phase??null,taskId:timing?.taskId??job?.phaseTaskId??null,
    writeBlocked:writeBlocked===true,transportBlocked:transportBlocked===true};
  if(Number.isFinite(timing?.elapsedMs)&&timing.elapsedMs>=0)result.phaseElapsedMs=timing.elapsedMs;
  if(typeof job?.finishedAt==='string')result.finishedAt=job.finishedAt;
  return result;
}
