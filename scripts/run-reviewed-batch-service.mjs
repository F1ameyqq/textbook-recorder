import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {inspectReviewedBatch} from '../src/review-preflight.mjs';
import {createNewSystemRun} from '../src/new-system-core.mjs';
import {existingWorkspacePath,existingWorkspaceDirectory,writableWorkspacePath,loadRecorderConfig} from '../src/recorder-config.mjs';
import {recorderRequest} from './recorder-control.mjs';

const defaultRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const completedStatuses=new Set(['completed','skipped_existing']);
const safeTaskStatuses=new Set(['pending',...completedStatuses]);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

export async function runReviewedBatch(argv,{root=defaultRoot,log=console.log,request=recorderRequest,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
  const options={action:'verify',config:'config/recorder.json',continue:false};
  const supplied=new Set();
  for(const argument of argv){
    if(argument==='--continue'){
      if(supplied.has('continue'))throw new Error('重复参数：--continue');
      supplied.add('continue');options.continue=true;continue;
    }
    const match=argument.match(/^--(manifest|state|action|limit|config)=(.+)$/u);
    if(!match||supplied.has(match[1]))throw new Error('只接受不重复的 --manifest=、--state=、--action=verify|execute、--limit=、--config= 和 --continue');
    supplied.add(match[1]);options[match[1]]=match[1]==='limit'?Number(match[2]):match[2];
  }
  if(!options.manifest||!options.state||!['execute','verify'].includes(options.action)||options.continue&&options.action!=='execute')throw new Error('批处理参数不完整或无效；--continue 仅用于 execute');
  if(supplied.has('limit')&&(!Number.isSafeInteger(options.limit)||options.limit<1||options.limit>1000))throw new Error('批处理 limit 必须为 1–1000');
  const config=await loadRecorderConfig(root,options.config),manifestPath=await existingWorkspacePath(root,options.manifest),statePath=await writableWorkspacePath(root,options.state);
  if(statePath===manifestPath)throw new Error('进度不能覆盖题单');
  const manifestBytes=await fs.readFile(manifestPath),manifestSha256=digest(manifestBytes),manifest=JSON.parse(manifestBytes.toString('utf8'));
  const baseDir=manifest.baseDir?await existingWorkspaceDirectory(root,manifest.baseDir):path.dirname(manifestPath),review=await inspectReviewedBatch(manifest,baseDir);
  if(manifest.bookId!==config.bookId||manifest.source!=='production'||!review.valid||review.errors?.length||review.readyForExecution!==true)throw new Error('本地题单质检未通过：'+(review.errors??[]).join('; '));
  if(!supplied.has('limit'))options.limit=options.action==='verify'?manifest.tasks.length:20;
  if(options.limit>1000)throw new Error('整批 verify 超过 1000 条；请明确分批题单及覆盖边界，不能只核对前 20 条');
  const expected=createNewSystemRun(manifest,{baseDir}),started=Date.now(),rounds=[];
  const reportPath=await writableWorkspacePath(root,statePath+'.'+options.action+'.report.json');
  let connectionCount,boundRunId,preflightStatus,pauseGeneration,continuationGuard,summary=null,lastPrinted=0,lastProgress='',previousDone=new Set();

  const readRun=async({missing=false}={})=>{
    let run,existing=true;
    try{run=JSON.parse(await fs.readFile(await existingWorkspacePath(root,statePath),'utf8'));}
    catch(error){if(!missing||error.code!=='ENOENT')throw error;existing=false;run=structuredClone(expected);}
    if(run.kind!=='new-system-run'||run.schemaVersion!==1||!run.id||run.bookId!==config.bookId||run.source!==manifest.source||run.manifestHash!==expected.manifestHash||!Array.isArray(run.tasks)||run.tasks.length!==manifest.tasks.length||run.tasks.some((row,index)=>!row||row.taskId!==manifest.tasks[index].id))throw new Error('终止进度与当前题单不符，不发布完成报告');
    if(options.continue&&existing){
      if(boundRunId!==undefined&&run.id!==boundRunId)throw new Error('原进度 run.id 已变化；停止自动接续，不能用替代 state');
      boundRunId??=run.id;
    }
    return run;
  };
  const doneIds=run=>new Set(run.tasks.filter(row=>completedStatuses.has(row.status)).map(row=>row.taskId));
  const safeRun=run=>['pending','stopped','completed'].includes(run.status)&&run.tasks.every(row=>safeTaskStatuses.has(row.status)&&row.recoveryRequired===false&&!row.lastError&&Number.isSafeInteger(row.attempts)&&row.attempts>=0);
  const assertStable=async()=>{
    if(await existingWorkspacePath(root,manifestPath)!==manifestPath||await writableWorkspacePath(root,statePath)!==statePath||digest(await fs.readFile(manifestPath))!==manifestSha256||createNewSystemRun(manifest,{baseDir}).manifestHash!==expected.manifestHash)throw new Error('原题单、资产或进度路径已变化；停止自动接续，不替换原 manifest/state');
  };
  if(options.continue){
    const initial=await readRun({missing:true});
    if(!safeRun(initial))throw new Error('原进度有错误、未知保存或未终止任务；不能自动接续');
    previousDone=doneIds(initial);
  }
  const initialCompleted=previousDone.size,maxRounds=options.continue?Math.max(1,manifest.tasks.length-initialCompleted):1;
  const writeReport=async(extra={})=>{
    await writableWorkspacePath(root,reportPath);
    await fs.writeFile(reportPath,JSON.stringify({...summary,bookId:config.bookId,action:options.action,manifestPath,statePath,manifestSha256,
      continuationEnabled:options.continue,limit:options.limit,maxRounds,initialCompleted,boundRunId,preflightStatus,rounds,
      elapsedSeconds:Math.round((Date.now()-started)/1000),...extra},null,2));
  };
  const readFence=status=>{
    const fence=status.continuationFence;
    if(!fence||fence.schemaVersion!==1||!(fence.previousTerminalId===null||typeof fence.previousTerminalId==='string'&&/^[A-Za-z0-9_-]{1,80}$/u.test(fence.previousTerminalId))||!Number.isSafeInteger(fence.pauseGeneration)||fence.pauseGeneration<0||typeof fence.paused!=='boolean')throw new Error('服务缺少有效接续保护状态；请确认空闲、重新启动服务并显式 probe，不提交自动接续');
    if(fence.paused)throw new Error('已请求暂停；停止自动接续，保留原任务与进度');
    if(pauseGeneration!==undefined&&fence.pauseGeneration!==pauseGeneration)throw new Error('暂停 generation 已变化；停止自动接续，不接受新的暂停状态');
    return fence;
  };
  const guardProof=(status,id)=>{
    const proof=status.remote?.job?.id===id?status.remote.job.continuationGuardAccepted:status.last?.id===id?status.last.continuationGuardAccepted:undefined;
    if(!proof||Object.entries({...continuationGuard,bookId:config.bookId,commandId:id}).some(([key,value])=>proof[key]!==value))throw new Error('缺少本命令接续保护的明确接受证明；停止监督，原命令不重放');
    return proof;
  };
  const assertStatus=(status,id)=>{
    if(status.bookId!==config.bookId||status.pending&&status.pending.id!==id)throw new Error('书籍或远端任务不符，停止监督且不重放');
    if(options.continue){
      if(status.error||status.connection!=='connected')throw new Error('连接中断或状态错误；停止自动接续，原命令不重放');
      if(!Number.isSafeInteger(status.connectionCount)||status.connectionCount<1)throw new Error('缺少连接身份，不能自动接续');
      if(status.connectionCount!==connectionCount)throw new Error('连接已重建；停止自动接续，原命令不重放');
      if(status.remote?.job?.stopRequested===true)throw new Error('已请求暂停；停止自动接续，保留原任务与进度');
      readFence(status);guardProof(status,id);
    }
  };
  const finish=async(ok,reason)=>{
    await writeReport({ok,continuationStopReason:reason,finishedAt:new Date().toISOString(),timings:rounds.at(-1)?.timings??[]});
    const result={ok,...summary,continuationEnabled:options.continue,rounds:rounds.length,continued:rounds.length>1,continuationStopReason:reason,reportPath};
    log(JSON.stringify(result));return result;
  };
  log(JSON.stringify({bookId:config.bookId,tasks:manifest.tasks.length,action:options.action,limit:options.limit,continuationEnabled:options.continue}));
  try{
    if(options.continue){
      const before=await request(root,{action:'status'},{configPath:options.config});
      preflightStatus={bookId:before.bookId,connection:before.connection,connectionCount:before.connectionCount,pending:before.pending,writeBlocked:before.writeBlocked,error:before.error??null,recovery:before.recovery,continuationFence:before.continuationFence};
      if(before.bookId!==config.bookId||before.pending!==null||before.writeBlocked!==false||before.error||before.recovery?.required===true)throw new Error('本地执行器已有任务、写入锁或状态错误；不提交自动接续');
      if(before.connection!=='connected')throw new Error('自动接续要求已连接且支持接续保护的服务；先显式 probe，不自动连接旧服务');
      if(!Number.isSafeInteger(before.connectionCount)||before.connectionCount<1)throw new Error('初始状态缺少有效连接身份；不提交自动接续');
      connectionCount=before.connectionCount;
      const fence=readFence(before);pauseGeneration=fence.pauseGeneration;
      continuationGuard={schemaVersion:1,previousTerminalId:fence.previousTerminalId,pauseGeneration,phase:'initial',connectionCount};
    }
    for(let round=1;round<=maxRounds;round++){
      if(options.continue){
        await assertStable();
        const before=await readRun({missing:round===1}),beforeDone=doneIds(before);
        if(!safeRun(before)||beforeDone.size!==previousDone.size||[...previousDone].some(id=>!beforeDone.has(id)))throw new Error('原进度在轮次之间变化或变为不安全；停止自动接续');
      }
      const id=randomUUID(),evidence={round,commandId:id,limit:options.limit,startedAt:new Date().toISOString(),completedBefore:previousDone.size,submissionAttempted:true,terminal:false,...(options.continue?{continuationGuard:structuredClone(continuationGuard)}:{})};
      rounds.push(evidence);await writeReport({status:'supervising'});
      let status=await request(root,{id,action:options.action,args:{manifest:manifestPath,state:statePath,limit:options.limit},...(options.continue?{continuationGuard:structuredClone(continuationGuard)}:{})},{configPath:options.config});
      while(true){
        assertStatus(status,id);
        if(!status.pending){
          if(status.last?.id!==id||options.continue&&status.last.terminal!==true)throw new Error('缺少本命令终止证明，不重复提交');
          if(options.continue&&readFence(status).previousTerminalId!==id)throw new Error('接续保护的终止任务身份不符；不重复提交');
          const run=await readRun(),done=doneIds(run),counts=run.tasks.reduce((all,row)=>({...all,[row.status]:(all[row.status]??0)+1}),{});
          summary={bookId:config.bookId,commandId:id,action:options.action,status:run.status,counts,elapsedSeconds:Math.round((Date.now()-started)/1000),connectionCount:status.connectionCount,writeBlocked:status.writeBlocked,error:status.last.error??status.last.evidenceError??status.last.result?.evidenceError??run.tasks.find(row=>row.lastError)?.lastError??null,recovery:status.recovery};
          const safeStopped=summary.status==='stopped'&&!summary.writeBlocked&&!summary.error;
          summary.limitReached=safeStopped&&status.last.result?.stopReason==='limit';summary.paused=safeStopped&&status.last.result?.stopReason==='pause';summary.stoppedNormally=safeStopped;
          Object.assign(evidence,{terminal:true,finishedAt:new Date().toISOString(),status:run.status,counts,completedAfter:done.size,completedTaskIds:[...done],connectionCount:status.connectionCount,
            writeBlocked:status.writeBlocked,error:summary.error,result:status.last.result??null,recovery:status.recovery,timings:status.last.timings??[],...(options.continue?{continuationGuardAccepted:guardProof(status,id),continuationFence:structuredClone(status.continuationFence)}:{})});
          if(!options.continue)return finish((summary.status==='completed'||safeStopped)&&!summary.writeBlocked&&!summary.error,summary.paused?'pause':summary.limitReached?'limit':'terminal');
          if(status.writeBlocked!==false||summary.error||status.last.result?.uncertain!==false||status.last.result?.pendingWrite||status.recovery?.required===true||!safeRun(run))return finish(false,'unsafe-terminal-state');
          if([...previousDone].some(taskId=>!done.has(taskId)))return finish(false,'progress-regressed');
          if(summary.paused)return finish(true,'pause');
          if(done.size===manifest.tasks.length&&['completed','stopped'].includes(run.status))return finish(true,'all-tasks-completed');
          if(!summary.limitReached)return finish(false,'not-a-limit-stop');
          if(done.size<=previousDone.size)return finish(false,'no-progress');
          previousDone=done;
          if(round===maxRounds)return finish(false,'round-bound-reached');
          await writeReport({status:'supervising',completed:done.size});
          // Recheck the exact terminal command before submitting a different ID.
          const fresh=await request(root,{action:'status'},{configPath:options.config});assertStatus(fresh,id);
          if(fresh.pending||fresh.writeBlocked!==false||fresh.last?.id!==id||fresh.last.terminal!==true||fresh.last.error||fresh.last.evidenceError||fresh.last.result?.evidenceError||fresh.last.result?.stopReason!=='limit'||fresh.last.result?.uncertain!==false||fresh.last.result?.pendingWrite||fresh.recovery?.required===true)throw new Error('原任务安全终止状态已变化；停止自动接续');
          if(readFence(fresh).previousTerminalId!==id)throw new Error('接续保护的上一终止任务已变化；不提交下一轮');
          continuationGuard={schemaVersion:1,previousTerminalId:id,pauseGeneration,phase:'limit',connectionCount};
          log(JSON.stringify({round,completed:done.size,total:manifest.tasks.length,continuing:true}));
          break;
        }
        const progress=JSON.stringify({round,phase:status.remote?.job?.phase,adapterPhase:status.remote?.job?.adapterPhase,progress:status.remote?.job?.progress??null});
        if(progress!==lastProgress&&Date.now()-lastPrinted>=15000){log(progress);lastPrinted=Date.now();lastProgress=progress;}
        await pause(1000);status=await request(root,{action:'status'},{configPath:options.config});
      }
    }
    throw new Error('自动接续达到轮数上界，保留原进度');
  }catch(error){
    await writeReport({ok:false,supervisionError:error.message,continuationStopReason:'supervision-error',finishedAt:new Date().toISOString()});
    throw error;
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){const result=await runReviewedBatch(process.argv.slice(2));if(!result.ok)process.exitCode=1;}
