import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {inspectReviewedBatch} from '../src/review-preflight.mjs';
import {createNewSystemRun} from '../src/new-system-core.mjs';
import {existingWorkspacePath,existingWorkspaceDirectory,writableWorkspacePath,loadRecorderConfig} from '../src/recorder-config.mjs';
import {recorderRequest} from './recorder-control.mjs';

const defaultRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export async function runReviewedBatch(argv,{root=defaultRoot,log=console.log,request=recorderRequest,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
  const options={action:'verify',limit:20,config:'config/recorder.json'};
  for(const argument of argv){const match=argument.match(/^--(manifest|state|action|limit|config)=(.+)$/u);if(!match)throw new Error('只接受 --manifest=、--state=、--action=verify|execute、--limit=、--config=');options[match[1]]=match[1]==='limit'?Number(match[2]):match[2];}
  if(!options.manifest||!options.state||!['execute','verify'].includes(options.action)||!Number.isSafeInteger(options.limit)||options.limit<1||options.limit>1000)throw new Error('批处理参数不完整或无效');
  const config=await loadRecorderConfig(root,options.config),manifestPath=await existingWorkspacePath(root,options.manifest),statePath=await writableWorkspacePath(root,options.state);if(statePath===manifestPath)throw new Error('进度不能覆盖题单');
  const manifest=JSON.parse(await fs.readFile(manifestPath,'utf8')),baseDir=manifest.baseDir?await existingWorkspaceDirectory(root,manifest.baseDir):path.dirname(manifestPath),review=await inspectReviewedBatch(manifest,baseDir);
  if(manifest.bookId!==config.bookId||manifest.source!=='production'||!review.valid||review.errors?.length||review.readyForExecution!==true)throw new Error('本地题单质检未通过：'+(review.errors??[]).join('; '));
  const id=randomUUID(),started=Date.now();log(JSON.stringify({bookId:config.bookId,tasks:manifest.tasks.length,action:options.action,commandId:id}));
  let status=await request(root,{id,action:options.action,args:{manifest:manifestPath,state:statePath,limit:options.limit}},{configPath:options.config});let lastPrinted=0;
  while(true){
    if(status.bookId!==config.bookId||status.pending&&status.pending.id!==id)throw new Error('书籍或远端任务不符，停止监督且不重放');
    if(!status.pending){if(status.last?.id!==id)throw new Error('缺少本命令终止证明，不重复提交');
      const run=JSON.parse(await fs.readFile(await existingWorkspacePath(root,statePath),'utf8')),expected=createNewSystemRun(manifest,{baseDir});if(run.kind!=='new-system-run'||run.bookId!==config.bookId||run.manifestHash!==expected.manifestHash||!Array.isArray(run.tasks)||run.tasks.length!==manifest.tasks.length||run.tasks.some((row,index)=>row.taskId!==manifest.tasks[index].id))throw new Error('终止进度与当前题单不符，不发布完成报告');
      const counts=run.tasks.reduce((all,row)=>({...all,[row.status]:(all[row.status]??0)+1}),{}),summary={bookId:config.bookId,commandId:id,action:options.action,status:run.status,counts,elapsedSeconds:Math.round((Date.now()-started)/1000),connectionCount:status.connectionCount,writeBlocked:status.writeBlocked,error:status.last.error??run.tasks.find(row=>row.lastError)?.lastError??null,recovery:status.recovery};
      const safeStopped=summary.status==='stopped'&&!summary.writeBlocked&&!summary.error;summary.limitReached=safeStopped&&status.last.result?.stopReason==='limit';summary.paused=safeStopped&&status.last.result?.stopReason==='pause';summary.stoppedNormally=safeStopped;
      log(JSON.stringify(summary));const reportPath=await writableWorkspacePath(root,statePath+'.'+options.action+'.report.json');await fs.writeFile(reportPath,JSON.stringify({...summary,finishedAt:new Date().toISOString(),timings:status.last.timings??[]},null,2));return {ok:(summary.status==='completed'||safeStopped)&&!summary.writeBlocked&&!summary.error,...summary};
    }
    if(Date.now()-lastPrinted>=15000){log(JSON.stringify({elapsedSeconds:Math.round((Date.now()-started)/1000),phase:status.remote?.job?.phase,adapterPhase:status.remote?.job?.adapterPhase,progress:status.remote?.job?.progress??null,connectionCount:status.connectionCount,recovery:status.recovery}));lastPrinted=Date.now();}
    await pause(1000);status=await request(root,{action:'status'},{configPath:options.config});
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){const result=await runReviewedBatch(process.argv.slice(2));if(!result.ok)process.exitCode=1;}
