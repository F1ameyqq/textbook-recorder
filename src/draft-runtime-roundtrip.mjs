import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {existingWorkspacePath, writableWorkspacePath, prepareRuntimeDirectory} from './recorder-config.mjs';
import {verifyNewSystemSave} from './new-system-core.mjs';
import {captureResponseBeforeWait} from './deferred-response-wait.mjs';

const SAVE_PATH='/edushop/textbook/myproducecommit/editshiti';
export const DRAFT_RUNTIME_MARKER_HTML='<p>【录入运行时临时测试标记：保存后立即原样恢复】</p>';
const registered=new WeakMap();
const liveCapabilities=new WeakMap();
const sha=value=>createHash('sha256').update(value).digest('hex');
const assert=(value,message)=>{if(!value)throw new Error(message);};
const positive=value=>Number.isSafeInteger(value)&&value>0;
const keys=(value,wanted)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===wanted.split(',').sort().join(',');
const nonempty=value=>typeof value==='string'&&Boolean(value.trim())&&!value.includes('\0');
const freeze=value=>{if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const rowKeys='seqIndex,shitiID,nodeID,question,answer,mainPicNum,answerPicNum,haveAnswer';
const safeReadMethod=method=>['GET','HEAD','OPTIONS'].includes(method);
function potentialWrite(request,origin){try{const url=new URL(request.url());return url.origin===origin&&(url.pathname===SAVE_PATH||!safeReadMethod(request.method()));}catch{return false;}}

/** This is a direct-user runtime test, not an image-reviewed entry manifest. */
export async function loadDraftRuntimePlan(root,manifestPath){
  root=await fs.realpath(root);
  const file=await existingWorkspacePath(root,manifestPath),bytes=await fs.readFile(file),manifest=JSON.parse(bytes);
  assert(keys(manifest,'schemaVersion,kind,source,bookId,authorization,scope,target,baseline')&&manifest.schemaVersion===1&&manifest.kind==='draft-runtime-roundtrip'&&manifest.source==='server-snapshot'&&positive(manifest.bookId),'往返测试计划结构或来源无效');
  assert(keys(manifest.authorization,'source,userQuote')&&manifest.authorization.source==='direct-user'&&nonempty(manifest.authorization.userQuote),'往返测试须绑定明确用户授权');
  assert(keys(manifest.scope,'chapterLabel,sectionLabel,nodeID')&&nonempty(manifest.scope.chapterLabel)&&nonempty(manifest.scope.sectionLabel)&&positive(manifest.scope.nodeID),'往返测试目录无效');
  assert(keys(manifest.target,'seqIndex,shitiID')&&positive(manifest.target.seqIndex)&&positive(manifest.target.shitiID),'往返测试原题身份无效');
  assert(keys(manifest.baseline,'path,sha256')&&nonempty(manifest.baseline.path)&&/^[a-f0-9]{64}$/u.test(manifest.baseline.sha256),'往返测试基线须绑定文件及SHA256');
  const baselinePath=await existingWorkspacePath(root,path.resolve(path.dirname(file),manifest.baseline.path));
  assert(baselinePath!==file,'基线不能是计划自身');
  const baselineBytes=await fs.readFile(baselinePath),baseline=JSON.parse(baselineBytes);
  assert(sha(baselineBytes)===manifest.baseline.sha256,'冻结基线SHA256不符');
  assert(baseline.bookId===manifest.bookId&&baseline.nodeID===manifest.scope.nodeID&&baseline.chapterLabel===manifest.scope.chapterLabel&&baseline.sectionLabel===manifest.scope.sectionLabel&&Number.isFinite(Date.parse(baseline.serverSnapshotAt))&&Array.isArray(baseline.records)&&baseline.records.length===manifest.target.seqIndex,'冻结基线须为同书完整目录及末题');
  const ids=new Set();
  for(const [i,row] of baseline.records.entries()){
    assert(keys(row,rowKeys)&&row.seqIndex===i+1&&positive(row.shitiID)&&!ids.has(row.shitiID)&&row.nodeID===baseline.nodeID&&typeof row.question==='string'&&typeof row.answer==='string'&&Number.isSafeInteger(row.mainPicNum)&&row.mainPicNum>=0&&Number.isSafeInteger(row.answerPicNum)&&row.answerPicNum>=0&&typeof row.haveAnswer==='boolean','冻结目录记录八字段、身份或顺序无效');
    ids.add(row.shitiID);
  }
  const original=baseline.records.at(-1);
  assert(original.shitiID===manifest.target.shitiID&&nonempty(original.question)&&nonempty(original.answer)&&original.haveAnswer===true&&positive(original.mainPicNum)&&positive(original.answerPicNum)&&!original.answer.includes('录入运行时临时测试标记'),'末题必须有完整原始答案、来源且无测试标记');
  const plan=freeze({...manifest,manifestPath:file,manifestSha256:sha(bytes),baseline:{path:baselinePath,sha256:sha(baselineBytes)},records:structuredClone(baseline.records),originalQuestionSha256:sha(original.question),originalAnswerSha256:sha(original.answer),markerHtml:DRAFT_RUNTIME_MARKER_HTML,temporaryAnswer:original.answer+DRAFT_RUNTIME_MARKER_HTML});
  registered.set(plan,{root,manifestBytesSha256:sha(bytes),baselineBytesSha256:sha(baselineBytes)});
  return plan;
}

async function binding(plan){
  const info=registered.get(plan);assert(info,'必须使用loadDraftRuntimePlan读取的原始计划');
  assert(sha(await fs.readFile(await existingWorkspacePath(info.root,plan.manifestPath)))===info.manifestBytesSha256&&sha(await fs.readFile(await existingWorkspacePath(info.root,plan.baseline.path)))===info.baselineBytesSha256,'往返测试计划或冻结基线已改变');
  return info;
}
function taskFor(plan){return {id:'draft-runtime-'+plan.manifestSha256,target:{chapterLabel:plan.scope.chapterLabel,sectionLabel:plan.scope.sectionLabel,record:plan.target.seqIndex,expectedRecordId:plan.target.shitiID}};}
function expectedRecords(plan,temporary=false){const rows=structuredClone(plan.records);if(temporary)rows.at(-1).answer=plan.temporaryAnswer;return rows;}
function journalIdentity(plan){return {kind:'draft-runtime-roundtrip-journal',schemaVersion:1,manifestPath:plan.manifestPath,manifestSha256:plan.manifestSha256,baselinePath:plan.baseline.path,baselineSha256:plan.baseline.sha256,bookId:plan.bookId,scope:plan.scope,target:plan.target};}
function assertJournal(plan,journal){for(const [key,value] of Object.entries(journalIdentity(plan)))assert(isDeepStrictEqual(journal[key],value),'原往返测试journal绑定不符: '+key);assert(typeof journal.journalId==='string'&&Number.isFinite(Date.parse(journal.startedAt))&&Array.isArray(journal.requests)&&Array.isArray(journal.unexpectedMutations),'原往返测试journal不完整');}
async function persist(root,file,value,{exclusive=false}={}){
  file=await writableWorkspacePath(root,file);await prepareRuntimeDirectory(root,path.dirname(file));
  if(exclusive){const handle=await fs.open(file,'wx');try{await handle.writeFile(JSON.stringify(value,null,2)+'\n');await handle.sync();}finally{await handle.close();}return;}
  const temp=file+'.'+randomUUID()+'.tmp',handle=await fs.open(await writableWorkspacePath(root,temp),'wx');
  try{await handle.writeFile(JSON.stringify(value,null,2)+'\n');await handle.sync();}finally{await handle.close();}
  await writableWorkspacePath(root,file);await fs.rename(temp,file);
}
/** Observe only a GET actually emitted by this page's fresh normal reload. */
export async function readDraftBookInfo(adapter,{refresh}={}){
  const page=adapter.page,requests=new Set();
  const matches=request=>{try{const url=new URL(request.url());return request.method()==='GET'&&url.origin===adapter.origin&&url.pathname==='/edushop/textbook/detail/basicinfo'&&url.searchParams.getAll('textbookID').length===1&&Number(url.searchParams.get('textbookID'))===adapter.bookId;}catch{return false;}};
  const onRequest=request=>{if(matches(request))requests.add(request);};page.on('request',onRequest);
  const captured=captureResponseBeforeWait(page,{timeoutMs:adapter.timeout,predicate:response=>requests.has(response.request())&&matches(response.request())});
  try{
    const refreshResult=await(refresh?refresh():adapter._reloadForFreshRead());
    const response=await captured.wait(),body=await response.json(),data=body?.data;
    assert(adapter.page===page&&response.ok()&&body.errno===0&&typeof data?.stateName==='string'&&Object.hasOwn(data,'canEdit')&&(!('textbookID' in data)||Number(data.textbookID)===adapter.bookId),'新鲜书籍状态GET响应缺少已知草稿状态contract');
    return {bookId:adapter.bookId,checkedAt:new Date().toISOString(),status:response.status(),stateName:data.stateName,canEdit:data.canEdit,canEditType:typeof data.canEdit,refreshResult};
  }finally{captured.dispose();page.off('request',onRequest);}
}
async function freshDraftScope(adapter,plan,temporary){
  const info=await readDraftBookInfo(adapter,{refresh:()=>readScope(adapter,plan,temporary)});
  assert(info.stateName==='草稿'&&info.canEdit===true,'仅允许当前可编辑草稿书执行往返测试');
  return info;
}
async function readScope(adapter,plan,temporary){
  const readback=await adapter.read(taskFor(plan),{refresh:true});
  const wanted=expectedRecords(plan,temporary),last=wanted.at(-1);
  assert(readback?.status==='found'&&readback.bookId===plan.bookId&&readback.recordId===plan.target.shitiID&&readback.count===wanted.length&&adapter._nodeID===plan.scope.nodeID&&isDeepStrictEqual(adapter._directoryRecords,wanted),'刷新回读完整目录八字段与预期不符');
  assert(readback.stem?.html===last.question&&readback.answer?.html===last.answer,'刷新编辑器原始HTML与完整目录不符');
  return {checkedAt:new Date().toISOString(),recordsSha256:sha(JSON.stringify(adapter._directoryRecords)),questionSha256:sha(last.question),answerSha256:sha(last.answer),recordId:readback.recordId,count:readback.count};
}
async function textAnswerPreflight(adapter,plan){
  await adapter.page.evaluate(html=>{
    const root=document.createElement('div');root.innerHTML=html;
    const allowed=new Set(['P','BR','SPAN','B','STRONG','I','EM','U','SUP','SUB']);
    if(!root.children.length||[...root.childNodes].some(node=>node.nodeType!==1&&node.textContent.trim())||[...root.children].some(node=>node.tagName!=='P')||[...root.querySelectorAll('*')].some(node=>!allowed.has(node.tagName)||[...node.attributes].some(attr=>!['style','dir','align','class'].includes(attr.name)||/^on/iu.test(attr.name)))||!root.textContent.trim())throw new Error('往返测试仅支持普通段落文字答案，不重录图片、公式或可执行内容');
  },plan.records.at(-1).answer);
}
function parseRequest(request){let body;try{body=request.postDataJSON();}catch{}if(!body||typeof body!=='object'||Array.isArray(body)){const raw=request.postData();try{body=JSON.parse(raw);}catch{body=Object.fromEntries(new URLSearchParams(raw));}}assert(body&&typeof body==='object'&&!Array.isArray(body),'保存正文无效');return body;}
function requestIdentity(body){return {bookId:Number(body.textbookID),nodeID:Number(body.nodeID),seqIndex:Number(body.seqIndex),shitiID:Number(body.shitiID),mainPicNum:Number(body.mainPicNum),answerPicNum:Number(body.answerPicNum)};}
function responseInteger(value){if(positive(value))return value;if(typeof value==='string'&&/^[1-9][0-9]*$/u.test(value)&&positive(Number(value)))return Number(value);return undefined;}
function expectedIdentity(plan){const last=plan.records.at(-1);return {bookId:plan.bookId,nodeID:plan.scope.nodeID,seqIndex:plan.target.seqIndex,shitiID:plan.target.shitiID,mainPicNum:last.mainPicNum,answerPicNum:last.answerPicNum};}
function validSettledRequests(plan,journal){
  if(journal.unexpectedMutations.length||journal.requests.length!==2)return false;
  return journal.requests.every((row,index)=>{
    const expectedAnswer=index===0?plan.temporaryAnswer:plan.records.at(-1).answer;
    return row.phase===(index===0?'temporary':'restore')&&row.method==='POST'&&row.pathname===SAVE_PATH&&row.status==='responded'&&row.dispatchDecision==='continued'&&row.requestValidated===true&&isDeepStrictEqual(row.identity,expectedIdentity(plan))&&row.questionSha256===plan.originalQuestionSha256&&row.answerSha256===sha(expectedAnswer)&&Number.isFinite(Date.parse(row.responseAt))&&verifyNewSystemSave({target:{record:plan.target.seqIndex,expectedRecordId:plan.target.shitiID},source:{pages:[plan.records.at(-1).mainPicNum],answerPages:[plan.records.at(-1).answerPicNum]}},row.receipt,{bookId:plan.bookId,existingRecordId:plan.target.shitiID}).ok;
  });
}
function validTemporaryRequest(plan,journal){
  if(journal.requests.length!==1||journal.unexpectedMutations.length)return false;
  const copy={...journal,requests:[journal.requests[0],{...journal.requests[0],index:2,phase:'restore',answerSha256:plan.originalAnswerSha256}]};
  return validSettledRequests(plan,copy);
}
function createCapability(adapter,plan,statePath,journal){
  const page=adapter.page,context=adapter.context,browser=context?.browser?.(),cap={page,context,statePath,manifestSha256:plan.manifestSha256,journalId:journal.journalId,nativeInputs:0,restoreIntent:false,idle:false,invalid:false,restoreEligible:false,noInputEligible:false,journalSha256:null};
  const revoke=()=>{cap.invalid=true;};
  const mutation=request=>{if(cap.idle&&potentialWrite(request,adapter.origin))revoke();};
  page.on('request',mutation);page.on('close',revoke);page.on('crash',revoke);browser?.on('disconnected',revoke);
  cap.dispose=async()=>{page.off('request',mutation);page.off('close',revoke);page.off('crash',revoke);browser?.off('disconnected',revoke);await cap.removeRoute?.();};
  liveCapabilities.set(adapter,cap);return cap;
}
function matchingCapability(adapter,plan,statePath,journal){const cap=liveCapabilities.get(adapter);return cap&&!cap.invalid&&cap.idle&&cap.page===adapter.page&&cap.context===adapter.context&&cap.statePath===statePath&&cap.manifestSha256===plan.manifestSha256&&cap.journalId===journal.journalId?cap:null;}

/** Exactly two ordinary editor/blur saves; an existing journal is never replayed. */
export async function runDraftRuntimeRoundtrip(options){return executeRoundtrip(options);}

/** A live, observed, known temporary save may be restored once. No replay. */
export async function restoreDraftRuntimeRoundtrip(options){
  const {adapter,plan}=options,info=await binding(plan),statePath=await existingWorkspacePath(info.root,options.statePath),bytes=await fs.readFile(statePath),journal=JSON.parse(bytes);
  assertJournal(plan,journal);const cap=matchingCapability(adapter,plan,statePath,journal);
  assert(cap?.restoreEligible&&cap.nativeInputs===1&&!cap.restoreIntent&&cap.journalSha256===sha(bytes)&&validTemporaryRequest(plan,journal),'缺少连续本进程已核验临时保存能力，禁止恢复重放');
  assert(adapter._pendingWrite?.kind===plan.kind&&adapter._pendingWrite.manifestSha256===plan.manifestSha256&&path.resolve(adapter._pendingWrite.evidencePath)===statePath,'恢复必须绑定原往返测试保存锁');
  return executeRoundtrip({...options,statePath},{journal,cap});
}

async function executeRoundtrip({adapter,plan,statePath,checkpoint=async()=>{},stopRequested=()=>false},resume=null){
  const info=await binding(plan);statePath=await writableWorkspacePath(info.root,statePath);
  assert(statePath!==plan.manifestPath&&statePath!==plan.baseline.path,'journal不能覆盖计划或冻结基线');
  assert(adapter?.bookId===plan.bookId&&!adapter._busy&&(resume||!adapter._uncertain&&!adapter._pendingWrite),'往返测试适配器不匹配或有未核验写入');
  if(!resume)try{await fs.access(statePath);throw new Error('原往返测试journal已存在，禁止重放；只能只读核对');}catch(error){if(error.code!=='ENOENT')throw error;}
  const page=adapter.page,context=adapter.context,journal=resume?.journal??{...journalIdentity(plan),journalId:randomUUID(),startedAt:new Date().toISOString(),phase:'preflight',stateStatus:'pending',requests:[],unexpectedMutations:[],draftChecks:[],readbacks:[]};
  const cap=resume?.cap??createCapability(adapter,plan,statePath,journal);cap.restoreEligible=false;
  let created=Boolean(resume),edited=Boolean(resume),fatal=null,queue=Promise.resolve(),phase=null,lastActivity=0;
  let dispatchEnabled=true,persistQueue=Promise.resolve();
  const checkPage=()=>assert(!cap.invalid&&adapter.page===page&&adapter.context===context&&!page.isClosed(),'往返测试浏览器绑定已改变');
  const notify=async()=>checkpoint({phase:journal.phase,statePath,bookId:plan.bookId,target:plan.target,observedSaveRequests:journal.requests.length,receipts:journal.requests.filter(row=>row.receipt).map(row=>row.receipt),uncertain:edited&&journal.stateStatus!=='completed'});
  const save=()=>{const operation=persistQueue.then(async()=>{await persist(info.root,statePath,journal);await notify();});persistQueue=operation.catch(()=>{});return operation;};
  const enqueue=fn=>{queue=queue.then(fn).catch(error=>{fatal??=error;});};
  const drain=async()=>{for(;;){const previous=queue;await previous;if(previous===queue)break;}if(fatal)throw fatal;};
  const byRequest=new Map();
  const onRequest=request=>{
    let url;try{url=new URL(request.url());}catch{return;}
    if(!potentialWrite(request,adapter.origin))return;
    lastActivity=Date.now();
    if(url.pathname!==SAVE_PATH||request.method()!=='POST'){
      journal.unexpectedMutations.push({method:request.method(),pathname:url.pathname,at:new Date().toISOString()});
      enqueue(async()=>{await save();throw new Error('往返测试出现范围外修改请求');});return;
    }
    const row={index:journal.requests.length+1,phase,method:request.method(),pathname:url.pathname,status:'observed',at:new Date().toISOString()};journal.requests.push(row);byRequest.set(request,row);
    enqueue(async()=>{
      const body=parseRequest(request),identity=requestIdentity(body);row.identity=identity;row.questionSha256=sha(String(body.question));row.answerSha256=sha(String(body.answer));
      const expectedAnswer=row.phase==='temporary'?plan.temporaryAnswer:row.phase==='restore'?plan.records.at(-1).answer:null;
      row.requestValidated=journal.requests.length<=2&&['temporary','restore'].includes(row.phase)&&journal.requests.filter(item=>item.phase===row.phase).length===1&&isDeepStrictEqual(identity,expectedIdentity(plan))&&body.question===plan.records.at(-1).question&&body.answer===expectedAnswer;
    row.status=row.requestValidated?'awaiting-response':'invalid-request';await save();assert(row.requestValidated,'往返保存请求不是绑定原ID、来源、原题干及固定答案');
    });
  };
  const onResponse=response=>{const row=byRequest.get(response.request());if(!row)return;lastActivity=Date.now();enqueue(async()=>{
    assert(row.status==='awaiting-response','往返保存响应没有合法请求');const body=await response.json();
    const normalized={errno:body?.errno,errmsg:body?.errmsg,data:{seqIndex:responseInteger(body?.data?.seqIndex),shitiID:responseInteger(body?.data?.shitiID),haveAnswer:body?.data?.haveAnswer}};
    row.receipt={bookId:plan.bookId,seqIndex:plan.target.seqIndex,shitiID:normalized.data.shitiID,mainPicNum:row.identity.mainPicNum,answerPicNum:row.identity.answerPicNum,request:{...row.identity},response:{status:response.status(),body:normalized,rawBody:body}};
    const valid=verifyNewSystemSave({target:{record:plan.target.seqIndex,expectedRecordId:plan.target.shitiID},source:{pages:[row.identity.mainPicNum],answerPages:[row.identity.answerPicNum]}},row.receipt,{bookId:plan.bookId,existingRecordId:plan.target.shitiID});
    row.status=valid.ok?'responded':'invalid-response';row.responseAt=new Date().toISOString();await save();assert(valid.ok,'往返保存业务回执不符: '+valid.errors.join('; '));
  });};
  const onFailed=request=>{const row=byRequest.get(request);if(row)enqueue(async()=>{row.status=row.dispatchDecision==='aborted'?'aborted-before-dispatch':'request-failed';await save();throw new Error('往返保存传输失败，禁止重试');});};
  const routeHandler=async route=>{
    const request=route.request();let url;try{url=new URL(request.url());}catch{return route.abort('blockedbyclient');}
    if(!potentialWrite(request,adapter.origin))return route.continue();
    const row=byRequest.get(request),wanted=phase==='temporary'?plan.temporaryAnswer:phase==='restore'?plan.records.at(-1).answer:null;let body;try{body=parseRequest(request);}catch{}
    const allowed=dispatchEnabled&&!cap.invalid&&url.pathname===SAVE_PATH&&request.method()==='POST'&&row&&body&&row.phase===phase&&['temporary','restore'].includes(phase)&&journal.requests.filter(item=>item.phase===phase).length===1&&isDeepStrictEqual(requestIdentity(body),expectedIdentity(plan))&&body.question===plan.records.at(-1).question&&body.answer===wanted;
    if(row)row.dispatchDecision=allowed?'continue-intent':'abort-intent';
    else journal.unexpectedMutations.push({method:request.method(),pathname:url.pathname,at:new Date().toISOString(),dispatchDecision:'aborted'});
    if(!allowed){cap.invalid=true;fatal??=new Error('往返测试预发送边界拒绝非预期修改');}
    try{
      if(created)await save();
      if(!allowed){await route.abort('blockedbyclient');if(row)row.dispatchDecision='aborted';if(created)await save();return;}
      await route.continue();row.dispatchDecision='continued';if(created)await save();
    }catch(error){cap.invalid=true;fatal??=error;try{await route.abort('blockedbyclient');}catch{}}
  };
  adapter._busy=true;
  try{
    checkPage();assert(!stopRequested(),'往返测试已停止');
    if(cap.removeRoute)await cap.removeRoute();checkPage();
    await page.route('**/*',routeHandler);cap.removeRoute=()=>page.unroute('**/*',routeHandler);cap.idle=false;
    if(!resume){await persist(info.root,statePath,journal,{exclusive:true});created=true;await notify();}
    page.on('request',onRequest);page.on('response',onResponse);page.on('requestfailed',onFailed);
    if(!resume){const initial=await freshDraftScope(adapter,plan,false);journal.draftChecks.push({...initial,refreshResult:undefined});journal.readbacks.push(initial.refreshResult);await textAnswerPreflight(adapter,plan);}
    for(const next of resume?['restore']:['temporary','restore']){
      checkPage();await binding(plan);assert(!stopRequested(),'往返测试已停止，保留原状态');await drain();
      const fresh=await freshDraftScope(adapter,plan,next==='restore');journal.draftChecks.push({...fresh,refreshResult:undefined});journal.readbacks.push(fresh.refreshResult);
      phase=next;journal.phase=next+'-write-intent';if(next==='restore')cap.restoreIntent=true;await save();
      checkPage();assert(!stopRequested(),'往返测试已停止，保留原状态');
      adapter._pendingWrite={kind:'draft-runtime-roundtrip',status:'pending',bookId:plan.bookId,phase:journal.phase,evidencePath:statePath,manifestSha256:plan.manifestSha256};
      adapter._uncertain=true;edited=true;cap.nativeInputs++;
      await adapter._paste('#answeredit .w-e-text',next==='temporary'?plan.temporaryAnswer:plan.records.at(-1).answer,{replace:true});
      await drain();
      assert(await page.locator('#contentedit .w-e-text').innerHTML()===plan.records.at(-1).question&&await page.locator('#answeredit .w-e-text').innerHTML()===(next==='temporary'?plan.temporaryAnswer:plan.records.at(-1).answer),'blur保存前编辑器原始HTML不符，禁止发送');
      await adapter._click(page.locator('input.el-input__inner').nth(0));
      const deadline=Date.now()+adapter.timeout;
      for(;;){await drain();const rows=journal.requests.filter(row=>row.phase===next);if(rows.length===1&&rows[0].status==='responded'&&Date.now()-lastActivity>=500)break;assert(Date.now()<deadline,'往返保存回执未完全settled，禁止重试');await pause(30);}
      journal.phase=next+'-readback';journal.readbacks.push(await readScope(adapter,plan,next==='temporary'));await drain();await save();
    }
    assert(validSettledRequests(plan,journal),'往返保存请求或回执未完整核验');
    journal.stateStatus='completed';journal.phase='completed';journal.finishedAt=new Date().toISOString();delete journal.error;delete journal.failedAt;await save();
    adapter._pendingWrite=null;adapter._uncertain=false;
    await cap.dispose();liveCapabilities.delete(adapter);
    return {kind:plan.kind,bookId:plan.bookId,stateStatus:'completed',uncertain:false,pendingWrite:null,writePerformed:true,statePath,manifestPath:plan.manifestPath,manifestSha256:plan.manifestSha256,baselineSha256:plan.baseline.sha256,originalRecordId:plan.target.shitiID,receipts:journal.requests.map(row=>row.receipt),saveRequests:2,restored:true,finalReadback:journal.readbacks.at(-1),preservedRecords:plan.records.length};
  }catch(error){
    dispatchEnabled=false;
    page.off('request',onRequest);page.off('response',onResponse);page.off('requestfailed',onFailed);
    for(;;){const previous=queue;await previous;if(previous===queue)break;}
    await persistQueue;
    const possible=edited||journal.requests.length>0||journal.unexpectedMutations.length>0;
    if(created){journal.stateStatus=possible?'unknown':'failed-before-write';journal.error=error.message;journal.failedAt=new Date().toISOString();try{await persist(info.root,statePath,journal);cap.journalSha256=sha(await fs.readFile(statePath));}catch(persistError){cap.invalid=true;error.journalError=persistError.message;}}
    cap.noInputEligible=created&&!cap.invalid&&cap.nativeInputs===0&&!journal.requests.length&&!journal.unexpectedMutations.length;
    cap.restoreEligible=created&&!cap.invalid&&cap.nativeInputs===1&&!cap.restoreIntent&&journal.phase==='temporary-readback'&&validTemporaryRequest(plan,journal)&&journal.readbacks.at(-1)?.answerSha256===sha(plan.temporaryAnswer);
    cap.idle=true;
    if(possible){adapter._uncertain=true;adapter._pendingWrite={kind:'draft-runtime-roundtrip',status:'pending',bookId:plan.bookId,phase:journal.phase,evidencePath:statePath,manifestSha256:plan.manifestSha256};}
    if(!created){await cap.dispose();liveCapabilities.delete(adapter);}
    error.statePath=statePath;error.writePerformed=edited;throw error;
  }finally{page.off('request',onRequest);page.off('response',onResponse);page.off('requestfailed',onFailed);adapter._busy=false;}
}

/** Read-only reconciliation cannot resume a temporary answer or resend a save. */
export async function reconcileDraftRuntimeRoundtrip({adapter,plan,statePath}){
  const info=await binding(plan),file=await existingWorkspacePath(info.root,statePath),journalBytes=await fs.readFile(file),journal=JSON.parse(journalBytes);
  assertJournal(plan,journal);assert(adapter.bookId===plan.bookId&&!adapter._busy,'往返测试仍执行或不是原书');
  if(adapter._pendingWrite)assert(adapter._pendingWrite.kind===plan.kind&&adapter._pendingWrite.manifestSha256===plan.manifestSha256&&path.resolve(adapter._pendingWrite.evidencePath)===file,'不能用往返journal清除其他保存锁');
  let observedMutation=false;const page=adapter.page,onRequest=request=>{if(potentialWrite(request,adapter.origin))observedMutation=true;};
  page.on('request',onRequest);let current;try{current=await adapter.read(taskFor(plan),{refresh:true});}finally{page.off('request',onRequest);}
  assert(current?.status==='found'&&current.bookId===plan.bookId&&current.recordId===plan.target.shitiID&&adapter._nodeID===plan.scope.nodeID,'往返核对原书或身份不符');
  const baseline=isDeepStrictEqual(adapter._directoryRecords,expectedRecords(plan,false))&&current.stem?.html===plan.records.at(-1).question&&current.answer?.html===plan.records.at(-1).answer;
  const temporary=isDeepStrictEqual(adapter._directoryRecords,expectedRecords(plan,true))&&current.stem?.html===plan.records.at(-1).question&&current.answer?.html===plan.temporaryAnswer;
  assert(sha(await fs.readFile(await existingWorkspacePath(info.root,file)))===sha(journalBytes),'只读核对期间原journal已改变');
  const cap=matchingCapability(adapter,plan,file,journal),zeroNativeInput=Boolean(cap?.noInputEligible&&cap.nativeInputs===0&&cap.journalSha256===sha(journalBytes)&&!journal.requests.length&&!journal.unexpectedMutations.length);
  const receiptsComplete=validSettledRequests(plan,journal),writeUnlocked=!observedMutation&&baseline&&(receiptsComplete||zeroNativeInput);
  if(writeUnlocked){adapter._pendingWrite=null;adapter._uncertain=false;await cap?.dispose();liveCapabilities.delete(adapter);}
  else {adapter._uncertain=true;adapter._pendingWrite={kind:'draft-runtime-roundtrip',status:'pending',bookId:plan.bookId,evidencePath:file,manifestSha256:plan.manifestSha256};}
  return {kind:plan.kind,bookId:plan.bookId,manifestPath:plan.manifestPath,manifestSha256:plan.manifestSha256,statePath:file,stateStatus:writeUnlocked?'completed':'blocked',writePerformed:false,uncertain:!writeUnlocked,pendingWrite:adapter._pendingWrite,outcome:baseline?'baseline':temporary?'temporary':'mismatch',writeUnlocked,restored:writeUnlocked,originalRecordId:plan.target.shitiID,saveRequests:journal.requests.length,recovery:{kind:plan.kind,bookId:plan.bookId,writeUnlocked,baselineRestored:baseline,allSaveRequestsSettled:receiptsComplete||zeroNativeInput,receiptsComplete,zeroNativeInputConfirmed:zeroNativeInput,liveRestoreEligible:Boolean(cap?.restoreEligible)}};
}
