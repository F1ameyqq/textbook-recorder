import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NewSystemAdapter } from '../src/new-system-adapter.mjs';
import { expectedEditor, renderEditorHtml } from '../src/new-system-core.mjs';

const task = { id:'live-append', target:{chapterLabel:'chapter', sectionLabel:'section', record:2},
  source:{pages:[3], answerPages:[9]}, stem:{blocks:[{type:'text', text:'synthetic question'}]},
  answer:{blocks:[{type:'text', text:'synthetic answer'}]}, review:{status:'approved', issues:[]} };
const prior = [{seqIndex:1, shitiID:101, nodeID:501, question:'<p>prior</p>', answer:'<p>answer</p>', mainPicNum:2, answerPicNum:9, haveAnswer:true}];
const saveRequest = () => ({url:()=> 'https://easylearn.baidu.com/edushop/textbook/myproducecommit/editshiti', method:()=> 'POST'});

async function fixture(t, {fresh=true, found=false, missingListeners=false, replaceDuringBirth=false}={}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'textbook-live-observation-'));
  t.after(() => fs.rm(dataDir, {recursive:true, force:true}));
  const browser = new EventEmitter(); browser.isConnected = () => true;
  const context = new EventEmitter(); context.browser = () => browser;
  const page = new EventEmitter(); page.context = () => context; page.isClosed = () => false;
  if (missingListeners) page.listeners=undefined;
  page.locator = () => ({}); page.waitForFunction = async () => {};
  const adapter = new NewSystemAdapter({page, baseDir:dataDir, dataDir, source:'fixture'});
  adapter.bookId = 100001;
  adapter.directory = async () => {adapter._nodeID=501; adapter._directoryRecords=structuredClone(prior);};
  adapter._navigateSources = async () => [3,9]; adapter._clipboardPreflight = async () => {};
  adapter._click = async () => {}; adapter._pasteReviewedAnswer = async () => {};
  adapter._paste = async () => {throw new Error('synthetic stem failure');};
  if (replaceDuringBirth) {
    const persist=adapter._persistPendingWrite.bind(adapter); let replaced=false;
    adapter._persistPendingWrite=async (...args)=>{await persist(...args); if(!replaced){replaced=true; adapter._pendingWrite=structuredClone(adapter._pendingWrite);}};
  }
  if (fresh) await assert.rejects(adapter.append(task), error => error.phase===(replaceDuringBirth?'durable-write-intent':'stem-native-paste-readback'));
  else {
    adapter._pendingWrite = {schemaVersion:1, kind:'new-system-append-recovery', status:'pending', bookId:100001, nodeID:501,
      task:structuredClone(task), priorRecords:structuredClone(prior), phase:'save-business-receipt', created:true,
      observedSaveRequests:0, receipt:null, startedAt:'2026-10-11T01:00:00.000Z', evidencePath:path.join(dataDir,'new-system-recovery','restored.pending.json')};
    adapter._uncertain = true;
  }
  const original = adapter._pendingWrite, disk = adapter.pendingWrite;
  const side = name => {const expected=expectedEditor(task[name],dataDir); return {html:renderEditorHtml(task[name],dataDir), text:expected.text, paragraphs:expected.paragraphs, images:[]};};
  adapter.read = async (_task, options) => {
    assert.equal(options.refresh,true); adapter._nodeID=501;
    adapter._directoryRecords=structuredClone(prior);
    if (!found) return {status:'missing', bookId:100001, target:structuredClone(task.target), count:1};
    adapter._directoryRecords.push({seqIndex:2, shitiID:102, nodeID:501, question:renderEditorHtml(task.stem,dataDir), answer:renderEditorHtml(task.answer,dataDir), mainPicNum:3, answerPicNum:9, haveAnswer:true});
    return {status:'found', bookId:100001, target:structuredClone(task.target), recordId:102, count:2,
      source:structuredClone(task.source), mainPicNum:3, answerPicNum:9, stem:side('stem'), answer:side('answer')};
  };
  return {adapter, page, context, browser, original, disk};
}

test('matching disk evidence reuses only a fresh append original and persists a zero-request proof', async t => {
  const {adapter,original,disk}=await fixture(t);
  const result=await adapter.reconcile(task,{pendingWrite:disk});
  assert.equal(adapter._pendingWrite,original);
  assert.deepEqual([result.recovery.outcome,result.recovery.writeUnlocked,result.recovery.liveNoSaveRequests],['not_saved',true,true]);
  const stored=JSON.parse(await fs.readFile(result.recovery.evidencePath,'utf8'));
  assert.equal(stored.observedSaveRequests,0); assert.equal(stored.recovery.outcome,'not_saved');
});

test('stale disk counts never replace dispatched SAVE counts, including failed requests and non-2xx responses', async t => {
  for (const outcome of ['requestfailed','non-2xx']) await t.test(outcome, async child => {
    const {adapter,page,original,disk}=await fixture(child);
    const request=saveRequest(); page.emit('request',request);
    if (outcome==='requestfailed') page.emit('requestfailed',request);
    else page.emit('response',{request:()=>request,status:()=>503});
    const result=await adapter.reconcile(task,{pendingWrite:disk});
    assert.equal(adapter._pendingWrite,original); assert.equal(original.observedSaveRequests,1);
    assert.equal(result.recovery.outcome,'unknown'); assert.equal(result.recovery.writeUnlocked,false);
    assert.equal(JSON.parse(await fs.readFile(result.recovery.evidencePath,'utf8')).observedSaveRequests,1);
  });
});

test('a higher supplied count is retained conservatively', async t => {
  const {adapter,disk}=await fixture(t); disk.observedSaveRequests=2;
  const result=await adapter.reconcile(task,{pendingWrite:disk});
  assert.equal(adapter._pendingWrite.observedSaveRequests,2); assert.equal(result.recovery.writeUnlocked,false);
});

test('a continuity gap never lowers the known count when stale disk evidence is restored', async t => {
  const {adapter,page,browser,disk}=await fixture(t); page.emit('request',saveRequest()); browser.emit('disconnected');
  const result=await adapter.reconcile(task,{pendingWrite:disk});
  assert.equal(result.recovery.writeUnlocked,false); assert.equal(adapter._pendingWrite.observedSaveRequests,1);
  assert.equal(JSON.parse(await fs.readFile(result.recovery.evidencePath,'utf8')).observedSaveRequests,1);
});

test('a supplied nonempty receipt cannot disappear between repeated missing reconciliations', async t => {
  const {adapter,disk}=await fixture(t); disk.receipt={shitiID:102};
  for (const options of [{pendingWrite:disk},{}, {pendingWrite:{...disk,receipt:null}}]) {
    const result=await adapter.reconcile(task,options);
    assert.equal(result.recovery.writeUnlocked,false); assert.equal(result.recovery.outcome,'unknown');
    assert.deepEqual(adapter._pendingWrite.receipt,{shitiID:102});
  }
});

test('deserialized or manually assigned intentions never acquire live proof after repeated recovery', async t => {
  const {adapter,disk}=await fixture(t,{fresh:false});
  for (const options of [{pendingWrite:disk},{},{pendingWrite:adapter.pendingWrite}]) {
    const result=await adapter.reconcile(task,options);
    assert.equal(result.recovery.outcome,'unknown'); assert.equal(result.recovery.writeUnlocked,false);
  }
});

test('all immutable identity fields must match; a later matching file cannot repair the observation gap', async t => {
  const changes={
    evidencePath:p=>{p.evidencePath=path.join(path.dirname(p.evidencePath),'different.pending.json');},
    startedAt:p=>{p.startedAt='2026-10-10T00:00:00.000Z';},
    task:p=>{p.task.stem.blocks[0].text+=' changed';},
    prior:p=>{p.priorRecords[0].question+='<p>changed</p>';},
    node:p=>{p.nodeID=502;}, book:p=>{p.bookId=100002;},
    kind:p=>{p.kind='wrong';}, schema:p=>{p.schemaVersion=2;},
  };
  for (const [name,change] of Object.entries(changes)) await t.test(name, async child => {
    const {adapter,disk}=await fixture(child), changed=structuredClone(disk); change(changed);
    let result;
    try {result=await adapter.reconcile(task,{pendingWrite:changed});}
    catch {assert.equal(adapter._uncertain,true); return;}
    assert.equal(result.recovery.writeUnlocked,false);
    assert.equal((await adapter.reconcile(task,{pendingWrite:disk})).recovery.writeUnlocked,false);
  });
});

test('an observed mutation of the original intent remains invalid after early rejection and restoration', async t => {
  const {adapter,original}=await fixture(t); original.task.stem.blocks[0].text+=' changed';
  await assert.rejects(adapter.reconcile(task),/已审题单/u);
  original.task.stem.blocks[0].text=task.stem.blocks[0].text;
  assert.equal((await adapter.reconcile(task)).recovery.writeUnlocked,false);
});

test('page, context, browser, and observer gaps permanently invalidate fresh qualification', async t => {
  const changes={
    close:({page})=>page.emit('close'), crash:({page})=>page.emit('crash'),
    contextClose:({context})=>context.emit('close'), disconnected:({browser})=>browser.emit('disconnected'),
    requestListener:({page})=>{const listener=page.listeners('request')[0]; page.off('request',listener); page.on('request',listener);},
    removalWitness:({page})=>{const watcher=page.listeners('removeListener')[0]; page.off('removeListener',watcher); const listener=page.listeners('request')[0]; page.off('request',listener); page.on('request',listener); page.on('removeListener',watcher);},
    contextWitness:({context})=>{const watcher=context.listeners('removeListener')[0]; context.off('removeListener',watcher); context.on('removeListener',watcher);},
    browserWitness:({browser})=>{const watcher=browser.listeners('removeListener')[0]; browser.off('removeListener',watcher); browser.on('removeListener',watcher);},
    replacement:({adapter,page,context})=>{const other=new EventEmitter(); other.context=()=>context; other.isClosed=()=>false; adapter.page=other; adapter._observe(other); adapter.page=page; adapter._observe(page);},
    contextIdentity:({adapter})=>{adapter.context={};},
  };
  for (const [name,change] of Object.entries(changes)) await t.test(name, async child => {
    const context=await fixture(child); change(context);
    const result=await context.adapter.reconcile(task,{pendingWrite:context.disk});
    assert.equal(result.recovery.writeUnlocked,false); assert.equal(result.recovery.outcome,'unknown');
  });
});

test('missing observer capability never permits a live zero-request proof', async t => {
  const {adapter,context,disk}=await fixture(t);
  context.browser=()=>null;
  assert.equal((await adapter.reconcile(task,{pendingWrite:disk})).recovery.writeUnlocked,false);
});

test('missing listeners introspection keeps basic request and response capture working but cannot unlock', async t => {
  const {adapter,page,disk}=await fixture(t,{missingListeners:true});
  const capture=adapter._captureSaveResponse();
  const request={...saveRequest(),postDataJSON:()=>({textbookID:100001})};
  const response={request:()=>request}; page.emit('request',request); page.emit('response',response);
  assert.equal(await capture.wait(),response); capture.dispose();
  assert.equal(adapter._pendingWrite.observedSaveRequests,1);
  assert.equal((await adapter.reconcile(task,{pendingWrite:disk})).recovery.writeUnlocked,false);
});

test('replacing an intention during its first durable await cannot promote a restored clone to fresh capability', async t => {
  const {adapter,disk}=await fixture(t,{replaceDuringBirth:true});
  const result=await adapter.reconcile(task,{pendingWrite:disk});
  assert.equal(result.recovery.outcome,'unknown'); assert.equal(result.recovery.writeUnlocked,false);
});

test('SAVE or observation loss during fresh read or the durable proof checkpoint retains the lock', async t => {
  for (const phase of ['read','persist-save','persist-disconnect']) await t.test(phase, async child => {
    const {adapter,page,browser,disk}=await fixture(child);
    if (phase==='read') {const read=adapter.read; adapter.read=async (...args)=>{const result=await read(...args); page.emit('request',saveRequest()); return result;};}
    else {
      const persist=adapter._persistPendingWrite.bind(adapter); let injected=false;
      adapter._persistPendingWrite=async (...args)=>{
        await persist(...args);
        if (!injected && adapter._pendingWrite.recovery?.outcome==='not_saved') {
          injected=true;
          if (phase==='persist-save') page.emit('request',saveRequest()); else browser.emit('disconnected');
        }
      };
    }
    const result=await adapter.reconcile(task,{pendingWrite:disk});
    assert.equal(result.recovery.outcome,'unknown'); assert.equal(result.recovery.writeUnlocked,false); assert.equal(adapter._uncertain,true);
    const stored=JSON.parse(await fs.readFile(result.recovery.evidencePath,'utf8')); assert.equal(stored.status,'pending'); assert.equal(stored.recovery.outcome,'unknown');
  });
});

test('stale disk null receipt cannot conceal a known live receipt conflict on saved recovery', async t => {
  for (const disconnected of [false,true]) await t.test(disconnected?'continuity lost':'continuity intact', async child => {
  const {adapter,browser,original,disk}=await fixture(child,{found:true});
  original.receipt={bookId:100001, seqIndex:2, shitiID:999, mainPicNum:3, answerPicNum:9,
    request:{bookId:100001, seqIndex:2, mainPicNum:3, answerPicNum:9}, response:{status:200,body:{errno:0,errmsg:'success',data:{seqIndex:2,shitiID:999,haveAnswer:true}}}};
  if (disconnected) browser.emit('disconnected');
  const result=await adapter.reconcile(task,{pendingWrite:disk});
  assert.equal(result.recovery.outcome,'unknown'); assert.equal(result.recovery.writeUnlocked,false);
  assert.ok(result.recovery.errors.some(error=>error.includes('服务器ID')));
  });
});

test('conflicting supplied and live receipts remain a saved-recovery blocker on subsequent calls', async t => {
  const {adapter,page,original,disk}=await fixture(t,{found:true});
  const receipt=id=>({bookId:100001,seqIndex:2,shitiID:id,mainPicNum:3,answerPicNum:9,
    request:{bookId:100001,seqIndex:2,mainPicNum:3,answerPicNum:9},response:{status:200,body:{errno:0,errmsg:'success',data:{seqIndex:2,shitiID:id,haveAnswer:true}}}});
  original.receipt=receipt(102); disk.receipt=receipt(999);
  const rejected=await adapter.reconcile(task,{pendingWrite:disk}); assert.equal(rejected.recovery.writeUnlocked,false);
  const stored=JSON.parse(await fs.readFile(rejected.recovery.evidencePath,'utf8')); assert.equal(stored.receiptConflict,true);
  const restored=new NewSystemAdapter({page,baseDir:adapter.baseDir,dataDir:adapter.dataDir,source:'fixture'});
  restored.bookId=100001; restored._uncertain=true;
  restored.read=async (...args)=>{const found=await adapter.read(...args); restored._nodeID=adapter._nodeID; restored._directoryRecords=structuredClone(adapter._directoryRecords); return found;};
  assert.equal((await restored.reconcile(task,{pendingWrite:stored})).recovery.writeUnlocked,false);
  assert.equal((await adapter.reconcile(task,{pendingWrite:{...disk,receipt:receipt(102)}})).recovery.writeUnlocked,false);
});
