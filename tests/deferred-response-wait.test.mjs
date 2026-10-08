import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {captureResponseBeforeWait} from '../src/deferred-response-wait.mjs';
import {NewSystemAdapter} from '../src/new-system-adapter.mjs';
import {renderEditorHtml,expectedEditor} from '../src/new-system-core.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const cleaned=page=>{for(const event of ['response','close','crash'])assert.equal(page.listenerCount(event),0,event+' listener leaked');};

test('editing longer than response budget does not consume the later wait budget',async()=>{
  const page=new EventEmitter(),response={id:1},capture=captureResponseBeforeWait(page,{predicate:()=>true,timeoutMs:15});
  await delay(45);assert.equal(page.listenerCount('response'),1);
  const waiting=capture.wait();setImmediate(()=>page.emit('response',response));
  assert.equal(await waiting,response);cleaned(page);
});
test('an early response during editing survives beyond the eventual wait budget',async()=>{
  const page=new EventEmitter(),response={id:1},capture=captureResponseBeforeWait(page,{predicate:()=>true,timeoutMs:15});
  page.emit('response',response);await delay(45);
  assert.equal(await capture.wait(),response);cleaned(page);capture.dispose();
});
test('the real response wait times out, cleans up, and cannot consume a late response',async()=>{
  const page=new EventEmitter(),capture=captureResponseBeforeWait(page,{predicate:()=>true,timeoutMs:20});
  await delay(35);const started=Date.now();
  await assert.rejects(capture.wait(),error=>error.code==='SAVE_RESPONSE_TIMEOUT' && error.name==='TimeoutError');
  assert.ok(Date.now()-started>=15);cleaned(page);page.emit('response',{id:'late'});await assert.rejects(capture.wait(),/only once/u);
});
test('only the first matching response is retained and wait is consumed once',async()=>{
  const page=new EventEmitter(),first={id:1},second={id:2},capture=captureResponseBeforeWait(page,{predicate:()=>true,timeoutMs:20});
  page.emit('response',first);page.emit('response',second);await tick();
  assert.equal(await capture.wait(),first);await assert.rejects(capture.wait(),/only once/u);cleaned(page);
});
for(const event of ['close','crash'])test(`${event} before wait fails closed with no unhandled rejection or listeners`,async()=>{
  const page=new EventEmitter(),capture=captureResponseBeforeWait(page,{predicate:()=>true,timeoutMs:20});page.emit(event);
  await assert.rejects(capture.wait(),new RegExp(event==='close'?'closed':'crashed','u'));cleaned(page);
});
for(const event of ['close','crash'])test(`${event} during editing invalidates an earlier cached response before wait`,async()=>{
  const page=new EventEmitter(),capture=captureResponseBeforeWait(page,{predicate:()=>true,timeoutMs:20});page.emit('response',{id:1});await tick();page.emit(event);
  await assert.rejects(capture.wait(),new RegExp(event==='close'?'closed':'crashed','u'));cleaned(page);
});
test('predicate failure is retained before wait and cleans up',async()=>{
  const page=new EventEmitter(),failure=new Error('invalid request'),capture=captureResponseBeforeWait(page,{predicate:()=>{throw failure;},timeoutMs:20});
  page.emit('response',{});await tick();await assert.rejects(capture.wait(),error=>error===failure);cleaned(page);
});
test('dispose before or during wait cancels and cleans up idempotently',async()=>{
  for(const started of [false,true]) {
    const page=new EventEmitter(),capture=captureResponseBeforeWait(page,{predicate:()=>true,timeoutMs:100});
    const waiting=started?capture.wait():null;capture.dispose();capture.dispose();
    await assert.rejects(waiting??capture.wait(),/disposed/u);cleaned(page);
  }
});
test('adapter response capture binds new cursor, POST, origin, save path, book, and extra request identity',async()=>{
  const page=Object.assign(new EventEmitter(),{context:()=>({})}),adapter=new NewSystemAdapter({page,source:'fixture',timeout:30});adapter.bookId=100001;adapter._observe(page);
  const origin='https://easylearn.baidu.com',save='/edushop/textbook/myproducecommit/editshiti';
  const request=({method='POST',url=origin+save,book=100001}={})=>({method:()=>method,url:()=>url,postDataJSON:()=>({textbookID:book})});
  const stale=request();page.emit('request',stale);const cursor=adapter._sequence;
  let expected;const capture=adapter._captureSaveResponse(cursor,r=>r===expected);
  page.emit('response',{request:()=>stale});
  for(const options of [{method:'GET'},{url:origin+'/other'},{url:'https://elsewhere.invalid'+save},{book:146005},{}]){const r=request(options);page.emit('request',r);page.emit('response',{request:()=>r});}
  await tick();assert.equal(page.listenerCount('response'),1);
  expected=request();page.emit('request',expected);const wanted={request:()=>expected};page.emit('response',wanted);
  assert.equal(await capture.wait(),wanted);cleaned(page);
});

const task={id:'timed-save',target:{chapterLabel:'测试章',sectionLabel:'测试节',record:2},source:{pages:[2],answerPages:[244]},stem:{blocks:[{type:'text',text:'完整题干'}]},answer:{blocks:[{type:'text',parts:['第一空','第二空']}]},review:{status:'approved',issues:[]}};
const prior={seqIndex:1,shitiID:1001,nodeID:2001,question:'<p>原题</p>',answer:'<p>原答案</p>',mainPicNum:1,answerPicNum:244,haveAnswer:true};
const side=(content)=>({...expectedEditor(content,process.cwd()),html:renderEditorHtml(content,process.cwd()),images:[]});
async function appendFixture(t,{early=false,pasteFailure=false}={}) {
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'deferred-save-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  const page=Object.assign(new EventEmitter(),{context:()=>({}),locator:selector=>({selector,nth(){return this;}}),waitForFunction:async()=>{}});
  const adapter=new NewSystemAdapter({page,source:'fixture',inputMode:'browser-command',dataDir,timeout:15});adapter.bookId=100001;adapter._observe(page);
  adapter.directory=async()=>{adapter._directoryRecords=[structuredClone(prior)];adapter._nodeID=2001;};adapter._navigateSources=async()=>[2,244];adapter._clipboardPreflight=async()=>{};
  let plus=0,saves=0,sent=false;
  const send=()=>{if(sent)return;sent=true;saves++;const r={url:()=>adapter.origin+'/edushop/textbook/myproducecommit/editshiti',method:()=> 'POST',postDataJSON:()=>({textbookID:100001,nodeID:2001,seqIndex:2,mainPicNum:2,answerPicNum:244})};page.emit('request',r);page.emit('response',{request:()=>r,ok:()=>true,status:()=>200,json:async()=>({errno:0,errmsg:'success',data:{seqIndex:2,shitiID:1002,haveAnswer:true}})});};
  adapter._click=async locator=>{if(locator.selector.includes('el-icon-plus'))plus++;else if(!early)setImmediate(send);};
  adapter._paste=async(selector,html)=>{await delay(25);if(pasteFailure)throw new Error('paste failed');if(selector.startsWith('#answer'))assert.match(html,/第一空(?:&nbsp;){8}第二空/u);else if(early)send();};
  adapter.read=async(actual,{refresh})=>{assert.equal(refresh,true);assert.equal(actual.target.expectedRecordId,1002);adapter._directoryRecords=[structuredClone(prior),{seqIndex:2,shitiID:1002,nodeID:2001,question:renderEditorHtml(task.stem,process.cwd()),answer:renderEditorHtml(task.answer,process.cwd()),mainPicNum:2,answerPicNum:244,haveAnswer:true}];return {status:'found',bookId:100001,target:actual.target,count:2,recordId:1002,stem:side(task.stem),answer:side(task.answer),source:task.source,mainPicNum:2,answerPicNum:244,haveAnswer:true};};
  return {adapter,page,get plus(){return plus;},get saves(){return saves;}};
}
for(const early of [false,true])test(`append integrates deferred response budget with ${early?'early editing':'post-edit'} response and one save`,async t=>{
  const f=await appendFixture(t,{early});const receipt=await f.adapter.append(task);assert.equal(receipt.shitiID,1002);assert.equal(f.plus,1);assert.equal(f.saves,1);assert.equal(f.adapter._pendingWrite.observedSaveRequests,1);assert.equal(f.adapter._pendingWrite.status,'completed');assert.equal(f.adapter._uncertain,false);assert.equal(receipt.preservedPriorRecords,1);cleaned(f.page);
});
test('append editor failure disposes the pre-registered listener and retains unknown write lock',async t=>{
  const f=await appendFixture(t,{pasteFailure:true});await assert.rejects(f.adapter.append(task),/paste failed/u);assert.equal(f.plus,1);assert.equal(f.saves,0);assert.equal(f.adapter._uncertain,true);assert.equal(f.adapter._pendingWrite.status,'pending');cleaned(f.page);
});

for(const early of [false,true])test(`replaceAnswer retains ${early?'early editing':'post-edit'} response after long editing without another save`,async()=>{
  const page=Object.assign(new EventEmitter(),{context:()=>({}),locator:selector=>({selector,nth(){return this;}})});
  const adapter=new NewSystemAdapter({page,source:'fixture',inputMode:'browser-command',timeout:15});adapter.bookId=100001;adapter._observe(page);
  const before={...structuredClone(task),id:'existing-answer',target:{...task.target,record:1,expectedRecordId:1001},answer:{blocks:[{type:'text',text:'原答案'}]}};
  const after={...structuredClone(before),answer:structuredClone(task.answer)};let current=structuredClone(before),sent=false,saves=0;
  adapter.guard=async()=>{};adapter._clipboardPreflight=async()=>{};
  adapter.read=async(actual,{refresh})=>{assert.equal(refresh,true);adapter._nodeID=2001;adapter._directoryRecords=[{...prior,question:renderEditorHtml(current.stem,process.cwd()),answer:renderEditorHtml(current.answer,process.cwd()),mainPicNum:2}];return {status:'found',bookId:100001,target:actual.target,recordId:1001,count:1,stem:side(current.stem),answer:side(current.answer),source:current.source,mainPicNum:2,answerPicNum:244,haveAnswer:true};};
  const send=()=>{if(sent)return;sent=true;saves++;current=structuredClone(after);const r={url:()=>adapter.origin+'/edushop/textbook/myproducecommit/editshiti',method:()=> 'POST',postDataJSON:()=>({textbookID:100001,nodeID:2001,seqIndex:1,shitiID:1001,mainPicNum:2,answerPicNum:244})};page.emit('request',r);page.emit('response',{request:()=>r,status:()=>200,json:async()=>({errno:0,errmsg:'success',data:{seqIndex:1,shitiID:1001,haveAnswer:true}})});};
  adapter._paste=async(selector,html,options)=>{assert.equal(options.replace,true);assert.equal(selector,'#answeredit .w-e-text');assert.match(html,/第一空(?:&nbsp;){8}第二空/u);await delay(40);if(early)send();};
  adapter._click=async()=>{if(!early)setImmediate(send);};
  const result=await adapter.replaceAnswer(after,{expectedBefore:before});assert.equal(result.receipt.shitiID,1001);assert.equal(result.saveRequests,1);assert.equal(saves,1);assert.equal(result.comparison.ok,true);assert.equal(adapter._busy,false);assert.equal(adapter._uncertain,false);cleaned(page);
});
