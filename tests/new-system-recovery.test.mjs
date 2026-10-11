import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { NewSystemAdapter } from '../src/new-system-adapter.mjs';
import { expectedEditor, renderEditorHtml, createNewSystemRun, reconcileNewSystemRun, runNewSystemBatch } from '../src/new-system-core.mjs';

const baseDir=await fs.mkdtemp(path.join(os.tmpdir(),'share-recovery-image-'));
after(()=>fs.rm(baseDir,{recursive:true,force:true}));
await fs.writeFile(path.join(baseDir,'figure.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR9cAAAAASUVORK5CYII=','base64'));
const image={type:'image',path:'figure.png',align:'center'};
const task={id:'recovery-approved',target:{chapterLabel:'第十四章 内能的利用',sectionLabel:'第3节 热机的效率',record:2},source:{pages:[31],answerPages:[244]},stem:{blocks:[{type:'text',runs:[{type:'text',text:'能量为10'},{type:'sup',text:'8'},{type:'text',text:' J'}]},image]},answer:{blocks:[{type:'text',parts:['第一空','第二空']}]},review:{status:'approved',issues:[]}};
const prior=[{seqIndex:1,shitiID:1001,nodeID:900320,question:'<p>旧题</p>',answer:'<p>旧答案</p>',mainPicNum:29,answerPicNum:244,haveAnswer:true}];
const added={seqIndex:2,shitiID:1002,nodeID:900320,question:renderEditorHtml(task.stem,baseDir),answer:renderEditorHtml(task.answer,baseDir),mainPicNum:31,answerPicNum:244,haveAnswer:true};
const pending=()=>({schemaVersion:1,kind:'new-system-append-recovery',status:'pending',bookId:100001,nodeID:900320,task:structuredClone(task),priorRecords:structuredClone(prior),phase:'save-business-receipt',created:true,observedSaveRequests:1,receipt:null});
const sideRead=side=>{const expected=expectedEditor(task[side],baseDir);return {html:renderEditorHtml(task[side],baseDir),text:expected.text,paragraphs:expected.paragraphs,images:expected.images.map(value=>({...value,complete:true,width:100,height:80,align:'center'}))};};
const saved=()=>({status:'found',bookId:100001,target:structuredClone(task.target),recordId:1002,count:2,source:structuredClone(task.source),mainPicNum:31,answerPicNum:244,stem:sideRead('stem'),answer:sideRead('answer')});

async function fixture(t,{missing=false,fresh=false}={}){
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'textbook-recovery-'));
  t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  const browser=new EventEmitter();browser.isConnected=()=>true;
  const context=new EventEmitter();context.browser=()=>browser;
  const page=new EventEmitter();page.context=()=>context;page.isClosed=()=>false;
  const adapter=new NewSystemAdapter({page,baseDir,dataDir,source:'fixture'});adapter.bookId=100001;
  adapter._pendingWrite=pending();adapter._uncertain=true;
  let records=missing?structuredClone(prior):[...structuredClone(prior),structuredClone(added)];
  let readback=missing?{status:'missing',bookId:100001,target:structuredClone(task.target),count:1}:saved();
  adapter.read=async(_task,options)=>{assert.equal(options.refresh,true);adapter._nodeID=900320;adapter._directoryRecords=records;return structuredClone(readback);};
  if(fresh){
    // Only a real fresh append invocation can establish continuous observation.
    adapter._pendingWrite=null;adapter._uncertain=false;
    adapter.directory=async()=>{adapter._directoryRecords=structuredClone(prior);adapter._nodeID=900320;};
    adapter._navigateSources=async()=>[31,244];adapter._clipboardPreflight=async()=>{};
    page.waitForFunction=async()=>{};page.locator=()=>({});adapter._click=async()=>{};
    adapter._pasteReviewedAnswer=async()=>{};adapter._paste=async()=>{throw new Error('synthetic stem failure');};
    await assert.rejects(adapter.append(task),error=>error.phase==='stem-native-paste-readback');
  }
  return {adapter,page,dataDir,records,readback};
}

test('saved recovery verifies full approved content and prior identities before durably unlocking the same connection',async t=>{
  const {adapter}=await fixture(t);
  const result=await adapter.reconcile(task);
  assert.deepEqual([result.recovery.outcome,result.recovery.writeUnlocked,result.recovery.receiptKnown],['saved',true,false]);
  assert.equal(adapter._uncertain,false);
  const stored=JSON.parse(await fs.readFile(result.recovery.evidencePath,'utf8'));
  assert.equal(stored.status,'reconciled');assert.equal(stored.recovery.recordId,1002);
  assert.deepEqual(stored.priorRecords,prior);assert.deepEqual(stored.task,task);
  // If the service dies after adapter proof but before run-state promotion,
  // the disk evidence can be loaded and re-proved without creating a new task.
  const rechecked=await adapter.reconcile(task,{pendingWrite:stored});
  assert.equal(rechecked.recovery.outcome,'saved');assert.equal(rechecked.recovery.writeUnlocked,true);
});

test('changed text, superscript, image, answer spacing, prior identity, source, or receipt retains the write lock',async t=>{
  const changes={
    text:({readback})=>{readback.stem.text+='错字';},
    superscript:({readback})=>{readback.stem.html=readback.stem.html.replace('<sup>8</sup>','<sup>7</sup>');},
    image:({readback})=>{readback.stem.images[0].sha256='wrong';},
    alignment:({readback})=>{readback.stem.images[0].align='left';},
    spacing:({readback})=>{readback.answer.text=readback.answer.text.replace('\u00a0'.repeat(8),'\u00a0'.repeat(7));},
    priorID:({records})=>{records[0].shitiID=9999;},
    priorText:({records})=>{records[0].question='<p>改变</p>';},
    source:({records})=>{records[1].mainPicNum=30;},
    receipt:({adapter})=>{adapter._pendingWrite.receipt={bookId:100001,seqIndex:2,shitiID:9999,request:{bookId:100001,seqIndex:2,mainPicNum:31,answerPicNum:244},mainPicNum:31,answerPicNum:244,response:{status:200,body:{errno:0,errmsg:'success',data:{seqIndex:2,shitiID:9999,haveAnswer:true}}}};},
  };
  for(const [name,change] of Object.entries(changes))await t.test(name,async child=>{
    const context=await fixture(child);change(context);
    const result=await context.adapter.reconcile(task);
    assert.equal(result.recovery.writeUnlocked,false);assert.equal(result.recovery.outcome,'unknown');
    assert.equal(context.adapter._uncertain,true);assert.ok(result.recovery.errors.length);
    await assert.rejects(context.adapter.append(task),/拒绝再次写入/u);
  });
});

test('missing recovery unlocks only an unchanged baseline with live proof that no SAVE was dispatched',async t=>{
  for(const mode of ['no-save','save-dispatched','restored'])await t.test(mode,async child=>{
    const {adapter}=await fixture(child,{missing:true,fresh:mode!=='restored'});
    adapter._pendingWrite.observedSaveRequests=mode==='save-dispatched'?1:0;
    const options=mode==='restored'?{pendingWrite:adapter.pendingWrite}:{};
    const result=await adapter.reconcile(task,options);
    assert.equal(result.recovery.writeUnlocked,mode==='no-save');
    assert.equal(result.recovery.outcome,mode==='no-save'?'not_saved':'unknown');
    assert.equal(adapter._uncertain,mode!=='no-save');
  });
});

test('append writes durable intent before Plus and preserves its exact phase after an uncertain paste',async t=>{
  const {adapter,page}=await fixture(t);adapter._pendingWrite=null;adapter._uncertain=false;
  let plus=0;
  adapter.directory=async()=>{adapter._directoryRecords=structuredClone(prior);adapter._nodeID=900320;};
  adapter._navigateSources=async()=>[31,244];adapter._clipboardPreflight=async()=>{};
  page.waitForResponse=async()=>new Promise(()=>{});page.waitForFunction=async()=>{};
  page.locator=selector=>({click:async()=>{assert.equal(selector,'.shiti-operate-btn .el-icon-plus');const before=JSON.parse(await fs.readFile(adapter.pendingWrite.evidencePath,'utf8'));assert.equal(before.phase,'before-plus');assert.equal(before.created,false);assert.deepEqual(before.priorRecords,prior);plus++;}});
  // This mock isolates durable intent/recovery ordering; native pointer safety
  // is exercised independently in owned Edge by checked-pointer-click.test.mjs.
  adapter._click=async locator=>locator.click();
  adapter._paste=async()=>{throw new Error('simulated paste failure');};
  await assert.rejects(adapter.append(task),error=>error.phase==='answer-native-paste-readback');
  assert.equal(plus,1);assert.equal(adapter._uncertain,true);
  const persisted=JSON.parse(await fs.readFile(adapter.pendingWrite.evidencePath,'utf8'));
  assert.equal(persisted.created,true);assert.equal(persisted.phase,'answer-native-paste-readback');
  assert.deepEqual(persisted.task,task);assert.equal(persisted.status,'pending');
  await assert.rejects(adapter.append(task),/拒绝再次写入/u);assert.equal(plus,1);
});

test('a changed or unapproved intended task cannot be used to clear uncertainty',async t=>{
  const {adapter}=await fixture(t);
  const changed=structuredClone(task);changed.review.status='pending';
  await assert.rejects(adapter.reconcile(changed),/已审题单/u);
  assert.equal(adapter._uncertain,true);
});

const manifest={kind:'new-system-batch',schemaVersion:1,bookId:100001,source:'fixture',tasks:[task]};
function failedRun(){const state=createNewSystemRun(manifest,{baseDir});state.status='failed';Object.assign(state.tasks[0],{status:'failed',attempts:1,recoveryRequired:true,lastError:'save receipt timed out'});return state;}

test('explicit saved recovery records independent confirmation without forging a receipt and rechecks all bindings on the next run',async t=>{
  const {adapter}=await fixture(t);
  const recovery=await adapter.reconcile(task);
  const state=failedRun();
  reconcileNewSystemRun({manifest,state,taskId:task.id,recovery,baseDir});
  assert.equal(state.tasks[0].status,'completed');assert.equal(state.tasks[0].receipt,null);
  assert.equal(state.tasks[0].recoveryConfirmation.recordId,1002);
  assert.equal(state.tasks[0].recoveryHistory[0].priorAttempts,1);
  let appends=0;
  const next={source:'fixture',bookId:100001,read:async()=>saved(),append:async()=>{appends++;throw new Error('must not append');}};
  await runNewSystemBatch({manifest,state,adapter:next,baseDir});
  assert.equal(state.status,'completed');assert.equal(appends,0);
  for(const field of ['manifestHash','taskId','bookId','recordId']){
    const bad=structuredClone(state);bad.tasks[0].recoveryConfirmation[field]=typeof bad.tasks[0].recoveryConfirmation[field]==='number'?9999:'wrong';
    await runNewSystemBatch({manifest,state:bad,adapter:next,baseDir});
    assert.equal(bad.status,'failed',field);assert.match(bad.tasks[0].lastError,/恢复确认/u);
  }
  const changed=structuredClone(state);
  next.read=async()=>{const result=saved();result.stem.text+='修改';return result;};
  await runNewSystemBatch({manifest,state:changed,adapter:next,baseDir});
  assert.equal(changed.status,'failed');assert.match(changed.tasks[0].lastError,/拒绝覆盖/u);
  assert.equal(appends,0);
});

test('explicit not-saved recovery resets only proven unsaved attempts while preserving history and rejecting unknown outcomes',async t=>{
  const {adapter}=await fixture(t,{missing:true,fresh:true});adapter._pendingWrite.observedSaveRequests=0;
  const recovery=await adapter.reconcile(task);
  const state=failedRun();
  reconcileNewSystemRun({manifest,state,taskId:task.id,recovery,baseDir});
  assert.deepEqual([state.tasks[0].status,state.tasks[0].attempts,state.tasks[0].recoveryRequired],['pending',0,false]);
  assert.equal(state.tasks[0].recoveryHistory[0].priorAttempts,1);
  const unknown=structuredClone(recovery);unknown.recovery.writeUnlocked=false;unknown.recovery.outcome='unknown';
  const untouched=failedRun(),before=structuredClone(untouched);
  assert.throws(()=>reconcileNewSystemRun({manifest,state:untouched,taskId:task.id,recovery:unknown,baseDir}),/adapter 证明/u);
  assert.deepEqual(untouched,before);
  const recorded=failedRun();recorded.tasks[0].receipt={shitiID:1002};
  assert.throws(()=>reconcileNewSystemRun({manifest,state:recorded,taskId:task.id,recovery,baseDir}),/不能抹去已保存证据/u);
  assert.equal(recorded.tasks[0].attempts,1);
});
