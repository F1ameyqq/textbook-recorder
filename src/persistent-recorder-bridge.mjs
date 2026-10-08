import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {NewSystemAdapter} from './new-system-adapter.mjs';
import {validateNewSystemManifest,createNewSystemRun,runNewSystemBatch,compareNewSystemReadback,reconcileNewSystemRun} from './new-system-core.mjs';
import {inspectReviewedBatch} from './review-preflight.mjs';
import {validateRecorderConfig,validateRecorderCommand,assertRecorderPage,existingWorkspacePath,existingWorkspaceDirectory,writableWorkspacePath,prepareRuntimeDirectory} from './recorder-config.mjs';

const copy=structuredClone;
const clean=error=>String(error?.message??'操作失败').replace(/(?:https?|wss?|file):\/\/\S+/giu,'[网址省略]').replace(/\b(?:token|cookie|authorization|password)\s*[:=][^\r\n]*/giu,'[凭据省略]').slice(0,500);
async function atomic(root,file,value){await writableWorkspacePath(root,file);await prepareRuntimeDirectory(root,path.dirname(file));const temp=file+'.'+randomUUID()+'.tmp';await writableWorkspacePath(root,temp);const handle=await fs.open(temp,'wx');try{await handle.writeFile(JSON.stringify(value,null,2));await handle.sync();}finally{await handle.close();}await writableWorkspacePath(root,file);await fs.rename(temp,file);}
const pendingSummary=adapter=>{const pending=adapter?.pendingWrite;return pending?.status==='pending'?{task:{id:pending.task.id},status:'pending',phase:pending.phase,evidencePath:pending.evidencePath}:null;};

/** A typed Node-side bridge. It never submits review, deletes, or runs arbitrary code. */
export async function installPersistentBridge({page,config,adapterFactory=options=>new NewSystemAdapter(options)}){
  const validated=validateRecorderConfig({bookId:config.bookId,origin:config.origin,inputMode:config.inputMode});
  if(page.__persistentRecorder){if(page.__persistentRecorder.status().bookId!==validated.bookId)throw new Error('已存在另一书籍桥接');return page.__persistentRecorder;}
  const root=await fs.realpath(config.root),dataDir=path.join(root,'data/persistent-executor');
  await prepareRuntimeDirectory(root,dataDir);await prepareRuntimeDirectory(root,path.join(dataDir,'jobs'));
  const guard=()=>assertRecorderPage(page.url(),validated.bookId);
  let adapter,job=null,stopping=false;
  const getAdapter=async()=>{guard();await prepareRuntimeDirectory(root,dataDir);for(const folder of ['new-system-recovery','directory-visibility-diagnostics'])await prepareRuntimeDirectory(root,path.join(dataDir,folder));await page.bringToFront();if(!adapter){adapter=adapterFactory({page,baseDir:root,dataDir,source:'production',origin:validated.origin,inputMode:'browser-command',waitForEditors:false});await adapter.connect(validated.bookId);}return adapter;};
  const stage=(phase,taskId=null)=>{const at=new Date().toISOString();if(job.phaseStartedAt)job.timings.push({phase:job.phase,taskId:job.phaseTaskId,startedAt:job.phaseStartedAt,finishedAt:at,elapsedMs:Date.parse(at)-Date.parse(job.phaseStartedAt)});job.phase=phase;job.phaseTaskId=taskId;job.phaseStartedAt=at;};
  const load=async(args,action)=>{
    stage('local-review');const manifestPath=await existingWorkspacePath(root,args.manifest),bytes=await fs.readFile(manifestPath),manifest=JSON.parse(bytes),baseDir=manifest.baseDir?await existingWorkspaceDirectory(root,manifest.baseDir):path.dirname(manifestPath);
    const validation=validateNewSystemManifest(manifest,baseDir),review=await inspectReviewedBatch(manifest,baseDir);
    if(!validation.valid||manifest.source!=='production'||manifest.bookId!==validated.bookId||!review.valid||review.errors?.length||review.readyForExecution===false||manifest.tasks.some(task=>task.review?.status!=='approved'))throw new Error('题单、覆盖、答案要求或书籍校验失败：'+[...validation.errors,...(review.errors??[])].join('; '));
    const statePath=await writableWorkspacePath(root,args.state??manifestPath+'.persistent.run.json');if(statePath===manifestPath)throw new Error('进度不能覆盖題单');
    let state;try{state=JSON.parse(await fs.readFile(await existingWorkspacePath(root,statePath),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;if(action==='reconcile')throw new Error('恢复必须使用原进度文件');state=createNewSystemRun(manifest,{baseDir});}
    const reportPath=path.join(dataDir,'jobs',job.id,'preflight.json');await atomic(root,reportPath,{bookId:validated.bookId,manifestPath,manifestSha256:createHash('sha256').update(bytes).digest('hex'),at:new Date().toISOString(),...review});job.preflightPath=reportPath;
    return {manifestPath,manifest,baseDir,statePath,state};
  };
  const execute=async(action,args)=>{
    if(action==='probe'){
      stage('connecting');const active=await getAdapter();
      if(args.inventory){stage('inventory');guard();await page.reload({waitUntil:'domcontentloaded'});await active.guard({waitForEditors:false});const inventoryPath=path.join(dataDir,'jobs',job.id,'inventory.json'),inventory={bookId:validated.bookId,startedAt:new Date().toISOString(),complete:false,scopes:[]};await atomic(root,inventoryPath,inventory);await active.inventory({onScope:async(row,completed,total)=>{guard();inventory.scopes.push(row);await atomic(root,inventoryPath,inventory);job.progress={status:'reading_inventory',completed,total};}});inventory.complete=true;inventory.finishedAt=new Date().toISOString();await atomic(root,inventoryPath,inventory);return {bookId:validated.bookId,writePerformed:false,inventoryPath,scopes:inventory.scopes.length,records:inventory.scopes.reduce((n,row)=>n+row.records.length,0)};}
      stage('directory-read');const serverSnapshotAt=new Date().toISOString();if(args.sectionLabel)await active.read({target:{chapterLabel:args.chapterLabel,sectionLabel:args.sectionLabel,record:1}},{refresh:true});guard();let recordsPath=null;
      if(args.exportRecords){recordsPath=path.join(dataDir,'jobs',job.id,'scope-records.json');await atomic(root,recordsPath,{bookId:validated.bookId,chapterLabel:args.chapterLabel,sectionLabel:args.sectionLabel,nodeID:active._nodeID,serverSnapshotAt,at:new Date().toISOString(),records:copy(active._directoryRecords)});}
      return {bookId:validated.bookId,connected:true,recordCount:args.sectionLabel?active._directoryRecords.length:null,recordsPath,writePerformed:false};
    }
    const context=await load(args,action);stage('connecting');const active=await getAdapter();active.baseDir=context.baseDir;
    if(action==='readback'){
      const task=context.manifest.tasks.find(row=>row.id===args.taskId);if(!task)throw new Error('任务不在题单中');stage('fresh-readback',task.id);const startedAt=new Date().toISOString(),found=await active.read(task,{refresh:true}),at=new Date().toISOString(),comparison=found.status==='found'?compareNewSystemReadback(task,found,{baseDir:context.baseDir,bookId:validated.bookId}):null;
      const readbackPath=path.join(dataDir,'jobs',job.id,'readback.json');await atomic(root,readbackPath,{bookId:validated.bookId,taskId:task.id,serverSnapshotAt:startedAt,at,readback:found,comparison});let screenshotPath=null;
      if(args.capture){if(!comparison?.ok)throw new Error('只允许截图已保存且全文核对通过的题');guard();screenshotPath=path.join(dataDir,'jobs',job.id,'readback.png');await writableWorkspacePath(root,screenshotPath);await page.screenshot({path:screenshotPath,fullPage:true});guard();}
      return {bookId:validated.bookId,taskId:task.id,status:found.status,recordId:found.recordId??null,comparison,readbackPath,screenshotPath,writePerformed:false};
    }
    if(action==='reconcile'){
      const task=context.manifest.tasks.find(row=>row.id===args.taskId);if(!task)throw new Error('任务不在原题单中');let pendingWrite;if(args.pendingPath)pendingWrite=JSON.parse(await fs.readFile(await existingWorkspacePath(root,args.pendingPath),'utf8'));
      stage('readonly-reconciliation',task.id);const result=await active.reconcile(task,{pendingWrite}),recovery=result.recovery;
      if(recovery?.writeUnlocked){const restored=reconcileNewSystemRun({manifest:context.manifest,state:context.state,taskId:task.id,recovery:result,baseDir:context.baseDir});await atomic(root,context.statePath,restored);}
      return {bookId:validated.bookId,taskId:task.id,statePath:context.statePath,manifestPath:context.manifestPath,recovery,uncertain:!recovery?.writeUnlocked,writePerformed:false};
    }
    if(action==='execute'&&active._uncertain)throw new Error('原保存尚未核对，拒绝再次新增');
    if(action==='execute'){try{const hold=JSON.parse(await fs.readFile(path.join(path.dirname(context.manifestPath),'task-hold.json'),'utf8'));if(hold.batchHeld===true)throw new Error('题单已暂停');}catch(error){if(error.code!=='ENOENT')throw error;}}
    const limit=args.limit??20;await atomic(root,context.statePath,context.state);
    const evidenceDir=path.join(dataDir,'jobs',job.id),readbackEvidence=path.join(evidenceDir,'verification-readbacks.jsonl'),sectionEvidence=path.join(evidenceDir,'verification-sections.json');
    const originalRead=active.read,originalAppend=active.append,sections={},snapshotTimes=new Map();let verifiedReadbacks=0;
    if(action==='verify'){await prepareRuntimeDirectory(root,evidenceDir);await writableWorkspacePath(root,readbackEvidence);await fs.writeFile(readbackEvidence,'',{flag:'wx'});await atomic(root,sectionEvidence,sections);}
    active.read=async(task,options={})=>{
      stage(action==='verify'?'verify-record':active._pendingWrite?.receipt?'saved-record-readback':'fresh-prewrite-read',task.id);const key=JSON.stringify([task.target.chapterLabel,task.target.sectionLabel]);
      const refresh=action==='verify'?(!snapshotTimes.has(key)||active._directoryKey!==key||!await active._scopeMatches(task.target)):options.refresh;
      const startedAt=new Date().toISOString(),found=await originalRead.call(active,task,{...options,refresh}),at=new Date().toISOString();guard();
      if(action==='verify'){if(refresh)snapshotTimes.set(key,startedAt);await writableWorkspacePath(root,readbackEvidence);await fs.appendFile(readbackEvidence,JSON.stringify({taskId:task.id,at,serverSnapshotAt:snapshotTimes.get(key),readback:found})+'\n');sections[key]={chapterLabel:task.target.chapterLabel,sectionLabel:task.target.sectionLabel,nodeID:active._nodeID,at,serverSnapshotAt:snapshotTimes.get(key),records:copy(active._directoryRecords)};await atomic(root,sectionEvidence,sections);verifiedReadbacks++;}
      return found;
    };
    active.append=async(task,options)=>{stage('append-ui',task.id);return originalAppend.call(active,task,options);};
    let result;try{result=await runNewSystemBatch({manifest:context.manifest,state:context.state,adapter:active,baseDir:context.baseDir,verifyOnly:action==='verify',limit,stopRequested:()=>stopping,persist:async state=>{await atomic(root,context.statePath,state);job.progress={status:state.status,completed:state.tasks.filter(row=>['completed','skipped_existing'].includes(row.status)).length,...(action==='verify'?{verifiedReadbacks}:{})};}});}finally{active.read=originalRead;active.append=originalAppend;}
    const unresolved=result.tasks.filter(row=>row.recoveryRequired&&!['completed','skipped_existing'].includes(row.status));
    return {bookId:validated.bookId,statePath:context.statePath,manifestPath:context.manifestPath,stateStatus:result.status,stopReason:result.status==='stopped'?(stopping?'pause':'limit'):null,counts:result.tasks.reduce((all,row)=>({...all,[row.status]:(all[row.status]??0)+1}),{}),uncertain:unresolved.length>0||action==='execute'&&active._uncertain===true,pendingWrite:unresolved.length?pendingSummary(active):null,writePerformed:action==='execute',...(action==='verify'?{readbackEvidence,sectionEvidence}:{})};
  };
  const bridge={
    status:()=>{guard();return {bookId:validated.bookId,job:job?{...copy(job),adapterPhase:adapter?.pendingWrite?.phase??null}:null};},
    pause:()=>{guard();stopping=true;if(job?.running)job.stopRequested=true;return {bookId:validated.bookId,stopRequested:true};},
    start:({id,action,args={}})=>{
      guard();if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,80}$/u.test(id))throw new Error('命令 ID 无效');validateRecorderCommand({id,action,args},root);if(!['probe','verify','execute','readback','reconcile'].includes(action))throw new Error('该动作不可作为浏览器任务');if(job?.running)throw new Error('已有任务运行');if(job?.id===id)throw new Error('命令 ID 已使用');
      stopping=false;job={id,action,running:true,terminal:false,startedAt:new Date().toISOString(),phase:null,phaseTaskId:null,phaseStartedAt:null,timings:[],progress:null};
      execute(action,args).then(result=>{job.result=result;}).catch(error=>{job.error=clean(error);job.result={uncertain:action==='execute'&&(adapter?.pendingWrite?.status==='pending'||adapter?._uncertain===true),pendingWrite:pendingSummary(adapter)};}).finally(async()=>{stage('terminal');job.finishedAt=new Date().toISOString();try{await atomic(root,path.join(dataDir,'jobs',id,'job-result.json'),{...job,running:false,terminal:true});}catch(error){job.evidenceError=clean(error);job.error??=job.evidenceError;if(action==='execute')job.result={...job.result,uncertain:true,pendingWrite:pendingSummary(adapter)};}job.running=false;job.terminal=true;});
      return {bookId:validated.bookId,id,started:true};
    },
  };
  Object.defineProperty(page,'__persistentRecorder',{value:bridge});return bridge;
}
