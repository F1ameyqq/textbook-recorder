import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {NewSystemAdapter} from './new-system-adapter.mjs';
import {recoverPreAppendSourceFailure} from './pre-append-recovery.mjs';
import {activateRecorderPage} from './browser-focus.mjs';
import {ReviewedRecordCorrectionAdapter} from './reviewed-record-correction.mjs';
import {validateRecordRepairSnapshot} from './reviewed-record-repair-snapshot.mjs';
import {validateNewSystemManifest,createNewSystemRun,runNewSystemBatch,compareNewSystemReadback,reconcileNewSystemRun,renderEditorHtml} from './new-system-core.mjs';
import {inspectReviewedBatch} from './review-preflight.mjs';
import {collectSourcePages} from './source-collector.mjs';
import {validateRecorderConfig,validateRecorderCommand,assertRecorderPage,existingWorkspacePath,existingWorkspaceDirectory,writableWorkspacePath,prepareRuntimeDirectory} from './recorder-config.mjs';
import {recorderCommandFingerprint} from './recorder-terminal-evidence.mjs';
import {readonlyNetworkGuard,readonlyNetworkCommandEvidence} from './readonly-network-guard.mjs';

const copy=structuredClone;
const clean=error=>String(error?.message??'操作失败').replace(/(?:https?|wss?|file):\/\/\S+/giu,'[网址省略]').replace(/\b(?:token|cookie|authorization|password)\s*[:=][^\r\n]*/giu,'[凭据省略]').slice(0,500);
async function atomic(root,file,value){await writableWorkspacePath(root,file);await prepareRuntimeDirectory(root,path.dirname(file));const temp=file+'.'+randomUUID()+'.tmp';await writableWorkspacePath(root,temp);const handle=await fs.open(temp,'wx');try{await handle.writeFile(JSON.stringify(value,null,2));await handle.sync();}finally{await handle.close();}await writableWorkspacePath(root,file);await fs.rename(temp,file);}
const pendingSummary=adapter=>{const pending=adapter?.pendingWrite;return pending?.status==='pending'?{task:{id:pending.task.id},status:'pending',phase:pending.phase,evidencePath:pending.evidencePath}:null;};

/** Read only the exact empty editors and their owning app instance. */
export function readRecorderWindowPreparationSnapshot(bookId){
  const stems=document.querySelectorAll('#contentedit .w-e-text'),answers=document.querySelectorAll('#answeredit .w-e-text');
  const result={confirmedEmpty:false,reason:'editor-not-unique',editorCounts:[stems.length,answers.length],ownerCount:0,focusFlag:false,initialEmptyModel:false};
  if(stems.length!==1||answers.length!==1)return result;
  const editors=[stems[0],answers[0]];
  const empty=editors.every(editor=>!editor.textContent.trim()&&!editor.innerText.trim()&&[...editor.querySelectorAll('*')].every(node=>['P','DIV','SPAN','BR'].includes(node.tagName)));
  const visited=new Set(),queue=document.querySelector('#app')?.__vue__?[document.querySelector('#app').__vue__]:[],candidates=[];
  while(queue.length&&visited.size<2000){const vm=queue.shift();if(!vm||visited.has(vm))continue;visited.add(vm);if(vm.$refs?.contentedit?.editor?.$textElem?.elems?.[0]===editors[0]&&vm.$refs?.answeredit?.editor?.$textElem?.elems?.[0]===editors[1])candidates.push(vm);if(Array.isArray(vm.$children))queue.push(...vm.$children);}
  result.ownerCount=candidates.length;
  if(!empty)return {...result,reason:'editor-content'};
  if(queue.length||candidates.length!==1)return {...result,reason:'owner-not-unique'};
  const owner=candidates[0];result.focusFlag=owner.focus===true;
  if(Number(owner.textbookID)!==bookId)return {...result,reason:'wrong-book'};
  if(owner.focus!==true)return {...result,confirmedEmpty:true,reason:'empty-editors'};
  // The platform's empty initialization onchange sets focus=true as well.
  // Accept only its unselected initial model: saveQuestion returns before any
  // request when index is absent. Never clear the app flag or edit its state.
  const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  const emptyHtml=value=>{
    if(typeof value!=='string'||value.length>1024)return false;
    const holder=document.createElement('div');holder.innerHTML=value;
    return !holder.textContent.trim()&&[...holder.querySelectorAll('*')].every(node=>['P','DIV','SPAN','BR'].includes(node.tagName)&&node.attributes.length===0);
  };
  const model=owner.checkedShitiInfo;
  const initial=object(owner.currentDirectoryNode)&&Object.keys(owner.currentDirectoryNode).length===0
    &&Array.isArray(owner.shitiList)&&owner.shitiList.length===0&&owner.selectedQuestionID===-1&&owner.lastSeqIndex===0
    &&object(model)&&Object.keys(model).every(key=>['question','answer'].includes(key)&&emptyHtml(model[key]));
  return {...result,confirmedEmpty:initial,reason:initial?'initial-empty-model':'dirty-or-selected-model',initialEmptyModel:initial};
}

/** A typed Node-side bridge. It never submits review, deletes, or runs arbitrary code. */
export async function installPersistentBridge({page,config,adapterFactory=options=>new NewSystemAdapter(options)}){
  const validated=validateRecorderConfig({bookId:config.bookId,origin:config.origin,inputMode:config.inputMode,focusMode:config.focusMode,windowMode:config.windowMode,browserBackend:config.browserBackend,browserProfileDir:config.browserProfileDir,readOnly:config.readOnly});
  assertRecorderPage(page.url(),validated.bookId);
  if(page.__persistentRecorder){const existing=page.__persistentRecorder.status();if(existing.bookId!==validated.bookId||existing.focusMode!==validated.focusMode||existing.windowMode!==validated.windowMode||(existing.readOnly??false)!==(validated.readOnly??false))throw new Error('已存在桥接的书籍、浏览器或 readOnly 模式不匹配');return page.__persistentRecorder;}
  const root=await fs.realpath(config.root),dataDir=path.join(root,'data/persistent-executor');
  await prepareRuntimeDirectory(root,dataDir);await prepareRuntimeDirectory(root,path.join(dataDir,'jobs'));
  const networkGuard=validated.readOnly?readonlyNetworkGuard(page,{bookId:validated.bookId}):null;
  const readonlyIdentity=()=>validated.readOnly?{readOnly:true,readOnlyNetwork:networkGuard.snapshot()}:{};
  const guard=()=>assertRecorderPage(page.url(),validated.bookId);
  let adapter,job=null,stopping=false,pauseGeneration=0,pauseLatched=false,normalWindowPreparation=null;
  const continuationFence=()=>({schemaVersion:1,previousTerminalId:job?.terminal===true?job.id:null,pauseGeneration,paused:pauseLatched});
  const probeDirectoryFailure=async error=>{
    if(error?.normalWindowPreparationReadiness)return {writePerformed:false,normalWindowPreparationReadiness:copy(error.normalWindowPreparationReadiness)};
    if(error?.code!=='TARGET_VISIBILITY_TIMEOUT'||!['directory-root','directory-chapter','directory-section'].includes(error.targetRole))return {};
    const diagnostic={code:error.code,targetRole:error.targetRole,phase:error.targetRole==='directory-root'?'refresh-directory-root':'directory-selection'};
    if(typeof error.directoryVisibilityEvidencePath==='string'){
      try{
        const evidencePath=await existingWorkspacePath(root,error.directoryVisibilityEvidencePath);
        const relative=path.relative(path.join(dataDir,'directory-visibility-diagnostics'),evidencePath);
        if(relative&&!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&path.extname(evidencePath)==='.json')diagnostic.evidencePath=evidencePath;
      }catch{}
    }
    return {writePerformed:false,directoryVisibilityDiagnostic:diagnostic};
  };
  const prepareNormalWindow=async()=>{
    const windowBridge=page.context?.()?.browser?.()?.__textbookRecorderWindowBridge;
    if(typeof windowBridge?.prepareNormalWindow!=='function')throw new Error('当前连接不支持指定书页的独立正常窗口准备');
    const preparingJob=job;
    const assertProbe=()=>{guard();if(!preparingJob||job!==preparingJob||preparingJob.running!==true||preparingJob.terminal!==false||preparingJob.action!=='probe'||preparingJob.stopRequested===true)throw new Error('窗口创建或移动仅允许当前单一只读探测');};
    const guardMutation=async()=>{
      assertProbe();
      const sessionPath=await existingWorkspacePath(root,path.join(dataDir,'session.json'));
      const state=JSON.parse(await fs.readFile(sessionPath,'utf8'));assertProbe();
      if(state.schemaVersion!==1||state.bookId!==validated.bookId||state.writeBlocked!==false||state.blockedContext!==null
        ||state.pending?.id!==preparingJob.id||state.pending.action!=='probe'||state.pending.servicePid!==process.pid)throw new Error('窗口准备缺少当前无写入锁的同一探测会话');
      const snapshot=await page.evaluate(readRecorderWindowPreparationSnapshot,validated.bookId);assertProbe();
      if(snapshot?.confirmedEmpty!==true){const error=new Error('窗口准备要求两个唯一空编辑器且无待保存修改');error.normalWindowPreparationReadiness=snapshot;throw error;}
    };
    const receipt=await windowBridge.prepareNormalWindow(page,{guardMutation});guard();
    if(!receipt||Object.keys(receipt).sort().join(',')!=='bookTabActive,created,documentTimeOrigin,helperTabActive,tabId,windowFocused,windowId,windowState'
      ||!Number.isSafeInteger(receipt.tabId)||receipt.tabId<1||!Number.isSafeInteger(receipt.windowId)||receipt.windowId<1
      ||receipt.windowState!=='normal'||receipt.bookTabActive!==true||receipt.helperTabActive!==false||receipt.windowFocused!==false
      ||typeof receipt.created!=='boolean'||!Number.isFinite(receipt.documentTimeOrigin)||receipt.documentTimeOrigin<=0)throw new Error('独立正常窗口准备回执不完整');
    normalWindowPreparation=copy(receipt);if(job===preparingJob&&job)job.normalWindowPreparation=copy(receipt);
  };
  const getAdapter=async()=>{guard();await prepareRuntimeDirectory(root,dataDir);for(const folder of ['new-system-recovery','directory-visibility-diagnostics'])await prepareRuntimeDirectory(root,path.join(dataDir,folder));await activateRecorderPage(page,validated.focusMode,{windowMode:validated.windowMode,guard});if(!adapter){adapter=adapterFactory({page,baseDir:root,dataDir,source:'production',origin:validated.origin,inputMode:'browser-command',focusMode:validated.focusMode,windowMode:validated.windowMode,directoryTimeout:60000,directoryRootTimeout:validated.focusMode==='background'&&validated.windowMode==='minimized'?90000:60000,waitForEditors:false});await adapter.connect(validated.bookId);}return adapter;};
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
    if(action==='collect'){
      stage('connecting');const active=await getAdapter();
      const guardNavigation=async()=>{guard();if(active._busy||active._uncertain||pendingSummary(active))throw new Error('存在未完成编辑或待核对保存，禁止采集导航');};
      await guardNavigation();stage('collecting-sources');
      return collectSourcePages({page,root,bookId:validated.bookId,from:args.from,to:args.to,output:args.output??path.join('data/jobs',job.id),guardNavigation,stopRequested:()=>stopping,onProgress:async progress=>{job.progress=progress;}});
    }
    if(action==='probe'){
      stage('connecting');const active=await getAdapter();
      if(args.inventory){stage('inventory');guard();await page.reload({waitUntil:'domcontentloaded'});await active.guard({waitForEditors:false});const inventoryPath=path.join(dataDir,'jobs',job.id,'inventory.json'),inventory={bookId:validated.bookId,startedAt:new Date().toISOString(),complete:false,scopes:[]};await atomic(root,inventoryPath,inventory);await active.inventory({onScope:async(row,completed,total)=>{guard();inventory.scopes.push(row);await atomic(root,inventoryPath,inventory);job.progress={status:'reading_inventory',completed,total};}});inventory.complete=true;inventory.finishedAt=new Date().toISOString();await atomic(root,inventoryPath,inventory);return {bookId:validated.bookId,...readonlyIdentity(),writePerformed:false,inventoryPath,scopes:inventory.scopes.length,records:inventory.scopes.reduce((n,row)=>n+row.records.length,0)};}
      stage('directory-read');const serverSnapshotAt=new Date().toISOString();if(args.sectionLabel)await active.read({target:{chapterLabel:args.chapterLabel,sectionLabel:args.sectionLabel,record:1}},{refresh:true});guard();let recordsPath=null;
      if(args.exportRecords){recordsPath=path.join(dataDir,'jobs',job.id,'scope-records.json');await atomic(root,recordsPath,{bookId:validated.bookId,chapterLabel:args.chapterLabel,sectionLabel:args.sectionLabel,nodeID:active._nodeID,serverSnapshotAt,at:new Date().toISOString(),records:copy(active._directoryRecords)});}
      return {bookId:validated.bookId,...readonlyIdentity(),connected:true,recordCount:args.sectionLabel?active._directoryRecords.length:null,recordsPath,writePerformed:false};
    }
    const context=await load(args,action);stage('connecting');const active=await getAdapter();active.baseDir=context.baseDir;
    if(action==='readback'){
      const task=context.manifest.tasks.find(row=>row.id===args.taskId);if(!task)throw new Error('任务不在题单中');stage('fresh-readback',task.id);const startedAt=new Date().toISOString(),found=await active.read(task,{refresh:true}),at=new Date().toISOString(),comparison=found.status==='found'?compareNewSystemReadback(task,found,{baseDir:context.baseDir,bookId:validated.bookId}):null;
      const readbackPath=path.join(dataDir,'jobs',job.id,'readback.json');await atomic(root,readbackPath,{bookId:validated.bookId,taskId:task.id,serverSnapshotAt:startedAt,at,readback:found,comparison});let screenshotPath=null;
      if(args.capture){if(!comparison?.ok)throw new Error('只允许截图已保存且全文核对通过的题');guard();screenshotPath=path.join(dataDir,'jobs',job.id,'readback.png');await writableWorkspacePath(root,screenshotPath);await page.screenshot({path:screenshotPath,fullPage:true});guard();}
      return {bookId:validated.bookId,...readonlyIdentity(),taskId:task.id,status:found.status,recordId:found.recordId??null,comparison,readbackPath,screenshotPath,writePerformed:false};
    }
    if(action==='reconcile'){
      const task=context.manifest.tasks.find(row=>row.id===args.taskId);if(!task)throw new Error('任务不在原题单中');let pendingWrite;if(args.pendingPath)pendingWrite=JSON.parse(await fs.readFile(await existingWorkspacePath(root,args.pendingPath),'utf8'));
      const promoteHistorical=async(result,assertCurrent)=>{
        const original=copy(context.state),restore=async error=>{
          const held=copy(original),entry=held.tasks.find(row=>row.taskId===task.id);
          entry.recoveryHistory??=[];entry.recoveryHistory.push({outcome:'unknown',taskId:task.id,bookId:validated.bookId,manifestHash:held.manifestHash,evidencePath:result.recovery.evidencePath,confirmedAt:new Date().toISOString(),error:clean(error)});
          await atomic(root,context.statePath,held);
        };
        assertCurrent();const restored=reconcileNewSystemRun({manifest:context.manifest,state:copy(original),taskId:task.id,recovery:result,baseDir:context.baseDir});
        try{assertCurrent();await atomic(root,context.statePath,restored);assertCurrent();}
        catch(error){await restore(error);throw error;}
        return restore;
      };
      stage('readonly-reconciliation',task.id);const result=args.historicalNetworkEvidencePath
        ? await active.reconcileHistoricalNetwork(task,{root,context,pendingPath:args.pendingPath,historicalNetworkEvidencePath:args.historicalNetworkEvidencePath,evidencePath:path.join(dataDir,'jobs',job.id,'historical-network-recovery.json'),promote:promoteHistorical})
        : args.preAppendFailureCommandId||args.preStemFailureCommandId
        ? await recoverPreAppendSourceFailure(active,{root,dataDir,context,task,failureCommandId:args.preAppendFailureCommandId??args.preStemFailureCommandId,baselineCommandId:args.baselineProbeCommandId,pendingPath:args.pendingPath,evidencePath:path.join(dataDir,'jobs',job.id,'pre-append-recovery.json')})
        : await active.reconcile(task,{pendingWrite}),recovery=result.recovery;
      if(recovery?.writeUnlocked&&!args.historicalNetworkEvidencePath){const restored=reconcileNewSystemRun({manifest:context.manifest,state:context.state,taskId:task.id,recovery:result,baseDir:context.baseDir});await atomic(root,context.statePath,restored);}
      return {bookId:validated.bookId,...readonlyIdentity(),taskId:task.id,statePath:context.statePath,manifestPath:context.manifestPath,recovery,uncertain:!recovery?.writeUnlocked,writePerformed:false};
    }
    if(action==='complete-record-repair'){
      const task=context.manifest.tasks.find(row=>row.id===args.taskId),ref=context.manifest.correction?.beforeSnapshot;
      if(!task||context.manifest.tasks.length!==1||!ref||!args.pendingPath)throw new Error('补全缺少原单题、已授权快照或待核对意图');
      const snapshotPath=await existingWorkspacePath(root,path.join(path.dirname(context.manifestPath),ref.path));
      if(path.dirname(snapshotPath)!==path.dirname(context.manifestPath))throw new Error('补全快照必须位于同一job');
      const bytes=await fs.readFile(snapshotPath);
      if(createHash('sha256').update(bytes).digest('hex')!==ref.sha256)throw new Error('补全冻结快照SHA256变化');
      const snapshot=JSON.parse(bytes),pendingPath=await existingWorkspacePath(root,args.pendingPath),pending=JSON.parse(await fs.readFile(pendingPath,'utf8'));
      let rejectedParameterProof;
      if(args.priorCompletionCommandId){
        const priorDir=path.join(dataDir,'jobs',args.priorCompletionCommandId);
        const priorJob=JSON.parse(await fs.readFile(await existingWorkspacePath(root,path.join(priorDir,'job-result.json')),'utf8'));
        const priorPreflight=JSON.parse(await fs.readFile(await existingWorkspacePath(root,path.join(priorDir,'preflight.json')),'utf8'));
        const priorEventBytes=await fs.readFile(await existingWorkspacePath(root,path.join(priorDir,'completion-events.jsonl')));
        const priorEvents=priorEventBytes.toString('utf8').trim().split('\n').map(JSON.parse);
        const priorReply=priorEvents.find(e=>e.taskId===task.id&&e.phase==='completion-save-response')?.receipt?.response;
        const originalIntent=JSON.parse(await fs.readFile(await existingWorkspacePath(root,pendingPath+'.completion.json'),'utf8'));
        if(priorJob.id!==args.priorCompletionCommandId||priorJob.action!=='complete-record-repair'||priorJob.terminal!==true
          ||priorPreflight.manifestPath!==context.manifestPath||priorPreflight.manifestSha256!==createHash('sha256').update(await fs.readFile(context.manifestPath)).digest('hex')
          ||priorReply?.status!==200||priorReply.body?.errno!==300001||priorReply.body?.data!==undefined
          ||originalIntent.taskId!==task.id||originalIntent.body?.shitiID!==task.target.expectedRecordId
          ||originalIntent.body?.question!==renderEditorHtml(task.stem,context.baseDir)||originalIntent.body?.answer!==renderEditorHtml(task.answer,context.baseDir))throw new Error('原补全没有明确、绑定原任务的参数错误回执，不能新请求');
        rejectedParameterProof={verified:true,errno:300001,commandId:args.priorCompletionCommandId,journalSha256:createHash('sha256').update(priorEventBytes).digest('hex')};
      }
      const eventsPath=path.join(dataDir,'jobs',job.id,'completion-events.jsonl');await fs.writeFile(eventsPath,'',{flag:'wx'});
      const {completeReviewedRecordRepair}=await import('./complete-reviewed-record-repair.mjs');
      stage('complete-approved-existing-record',task.id);
      const result=await completeReviewedRecordRepair(active,task,{snapshot,pending,pendingPath,rejectedParameterProof,
        checkpoint:async event=>fs.appendFile(eventsPath,JSON.stringify({taskId:task.id,at:new Date().toISOString(),...event})+'\n')});
      const restored=reconcileNewSystemRun({manifest:context.manifest,state:context.state,taskId:task.id,recovery:result,baseDir:context.baseDir});
      restored.tasks[0].receipt=result.receipt??restored.tasks[0].receipt;
      await atomic(root,context.statePath,restored);
      return {bookId:validated.bookId,...readonlyIdentity(),taskId:task.id,statePath:context.statePath,manifestPath:context.manifestPath,
        recovery:result.recovery,stateStatus:restored.status,uncertain:false,writePerformed:Boolean(result.receipt),eventsPath};
    }
    if(action==='execute'&&active._uncertain)throw new Error('原保存尚未核对，拒绝再次新增');
    if(action==='execute'&&context.manifest.correction){
      const correction=context.manifest.correction;
      if(correction.schemaVersion!==1||typeof correction.beforeManifest!=='string'||!/^[a-f0-9]{64}$/u.test(correction.beforeSha256??''))throw new Error('修订缺少已审原题单绑定');
      const beforePath=await existingWorkspacePath(root,path.join(path.dirname(context.manifestPath),correction.beforeManifest));
      const bytes=await fs.readFile(beforePath),before=JSON.parse(bytes);
      if(createHash('sha256').update(bytes).digest('hex')!==correction.beforeSha256||before.bookId!==validated.bookId||before.tasks.length!==context.manifest.tasks.length||!validateNewSystemManifest(before,context.baseDir).valid)throw new Error('修订原题单哈希、书籍或范围不符');
      for(const [i,task] of context.manifest.tasks.entries())if(task.id!==before.tasks[i].id||!Number.isSafeInteger(task.target.expectedRecordId)||JSON.stringify(task.target)!==JSON.stringify(before.tasks[i].target)||JSON.stringify(task.source)!==JSON.stringify(before.tasks[i].source))throw new Error('修订范围、原ID或来源改变');
      let repairSnapshot;
      if(correction.beforeSnapshot!==undefined){
        const ref=correction.beforeSnapshot;
        if(context.manifest.tasks.length!==1||typeof ref?.path!=='string'||!/^[a-f0-9]{64}$/u.test(ref.sha256??''))throw new Error('修复快照须为单题及明确文件哈希绑定');
        const snapshotPath=await existingWorkspacePath(root,path.join(path.dirname(context.manifestPath),ref.path));
        if(path.dirname(snapshotPath)!==path.dirname(context.manifestPath))throw new Error('修复快照须与题单同作业根');
        const snapshotBytes=await fs.readFile(snapshotPath);
        if(createHash('sha256').update(snapshotBytes).digest('hex')!==ref.sha256)throw new Error('修复快照哈希不符');
        repairSnapshot=JSON.parse(snapshotBytes);validateRecordRepairSnapshot(repairSnapshot,context.manifest.tasks[0],validated.bookId);
      }
      if(context.state.tasks.some(row=>row.status!=='pending'&&(row.status!=='completed'||row.comparison?.ok!==true)))throw new Error('修订进度有未知结果或缺少回读；不可重放修订');
      const correcting=new ReviewedRecordCorrectionAdapter({page,baseDir:context.baseDir,dataDir,source:'production',origin:validated.origin,inputMode:'browser-command',focusMode:validated.focusMode,windowMode:validated.windowMode,directoryTimeout:60000,waitForEditors:false});
      await correcting.connect(validated.bookId);
      const correctionState=context.state,eventsPath=path.join(dataDir,'jobs',job.id,'correction-events.jsonl');
      await fs.writeFile(eventsPath,'',{flag:'wx'});await atomic(root,context.statePath,correctionState);
      let completed=correctionState.tasks.filter(row=>row.status==='completed').length,processed=0;
      try{
        for(const [i,task] of context.manifest.tasks.entries()){
          if(correctionState.tasks[i].status==='completed')continue;
          if(stopping||processed>=(args.limit??20))break;
          stage('correct-existing-record',task.id);
          const checkpoint=async event=>{await fs.appendFile(eventsPath,JSON.stringify({taskId:task.id,at:new Date().toISOString(),...event})+'\n');};
          let result;
          if(repairSnapshot){
            if(repairSnapshot.records.length!==task.target.record)throw new Error('空答案来源补全当前仅支持目录末题');
            const found=await correcting.read(task,{refresh:true});
            if(found.recordId!==task.target.expectedRecordId||JSON.stringify(correcting._directoryRecords)!==JSON.stringify(repairSnapshot.records))throw new Error('空答案补全前完整目录已变化');
            correcting._pendingWrite={status:'pending',phase:'correction',task:copy(task),before:copy(before.tasks[i]),
              priorRecords:copy(repairSnapshot.records),observedSaveRequests:0};
            await correcting._persistPendingWrite();correcting._uncertain=true;
            const {completeReviewedRecordRepair}=await import('./complete-reviewed-record-repair.mjs');
            const completedRepair=await completeReviewedRecordRepair(correcting,task,{snapshot:repairSnapshot,
              pending:copy(correcting.pendingWrite),pendingPath:correcting.pendingWrite.evidencePath,checkpoint});
            result={receipt:completedRepair.receipt,readback:completedRepair,
              comparison:compareNewSystemReadback(task,completedRepair,{baseDir:context.baseDir,bookId:validated.bookId})};
          }else result=await correcting.replaceRecord(task,{expectedBefore:before.tasks[i],checkpoint});
          Object.assign(correctionState.tasks[i],{status:'completed',recordId:task.target.expectedRecordId,receipt:result.receipt,readback:result.readback,comparison:result.comparison});completed++;processed++;job.progress={completed,total:context.manifest.tasks.length};await atomic(root,context.statePath,correctionState);
        }
        correctionState.status=completed===context.manifest.tasks.length?'completed':'stopped';await atomic(root,context.statePath,correctionState);
        return {bookId:validated.bookId,...readonlyIdentity(),statePath:context.statePath,manifestPath:context.manifestPath,stateStatus:correctionState.status,stopReason:correctionState.status==='stopped'?(stopping?'pause':'limit'):null,counts:{completed,pending:context.manifest.tasks.length-completed},uncertain:false,writePerformed:true,correction:true,eventsPath};
      }catch(error){
        if(correcting._uncertain||correcting.pendingWrite){active._uncertain=true;active._pendingWrite=correcting.pendingWrite;}
        throw error;
      }
    }
    if(action==='execute'){try{const hold=JSON.parse(await fs.readFile(path.join(path.dirname(context.manifestPath),'task-hold.json'),'utf8'));if(hold.batchHeld===true)throw new Error('题单已暂停');}catch(error){if(error.code!=='ENOENT')throw error;}}
    const limit=args.limit??20;await atomic(root,context.statePath,context.state);
    const evidenceDir=path.join(dataDir,'jobs',job.id),readbackEvidence=path.join(evidenceDir,'verification-readbacks.jsonl'),sectionEvidence=path.join(evidenceDir,'verification-sections.json');
    const originalRead=active.read,originalAppend=active.append,sections={},snapshotTimes=new Map();let verifiedReadbacks=0;
    if(action==='verify'){await prepareRuntimeDirectory(root,evidenceDir);await writableWorkspacePath(root,readbackEvidence);await fs.writeFile(readbackEvidence,'',{flag:'wx'});await atomic(root,sectionEvidence,sections);}
    active.read=async(task,options={})=>{
      stage(action==='verify'?'verify-record':active._pendingWrite?.receipt&&active._pendingWrite.task?.id===task.id?'saved-record-readback':'fresh-prewrite-read',task.id);const key=JSON.stringify([task.target.chapterLabel,task.target.sectionLabel]);
      const refresh=action==='verify'?(!snapshotTimes.has(key)||active._directoryKey!==key||!await active._scopeMatches(task.target)):options.refresh;
      const startedAt=new Date().toISOString(),found=await originalRead.call(active,task,{...options,refresh}),at=new Date().toISOString();guard();
      if(action==='verify'){if(refresh)snapshotTimes.set(key,startedAt);await writableWorkspacePath(root,readbackEvidence);await fs.appendFile(readbackEvidence,JSON.stringify({taskId:task.id,at,serverSnapshotAt:snapshotTimes.get(key),readback:found})+'\n');sections[key]={chapterLabel:task.target.chapterLabel,sectionLabel:task.target.sectionLabel,nodeID:active._nodeID,at,serverSnapshotAt:snapshotTimes.get(key),records:copy(active._directoryRecords)};await atomic(root,sectionEvidence,sections);verifiedReadbacks++;}
      return found;
    };
    active.append=async(task,options)=>{stage('append-ui',task.id);return originalAppend.call(active,task,options);};
    let result;try{result=await runNewSystemBatch({manifest:context.manifest,state:context.state,adapter:active,baseDir:context.baseDir,verifyOnly:action==='verify',limit,stopRequested:()=>stopping,persist:async state=>{await atomic(root,context.statePath,state);job.progress={status:state.status,completed:state.tasks.filter(row=>['completed','skipped_existing'].includes(row.status)).length,...(action==='verify'?{verifiedReadbacks}:{})};}});}finally{active.read=originalRead;active.append=originalAppend;}
    const unresolved=result.tasks.filter(row=>row.recoveryRequired&&!['completed','skipped_existing'].includes(row.status));
    return {bookId:validated.bookId,...readonlyIdentity(),statePath:context.statePath,manifestPath:context.manifestPath,stateStatus:result.status,stopReason:result.status==='stopped'?(stopping?'pause':'limit'):null,counts:result.tasks.reduce((all,row)=>({...all,[row.status]:(all[row.status]??0)+1}),{}),uncertain:unresolved.length>0||action==='execute'&&active._uncertain===true,pendingWrite:unresolved.length?pendingSummary(active):null,writePerformed:action==='execute',...(action==='verify'?{readbackEvidence,sectionEvidence}:{})};
  };
  const bridge={
    status:()=>{guard();const windowBridge=page.context?.()?.browser?.()?.__textbookRecorderWindowBridge;return {bookId:validated.bookId,readOnly:validated.readOnly??false,...readonlyIdentity(),focusMode:validated.focusMode,windowMode:validated.windowMode,pausePersistenceSupported:true,...(normalWindowPreparation?{normalWindowPreparation:copy(normalWindowPreparation)}:{}),...(typeof windowBridge?.cleanup==='function'?{windowHelperCleanupSupported:true}:{}),continuationFence:continuationFence(),job:job?{...copy(job),adapterPhase:adapter?.pendingWrite?.phase??null}:null};},
    cleanupWindowHelper:async()=>{guard();if(job?.running)throw new Error('任务未确认终止，不能清理窗口辅助页');const windowBridge=page.context?.()?.browser?.()?.__textbookRecorderWindowBridge;if(typeof windowBridge?.cleanup!=='function')throw new Error('当前连接没有窗口辅助页协议');const cleanup=await windowBridge.cleanup();guard();return {bookId:validated.bookId,...readonlyIdentity(),cleanup};},
    syncPause:control=>{guard();if(!control||control.schemaVersion!==1||Object.keys(control).some(key=>!['schemaVersion','generation','paused'].includes(key))||!Number.isSafeInteger(control.generation)||control.generation<0||typeof control.paused!=='boolean')throw new Error('持久暂停同步参数无效');pauseGeneration=Math.max(pauseGeneration,control.generation);pauseLatched ||= control.paused;if(pauseLatched)stopping=true;return {bookId:validated.bookId,...readonlyIdentity(),continuationFence:continuationFence()};},
    pause:(options={})=>{guard();if(Object.keys(options).some(key=>key!=='pauseGeneration')||options.pauseGeneration!==undefined&&(!Number.isSafeInteger(options.pauseGeneration)||options.pauseGeneration<1))throw new Error('暂停版本无效');stopping=true;pauseLatched=true;pauseGeneration=options.pauseGeneration===undefined?pauseGeneration+1:Math.max(pauseGeneration,options.pauseGeneration);if(job)job.stopRequested=true;return {bookId:validated.bookId,...readonlyIdentity(),stopRequested:true,continuationFence:continuationFence()};},
    start:({id,action,args={},continuationGuard,resumePauseGeneration})=>{
      guard();if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,80}$/u.test(id))throw new Error('命令 ID 无效');const command=validateRecorderCommand({id,action,args,...(continuationGuard===undefined?{}:{continuationGuard})},root);if(!['probe','collect','verify','execute','readback','reconcile','complete-record-repair'].includes(action))throw new Error('该动作不可作为浏览器任务');
      if(validated.readOnly&&['execute','complete-record-repair'].includes(action))throw new Error('readOnly 桥接禁止 execute 和 complete-record-repair');
      if(resumePauseGeneration!==undefined&&(action!=='execute'||continuationGuard||!Number.isSafeInteger(resumePauseGeneration)||resumePauseGeneration<0))throw new Error('普通执行的暂停恢复版本无效');
      let acceptedGuard;
      if(command.continuationGuard){
        const fence=continuationFence(),expected=command.continuationGuard,priorSafe=expected.phase==='initial'?(!job||job.terminal===true&&!job.running):job?.terminal===true&&!job.running&&job.action==='execute'&&!job.error&&!job.evidenceError&&job.result?.stateStatus==='stopped'&&job.result?.stopReason==='limit'&&job.result?.uncertain===false&&!job.result?.pendingWrite;
        if(!priorSafe||fence.paused||fence.previousTerminalId!==expected.previousTerminalId||fence.pauseGeneration!==expected.pauseGeneration)return {bookId:validated.bookId,...readonlyIdentity(),id,started:false,rejected:'continuation-fence',writePerformed:false,uncertain:false,continuationFence:fence};
        acceptedGuard={...copy(expected),bookId:validated.bookId,commandId:id};
      }
      if(resumePauseGeneration!==undefined&&resumePauseGeneration!==pauseGeneration)return {bookId:validated.bookId,...readonlyIdentity(),id,started:false,rejected:'pause-fence',writePerformed:false,uncertain:false,continuationFence:continuationFence()};
      if(job?.running)throw new Error('已有任务运行');if(job?.id===id)throw new Error('命令 ID 已使用');
      const pauseResumeAccepted=resumePauseGeneration===undefined?null:{schemaVersion:1,pauseGeneration:resumePauseGeneration,bookId:validated.bookId,commandId:id};
      stopping=false;if(action==='execute'&&!acceptedGuard)pauseLatched=false;job={id,action,bookId:validated.bookId,servicePid:process.pid,commandSha256:recorderCommandFingerprint(command),running:true,terminal:false,startedAt:new Date().toISOString(),phase:null,phaseTaskId:null,phaseStartedAt:null,timings:[],progress:null,...(acceptedGuard?{continuationGuardAccepted:acceptedGuard}:{}),...(pauseResumeAccepted?{pauseResumeAccepted}:{})};
      const running=networkGuard?Promise.resolve().then(async()=>{job.readOnlyNetworkStart=await networkGuard.checkpoint();return execute(action,args);}):execute(action,args);
      running.then(result=>{job.result=result;}).catch(async error=>{job.error=clean(error);job.result={...(action==='collect'?{...error.collection,writePerformed:false}:{}),...(action==='probe'?await probeDirectoryFailure(error):{}),uncertain:action==='execute'&&(adapter?.pendingWrite?.status==='pending'||adapter?._uncertain===true),pendingWrite:pendingSummary(adapter)};}).finally(async()=>{stage('terminal');job.finishedAt=new Date().toISOString();try{if(networkGuard){const end=await networkGuard.checkpoint();if(job.readOnlyNetworkStart){job.readOnlyNetwork=readonlyNetworkCommandEvidence(id,action,job.readOnlyNetworkStart,end);job.result={...job.result,readOnlyNetwork:job.readOnlyNetwork};}if(!end.allMutationAttemptsBlocked||end.evidenceError)throw new Error('只读网络屏障的阻断或证据未确认');}await atomic(root,path.join(dataDir,'jobs',id,'job-result.json'),{...job,running:false,terminal:true});}catch(error){job.evidenceError=clean(error);job.error??=job.evidenceError;if(action==='execute')job.result={...job.result,uncertain:true,pendingWrite:pendingSummary(adapter)};}job.running=false;job.terminal=true;});
      return {bookId:validated.bookId,...readonlyIdentity(),id,started:true,continuationFence:continuationFence(),...(acceptedGuard?{continuationGuardAccepted:acceptedGuard}:{}),...(pauseResumeAccepted?{pauseResumeAccepted}:{})};
    },
  };
  Object.defineProperty(page,'__persistentRecorder',{value:bridge});return bridge;
}
