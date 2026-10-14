import fs from 'node:fs/promises';
import path from 'node:path';
import {existingWorkspacePath,TASK_ACTIONS} from './recorder-config.mjs';
import {safeDiagnosticMessage} from '../scripts/run-new-system-extension.mjs';

const validId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,80}$/u.test(value);
const number=value=>Number.isFinite(value)&&value>=0?value:null;
const timestamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?value:null;
const selected=(value,keys)=>Object.fromEntries(keys.filter(key=>value?.[key]!==undefined).map(key=>[key,value[key]]));
const commandIdentity=value=>value&&typeof value==='object'&&!Array.isArray(value)&&validId(value.id)&&TASK_ACTIONS.includes(value.action);

async function readLocalJson(root,file){
  let resolved;
  try{resolved=await existingWorkspacePath(root,file);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  const info=await fs.stat(resolved);
  if(!info.isFile()||info.size>10*1024*1024)throw new Error('本地诊断文件类型或大小无效');
  return {value:JSON.parse(await fs.readFile(resolved,'utf8')),path:resolved,modifiedAt:info.mtime.toISOString()};
}

/** Aggregate only phase names and durations. Textbook contents and credentials
 * never enter this report. Recorded timings describe an observed command. */
export function summarizeRecordedTimings(job){
  const totals=new Map();let invalidSamples=0;
  for(const sample of Array.isArray(job?.timings)?job.timings:[]){
    if(typeof sample?.phase!=='string'||!/^[a-z][a-z0-9-]{0,79}$/u.test(sample.phase)||number(sample.elapsedMs)===null){invalidSamples++;continue;}
    const row=totals.get(sample.phase)??{phase:sample.phase,calls:0,elapsedMs:0,maxMs:0};
    row.calls++;row.elapsedMs+=sample.elapsedMs;row.maxMs=Math.max(row.maxMs,sample.elapsedMs);totals.set(row.phase,row);
  }
  const phases=[...totals.values()].sort((a,b)=>b.elapsedMs-a.elapsedMs||a.phase.localeCompare(b.phase));
  const startedAt=timestamp(job?.startedAt),finishedAt=timestamp(job?.finishedAt);
  return {startedAt,finishedAt,wallTimeMs:startedAt&&finishedAt?number(Date.parse(finishedAt)-Date.parse(startedAt)):null,
    recordedPhaseTimeMs:phases.reduce((total,row)=>total+row.elapsedMs,0),invalidSamples,phases};
}

/** Local files only: no HTTP, browser connection, task dispatch, or lock edits. */
export async function diagnoseRecorder(root,{jobId,now=Date.now}={}){
  if(jobId!==undefined&&!validId(jobId))throw new Error('--job 必须是原命令 ID');
  root=await fs.realpath(root);
  const sessionFile=await readLocalJson(root,'data/persistent-executor/session.json');
  const session=sessionFile?.value;
  if(session&&(session.schemaVersion!==1||!Number.isSafeInteger(session.bookId)||session.bookId<1||typeof session.writeBlocked!=='boolean'
    ||!Object.hasOwn(session,'pending')||session.pending!==null&&!commandIdentity(session.pending)
    ||session.last!==undefined&&session.last!==null&&!commandIdentity(session.last)))throw new Error('本地会话身份、命令或锁状态无效，保留原文件');
  const currentId=session?.pending?.id??session?.last?.id??null;
  const requestedId=jobId??currentId;
  if(requestedId!==null&&!validId(requestedId))throw new Error('本地会话命令 ID 无效');
  const jobFile=requestedId?await readLocalJson(root,path.join('data/persistent-executor/jobs',requestedId,'job-result.json')):null;
  const job=jobFile?.value;
  if(job&&(job.id!==requestedId||!TASK_ACTIONS.includes(job.action)||!Number.isSafeInteger(job.bookId)||job.bookId<1
    ||session&&job.bookId!==session.bookId))throw new Error('终止证据与原命令或书籍不符，保留原文件');
  const boundToCurrent=requestedId!==null&&requestedId===currentId;
  if(job&&boundToCurrent&&job.action!==(session.pending??session.last)?.action)
    throw new Error('终止证据与原命令动作不符，保留原文件');
  const report={schemaVersion:1,readOnly:true,source:'local-files',productionChecked:false,bookId:session?.bookId??job?.bookId??null,
    sessionPath:sessionFile?.path??null,sessionModifiedAt:sessionFile?.modifiedAt??null,
    sessionAgeMs:sessionFile?Math.max(0,now()-Date.parse(sessionFile.modifiedAt)):null,
    commandId:requestedId,boundToCurrent,pending:session?.pending?selected(session.pending,['id','action','at']):null,
    writeBlocked:session?.writeBlocked??null,pauseControl:session?.pauseControl?selected(session.pauseControl,['generation','paused']):null,
    terminalEvidencePath:jobFile?.path??null,
    job:job?{...selected(job,['id','action','running','terminal','phase','phaseTaskId','phaseStartedAt']),
      error:job.error?safeDiagnosticMessage(job.error):null,evidenceError:job.evidenceError?safeDiagnosticMessage(job.evidenceError):null,
      result:job.result?selected(job.result,['stateStatus','stopReason','uncertain','writePerformed']):null,
      timings:summarizeRecordedTimings(job)}:null,
    nextStep:null};
  if(!session)report.nextStep={code:'no-local-session',instruction:'没有本地会话。此诊断没有建立连接，也没有核对平台。'};
  else if(!boundToCurrent&&job)report.nextStep={code:'historical-command',instruction:'这是历史命令证据，不用于收尾当前任务或解除当前写入锁。'};
  else if(session.writeBlocked){
    const blocked=session.blockedContext;
    report.nextStep={code:'reconcile-original-save',instruction:'保留写入锁；先核对原 manifest/state/taskId。命令终止文件本身不能证明保存成功或未保存。',
      binding:blocked?selected(blocked,['manifest','state','manifestSha256','taskId','pendingPath']):null};
  }else if(session.pending){
    report.nextStep={code:job?.terminal===true&&job.running===false?'terminal-evidence-available':'await-original-command',
      instruction:job?.terminal===true&&job.running===false?'已存在原命令的终止文件。让同一服务按严格绑定规则收尾；不要重复派发命令。':'本地尚无原命令终止文件。保留任务；不要把等待超时当作失败后重发。'};
  }else report.nextStep={code:'inspect-recorded-phases',instruction:'可按阶段累计耗时定位慢点。该本地报告没有刷新平台，不能代替保存和全文回读验收。'};
  return report;
}
