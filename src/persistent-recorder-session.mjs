import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {connectMcp,parseTabs,selectBookTab,isBookTab,validateToolSet,parseBridgeResult,safeDiagnosticMessage} from '../scripts/run-new-system-extension.mjs';
import {pidAlive} from './persistent-recorder-lock.mjs';
import {resolveExtensionAuth} from './extension-auth.mjs';
import {TASK_ACTIONS,PLATFORM_ORIGIN,validateRecorderConfig,validateRecorderCommand,workspacePath,existingWorkspacePath,existingWorkspaceDirectory,writableWorkspacePath,prepareRuntimeDirectory,recorderBookUrl} from './recorder-config.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function atomic(root,file,value){await writableWorkspacePath(root,file);await prepareRuntimeDirectory(root,path.dirname(file));const temporary=file+'.'+randomUUID()+'.tmp';await writableWorkspacePath(root,temporary);const handle=await fs.open(temporary,'wx');try{await handle.writeFile(JSON.stringify(value,null,2));await handle.sync();}finally{await handle.close();}await writableWorkspacePath(root,file);await fs.rename(temporary,file);}
const validId=id=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,80}$/u.test(id);

/** One persistent MCP client. Reconnection never resubmits a command. */
export class PersistentRecorderSession{
  constructor({root,bookId,statePath,connect=connectMcp,alive=pidAlive,resolveAuth=resolveExtensionAuth}){
    validateRecorderConfig({bookId});this.root=path.resolve(root);this.bookId=bookId;
    this.statePath=workspacePath(this.root,statePath??'data/persistent-executor/session.json');this.connectFactory=connect;this.alive=alive;this.resolveAuth=resolveAuth;
    this.connection=null;this.dead=false;this.binding=false;this.busy=false;
    this.state={schemaVersion:1,bookId,pending:null,writeBlocked:false,blockedContext:null,last:null,seenIds:[],connectionCount:0};
  }
  async initialize(){
    this.statePath=await writableWorkspacePath(this.root,this.statePath);
    try{const saved=JSON.parse(await fs.readFile(await existingWorkspacePath(this.root,this.statePath),'utf8')),pending=saved.pending,blocked=saved.blockedContext;
      if(saved.schemaVersion!==1||saved.bookId!==this.bookId||typeof saved.writeBlocked!=='boolean'||!Number.isSafeInteger(saved.connectionCount)||saved.connectionCount<0||!Array.isArray(saved.seenIds)||saved.seenIds.some(id=>!validId(id))||new Set(saved.seenIds).size!==saved.seenIds.length||pending!==null&&(!pending||!saved.seenIds.includes(pending.id)||!TASK_ACTIONS.includes(pending.action)||!Number.isSafeInteger(pending.servicePid)||pending.servicePid<1)||saved.writeBlocked&&(!blocked||typeof blocked.manifest!=='string'||typeof blocked.state!=='string'||!/^[a-f0-9]{64}$/u.test(blocked.manifestSha256??'')))throw new Error('会话进度损坏或缺少原任务恢复绑定');
      if(pending)validateRecorderCommand({id:pending.id,action:pending.action,args:pending.args},this.root);
      if(blocked){blocked.manifest=await writableWorkspacePath(this.root,blocked.manifest);blocked.state=await writableWorkspacePath(this.root,blocked.state);if(blocked.pendingPath)blocked.pendingPath=await writableWorkspacePath(this.root,blocked.pendingPath);}
      this.state=saved;
    }catch(error){if(error.code!=='ENOENT')throw error;}
  }
  async persist(){const snapshot=structuredClone(this.state),previous=this.persistPromise??Promise.resolve();this.persistPromise=previous.catch(()=>{}).then(()=>atomic(this.root,this.statePath,snapshot));await this.persistPromise;}
  snapshot(){const blocked=this.state.blockedContext;return {bookId:this.bookId,connection:this.connection&&!this.dead?'connected':'disconnected',authConfigured:this.connection?.authConfigured??null,connectionCount:this.state.connectionCount,pending:this.state.pending,writeBlocked:this.state.writeBlocked,blockedContext:blocked,last:this.state.last,recovery:{required:this.state.writeBlocked,taskId:blocked?.taskId??null,pendingPath:blocked?.pendingPath??null,instruction:this.state.writeBlocked?'先对原 manifest/state/taskId 执行只读 reconcile；未知保存不能重新 execute':'没有待核对保存，可提交新的已审题单'}};}
  async connect(){if(this.closing||this.closed)throw new Error('执行器正在关闭或已关闭');if(this.connectPromise)return this.connectPromise;this.connectPromise=this._connect().finally(()=>{this.connectPromise=null;});return this.connectPromise;}
  async _connect(){
    if(this.connection&&!this.dead)return;
    if(this.connection){await this.connection.close();this.connection=null;this.state.authRequired=true;await this.persist();}
    if(this.state.authRequired){const auth=await this.resolveAuth();if(!auth.authConfigured)throw new Error('自动重连需要已配置的扩展凭据；不会重复请求浏览器授权');}
    const bridgePath=path.join(path.dirname(this.statePath),'persistent.bridge.cjs'),moduleUrl=pathToFileURL(path.join(this.root,'src/persistent-recorder-bridge.mjs')).href;
    await writableWorkspacePath(this.root,bridgePath);
    await prepareRuntimeDirectory(this.root,path.dirname(bridgePath));await writableWorkspacePath(this.root,bridgePath);await fs.writeFile(bridgePath,`exports.default=async({page})=>{const {installPersistentBridge}=await import(${JSON.stringify(moduleUrl)});await installPersistentBridge({page,config:${JSON.stringify({root:this.root,bookId:this.bookId,origin:PLATFORM_ORIGIN,inputMode:'browser-command'})}});};`);
    this.connection=await this.connectFactory(bridgePath);this.dead=false;this.binding=false;this.state.authRequired=false;
    this.connection.onClosed?.(()=>{this.dead=true;this.binding=false;});this.state.connectionCount++;await this.persist();validateToolSet((await this.connection.client.listTools()).tools);
  }
  async call(name,args){const result=await this.connection.client.callTool({name,arguments:args},undefined,{timeout:45000});if(result?.isError)throw new Error(safeDiagnosticMessage(result.content?.filter(row=>row.type==='text').map(row=>row.text).join(' ')??'MCP调用失败'));return result;}
  async bind(){if(this.bindPromise)return this.bindPromise;this.bindPromise=this._bind().finally(()=>{this.bindPromise=null;});return this.bindPromise;}
  async _bind(){await this.connect();if(this.binding)return;let tabs=parseTabs(await this.call('browser_tabs',{action:'list'}));if(!tabs.some(tab=>isBookTab(tab.url,this.bookId)))tabs=parseTabs(await this.call('browser_tabs',{action:'new',url:recorderBookUrl(this.bookId)}));const selected=selectBookTab(tabs,this.bookId);await this.call('browser_tabs',{action:'select',index:selected.index});this.binding=true;}
  async bridge(action,payload){await this.bind();const argument=payload===undefined?'':JSON.stringify(payload),result=parseBridgeResult(await this.call('browser_run_code_unsafe',{code:`async (page) => { if (!page.__persistentRecorder) throw new Error('常驻桥接未安装'); return await page.__persistentRecorder.${action}(${argument}); }`}));if(result.bookId!==this.bookId)throw new Error('桥接书籍不匹配');return result;}
  context(args){return {manifest:workspacePath(this.root,args.manifest),state:workspacePath(this.root,args.state??args.manifest+'.persistent.run.json')};}
  async reviewedContext(args){
    const context=this.context(args),manifestPath=await existingWorkspacePath(this.root,context.manifest),bytes=await fs.readFile(manifestPath),manifest=JSON.parse(bytes);
    const baseDir=manifest.baseDir?await existingWorkspaceDirectory(this.root,manifest.baseDir):path.dirname(manifestPath);
    const {inspectReviewedBatch}=await import('./review-preflight.mjs'),report=await inspectReviewedBatch(manifest,baseDir);
    if(manifest.bookId!==this.bookId||manifest.source!=='production'||!report.valid||report.errors?.length||report.readyForExecution===false||manifest.tasks.some(task=>task.review?.status!=='approved'))throw new Error('本地已审题单/覆盖/答案要求校验失败：'+(report.errors??[]).join('; '));
    context.state=await writableWorkspacePath(this.root,context.state);if(context.state===manifestPath)throw new Error('进度不能覆盖题单');
    return {...context,manifest:manifestPath,manifestSha256:sha(bytes)};
  }
  async bindUnknownRecovery(){
    const context=this.state.blockedContext;if(!context||context.taskId)return;
    const manifestBytes=await fs.readFile(await existingWorkspacePath(this.root,context.manifest));if(sha(manifestBytes)!==context.manifestSha256)throw new Error('原题单已变化，保留写入锁');
    const run=JSON.parse(await fs.readFile(await existingWorkspacePath(this.root,context.state),'utf8')),manifest=JSON.parse(manifestBytes),{createNewSystemRun}=await import('./new-system-core.mjs');
    const baseDir=manifest.baseDir?await existingWorkspaceDirectory(this.root,manifest.baseDir):path.dirname(context.manifest),expected=createNewSystemRun(manifest,{baseDir}),unresolved=run.tasks?.filter(row=>row.recoveryRequired&&!['completed','skipped_existing'].includes(row.status))??[];
    if(run.kind!=='new-system-run'||run.bookId!==this.bookId||run.manifestHash!==expected.manifestHash||unresolved.length!==1||!manifest.tasks.some(task=>task.id===unresolved[0].taskId))throw new Error('失败任务身份不唯一，保留原写入锁');
    context.taskId=unresolved[0].taskId;await this.persist();
  }
  async noWriteFailureProof(pending){
    if(pending.action!=='execute'||this.alive(pending.servicePid))return null;
    try{const context=await this.reviewedContext(pending.args),manifest=JSON.parse(await fs.readFile(context.manifest,'utf8')),run=JSON.parse(await fs.readFile(await existingWorkspacePath(this.root,context.state),'utf8')),{createNewSystemRun}=await import('./new-system-core.mjs'),baseDir=manifest.baseDir?await existingWorkspaceDirectory(this.root,manifest.baseDir):path.dirname(context.manifest),expected=createNewSystemRun(manifest,{baseDir});
      if(context.manifestSha256!==this.state.blockedContext?.manifestSha256||run.kind!=='new-system-run'||run.bookId!==this.bookId||run.manifestHash!==expected.manifestHash||run.status!=='failed'||Date.parse(run.updatedAt)<Date.parse(pending.at)||run.tasks?.length!==manifest.tasks.length)return null;
      const failures=run.tasks.filter(row=>row.status==='failed');if(failures.length!==1||!String(failures[0].lastError??'').startsWith('回读失败:')||run.tasks.some((row,i)=>row.taskId!==manifest.tasks[i].id||row.attempts!==0||row.recoveryRequired!==false||row.receipt||row.recoveryConfirmation||!['pending','failed'].includes(row.status)))return null;
      return {kind:'terminated-before-append',bookId:this.bookId,taskId:failures[0].taskId,manifestSha256:context.manifestSha256,oldServicePid:pending.servicePid,checkedAt:new Date().toISOString()};
    }catch{return null;}
  }
  async status({connect=false}={}){if(this.statusPromise)return this.statusPromise;this.statusPromise=this._status({connect}).finally(()=>{this.statusPromise=null;});return this.statusPromise;}
  async _status({connect}){
    if(!this.connection&&!connect)return this.snapshot();
    try{const remote=await this.bridge('status'),pending=this.state.pending;
      if(pending&&remote.job?.id===pending.id&&remote.job.terminal){
        this.state.last=remote.job;
        if(pending.action==='execute'){
          const result=remote.job.result;this.state.writeBlocked=result?.uncertain!==false;
          this.state.blockedContext=this.state.writeBlocked?{...this.state.blockedContext,taskId:result?.pendingWrite?.task?.id??this.state.blockedContext?.taskId??null,pendingPath:result?.pendingWrite?.evidencePath??this.state.blockedContext?.pendingPath??null}:null;
        }
        if(pending.action==='reconcile'&&!remote.job.error&&this.state.writeBlocked){const result=remote.job.result,proof=result?.recovery,blocked=this.state.blockedContext;
          const contentProof=proof?.outcome==='saved'?proof.priorRecordsUnchanged===true&&proof.targetRecordUnique===true&&proof.fullContentCompared===true&&Number.isSafeInteger(proof.recordId)&&proof.recordId>0:proof?.outcome==='not_saved'&&proof.liveNoSaveRequests===true&&proof.recordId===null;
          if(result?.writePerformed===false&&result?.uncertain===false&&proof?.writeUnlocked===true&&contentProof&&result.manifestPath===blocked.manifest&&result.statePath===blocked.state&&result.taskId===blocked.taskId&&proof.taskId===blocked.taskId&&proof.bookId===this.bookId){this.state.writeBlocked=false;this.state.blockedContext=null;}
        }
        this.state.pending=null;await this.persist();
      }else if(pending&&!remote.job&&!this.alive(pending.servicePid)&&this.connection.servicePid!==pending.servicePid){
        const proof=await this.noWriteFailureProof(pending);this.state.last={id:pending.id,action:pending.action,terminal:true,...(proof?{result:{uncertain:false,noWriteProof:proof}}:{error:'旧子服务已退出，原结果待只读核对'})};
        if(pending.action==='execute'&&proof){this.state.writeBlocked=false;this.state.blockedContext=null;}
        this.state.pending=null;await this.persist();
      }
      return {...this.snapshot(),remote};
    }catch(error){return {...this.snapshot(),error:safeDiagnosticMessage(error.message),taskNotRetried:true};}
  }
  async command(command){
    if(this.closed||this.closing)throw new Error('执行器正在关闭或已关闭');const {action,args}=validateRecorderCommand(command,this.root);
    if(action==='status')return this.status({connect:true});if(action==='pause')return this.bridge('pause');if(action==='close'){await this.close();return {bookId:this.bookId,closed:true};}
    if(this.busy||this.state.pending)throw new Error('已有任务或命令尚未终止');this.busy=true;
    try{
      const context=!['probe','collect'].includes(action)?await this.reviewedContext(args):null;
      if(action==='collect'&&this.state.writeBlocked)throw new Error('保存结果待核对；保留写入锁，禁止切换来源页采集');
      if(action==='execute'&&this.state.writeBlocked)throw new Error('保存结果待核对；保留写入锁，禁止再次新增');
      if(action==='reconcile'&&this.state.writeBlocked){await this.bindUnknownRecovery();const blocked=this.state.blockedContext,pendingPath=blocked.pendingPath?await writableWorkspacePath(this.root,args.pendingPath??blocked.pendingPath):null;if(context.manifest!==blocked.manifest||context.state!==blocked.state||context.manifestSha256!==blocked.manifestSha256||args.taskId!==blocked.taskId||blocked.pendingPath&&pendingPath!==blocked.pendingPath)throw new Error('只能核对原失败题单/进度/任务');if(blocked.pendingPath)args.pendingPath=pendingPath;}
      const id=command.id??randomUUID();if(this.state.seenIds.includes(id))throw new Error('命令 ID 已使用，禁止重复派发');
      await this.bind();this.state.pending={id,action,args:structuredClone(args),servicePid:this.connection.servicePid,at:new Date().toISOString()};this.state.seenIds.push(id);
      if(action==='execute'){this.state.writeBlocked=true;this.state.blockedContext={...context,taskId:null,pendingPath:null};}await this.persist();
      try{await this.bridge('start',{id,action,args});}catch(error){this.state.lastError=safeDiagnosticMessage(error.message);await this.persist();return {...this.snapshot(),error:this.state.lastError,taskNotRetried:true};}
      return await this.status();
    }finally{this.busy=false;}
  }
  async close(){
    if(this.closed)return;if(this.busy||this.connectPromise||this.bindPromise||this.closing)throw new Error('命令或连接正在执行，保留运行锁');this.closing=true;
    try{if(this.statusPromise)await this.statusPromise;if(this.state.pending)throw new Error('任务未确认终止；先 pause 再等待 status');if(this.connection)await this.connection.close();this.connection=null;this.dead=false;this.binding=false;this.closed=true;}finally{this.closing=false;}
  }
}
