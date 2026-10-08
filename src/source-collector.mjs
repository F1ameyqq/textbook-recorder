import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {assertRecorderPage,PLATFORM_ORIGIN,workspacePath,existingWorkspacePath,writableWorkspacePath,prepareRuntimeDirectory,validateRecorderConfig} from './recorder-config.mjs';
import {preparationJob} from './preparation-files.mjs';

const activePages=new WeakSet(),INPUT='input.el-input__inner';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const now=()=>new Date().toISOString();
const positive=n=>Number.isSafeInteger(n)&&n>0;
const clean=error=>String(error?.message??'原图采集失败').replace(/(?:https?|blob|file):\S+/giu,'[网址省略]').replace(/\b(?:token|cookie|authorization|password)\s*[:=][^\r\n]*/giu,'[凭据省略]').slice(0,400);

export async function assertEmptySourceEditors(page){
  const state=await page.evaluate(({operation})=>{
    if(operation!=='collector-editors')throw new Error('采集检查类型错误');
    const selectors=['#contentedit .w-e-text','#answeredit .w-e-text'];
    return selectors.map(selector=>{const nodes=document.querySelectorAll(selector);return {count:nodes.length,html:nodes[0]?.innerHTML??null};});
  },{operation:'collector-editors'});
  if(!Array.isArray(state)||state.length!==2||state.some(row=>row.count!==1||typeof row.html!=='string'||! /^(?:|<p>(?:<br>)?<\/p>|<br>)$/u.test(row.html)))throw new Error('采集要求两个编辑器都为空；请从已保存后的空编辑器入口采集，不会清空或刷新现有内容');
}

async function snapshot(page){
  return page.evaluate(({operation})=>{
    if(operation!=='collector-source-snapshot')throw new Error('采集检查类型错误');
    const inputs=[...document.querySelectorAll('input.el-input__inner')],images=[...document.querySelectorAll('.cropper-box-canvas img[alt="cropper-img"]')];
    const totals=[...document.body.innerText.matchAll(/共\s*(\d+)\s*页/g)].map(match=>Number(match[1]));
    const image=images[0];
    return {inputCount:inputs.length,imageCount:images.length,page:Number(inputs[0]?.value),totals,src:image?.src??null,complete:Boolean(image?.complete),width:image?.naturalWidth??0,height:image?.naturalHeight??0};
  },{operation:'collector-source-snapshot'});
}
function validateSnapshot(state,totalPages){
  if(state?.inputCount!==2||state.imageCount!==2||!Array.isArray(state.totals)||state.totals.length!==2||!positive(state.totals[0])||state.totals[0]!==state.totals[1]||totalPages!==undefined&&state.totals[0]!==totalPages)throw new Error('原图面板或全书页数不能唯一确认');
  if(!positive(state.page)||state.page>state.totals[0])throw new Error('当前来源图片序号无效');
  return state.totals[0];
}
function loaded(state){return state.complete&&positive(state.width)&&positive(state.height)&&typeof state.src==='string'&&state.src.startsWith('blob:')&&new URL(state.src).origin===PLATFORM_ORIGIN;}
function sameImage(a,b){return a.page===b.page&&a.src===b.src&&a.width===b.width&&a.height===b.height&&a.complete===b.complete;}

async function atomicFile(root,file,bytes){
  const target=await writableWorkspacePath(root,file);await prepareRuntimeDirectory(root,path.dirname(target));
  const temporary=await writableWorkspacePath(root,target+'.'+randomUUID()+'.tmp');
  try{await fs.writeFile(temporary,bytes,{flag:'wx'});await writableWorkspacePath(root,target);await fs.rename(temporary,target);}
  finally{await fs.rm(temporary,{force:true});}
}
function validateIndex(index,bookId,totalPages){
  if(index?.schemaVersion!==1||index.bookId!==bookId||index.system!=='teaching-content'||index.totalPages!==totalPages||!Array.isArray(index.pages)||!Array.isArray(index.failures))throw new Error('已有原图索引与书籍、总页数或格式不符');
  const seen=new Set();
  for(const row of index.pages){
    if(!positive(row.systemPage)||row.systemPage>totalPages||seen.has(row.systemPage)||!positive(row.bytes)||!positive(row.width)||!positive(row.height)||!/^[a-f0-9]{64}$/u.test(row.sha256??'')||!['image/png','image/jpeg'].includes(row.mimeType))throw new Error('原图索引页号或文件证据无效');
    const ext=row.mimeType==='image/png'?'png':'jpg';
    if(row.file!==`images/page-${String(row.systemPage).padStart(4,'0')}.${ext}`)throw new Error('原图索引文件路径无效');
    seen.add(row.systemPage);
  }
}
async function jobDirectory(root,output){
  const entry=workspacePath(root,output),jobs=workspacePath(root,'data/jobs'),relative=path.relative(jobs,entry);
  if(!/^[A-Za-z0-9_-]{1,80}$/u.test(relative))throw new Error('原图输出必须是 data/jobs/<job> 目录');
  const job=await preparationJob(root,path.join(entry,'index.json'),{create:true});
  if(path.relative(entry,job.baseDir)!=='')throw new Error('原图输出子 junction 改变了 data/jobs/<job> 实际路径');
  return job.baseDir;
}

/** Only standard DOM reads, blob fetch, and ordinary source-page navigation. */
export async function collectSourcePages({page,root,bookId,from,to,output,onProgress=async()=>{},guardNavigation=async()=>{},stopRequested=()=>false,timeout=20000}){
  validateRecorderConfig({bookId});
  if(!positive(from)||!positive(to)||to<from||!positive(timeout))throw new Error('采集需要明确正整数 from/to 和有界 timeout');
  if(!page||typeof page.route!=='function'||typeof page.unroute!=='function'||typeof page.on!=='function'||typeof page.off!=='function')throw new Error('采集连接必须支持当前页只读路由屏障');
  if(activePages.has(page))throw new Error('同一页面已有原图采集任务');
  activePages.add(page);
  let directory,index,indexPath,indexReady=false,installed=false,downloaded=0,skipped=0,paused=false,primaryError=null;
  const blocked=[],observed=new Set(),aborted=new Set();
  const mutation=request=>{try{return new URL(request.url()).origin===PLATFORM_ORIGIN&&['POST','PUT','PATCH','DELETE'].includes(request.method());}catch{return false;}};
  const observe=request=>{if(mutation(request))observed.add(request);};
  const barrier=async route=>{const request=route.request();if(mutation(request)){blocked.push({method:request.method(),pathname:new URL(request.url()).pathname,at:now()});await route.abort();aborted.add(request);}else await route.continue();};
  const guard=async()=>{
    assertRecorderPage(page.url(),bookId);await guardNavigation();await assertEmptySourceEditors(page);
    if(blocked.length||[...observed].some(request=>!aborted.has(request)))throw new Error('采集期间出现页面写请求，已停止；不会重放请求');
  };
  const save=async()=>atomicFile(directory,indexPath,JSON.stringify(index,null,2)+'\n');
  const summary=()=>({bookId,indexPath,outputDirectory:directory,totalPages:index?.totalPages??null,from,to,requestedPages:to-from+1,downloaded,skipped,status:index?.status??'failed',paused,writePerformed:false});
  const waitLoaded=async(number,oldSrc,requireChanged)=>{
    const deadline=Date.now()+timeout;
    while(Date.now()<deadline){await guard();const state=await snapshot(page);validateSnapshot(state,index.totalPages);if(state.page===number&&loaded(state)&&(!requireChanged||state.src!==oldSrc))return state;await sleep(80);}
    throw new Error('原图页号、图片加载或新图片身份等待超时');
  };
  const navigate=async(number,{fresh=false}={})=>{
    await guard();let before=await snapshot(page);validateSnapshot(before,index.totalPages);
    const steps=[];
    const change=async(target,previous)=>{
      await guard();const startedAt=now(),input=page.locator(INPUT).first();
      await input.fill(String(target),{timeout});await guard();await input.press('Tab',{timeout});
      const state=await waitLoaded(target,previous.src,true);
      steps.push({fromPage:previous.page,toPage:target,fromBlobSrcSha256:sha(previous.src??''),toBlobSrcSha256:sha(state.src),startedAt,loadedAt:now()});return state;
    };
    if(fresh&&before.page===number){
      if(index.totalPages===1)throw new Error('单页书无法通过受控切页证明原图身份；停止采集，请提供另经核验的原始图片');
      before=await change(number===index.totalPages?number-1:number+1,before);
    }
    if(!fresh&&before.page===number&&loaded(before))return {...before,navigationSteps:steps};
    const state=await change(number,before);return {...state,navigationSteps:steps};
  };
  try{
    await guard();const first=await snapshot(page),totalPages=validateSnapshot(first);
    if(to>totalPages)throw new Error('指定采集页段超出全书图片序号范围');
    directory=await jobDirectory(root,output);indexPath=path.join(directory,'index.json');
    try{index=JSON.parse(await fs.readFile(await existingWorkspacePath(directory,indexPath),'utf8'));validateIndex(index,bookId,totalPages);}
    catch(error){if(error.code!=='ENOENT')throw error;index={schemaVersion:1,bookId,system:'teaching-content',totalPages,status:'collecting',pages:[],failures:[],startedAt:now()};}
    indexReady=true;index.status='collecting';index.lastRange={from,to,startedAt:now()};await save();
    page.on('request',observe);await page.route('**/*',barrier);installed=true;
    for(let number=from;number<=to;number++){
      await guard();if(stopRequested()){paused=true;break;}
      const cached=index.pages.find(row=>row.systemPage===number);
      if(cached){
        let bytes;try{bytes=await fs.readFile(await existingWorkspacePath(directory,cached.file));}catch(error){if(error.code!=='ENOENT')throw error;}
        if(bytes&&bytes.length===cached.bytes&&sha(bytes)===cached.sha256){skipped++;await onProgress({...summary(),systemPage:number,cached:true});continue;}
      }
      const before=await navigate(number,{fresh:true});
      const captured=await page.evaluate(async({operation,src,number,timeout})=>{
        if(operation!=='collector-blob-bytes')throw new Error('采集读取类型错误');
        const image=document.querySelector('.cropper-box-canvas img[alt="cropper-img"]'),input=document.querySelector('input.el-input__inner');
        if(!image||Number(input?.value)!==number||image.src!==src||!image.complete||image.naturalWidth<=0||image.naturalHeight<=0)throw new Error('原图读取前页面或图片已改变');
        let timer;
        try{return await Promise.race([(async()=>{
          const response=await fetch(src,{credentials:'omit'});if(!response.ok)throw new Error('本页原图 blob 读取失败');
          const blob=await response.blob();if(blob.size<=0||blob.size>50*1024*1024)throw new Error('原图字节大小不支持');
          const dataUrl=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('原图 FileReader 读取失败'));reader.readAsDataURL(blob);});
          if(Number(input.value)!==number||image.src!==src||!image.complete)throw new Error('原图读取期间页面或图片已改变');
          return {dataUrl,bytes:blob.size};
        })(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('本页原图 blob 读取超时')),timeout);})]);}finally{clearTimeout(timer);}
      },{operation:'collector-blob-bytes',src:before.src,number,timeout});
      await guard();const after=await snapshot(page);validateSnapshot(after,totalPages);
      if(!loaded(after)||!sameImage(before,after))throw new Error('原图读取前后页号、图片或尺寸不一致');
      const match=/^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/u.exec(captured?.dataUrl??'');
      if(!match)throw new Error('原图必须是 PNG/JPEG blob');
      const bytes=Buffer.from(match[2],'base64'),extension=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'png':bytes[0]===255&&bytes[1]===216?'jpg':null;
      if(!extension||bytes.length!==captured.bytes||match[1]!==`image/${extension==='jpg'?'jpeg':'png'}`)throw new Error('原图 MIME、文件签名或字节数不一致');
      const file=`images/page-${String(number).padStart(4,'0')}.${extension}`;
      await atomicFile(directory,file,bytes);await guard();
      index.pages=index.pages.filter(row=>row.systemPage!==number);index.pages.push({systemPage:number,file,mimeType:match[1],bytes:bytes.length,width:after.width,height:after.height,sha256:sha(bytes),capturedAt:now(),navigationProof:{kind:'controlled-source-navigation',steps:before.navigationSteps}});index.pages.sort((a,b)=>a.systemPage-b.systemPage);downloaded++;await save();await onProgress({...summary(),systemPage:number,cached:false});
    }
    if(!paused)await navigate(first.page);
    index.status=paused?'paused':index.pages.length===totalPages?'downloaded':'partial';index.updatedAt=now();index.blockedWrites=blocked;await save();return summary();
  }catch(error){
    primaryError=error;paused=true;
    if(indexReady){index.status='paused';index.updatedAt=now();index.blockedWrites=blocked;index.failures.push({at:now(),message:clean(error)});try{await save();}catch(persistError){error.evidenceError=clean(persistError);}}
    error.collection=summary();throw error;
  }finally{
    const cleanupErrors=[];
    try{if(installed)await page.unroute('**/*',barrier);}catch(error){cleanupErrors.push(clean(error));}
    try{page.off('request',observe);}catch(error){cleanupErrors.push(clean(error));}finally{activePages.delete(page);}
    if(cleanupErrors.length){
      paused=true;const cleanupError=cleanupErrors.join('; ');let evidenceError;
      if(indexReady){index.status='paused';index.updatedAt=now();index.failures.push({at:now(),phase:'cleanup',message:cleanupError});try{await save();}catch(error){evidenceError=clean(error);}}
      if(primaryError){primaryError.cleanupError=cleanupError;primaryError.collection={...primaryError.collection,...summary(),cleanupError};if(evidenceError)primaryError.cleanupEvidenceError=evidenceError;}
      else{const failure=new Error('原图采集清理失败；暂停采集并保留证据');failure.cleanupError=cleanupError;failure.collection={...summary(),cleanupError};if(evidenceError)failure.evidenceError=evidenceError;throw failure;}
    }
  }
}
