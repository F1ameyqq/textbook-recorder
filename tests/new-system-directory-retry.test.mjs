import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NewSystemAdapter } from '../src/new-system-adapter.mjs';
import { waitVisibleByTimer } from '../src/timer-visible-wait.mjs';

const bookUrl='https://easylearn.baidu.com/edu-shop-web/#/content-manager/teaching-content?textbookID=100001&textbookType=main';
const target={chapterLabel:'第十四章 内能的利用',sectionLabel:'第3节 热机的效率',record:1,expectedRecordId:1001};
const task={id:'saved-read-fixture',target,source:{pages:[29],answerPages:[244]}};
const approvedTask={...task,review:{status:'approved',issues:[]}};
// Matches the real exam14 record9 mount-delay diagnostic's empty-tree shape.
const emptyTreeDom={readyState:'complete',title:'fixture',visibility:'visible',focused:true,viewport:{width:2477,height:1403,scrollX:0,scrollY:0},treeCount:0,treeNodeCount:0,contentCount:0,visibleContentCount:0,roots:[],chapterCount:0,chapterInnerTextCount:0,chapters:[],sectionCount:0,sections:[],ancestors:[],loading:[]};
const record={seqIndex:1,shitiID:1001,nodeID:900320,question:'<p>原题干</p>',answer:'<p>原答案</p>',mainPicNum:29,answerPicNum:244,haveAnswer:true};
const copy=value=>structuredClone(value);
function visibilityError(role='directory-chapter') {const error=new Error('specified tree target was not displayed');error.code='TARGET_VISIBILITY_TIMEOUT';error.targetRole=role;error.visibilityDiagnostic={name:'章节 '+target.chapterLabel,targetRole:role,startedAt:new Date().toISOString(),endedAt:new Date().toISOString(),timeout:20,lastState:{count:0,visible:false}};return error;}

test('timer timeout retains real last count/visibility and role; duplicate/evaluation errors are not relabeled',async()=>{
  const before=new Date().toISOString();let samples=0;
  await assert.rejects(waitVisibleByTimer({evaluateAll:async()=>{samples++;return {count:1,visible:false};}},{timeout:1,name:'章节 example',targetRole:'directory-chapter'}),error=>{
    assert.equal(error.code,'TARGET_VISIBILITY_TIMEOUT');assert.equal(error.targetRole,'directory-chapter');assert.deepEqual(error.visibilityDiagnostic.lastState,{count:1,visible:false});assert.ok(Date.parse(error.visibilityDiagnostic.startedAt)>=Date.parse(before));assert.ok(Date.parse(error.visibilityDiagnostic.endedAt)>=Date.parse(error.visibilityDiagnostic.startedAt));return true;
  });assert.equal(samples,1);
  await assert.rejects(waitVisibleByTimer({evaluateAll:async()=>({count:2,visible:true})},{timeout:100,targetRole:'directory-chapter'}),error=>{assert.equal(error.code,undefined);return /唯一/u.test(error.message);});
  const original=new Error('invalid selector');await assert.rejects(waitVisibleByTimer({evaluateAll:async()=>{throw original;}},{timeout:100,targetRole:'directory-chapter'}),error=>error===original);
});

async function fixture(t,{failures=[visibilityError()],saved=true,wrongReceipt=false,oldTask=false,captureFails=false,persistFails=false,changeBookDuringCapture=false,recordId=1001,diagnosticDom,initialUrl=bookUrl}={}) {
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'directory-retry-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  const events=[];let url=initialUrl,directoryCalls=0,saveCalls=0,plusCalls=0;
  const page={context:()=>({}),isClosed:()=>false,url:()=>url,on:()=>{},bringToFront:async()=>events.push('front'),reload:async()=>events.push('reload'),
    evaluate:async fn=>{if(/document\.visibilityState\s*===\s*['"]visible['"]/u.test(fn.toString()))return true;events.push('diagnostic-dom');if(captureFails)throw new Error('diagnostic DOM unavailable');if(changeBookDuringCapture)url=bookUrl.replace('100001','146005');return diagnosticDom?copy(diagnosticDom):{readyState:'complete',title:'fixture',visibility:'visible',focused:true,treeCount:1,treeNodeCount:0,contentCount:0,visibleContentCount:0,roots:[],chapterCount:0,chapters:[],sectionCount:0,sections:[],ancestors:[],loading:[]};},
    locator:()=>{throw new Error('no save or Plus locator may be requested in this fixture');},
  };
  const adapter=new NewSystemAdapter({page,inputMode:'browser-command',dataDir});adapter.bookId=100001;
  const receipt={bookId:100001,seqIndex:1,shitiID:1001,mainPicNum:29,answerPicNum:244,request:{bookId:100001,seqIndex:1,mainPicNum:29,answerPicNum:244},response:{status:200,body:{errno:wrongReceipt?300001:0,errmsg:'success',data:{seqIndex:1,shitiID:1001,haveAnswer:true}}}};
  adapter._pendingWrite={schemaVersion:1,kind:'new-system-append-recovery',bookId:100001,nodeID:900320,status:'pending',created:saved,task:{...copy(task),id:oldTask?'different-task':task.id},observedSaveRequests:saved?1:0,receipt:saved?copy(receipt):null,priorRecords:[],phase:'receipt-checkpoint',updatedAt:'2026-10-07T00:00:00.000Z'};
  if(persistFails)adapter._persistPendingWrite=async()=>{throw new Error('diagnostic checkpoint unavailable');};
  adapter.directory=async()=>{events.push('directory');const error=failures[directoryCalls++];if(error)throw error;adapter._directoryRecords=[{...record,shitiID:recordId}];adapter._nodeID=900320;};
  adapter._selectRecord=async selected=>{events.push('record');assert.equal(selected.shitiID,1001);};
  adapter._editorRead=async selector=>({html:selector.startsWith('#contentedit')?record.question:record.answer,images:[]});
  adapter._scopeMatches=async()=>true;
  adapter.append=async()=>{plusCalls++;throw new Error('append forbidden');};adapter._paste=async()=>{saveCalls++;throw new Error('save forbidden');};adapter._navigateSources=async()=>{saveCalls++;throw new Error('source mutation forbidden');};
  return {adapter,events,dataDir,receipt,get directoryCalls(){return directoryCalls;},get saveCalls(){return saveCalls;},get plusCalls(){return plusCalls;}};
}
for(const role of ['directory-chapter','directory-section'])test(`saved fresh ${role} visibility timeout diagnoses then performs one pure reload and succeeds`,async t=>{
  const f=await fixture(t,{failures:[visibilityError(role)]});const result=await f.adapter.read(task,{refresh:true});
  assert.equal(result.recordId,1001);assert.equal(f.directoryCalls,2);assert.equal(f.events.filter(event=>event==='reload').length,2);assert.equal(f.saveCalls,0);assert.equal(f.plusCalls,0);
  const diagnostic=f.adapter._pendingWrite.directoryVisibilityDiagnostics[0];assert.equal(diagnostic.attempt,1);assert.equal(diagnostic.savedReceiptBound,true);assert.equal(diagnostic.urlIdentity.validated,true);assert.equal(diagnostic.dom.chapterCount,0);assert.ok(Date.parse(diagnostic.capturedAt)>=Date.parse(diagnostic.captureStartedAt));
  assert.equal(f.events.filter(event=>event==='diagnostic-dom').length,1);assert.ok(f.events.indexOf('diagnostic-dom')<f.events.lastIndexOf('reload'));
  assert.deepEqual(f.adapter._pendingWrite.receipt,f.receipt);assert.equal(f.adapter._pendingWrite.updatedAt,'2026-10-07T00:00:00.000Z');assert.equal(f.adapter._pendingWrite.status,'pending');assert.equal(f.adapter._pendingWrite.phase,'receipt-checkpoint');
  const stored=JSON.parse(await fs.readFile(f.adapter._pendingWrite.evidencePath,'utf8'));assert.equal(stored.directoryVisibilityDiagnostics.length,1);assert.deepEqual(stored.receipt,f.receipt);
});

test('a second visibility timeout persists both actual diagnostics and stops without a third reload',async t=>{
  const first=visibilityError(),second=visibilityError('directory-section'),f=await fixture(t,{failures:[first,second]});
  await assert.rejects(f.adapter.read(task,{refresh:true}),error=>error===second && error.cause===first && error.directoryVisibilityRetryExhausted===true);
  assert.equal(f.directoryCalls,2);assert.equal(f.events.filter(event=>event==='reload').length,2);assert.deepEqual(f.adapter._pendingWrite.directoryVisibilityDiagnostics.map(row=>row.attempt),[1,2]);assert.equal(f.saveCalls,0);assert.equal(f.plusCalls,0);
});
for(const [name,error] of [['editor visibility',visibilityError('editor')],['untyped visibility',visibilityError(null)],['response error',new Error('platform LIST business response invalid')],['scope identity',new Error('selected scope identity changed')],['duplicate selector',new Error('visible target must be unique')]])test(`${name} errors receive no retry or diagnostic substitution`,async t=>{
  const f=await fixture(t,{failures:[error]});await assert.rejects(f.adapter.read(task,{refresh:true}),caught=>caught===error);assert.equal(f.directoryCalls,1);assert.equal(f.events.filter(event=>event==='reload').length,1);assert.equal(f.adapter._pendingWrite.directoryVisibilityDiagnostics,undefined);assert.equal(f.saveCalls,0);assert.equal(f.plusCalls,0);
});
for(const [name,options] of [['not saved',{saved:false}],['rejected business receipt',{wrongReceipt:true}],['another task receipt',{oldTask:true}]])test(`${name} retains the original error and never guesses or retries`,async t=>{
  const original=visibilityError(),f=await fixture(t,{...options,failures:[original]});await assert.rejects(f.adapter.read(task,{refresh:true}),error=>error===original);assert.equal(f.directoryCalls,1);assert.equal(f.events.filter(event=>event==='reload').length,1);assert.equal(f.saveCalls,0);assert.equal(f.plusCalls,0);
  if(options.oldTask){assert.equal(f.adapter._pendingWrite.directoryVisibilityDiagnostics,undefined);assert.equal((await fs.readdir(path.join(f.dataDir,'directory-visibility-diagnostics'))).length,1);}else assert.equal(f.adapter._pendingWrite.directoryVisibilityDiagnostics[0].savedReceiptBound,false);
});
test('a non-fresh read never retries even with an existing successful receipt',async t=>{
  const original=visibilityError(),f=await fixture(t,{failures:[original]});await assert.rejects(f.adapter.read(task),error=>error===original);assert.equal(f.directoryCalls,1);assert.equal(f.events.includes('reload'),false);assert.equal(f.events.includes('diagnostic-dom'),false);
});
for(const [name,options] of [['DOM diagnostic unavailable',{captureFails:true}],['diagnostic checkpoint unavailable',{persistFails:true}],['book changed during diagnostic',{changeBookDuringCapture:true}]])test(`${name} prevents the additional reload`,async t=>{
  const original=visibilityError(),f=await fixture(t,{...options,failures:[original]});await assert.rejects(f.adapter.read(task,{refresh:true}),error=>error===original && typeof error.directoryDiagnosticError==='string');assert.equal(f.directoryCalls,1);assert.equal(f.events.filter(event=>event==='reload').length,1);assert.equal(f.saveCalls,0);assert.equal(f.plusCalls,0);
  if(!options.persistFails){const diagnostic=f.adapter._pendingWrite.directoryVisibilityDiagnostics[0];assert.equal(diagnostic.captureComplete,false);assert.equal(typeof diagnostic.captureError,'string');assert.deepEqual(f.adapter._pendingWrite.receipt,f.receipt);}
});
test('record identity mismatch after a successful directory load is outside the retry boundary',async t=>{
  const f=await fixture(t,{failures:[],recordId:1002});await assert.rejects(f.adapter.read(task,{refresh:true}),/其他服务器 ID/u);assert.equal(f.directoryCalls,1);assert.equal(f.events.filter(event=>event==='reload').length,1);assert.equal(f.events.includes('diagnostic-dom'),false);assert.equal(f.saveCalls,0);assert.equal(f.plusCalls,0);
});

async function prewriteFixture(t,options={}) {
  const f=await fixture(t,{saved:false,diagnosticDom:emptyTreeDom,...options});
  f.adapter._pendingWrite=null;
  return f;
}
async function standaloneDiagnostics(f) {
  const folder=path.join(f.dataDir,'directory-visibility-diagnostics');
  const files=await fs.readdir(folder);
  return Promise.all(files.map(file=>fs.readFile(path.join(folder,file),'utf8').then(JSON.parse)));
}
function priorTerminal(f,status='completed') {
  f.adapter._pendingWrite={schemaVersion:1,kind:'new-system-append-recovery',bookId:100001,nodeID:900320,status,created:true,task:{...copy(approvedTask),id:'previous-task',target:{...target,sectionLabel:'上一节'}},observedSaveRequests:1,receipt:copy(f.receipt),priorRecords:[],phase:status,updatedAt:'2026-10-07T00:00:00.000Z',...(status==='reconciled'?{recovery:{outcome:'saved',recordId:1001,checkedAt:'2026-10-07T00:00:00.000Z'}}:{})};
}

test('a refresh root timeout preserves a durable read-only diagnostic without another reload or selection',async t=>{
  const f=await prewriteFixture(t),original=visibilityError('directory-root');
  f.adapter._reloadForFreshRead=async()=>{f.events.push('reload');throw original;};
  await assert.rejects(f.adapter.read(approvedTask,{refresh:true}),error=>error===original && typeof error.directoryVisibilityEvidencePath==='string');
  const [diagnostic]=await standaloneDiagnostics(f);
  assert.equal(diagnostic.phase,'refresh-directory-root');assert.equal(diagnostic.captureComplete,true);
  assert.equal(diagnostic.savedReceiptBound,false);assert.equal(diagnostic.prewriteEmptyTreeRetryEligible,false);
  assert.equal(f.events.filter(event=>event==='reload').length,1);assert.equal(f.directoryCalls,0);
  assert.equal(f.saveCalls,0);assert.equal(f.plusCalls,0);assert.equal(f.adapter._pendingWrite,null);
});

test('root diagnostic failure retains the original timeout and partial evidence without retry',async t=>{
  const f=await prewriteFixture(t,{captureFails:true}),original=visibilityError('directory-root');
  f.adapter._reloadForFreshRead=async()=>{f.events.push('reload');throw original;};
  await assert.rejects(f.adapter.read(approvedTask,{refresh:true}),error=>error===original && error.directoryDiagnosticError==='diagnostic DOM unavailable');
  const [diagnostic]=await standaloneDiagnostics(f);assert.equal(diagnostic.captureComplete,false);assert.equal(diagnostic.phase,'refresh-directory-root');
  assert.equal(f.events.filter(event=>event==='reload').length,1);assert.equal(f.directoryCalls,0);assert.equal(f.saveCalls,0);assert.equal(f.plusCalls,0);
});

test('approved pre-write complete empty tree retries once through normal read with no save or Plus',async t=>{
  const f=await prewriteFixture(t);const result=await f.adapter.read(approvedTask,{refresh:true});
  assert.equal(result.status,'found');assert.equal(result.recordId,1001);assert.equal(result.count,1);assert.equal(f.directoryCalls,2);assert.equal(f.events.filter(event=>event==='reload').length,2);assert.equal(f.saveCalls,0);assert.equal(f.plusCalls,0);assert.equal(f.adapter._pendingWrite,null);
  const [diagnostic]=await standaloneDiagnostics(f);assert.equal(diagnostic.savedReceiptBound,false);assert.equal(diagnostic.prewriteEmptyTreeRetryEligible,true);assert.equal(diagnostic.captureComplete,true);assert.deepEqual(diagnostic.dom,emptyTreeDom);assert.equal(diagnostic.urlIdentity.validated,true);assert.equal(diagnostic.attempt,1);
  assert.ok(f.events.indexOf('diagnostic-dom')<f.events.lastIndexOf('reload'));
});
test('approved pre-write one empty tree container retries once with no save or Plus',async t=>{
  const f=await prewriteFixture(t,{diagnosticDom:{...emptyTreeDom,treeCount:1}});assert.equal((await f.adapter.read(approvedTask,{refresh:true})).status,'found');assert.equal(f.directoryCalls,2);assert.equal(f.events.filter(event=>event==='reload').length,2);assert.equal(f.saveCalls,0);assert.equal(f.plusCalls,0);assert.equal(f.adapter._pendingWrite,null);
  const [diagnostic]=await standaloneDiagnostics(f);assert.equal(diagnostic.dom.treeCount,1);assert.equal(diagnostic.prewriteEmptyTreeRetryEligible,true);
});
for(const field of ['treeNodeCount','contentCount'])test(`one tree container with nonzero ${field} still receives zero retry`,async t=>{
  const original=visibilityError(),f=await prewriteFixture(t,{failures:[original],diagnosticDom:{...emptyTreeDom,treeCount:1,[field]:1}});await assert.rejects(f.adapter.read(approvedTask,{refresh:true}),error=>error===original);assert.equal(f.directoryCalls,1);assert.equal(f.events.filter(event=>event==='reload').length,1);assert.equal(f.saveCalls,0);assert.equal(f.plusCalls,0);assert.equal((await standaloneDiagnostics(f))[0].prewriteEmptyTreeRetryEligible,false);
});
test('pre-write empty tree second timeout stops after one retry with both actual diagnostics',async t=>{
  const first=visibilityError(),second=visibilityError(),f=await prewriteFixture(t,{failures:[first,second]});
  await assert.rejects(f.adapter.read(approvedTask,{refresh:true}),error=>error===second && error.cause===first && error.directoryVisibilityRetryExhausted===true);
  assert.equal(f.directoryCalls,2);assert.equal(f.events.filter(event=>event==='reload').length,2);assert.equal(f.saveCalls,0);assert.equal(f.plusCalls,0);assert.equal(f.adapter._pendingWrite,null);assert.deepEqual((await standaloneDiagnostics(f)).map(row=>row.attempt).sort(),[1,2]);
});
for(const status of ['completed','reconciled'])test(`only a different task's valid older ${status} pending permits the pre-write retry`,async t=>{
  const f=await prewriteFixture(t);priorTerminal(f,status);const prior=copy(f.adapter._pendingWrite);
  assert.equal((await f.adapter.read(approvedTask,{refresh:true})).status,'found');assert.equal(f.directoryCalls,2);assert.equal(f.saveCalls,0);assert.equal(f.plusCalls,0);assert.deepEqual(f.adapter._pendingWrite,prior);assert.equal((await standaloneDiagnostics(f))[0].prewriteEmptyTreeRetryEligible,true);
});
test('an older reconciled not_saved intention permits only the fresh read and is left unchanged',async t=>{
  const f=await prewriteFixture(t);priorTerminal(f,'reconciled');Object.assign(f.adapter._pendingWrite,{created:false,receipt:null,observedSaveRequests:0,recovery:{outcome:'not_saved',recordId:null,checkedAt:'2026-10-07T00:00:00.000Z'}});const prior=copy(f.adapter._pendingWrite);
  assert.equal((await f.adapter.read(approvedTask,{refresh:true})).status,'found');assert.equal(f.directoryCalls,2);assert.deepEqual(f.adapter._pendingWrite,prior);assert.equal(f.saveCalls,0);assert.equal(f.plusCalls,0);
});
for(const [name,alter] of [
  ['unapproved task',({readTask})=>{readTask.review.status='pending';}],
  ['approval with unresolved issues',({readTask})=>{readTask.review.issues=['unresolved'];}],
  ['missing approval',({readTask})=>{delete readTask.review;}],
  ['busy adapter',({f})=>{f.adapter._busy=true;}],
  ['uncertain adapter',({f})=>{f.adapter._uncertain=true;}],
  ['older pending unknown',({f})=>{priorTerminal(f);f.adapter._pendingWrite.status='pending';}],
  ['older reconciled unknown',({f})=>{priorTerminal(f,'reconciled');f.adapter._pendingWrite.recovery.outcome='unknown';}],
  ['older rejected receipt',({f})=>{priorTerminal(f);f.adapter._pendingWrite.receipt.response.body.errno=300001;}],
  ['same task without receipt',({f})=>{priorTerminal(f);Object.assign(f.adapter._pendingWrite,{task:copy(approvedTask),created:false,receipt:null,observedSaveRequests:0});}],
  ['same task rejected receipt',({f})=>{priorTerminal(f);f.adapter._pendingWrite.task=copy(approvedTask);f.adapter._pendingWrite.receipt.response.body.errno=300001;}],
  ['renamed same target without receipt',({f})=>{priorTerminal(f);f.adapter._pendingWrite.task.target=copy(target);f.adapter._pendingWrite.receipt=null;}],
  ['malformed terminal intention',({f})=>{priorTerminal(f);delete f.adapter._pendingWrite.task.source;}],
])test(`pre-write ${name} retains the first error and has no additional reload`,async t=>{
  const original=visibilityError(),f=await prewriteFixture(t,{failures:[original]}),readTask=copy(approvedTask);alter({f,readTask});
  await assert.rejects(f.adapter.read(readTask,{refresh:true}),error=>error===original);assert.equal(f.directoryCalls,1);assert.equal(f.events.filter(event=>event==='reload').length,1);assert.equal(f.saveCalls,0);assert.equal(f.plusCalls,0);
});
for(const [name,patch] of [
  ['two tree containers exist',{treeCount:2}],
  ['tree node exists',{treeNodeCount:1}],
  ['directory content exists',{contentCount:1}],
  ['target count exists but hidden',{chapterCount:1}],
  ['section exists',{sectionCount:1}],
  ['missing diagnostic field',{chapterInnerTextCount:undefined}],
  ['root exists',{roots:[{visible:false}]}],
  ['page hidden',{visibility:'hidden'}],
  ['page not focused',{focused:false}],
  ['page not complete',{readyState:'interactive'}],
  ['visible loading mask',{loading:[{visible:true}]}],
])test(`pre-write ${name} is not an empty mounted-tree delay and gets zero retry`,async t=>{
  const original=visibilityError(),f=await prewriteFixture(t,{failures:[original],diagnosticDom:{...emptyTreeDom,...patch}});
  await assert.rejects(f.adapter.read(approvedTask,{refresh:true}),error=>error===original);assert.equal(f.directoryCalls,1);assert.equal(f.events.filter(event=>event==='reload').length,1);assert.equal((await standaloneDiagnostics(f))[0].prewriteEmptyTreeRetryEligible,false);assert.equal(f.saveCalls,0);assert.equal(f.plusCalls,0);
});
test('pre-write target timer count1 does not retry even if a later whole-tree diagnostic is empty',async t=>{
  const original=visibilityError();original.visibilityDiagnostic.lastState.count=1;
  const f=await prewriteFixture(t,{failures:[original]});await assert.rejects(f.adapter.read(approvedTask,{refresh:true}),error=>error===original);assert.equal(f.directoryCalls,1);assert.equal(f.events.filter(event=>event==='reload').length,1);assert.equal(f.saveCalls,0);assert.equal(f.plusCalls,0);
});
test('pre-write wrong-book URL is rejected before any reload or directory retry',async t=>{
  const f=await prewriteFixture(t,{initialUrl:bookUrl.replace('100001','146005')});await assert.rejects(f.adapter.read(approvedTask,{refresh:true}),/书 ID/u);assert.equal(f.directoryCalls,0);assert.equal(f.events.filter(event=>event==='reload').length,0);assert.equal(f.events.includes('diagnostic-dom'),false);assert.equal(f.saveCalls,0);assert.equal(f.plusCalls,0);
});
test('pre-write URL changing to another book during capture retains the original error with zero retry',async t=>{
  const original=visibilityError(),f=await prewriteFixture(t,{failures:[original],changeBookDuringCapture:true});await assert.rejects(f.adapter.read(approvedTask,{refresh:true}),error=>error===original && typeof error.directoryDiagnosticError==='string');assert.equal(f.directoryCalls,1);assert.equal(f.events.filter(event=>event==='reload').length,1);assert.equal((await standaloneDiagnostics(f))[0].captureComplete,false);assert.equal(f.saveCalls,0);assert.equal(f.plusCalls,0);
});
test('pre-write quiet state is rechecked after durable capture before any extra reload',async t=>{
  const original=visibilityError(),f=await prewriteFixture(t,{failures:[original]});const persist=f.adapter._persistDirectoryVisibilityDiagnostic.bind(f.adapter);
  f.adapter._persistDirectoryVisibilityDiagnostic=async(...args)=>{const result=await persist(...args);f.adapter._uncertain=true;return result;};
  await assert.rejects(f.adapter.read(approvedTask,{refresh:true}),error=>error===original);assert.equal(f.directoryCalls,1);assert.equal(f.events.filter(event=>event==='reload').length,1);assert.equal(f.saveCalls,0);assert.equal(f.plusCalls,0);
});
test('pre-write successful retry preserves the original server identity check',async t=>{
  const f=await prewriteFixture(t,{recordId:1002});await assert.rejects(f.adapter.read(approvedTask,{refresh:true}),/其他服务器 ID/u);assert.equal(f.directoryCalls,2);assert.equal(f.events.filter(event=>event==='reload').length,2);assert.equal(f.saveCalls,0);assert.equal(f.plusCalls,0);
});
