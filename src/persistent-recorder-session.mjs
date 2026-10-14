import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {connectMcp,parseTabs,selectBookTab,isBookTab,validateToolSet,parseBridgeResult,safeDiagnosticMessage} from '../scripts/run-new-system-extension.mjs';
import {pidAlive} from './persistent-recorder-lock.mjs';
import {resolveExtensionAuth} from './extension-auth.mjs';
import {TASK_ACTIONS,PLATFORM_ORIGIN,validateRecorderConfig,validateRecorderCommand,workspacePath,existingWorkspacePath,existingWorkspaceDirectory,writableWorkspacePath,prepareRuntimeDirectory,recorderBookUrl,assertRecorderPage} from './recorder-config.mjs';
import {validBeforePlusProof} from './pre-append-recovery.mjs';
import {validHistoricalNetworkRecoveryProof} from './historical-network-recovery.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function atomic(root,file,value){await writableWorkspacePath(root,file);await prepareRuntimeDirectory(root,path.dirname(file));const temporary=file+'.'+randomUUID()+'.tmp';await writableWorkspacePath(root,temporary);const handle=await fs.open(temporary,'wx');try{await handle.writeFile(JSON.stringify(value,null,2));await handle.sync();}finally{await handle.close();}await writableWorkspacePath(root,file);await fs.rename(temporary,file);}
const validId=id=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,80}$/u.test(id);
const readContinuationFence=value=>value&&value.schemaVersion===1&&(value.previousTerminalId===null||validId(value.previousTerminalId))&&Number.isSafeInteger(value.pauseGeneration)&&value.pauseGeneration>=0&&typeof value.paused==='boolean'?structuredClone(value):null;
const acceptedContinuation=(proof,guard,bookId,id)=>proof?.schemaVersion===1&&proof.bookId===bookId&&proof.commandId===id&&proof.previousTerminalId===guard.previousTerminalId&&proof.pauseGeneration===guard.pauseGeneration&&proof.phase===guard.phase&&proof.connectionCount===guard.connectionCount;
const validPauseControl=value=>value&&value.schemaVersion===1&&Number.isSafeInteger(value.generation)&&value.generation>=0&&typeof value.paused==='boolean'&&Object.keys(value).every(key=>['schemaVersion','generation','paused'].includes(key));
const acceptedResume=(proof,generation,bookId,id)=>proof?.schemaVersion===1&&proof.bookId===bookId&&proof.commandId===id&&proof.pauseGeneration===generation;

/** One persistent MCP client. Reconnection never resubmits a command. */
export class PersistentRecorderSession{
  constructor({root,bookId,focusMode,windowMode,statePath,connect=connectMcp,alive=pidAlive,resolveAuth=resolveExtensionAuth,maxAutomaticReconnects=1,statusTimeoutMs=10000}){
    const config=validateRecorderConfig({bookId,focusMode,windowMode});this.focusMode=config.focusMode;this.windowMode=config.windowMode;this.root=path.resolve(root);this.bookId=bookId;
    if(!Number.isSafeInteger(maxAutomaticReconnects)||maxAutomaticReconnects<0||maxAutomaticReconnects>3)throw new Error('自动重连上限必须为 0–3');
    if(!Number.isSafeInteger(statusTimeoutMs)||statusTimeoutMs<1||statusTimeoutMs>45000)throw new Error('状态等待时限必须为 1–45000 毫秒');this.statusTimeoutMs=statusTimeoutMs;
    this.statePath=workspacePath(this.root,statePath??'data/persistent-executor/session.json');this.connectFactory=connect;this.alive=alive;this.resolveAuth=resolveAuth;
    this.connection=null;this.dead=false;this.binding=false;this.pageBindingId=null;this.busy=false;
    this.maxAutomaticReconnects=maxAutomaticReconnects;this.automaticReconnects=0;this.connectionAttempts=0;this.tabCreationAttempted=false;this.ownedTab=null;this.tabCleanup=null;
    this.continuationFence=null;this.pausePersistenceSupported=false;
    this.state={schemaVersion:1,bookId,pending:null,writeBlocked:false,blockedContext:null,last:null,seenIds:[],connectionCount:0,pauseControl:{schemaVersion:1,generation:0,paused:false}};
  }
  async initialize(){
    this.statePath=await writableWorkspacePath(this.root,this.statePath);
    try{const saved=JSON.parse(await fs.readFile(await existingWorkspacePath(this.root,this.statePath),'utf8')),pending=saved.pending,blocked=saved.blockedContext;
      if(saved.schemaVersion!==1||saved.bookId!==this.bookId||typeof saved.writeBlocked!=='boolean'||!Number.isSafeInteger(saved.connectionCount)||saved.connectionCount<0||!Array.isArray(saved.seenIds)||saved.seenIds.some(id=>!validId(id))||new Set(saved.seenIds).size!==saved.seenIds.length||pending!==null&&(!pending||!saved.seenIds.includes(pending.id)||!TASK_ACTIONS.includes(pending.action)||!Number.isSafeInteger(pending.servicePid)||pending.servicePid<1)||saved.writeBlocked&&(!blocked||typeof blocked.manifest!=='string'||typeof blocked.state!=='string'||!/^[a-f0-9]{64}$/u.test(blocked.manifestSha256??'')))throw new Error('会话进度损坏或缺少原任务恢复绑定');
      if(pending)validateRecorderCommand({id:pending.id,action:pending.action,args:pending.args,...(pending.continuationGuard===undefined?{}:{continuationGuard:pending.continuationGuard})},this.root);
      if(blocked){blocked.manifest=await writableWorkspacePath(this.root,blocked.manifest);blocked.state=await writableWorkspacePath(this.root,blocked.state);if(blocked.pendingPath)blocked.pendingPath=await writableWorkspacePath(this.root,blocked.pendingPath);}
      if(saved.tabLifecycle!==undefined&&(!saved.tabLifecycle||!Array.isArray(saved.tabLifecycle.created)||saved.tabLifecycle.created.some(tab=>!tab||typeof tab.ownerId!=='string'||tab.bookId!==this.bookId||!['confirmed','unconfirmed'].includes(tab.ownership))))throw new Error('书页生命周期记录无效；不采用磁盘身份关闭浏览器页');
      if(saved.pauseControl===undefined)saved.pauseControl={schemaVersion:1,generation:0,paused:false};if(!validPauseControl(saved.pauseControl))throw new Error('持久暂停控制无效；保留原任务与写入锁');
      this.state=saved;
      if(saved.tabLifecycle?.created.some(tab=>tab.cleanup?.outcome!=='closed'))this.recordTabCleanup({outcome:'retained',reason:'previous-service-page'});
    }catch(error){if(error.code!=='ENOENT')throw error;}
  }
  async persist(){const snapshot=structuredClone(this.state),previous=this.persistPromise??Promise.resolve();this.persistPromise=previous.catch(()=>{}).then(()=>atomic(this.root,this.statePath,snapshot));await this.persistPromise;}
  statusRequestSnapshot(attempt=this.statusOperation){
    if(!attempt)return this.lastStatusRequest??{state:'idle'};
    return {state:attempt.finished?'settled':attempt.expired?'blocked':'waiting',startedAt:attempt.startedAt,elapsedMs:Math.max(0,Date.now()-attempt.startedMs),dispatched:attempt.dispatched===true,transportReturned:attempt.transportReturned===true,remoteReturned:attempt.remoteReturned===true,responseOutcome:attempt.responseOutcome??null,servicePid:Number.isSafeInteger(attempt.connection?.servicePid)&&attempt.connection.servicePid>0?attempt.connection.servicePid:null,connectionCount:attempt.connectionCount};
  }
  snapshot(){const blocked=this.state.blockedContext;return {bookId:this.bookId,focusMode:this.focusMode,windowMode:this.windowMode,sessionPath:this.statePath,connection:this.connection&&!this.dead?'connected':'disconnected',authConfigured:this.connection?.authConfigured??null,connectionCount:this.state.connectionCount,statusRequest:this.statusRequestSnapshot(),pauseControl:structuredClone(this.state.pauseControl),continuationFence:this.continuationFence?{...this.continuationFence,pauseGeneration:this.state.pauseControl.generation,paused:this.state.pauseControl.paused}:null,pending:this.state.pending,writeBlocked:this.state.writeBlocked,blockedContext:blocked,last:this.state.last,reconnect:{automaticAttempts:this.automaticReconnects,maximum:this.maxAutomaticReconnects,limited:this.automaticReconnects>=this.maxAutomaticReconnects&&(this.dead||!this.connection)},tabLifecycle:this.state.tabLifecycle??{created:[],lastCleanup:null},tabCleanup:this.tabCleanup,recovery:{required:this.state.writeBlocked,taskId:blocked?.taskId??null,pendingPath:blocked?.pendingPath??null,instruction:this.state.writeBlocked?'先对原 manifest/state/taskId 执行只读 reconcile；未知保存不能重新 execute':'没有待核对保存，可提交新的已审题单'}};}
  async connect({explicit=false}={}){if(this.closing||this.closed)throw new Error('执行器正在关闭或已关闭');if(this.connectPromise)return this.connectPromise;if(explicit)this.automaticReconnects=0;this.connectPromise=this._connect({explicit}).finally(()=>{this.connectPromise=null;});return this.connectPromise;}
  async _connect({explicit=false}={}){
    if(this.connection&&!this.dead)return;
    if(this.connectionAttempts>0){if(!explicit&&this.automaticReconnects>=this.maxAutomaticReconnects)throw new Error('自动重连已达上限；状态轮询不会继续打开浏览器页，请显式请求连接');if(!explicit)this.automaticReconnects++;}
    this.connectionAttempts++;
    if(this.ownedTab){this.recordTabCleanup({outcome:'retained',reason:'connection-lost',ownerId:this.ownedTab.ownerId});this.ownedTab=null;}
    if(this.connection){await this.connection.close();this.connection=null;this.state.authRequired=true;await this.persist();}
    if(this.state.authRequired){const auth=await this.resolveAuth();if(!auth.authConfigured)throw new Error('自动重连需要已配置的扩展凭据；不会重复请求浏览器授权');}
    const bridgePath=path.join(path.dirname(this.statePath),'persistent.bridge.cjs'),moduleUrl=pathToFileURL(path.join(this.root,'src/persistent-recorder-bridge.mjs')).href;
    await writableWorkspacePath(this.root,bridgePath);
    this.pageBindingId=randomUUID();
    const config={root:this.root,bookId:this.bookId,origin:PLATFORM_ORIGIN,inputMode:'browser-command',focusMode:this.focusMode,windowMode:this.windowMode},configUrl=pathToFileURL(path.join(this.root,'src/recorder-config.mjs')).href;
    // MCP run-code uses a VM without a dynamic-import callback. Keep imports in
    // this CJS init-page closure; the VM invokes only this fixed Node-side loader.
    const bootstrap=`exports.default=async({page})=>{
      const {assertRecorderPage}=await import(${JSON.stringify(configUrl)}),context=page.context(),config=${JSON.stringify(config)},bindingId=${JSON.stringify(this.pageBindingId)};
      const identity={schemaVersion:1,bookId:config.bookId,focusMode:config.focusMode,windowMode:config.windowMode,bindingId};
      const matches=()=>context.pages().filter(candidate=>{try{if(candidate.isClosed())return false;assertRecorderPage(candidate.url(),config.bookId);return true;}catch{return false;}});
      const assertTarget=target=>{if(target.context()!==context||target.isClosed())throw new Error('桥接安装目标不属于本连接');assertRecorderPage(target.url(),config.bookId);const pages=matches();if(pages.length!==1||pages[0]!==target)throw new Error('书籍录入页不能唯一确认，拒绝安装');if(target.__textbookRecorderSessionPage!==undefined&&target.__textbookRecorderSessionPage!==bindingId)throw new Error('书页已绑定其他连接，拒绝安装');};
      let loader=context.__textbookRecorderBridgeBootstrap;
      if(loader){if(Object.keys(identity).some(key=>loader[key]!==identity[key])||typeof loader.install!=='function')throw new Error('连接桥接加载器身份不匹配');}
      else{loader=Object.freeze({...identity,install:async target=>{assertTarget(target);const {installPersistentBridge}=await import(${JSON.stringify(moduleUrl)});assertTarget(target);const bridge=await installPersistentBridge({page:target,config});assertTarget(target);const status=bridge.status();if(status.bookId!==config.bookId||status.focusMode!==config.focusMode||status.windowMode!==config.windowMode)throw new Error('安装桥接的书籍或浏览器模式不匹配');return bridge;}});Object.defineProperty(context,'__textbookRecorderBridgeBootstrap',{value:loader});}
      if(config.focusMode==='foreground'){try{assertRecorderPage(page.url(),config.bookId);}catch{return;}await loader.install(page);}
    };`;
    await prepareRuntimeDirectory(this.root,path.dirname(bridgePath));await writableWorkspacePath(this.root,bridgePath);await fs.writeFile(bridgePath,bootstrap);
    const connected=await this.connectFactory(bridgePath);this.connection=connected;this.dead=false;this.binding=false;this.tabCreationAttempted=false;this.continuationFence=null;this.pausePersistenceSupported=false;this.state.authRequired=false;
    connected.onClosed?.(()=>{if(this.connection===connected){this.dead=true;this.binding=false;}});this.state.connectionCount++;await this.persist();validateToolSet((await this.connection.client.listTools()).tools);
  }
  async call(name,args,{onResponse}={}){const connection=this.connection,connectionCount=this.state.connectionCount,bindingId=this.pageBindingId;const result=await connection.client.callTool({name,arguments:args},undefined,{timeout:45000});onResponse?.({connection,connectionCount,bindingId,outcome:result?.isError?'tool-error':'response'});if(result?.isError)throw new Error(safeDiagnosticMessage(result.content?.filter(row=>row.type==='text').map(row=>row.text).join(' ')??'MCP调用失败'));return result;}
  backgroundPageCode({bound=true}={}){
    return `const PLATFORM_ORIGIN=${JSON.stringify(PLATFORM_ORIGIN)}; const assertBookPage=${assertRecorderPage.toString()}; const bookPages=()=>page.context().pages().filter(candidate=>{try{if(candidate.isClosed())return false;assertBookPage(candidate.url(),${this.bookId});return true;}catch{return false;}}); const matches=bookPages(); if(matches.length!==1)throw new Error('书籍录入页不能唯一确认，拒绝采用活动页'); const target=matches[0]; ${bound?`const marked=page.context().pages().filter(candidate=>candidate.__textbookRecorderSessionPage===${JSON.stringify(this.pageBindingId)}); if(marked.length!==1||marked[0]!==target)throw new Error('绑定书页身份变化，拒绝采用活动页');`:''}`;
  }
  async invokeBridge(action,payload,options){
    if(!['status','syncPause','pause','start','cleanupWindowHelper'].includes(action))throw new Error('桥接动作无效');
    const argument=payload===undefined?'':JSON.stringify(payload),selection=this.focusMode==='background'?this.backgroundPageCode():'',target=this.focusMode==='background'?'target':'page';
    return parseBridgeResult(await this.call('browser_run_code_unsafe',{code:`async (page) => { ${selection} const identity=${target}.__persistentRecorder?.status(); if(identity?.bookId!==${this.bookId}||identity.focusMode!==${JSON.stringify(this.focusMode)}||identity.windowMode!==${JSON.stringify(this.windowMode)})throw new Error('绑定书页桥接的书籍或 focusMode/windowMode 不匹配'); if (!${target}.__persistentRecorder) throw new Error('常驻桥接未安装'); return await ${target}.__persistentRecorder.${action}(${argument}); }`},options));
  }
  bridgeLoaderCode(target){return `const loader=${target}.context().__textbookRecorderBridgeBootstrap; if(loader?.schemaVersion!==1||loader.bookId!==${this.bookId}||loader.focusMode!==${JSON.stringify(this.focusMode)}||loader.windowMode!==${JSON.stringify(this.windowMode)}||loader.bindingId!==${JSON.stringify(this.pageBindingId)}||typeof loader.install!=='function')throw new Error('连接桥接加载器身份不匹配'); await loader.install(${target});`;}
  async bindBackgroundPage(ownerId){
    const ownership=ownerId===undefined?'':`if(target.url()!==${JSON.stringify(recorderBookUrl(this.bookId))}||target.__textbookRecorderOwnedTab!==undefined)throw new Error('新建书页身份变化，保留页面'); Object.defineProperty(target,'__textbookRecorderOwnedTab',{value:${JSON.stringify(ownerId)}});`;
    const result=parseBridgeResult(await this.call('browser_run_code_unsafe',{code:`async (page) => { ${this.backgroundPageCode({bound:false})} if(target.__textbookRecorderSessionPage!==undefined&&target.__textbookRecorderSessionPage!==${JSON.stringify(this.pageBindingId)})throw new Error('书页已绑定其他连接，拒绝采用'); if(!target.__persistentRecorder){${this.bridgeLoaderCode('target')}} const identity=target.__persistentRecorder.status(); if(identity.bookId!==${this.bookId}||identity.focusMode!==${JSON.stringify(this.focusMode)}||identity.windowMode!==${JSON.stringify(this.windowMode)})throw new Error('书页桥接的书籍或 focusMode/windowMode 不匹配'); const rechecked=bookPages();if(rechecked.length!==1||rechecked[0]!==target)throw new Error('书页在绑定期间变化，拒绝采用'); if(target.__textbookRecorderSessionPage===undefined)Object.defineProperty(target,'__textbookRecorderSessionPage',{value:${JSON.stringify(this.pageBindingId)}}); ${ownership} return {bookId:${this.bookId},focusMode:${JSON.stringify(this.focusMode)},windowMode:${JSON.stringify(this.windowMode)},bindingId:${JSON.stringify(this.pageBindingId)}${ownerId===undefined?'':`,ownerId:${JSON.stringify(ownerId)}`}}; }`}));
    if(result.bookId!==this.bookId||result.focusMode!==this.focusMode||result.windowMode!==this.windowMode||result.bindingId!==this.pageBindingId||ownerId!==undefined&&result.ownerId!==ownerId)throw new Error('后台书页绑定未取得本书和模式证明');
  }
  async installForegroundBridge(){
    const result=parseBridgeResult(await this.call('browser_run_code_unsafe',{code:`async (page) => { const PLATFORM_ORIGIN=${JSON.stringify(PLATFORM_ORIGIN)}; const assertBookPage=${assertRecorderPage.toString()}; assertBookPage(page.url(),${this.bookId}); if(!page.__persistentRecorder){${this.bridgeLoaderCode('page')}} return await page.__persistentRecorder.status(); }`}));
    if(result.bookId!==this.bookId||result.focusMode!==this.focusMode||result.windowMode!==this.windowMode)throw new Error('前台书页桥接的书籍或 focusMode/windowMode 不匹配');
  }
  async bind(){if(this.bindPromise)return this.bindPromise;this.bindPromise=this._bind().finally(()=>{this.bindPromise=null;});return this.bindPromise;}
  async _bind(){
    await this.connect();if(this.binding)return;let tabs=parseTabs(await this.call('browser_tabs',{action:'list'}));
    if(!tabs.some(tab=>isBookTab(tab.url,this.bookId))){
      if(this.tabCreationAttempted)throw new Error('本连接已尝试新建书页但身份未确认，保留页面；不会重复开页');
      this.tabCreationAttempted=true;const before=tabs;try{tabs=parseTabs(await this.call('browser_tabs',{action:'new',url:recorderBookUrl(this.bookId)}));}catch(error){this.recordTabCleanup({outcome:'retained',reason:'creation-unconfirmed'});await this.persist();throw error;}
      const added=tabs.filter(tab=>!before.some(old=>old.index===tab.index));
      if(added.length!==1||!isBookTab(added[0].url,this.bookId)||!before.every(old=>tabs.some(tab=>tab.index===old.index&&tab.url===old.url))){this.recordTabCleanup({outcome:'retained',reason:'creation-identity-ambiguous'});await this.persist();throw new Error('新建书页身份不能唯一确认，保留页面；不会重复开页');}
      const selected=added[0],ownerId=randomUUID(),record={ownerId,bookId:this.bookId,servicePid:this.connection.servicePid,createdAt:new Date().toISOString(),indexAtCreation:selected.index,ownership:'unconfirmed'};
      this.state.tabLifecycle??={created:[],lastCleanup:null};this.state.tabLifecycle.created.push(record);await this.persist();
      let marked;try{if(this.focusMode==='background')await this.bindBackgroundPage(ownerId);else{await this.call('browser_tabs',{action:'select',index:selected.index});marked=parseBridgeResult(await this.call('browser_run_code_unsafe',{code:`async (page) => { if (page.url() !== ${JSON.stringify(recorderBookUrl(this.bookId))} || page.__textbookRecorderOwnedTab !== undefined) throw new Error('新建书页身份变化，保留页面'); Object.defineProperty(page, '__textbookRecorderOwnedTab', {value:${JSON.stringify(ownerId)}}); return {bookId:${this.bookId},ownerId:${JSON.stringify(ownerId)}}; }`}));if(marked.bookId!==this.bookId||marked.ownerId!==ownerId)throw new Error('新建书页标记未确认，保留页面');}}
      catch(error){this.recordTabCleanup({outcome:'retained',reason:'ownership-unconfirmed',ownerId});await this.persist();throw error;}
      record.ownership='confirmed';this.ownedTab={ownerId,connection:this.connection};await this.persist();
    }
    const selected=selectBookTab(tabs,this.bookId);if(this.focusMode==='background')await this.bindBackgroundPage();else{await this.call('browser_tabs',{action:'select',index:selected.index});await this.installForegroundBridge();}
    await this.synchronizePauseControl();this.binding=true;
  }
  async mergePauseFence(value){const fence=readContinuationFence(value);if(!fence){this.continuationFence=null;return null;}const control=this.state.pauseControl,next={schemaVersion:1,generation:Math.max(control.generation,fence.pauseGeneration),paused:control.paused||fence.paused};this.continuationFence=fence;if(next.generation!==control.generation||next.paused!==control.paused){this.state.pauseControl=next;await this.persist();}return {...fence,pauseGeneration:next.generation,paused:next.paused};}
  async synchronizePauseControl(){
    const remote=await this.invokeBridge('status');if(remote.bookId!==this.bookId||remote.focusMode!==this.focusMode||remote.windowMode!==this.windowMode)throw new Error('暂停同步书籍或 focusMode/windowMode 不匹配');await this.mergePauseFence(remote.continuationFence);this.pausePersistenceSupported=remote.pausePersistenceSupported===true;this.windowHelperCleanupSupported=remote.windowHelperCleanupSupported===true;
    if(!this.pausePersistenceSupported){if(this.state.pauseControl.paused||this.state.pauseControl.generation>0)throw new Error('浏览器桥接不支持持久暂停同步，保留暂停；请更新服务后再操作');return;}
    const result=await this.invokeBridge('syncPause',this.state.pauseControl);if(result.bookId!==this.bookId||!readContinuationFence(result.continuationFence))throw new Error('持久暂停同步未取得本书证明');await this.mergePauseFence(result.continuationFence);
  }
  recordTabCleanup(result){this.tabCleanup={...result,at:new Date().toISOString()};this.state.tabLifecycle??={created:[],lastCleanup:null};this.state.tabLifecycle.lastCleanup=this.tabCleanup;const record=this.state.tabLifecycle.created.find(tab=>tab.ownerId===result.ownerId);if(record)record.cleanup=this.tabCleanup;}
  async cleanupOwnedTab(){
    if(!this.ownedTab){if(this.tabCleanup?.outcome!=='retained')this.recordTabCleanup({outcome:'not-owned',reason:'existing-user-page'});return;}
    const {ownerId,connection}=this.ownedTab;
    if(this.state.pending||this.state.writeBlocked){this.recordTabCleanup({outcome:'retained',reason:this.state.pending?'pending-command':'write-blocked',ownerId});return;}
    if(this.connection!==connection||this.dead){this.recordTabCleanup({outcome:'retained',reason:'connection-lost',ownerId});return;}
    try{
      const result=parseBridgeResult(await this.call('browser_run_code_unsafe',{code:`async (page) => { const matches=page.context().pages().filter(candidate=>candidate.__textbookRecorderOwnedTab===${JSON.stringify(ownerId)}); if(matches.length!==1)return {bookId:${this.bookId},outcome:'retained',reason:'identity-not-unique'}; const owned=matches[0]; if(owned.isClosed()||owned.url()!==${JSON.stringify(recorderBookUrl(this.bookId))})return {bookId:${this.bookId},outcome:'retained',reason:'page-navigated-or-closed'}; let editorState; try { editorState=await owned.evaluate(() => { const editors=['#contentedit .w-e-text','#answeredit .w-e-text'].map(selector=>document.querySelector(selector)); return {confirmedEmpty:editors.every(editor=>editor && !editor.textContent.trim() && !editor.innerText.trim() && [...editor.querySelectorAll('*')].every(node=>['P','DIV','SPAN','BR'].includes(node.tagName)))}; }); } catch {} if(editorState?.confirmedEmpty!==true)return {bookId:${this.bookId},outcome:'retained',reason:'editor-content-not-confirmed'}; if(owned.url()!==${JSON.stringify(recorderBookUrl(this.bookId))})return {bookId:${this.bookId},outcome:'retained',reason:'page-navigated-or-closed'}; await owned.close({runBeforeUnload:false}); return {bookId:${this.bookId},outcome:'closed',reason:'owned-empty-page-confirmed'}; }`}));
      if(result.bookId!==this.bookId||!['closed','retained'].includes(result.outcome))throw new Error('书页关闭结果身份不符');this.recordTabCleanup({...result,ownerId});
    }catch(error){this.recordTabCleanup({outcome:'retained',reason:'cleanup-unconfirmed',ownerId,error:safeDiagnosticMessage(error.message)});}
  }
  async bridge(action,payload,options){await this.bind();if(action==='start'){
      if(this.statusOperation){await this.statusPromise;if(this.statusOperation?.expired)return {bookId:this.bookId,id:payload.id,started:false,rejected:'status-inflight',writePerformed:false,uncertain:false,continuationFence:{schemaVersion:1,previousTerminalId:this.continuationFence?.previousTerminalId??null,pauseGeneration:this.state.pauseControl.generation,paused:this.state.pauseControl.paused}};}
      const guard=payload.continuationGuard,control=this.state.pauseControl;
      if(guard&&(guard.connectionCount!==this.state.connectionCount||guard.pauseGeneration!==control.generation||control.paused)||payload.resumePauseGeneration!==undefined&&payload.resumePauseGeneration!==control.generation)return {bookId:this.bookId,id:payload.id,started:false,rejected:guard?'continuation-fence':'pause-fence',writePerformed:false,uncertain:false,continuationFence:{schemaVersion:1,previousTerminalId:this.continuationFence?.previousTerminalId??null,pauseGeneration:control.generation,paused:control.paused}};
    }const result=await this.invokeBridge(action,payload,options);if(result.bookId!==this.bookId)throw new Error('桥接书籍不匹配');return result;}
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
  async noWriteFailureProof(pending,terminal){
    if(pending.action!=='execute'||!terminal&&this.alive(pending.servicePid))return null;
    if(terminal&&(terminal.job.error||terminal.job.evidenceError||terminal.job.result?.uncertain!==false||terminal.job.result?.pendingWrite!==null))return null;
    try{const context=terminal?.context??await this.reviewedContext(pending.args),manifest=terminal?.manifest??JSON.parse(await fs.readFile(context.manifest,'utf8')),run=terminal?.run??JSON.parse(await fs.readFile(await existingWorkspacePath(this.root,context.state),'utf8')),{createNewSystemRun}=await import('./new-system-core.mjs'),baseDir=manifest.baseDir?await existingWorkspaceDirectory(this.root,manifest.baseDir):path.dirname(context.manifest),expected=createNewSystemRun(manifest,{baseDir});
      if(context.manifestSha256!==this.state.blockedContext?.manifestSha256||run.kind!=='new-system-run'||run.bookId!==this.bookId||run.manifestHash!==expected.manifestHash||run.status!=='failed'||Date.parse(run.updatedAt)<Date.parse(pending.at)||run.tasks?.length!==manifest.tasks.length)return null;
      const failures=run.tasks.filter(row=>row.status==='failed');if(failures.length!==1||!String(failures[0].lastError??'').startsWith('回读失败:')||run.tasks.some((row,i)=>row.taskId!==manifest.tasks[i].id||row.attempts!==0||row.recoveryRequired!==false||row.receipt||row.recoveryConfirmation||!['pending','failed'].includes(row.status)))return null;
      return {kind:'terminated-before-append',bookId:this.bookId,taskId:failures[0].taskId,manifestSha256:context.manifestSha256,oldServicePid:pending.servicePid,checkedAt:new Date().toISOString(),...(terminal?{commandId:pending.id,terminalJobPath:terminal.jobPath,terminalJobSha256:terminal.jobSha256}: {})};
    }catch{return null;}
  }
  statusIdentity(){return {pending:this.state.pending,connection:this.connection,connectionCount:this.state.connectionCount,bindingId:this.pageBindingId,pauseGeneration:this.state.pauseControl.generation};}
  statusIdentityMatches(identity){return this.state.pending===identity.pending&&this.connection===identity.connection&&this.state.connectionCount===identity.connectionCount&&this.pageBindingId===identity.bindingId&&this.state.pauseControl.generation===identity.pauseGeneration;}
  async localTerminalStatus(message){
    const identity=this.statusIdentity(),pending=identity.pending;
    try{
      if(pending?.action!=='execute')throw new Error('没有可核对的原新增命令');
      const jobPath=await existingWorkspacePath(this.root,path.join('data/persistent-executor/jobs',pending.id,'job-result.json')),jobBytes=await fs.readFile(jobPath),job=JSON.parse(jobBytes),result=job.result;
      const start=Date.parse(job.startedAt),finish=Date.parse(job.finishedAt),submitted=Date.parse(pending.at);
      if(job.id!==pending.id||job.action!==pending.action||job.terminal!==true||job.running!==false||result?.bookId!==this.bookId
        ||job.bookId!==undefined&&job.bookId!==this.bookId||job.servicePid!==undefined&&job.servicePid!==pending.servicePid
        ||![start,finish,submitted].every(Number.isFinite)||start<submitted||finish<start||finish>Date.now())throw new Error('本地终止命令身份或时间不匹配');
      if(pending.continuationGuard&&!acceptedContinuation(job.continuationGuardAccepted,pending.continuationGuard,this.bookId,pending.id))throw new Error('本地终止命令缺少接续接受证明');
      const context=await this.reviewedContext(pending.args),blocked=this.state.blockedContext;
      if(!blocked||context.manifest!==blocked.manifest||context.state!==blocked.state||context.manifestSha256!==blocked.manifestSha256
        ||result.manifestPath!==context.manifest||result.statePath!==context.state)throw new Error('本地终止结果不属于原题单和进度');
      const manifestBytes=await fs.readFile(context.manifest),manifest=JSON.parse(manifestBytes),statePath=await existingWorkspacePath(this.root,context.state),stateBytes=await fs.readFile(statePath),run=JSON.parse(stateBytes),{createNewSystemRun}=await import('./new-system-core.mjs');
      const baseDir=manifest.baseDir?await existingWorkspaceDirectory(this.root,manifest.baseDir):path.dirname(context.manifest),expected=createNewSystemRun(manifest,{baseDir}),updated=Date.parse(run.updatedAt);
      if(sha(manifestBytes)!==blocked.manifestSha256||run.kind!=='new-system-run'||run.bookId!==this.bookId||run.manifestHash!==expected.manifestHash
        ||!['failed','stopped','completed'].includes(run.status)||run.status!==result.stateStatus||!Number.isFinite(updated)||updated<submitted||updated>finish
        ||run.tasks?.length!==manifest.tasks.length||run.tasks.some((row,index)=>row.taskId!==manifest.tasks[index].id))throw new Error('原进度或题单身份不匹配');
      const terminal={context,manifest,run,job,jobPath,jobSha256:sha(jobBytes)},proof=await this.noWriteFailureProof(pending,terminal);
      const unresolved=run.tasks.filter(row=>row.recoveryRequired===true&&!['completed','skipped_existing'].includes(row.status));
      if(!proof&&(unresolved.length!==1||result.pendingWrite?.task?.id!==unresolved[0].taskId))throw new Error('无法唯一绑定原官方只读恢复，保留命令与写入锁');
      const pendingPath=!proof&&result.pendingWrite?.evidencePath?await existingWorkspacePath(this.root,result.pendingWrite.evidencePath):blocked.pendingPath??null;
      if(!this.statusIdentityMatches(identity)||sha(await fs.readFile(await existingWorkspacePath(this.root,jobPath)))!==terminal.jobSha256
        ||sha(await fs.readFile(await existingWorkspacePath(this.root,context.manifest)))!==context.manifestSha256
        ||sha(await fs.readFile(await existingWorkspacePath(this.root,statePath)))!==sha(stateBytes)||!this.statusIdentityMatches(identity))throw new Error('本地终止证据或会话身份已变化');
      this.state.last={...job,localTerminalProof:{kind:'bound-local-terminal',jobPath,jobSha256:terminal.jobSha256,manifestSha256:context.manifestSha256,stateSha256:sha(stateBytes)},...(proof?{result:{...result,uncertain:false,noWriteProof:proof}}:{})};
      this.state.writeBlocked=!proof;this.state.blockedContext=proof?null:{...blocked,taskId:unresolved[0].taskId,pendingPath};this.state.pending=null;await this.persist();
      return {...this.snapshot(),statusSource:'local-terminal',taskNotRetried:true};
    }catch(error){return {...this.snapshot(),error:message,localTerminalError:safeDiagnosticMessage(error.message),taskNotRetried:true};}
  }
  async status({connect=false}={}){
    if(this.statusPromise)return this.statusPromise;
    const blocked=this.statusOperation;if(blocked?.expired&&Number.isSafeInteger(blocked.connection?.servicePid)&&!this.alive(blocked.connection.servicePid)&&(this.dead||!this.connection||this.connection!==blocked.connection))this.statusOperation=null;
    if(this.statusOperation?.expired){this.statusPromise=this.localTerminalStatus('远端状态仍未返回；任务不重发').finally(()=>{this.statusPromise=null;});return this.statusPromise;}
    const attempt={...this.statusIdentity(),expired:false,startedMs:Date.now(),startedAt:new Date().toISOString()};this.statusOperation=attempt;
    const operation=this._status({connect,attempt});operation.finally(()=>{if(this.statusOperation!==attempt)return;const sameTransport=this.connection===attempt.connection&&this.state.connectionCount===attempt.connectionCount&&this.pageBindingId===attempt.bindingId;if(attempt.remoteReturned||attempt.transportReturned&&sameTransport||!attempt.dispatched&&!attempt.expired){attempt.finished=true;this.lastStatusRequest=this.statusRequestSnapshot(attempt);this.statusOperation=null;}else attempt.expired=true;}).catch(()=>{});
    let timer;const deadline=new Promise(resolve=>{timer=setTimeout(()=>{attempt.expired=true;resolve(this.localTerminalStatus('状态等待超时；保留原任务，不重发'));},this.statusTimeoutMs);});
    this.statusPromise=Promise.race([operation,deadline]).finally(()=>{clearTimeout(timer);this.statusPromise=null;});return this.statusPromise;
  }
  async _status({connect,attempt}){
    if(!this.connection&&!connect)return this.snapshot();
    try{if(connect)await this.connect({explicit:true});Object.assign(attempt,{connection:this.connection,connectionCount:this.state.connectionCount,bindingId:this.pageBindingId});if(attempt.expired)return this.snapshot();await this.bind();if(attempt.expired||this.state.pending!==attempt.pending||this.state.pauseControl.generation!==attempt.pauseGeneration)return {...this.snapshot(),taskNotRetried:true};Object.assign(attempt,{connection:this.connection,connectionCount:this.state.connectionCount,bindingId:this.pageBindingId});attempt.dispatched=true;
      const onResponse=response=>{if(response.connection===attempt.connection&&response.connectionCount===attempt.connectionCount&&response.bindingId===attempt.bindingId&&this.connection===attempt.connection&&this.state.connectionCount===attempt.connectionCount&&this.pageBindingId===attempt.bindingId){attempt.transportReturned=true;attempt.responseOutcome=response.outcome;}};
      const remote=await this.bridge('status',undefined,{onResponse});if(remote.bookId!==this.bookId)throw new Error('桥接书籍不匹配');attempt.remoteReturned=this.connection===attempt.connection&&this.state.connectionCount===attempt.connectionCount&&this.pageBindingId===attempt.bindingId;if(attempt.expired||!this.statusIdentityMatches(attempt))return {...this.snapshot(),taskNotRetried:true};const pending=attempt.pending;await this.mergePauseFence(remote.continuationFence);if(attempt.expired||!this.statusIdentityMatches(attempt))return {...this.snapshot(),taskNotRetried:true};
      if(pending&&remote.job?.id===pending.id&&remote.job.terminal){
        if(pending.continuationGuard&&!acceptedContinuation(remote.job.continuationGuardAccepted,pending.continuationGuard,this.bookId,pending.id))throw new Error('自动接续终止结果缺少本命令接受证明，保留任务与写入锁');
        this.state.last=remote.job;
        if(pending.action==='execute'){
          const result=remote.job.result;this.state.writeBlocked=result?.uncertain!==false;
          this.state.blockedContext=this.state.writeBlocked?{...this.state.blockedContext,taskId:result?.pendingWrite?.task?.id??this.state.blockedContext?.taskId??null,pendingPath:result?.pendingWrite?.evidencePath??this.state.blockedContext?.pendingPath??null}:null;
        }
        if(['reconcile','complete-record-repair'].includes(pending.action)&&!remote.job.error&&this.state.writeBlocked){const result=remote.job.result,proof=result?.recovery,blocked=this.state.blockedContext;
          const historical=proof?.liveNoSaveRequests===false&&validHistoricalNetworkRecoveryProof(proof.historicalNetworkProof,{bookId:this.bookId,taskId:blocked.taskId,manifestSha256:blocked.manifestSha256})
            &&proof.historicalNetworkProof.originalPendingPath===blocked.pendingPath&&proof.historicalNetworkProof.currentManifest===blocked.manifest&&proof.historicalNetworkProof.currentState===blocked.state
            &&proof.historicalNetworkProof.freshConfirmation.nodeID===proof.nodeID&&JSON.stringify(proof.historicalNetworkProof.freshConfirmation.priorRecordIds)===JSON.stringify(proof.priorRecordIds);
          const contentProof=proof?.outcome==='saved'?proof.priorRecordsUnchanged===true&&proof.targetRecordUnique===true&&proof.fullContentCompared===true&&Number.isSafeInteger(proof.recordId)&&proof.recordId>0:proof?.outcome==='not_saved'&&(proof.liveNoSaveRequests===true||validBeforePlusProof(proof.beforePlusFailure,{bookId:this.bookId,taskId:blocked.taskId,manifestSha256:blocked.manifestSha256})||historical)&&proof.priorRecordsUnchanged===true&&proof.recordId===null;
          const writeScopeValid=pending.action==='complete-record-repair'?typeof result?.writePerformed==='boolean':result?.writePerformed===false;
          if(writeScopeValid&&result?.uncertain===false&&proof?.writeUnlocked===true&&contentProof&&result.manifestPath===blocked.manifest&&result.statePath===blocked.state&&result.taskId===blocked.taskId&&proof.taskId===blocked.taskId&&proof.bookId===this.bookId){this.state.writeBlocked=false;this.state.blockedContext=null;}
        }
        this.state.pending=null;await this.persist();
      }else if(pending&&!remote.job&&!this.alive(pending.servicePid)&&this.connection.servicePid!==pending.servicePid){
        const proof=await this.noWriteFailureProof(pending);if(attempt.expired||!this.statusIdentityMatches(attempt))return {...this.snapshot(),taskNotRetried:true};this.state.last={id:pending.id,action:pending.action,terminal:true,...(proof?{result:{uncertain:false,noWriteProof:proof}}:{error:'旧子服务已退出，原结果待只读核对'})};
        if(pending.action==='execute'&&proof){this.state.writeBlocked=false;this.state.blockedContext=null;}
        this.state.pending=null;await this.persist();
      }
      return {...this.snapshot(),remote};
    }catch(error){return {...this.snapshot(),error:safeDiagnosticMessage(error.message),taskNotRetried:true};}
  }
  async command(command){
    if(this.closed||this.closing)throw new Error('执行器正在关闭或已关闭');const {action,args,continuationGuard}=validateRecorderCommand(command,this.root);
    if(action==='status')return this.status({connect:true});if(action==='pause'){const generation=Math.max(this.state.pauseControl.generation,this.continuationFence?.pauseGeneration??0)+1;if(!Number.isSafeInteger(generation))throw new Error('暂停版本已达上限，保留暂停');this.state.pauseControl={schemaVersion:1,generation,paused:true};await this.persist();const result=await this.bridge('pause',{pauseGeneration:generation});await this.mergePauseFence(result.continuationFence);return {...result,pauseControl:structuredClone(this.state.pauseControl),continuationFence:this.snapshot().continuationFence};}if(action==='close')return this.close();
    if(this.busy||this.state.pending)throw new Error('已有任务或命令尚未终止');const resumePauseGeneration=action==='execute'&&!continuationGuard?this.state.pauseControl.generation:undefined;this.busy=true;
    try{
      if(this.statusOperation?.expired)throw new Error('原远端状态仍在等待，禁止派发新任务；不重发，不自动重连');
      const context=!['probe','collect'].includes(action)?await this.reviewedContext(args):null;
      if(action==='collect'&&this.state.writeBlocked)throw new Error('保存结果待核对；保留写入锁，禁止切换来源页采集');
      if(action==='execute'&&this.state.writeBlocked)throw new Error('保存结果待核对；保留写入锁，禁止再次新增');
      if(action==='reconcile'&&args.historicalNetworkEvidencePath&&!this.state.writeBlocked)throw new Error('历史网络核对仅允许原已锁定的未知保存任务');
      if(action==='complete-record-repair'&&!this.state.writeBlocked)throw new Error('补全仅允许原已绑定待核对任务');
      if(['reconcile','complete-record-repair'].includes(action)&&this.state.writeBlocked){await this.bindUnknownRecovery();const blocked=this.state.blockedContext,pendingPath=blocked.pendingPath?await writableWorkspacePath(this.root,args.pendingPath??blocked.pendingPath):null;if(context.manifest!==blocked.manifest||context.state!==blocked.state||context.manifestSha256!==blocked.manifestSha256||args.taskId!==blocked.taskId||blocked.pendingPath&&pendingPath!==blocked.pendingPath)throw new Error('只能核对原失败题单/进度/任务');if(blocked.pendingPath)args.pendingPath=pendingPath;}
      const id=command.id??randomUUID();if(this.state.seenIds.includes(id))throw new Error('命令 ID 已使用，禁止重复派发');
      await this.bind();
      if(continuationGuard){const remote=await this.bridge('status'),fence=await this.mergePauseFence(remote.continuationFence);if(!fence||!this.pausePersistenceSupported)throw new Error('当前浏览器桥接缺少自动接续保护协议，未提交任务');if(fence.paused||fence.previousTerminalId!==continuationGuard.previousTerminalId||fence.pauseGeneration!==continuationGuard.pauseGeneration||continuationGuard.connectionCount!==this.state.connectionCount)throw new Error('自动接续的连接、暂停版本或原终止命令已变化，未提交任务');}
      const previousBlock={writeBlocked:this.state.writeBlocked,blockedContext:structuredClone(this.state.blockedContext)};
      this.state.pending={id,action,args:structuredClone(args),servicePid:this.connection.servicePid,at:new Date().toISOString(),...(continuationGuard?{continuationGuard:structuredClone(continuationGuard)}:{})};this.state.seenIds.push(id);
      if(action==='execute'){this.state.writeBlocked=true;this.state.blockedContext={...context,taskId:null,pendingPath:null};}await this.persist();
      try{
        const started=await this.bridge('start',{id,action,args,...(continuationGuard?{continuationGuard}:{}),...(resumePauseGeneration===undefined?{}:{resumePauseGeneration})}),fence=await this.mergePauseFence(started.continuationFence);
        if(started.id===id&&started.started===false&&['continuation-fence','pause-fence','status-inflight'].includes(started.rejected)&&started.writePerformed===false&&started.uncertain===false&&fence){this.state.pending=null;this.state.writeBlocked=previousBlock.writeBlocked;this.state.blockedContext=previousBlock.blockedContext;this.state.lastError='执行保护拒绝了任务；连接、暂停或原终止状态已变化，任务未启动';await this.persist();return {...this.snapshot(),error:this.state.lastError,rejected:started.rejected,taskNotRetried:true};}
        if(continuationGuard){
          if(started.id!==id||started.started!==true||!fence||!acceptedContinuation(started.continuationGuardAccepted,continuationGuard,this.bookId,id))throw new Error('自动接续未取得绑定本命令的接受证明，保留原任务与写入锁，不重发');
        }
        if(resumePauseGeneration!==undefined&&this.pausePersistenceSupported){if(started.id!==id||started.started!==true||!acceptedResume(started.pauseResumeAccepted,resumePauseGeneration,this.bookId,id))throw new Error('普通执行未取得同版本暂停恢复证明，保留任务与写入锁');if(this.state.pauseControl.generation===resumePauseGeneration&&started.continuationFence?.paused===false){this.state.pauseControl={schemaVersion:1,generation:resumePauseGeneration,paused:false};await this.persist();}}
      }catch(error){this.state.lastError=safeDiagnosticMessage(error.message);await this.persist();return {...this.snapshot(),error:this.state.lastError,taskNotRetried:true};}
      return await this.status();
    }finally{this.busy=false;}
  }
  async close(){
    if(this.closed)return {bookId:this.bookId,closed:true,tabCleanup:this.tabCleanup};if(this.busy||this.connectPromise||this.bindPromise||this.closing)throw new Error('命令或连接正在执行，保留运行锁');this.closing=true;
    try{if(this.statusPromise)await this.statusPromise;if(this.state.pending)throw new Error('任务未确认终止；先 pause 再等待 status');const statusPid=this.statusOperation?.connection?.servicePid;if(this.statusOperation?.expired&&(!Number.isSafeInteger(statusPid)||statusPid<1||this.alive(statusPid)))throw new Error('原远端状态未确认结束；保留运行锁，不自动关闭或重连');if(this.windowHelperCleanupSupported&&this.connection&&!this.dead){try{const result=await this.invokeBridge('cleanupWindowHelper');if(result.bookId!==this.bookId||typeof result.cleanup?.removed!=='boolean'||Object.keys(result.cleanup).some(key=>!['removed','reason'].includes(key)))throw new Error('窗口辅助页清理回执无效');this.state.windowHelperCleanup=result.cleanup;}catch{this.state.windowHelperCleanup={removed:false,reason:'cleanup-unconfirmed'};}}await this.cleanupOwnedTab();await this.persist();if(this.connection)await this.connection.close();this.connection=null;this.dead=false;this.binding=false;this.closed=true;return {bookId:this.bookId,closed:true,tabCleanup:this.tabCleanup,...(this.state.windowHelperCleanup?{windowHelperCleanup:this.state.windowHelperCleanup}:{})};}finally{this.closing=false;}
  }
}
