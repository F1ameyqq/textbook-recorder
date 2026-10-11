import test,{after as afterTests} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {NativeAnalysisCorrectionAdapter} from '../src/native-analysis-correction-adapter.mjs';
import {renderEditorHtml,expectedEditor} from '../src/new-system-core.mjs';
import {ANALYSIS_SEPARATOR} from '../src/analysis-separator.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR9cAAAAASUVORK5CYII=','base64');
const baseDir=await fs.mkdtemp(path.join(os.tmpdir(),'native-correction-fixture-'));await fs.writeFile(path.join(baseDir,'figure.png'),png);afterTests(()=>fs.rm(baseDir,{recursive:true,force:true}));
let ownedBrowserPromise;afterTests(async()=>{if(ownedBrowserPromise)await (await ownedBrowserPromise.catch(()=>null))?.close();});
const render=content=>renderEditorHtml(content,baseDir);
const book=100001,nodeID=2001,recordID=1002;
const before={id:'native-existing-answer',target:{chapterLabel:'Fixture chapter',sectionLabel:'Fixture section',record:2,expectedRecordId:recordID},source:{pages:[2],answerPages:[244]},stem:{blocks:[{type:'text',runs:[{type:'text',text:'完整题干。Choose one: 10'},{type:'sup',text:'8'},{type:'text',text:' and H'},{type:'sub',text:'2'},{type:'text',text:'O.'}]},{type:'image',path:'figure.png',align:'center'}]},answer:{blocks:[{type:'text',text:'原答案'}]},review:{status:'approved',issues:[]}};
const after={...structuredClone(before),answer:{blocks:[{type:'text',text:'4. D'},{type:'text',text:'5. C'},{type:'text',parts:['第一空','第二空']},{type:'analysis-separator'},{type:'text',text:'4. Explanation: D is correct.'},{type:'text',text:'5. Explanation: C is correct.'},{type:'image',path:'figure.png',align:'center'}]}};
const record=()=>({seqIndex:2,shitiID:recordID,nodeID,question:render(before.stem),answer:render(before.answer),mainPicNum:2,answerPicNum:244,haveAnswer:true});
const prior=()=>({seqIndex:1,shitiID:1001,nodeID,question:'<p>Other question</p>',answer:'<p>Other answer</p>',mainPicNum:1,answerPicNum:244,haveAnswer:true});
const side=content=>({...expectedEditor(content,baseDir),html:render(content),images:expectedEditor(content,baseDir).images.map(image=>({...image,complete:true,width:image.type==='analysis-separator'?1028:1,height:image.type==='analysis-separator'?40:1,align:image.type==='analysis-separator'?'left':'center'}))});

/** Owned localhost UI sends actual browser POSTs and receives actual HTTP replies.
 * The logical read fixture isolates this test's save-cycle boundary; physical
 * separator pixels are tested separately and are not claimed as production proof.
 */
async function fixture(t,{stages=2,markerOnly=false,reverseReplies=false,wrongID=false,businessFailure=false,badAnswer=false,missingFinal=false,extraSave=false,responseMissing=false,changePrior=false,checkpointFailure=false,restoreIntermediateOnReply=false}={}) {
  let browser;try{ownedBrowserPromise??=chromium.launch({channel:'msedge',headless:true});browser=await ownedBrowserPromise;}catch{t.skip('Edge unavailable for owned localhost network fixture');return null;}
  const requests=[],replies=[],events=[],networkEvents=[];let records=[prior(),record()];
  const beforeTask=markerOnly?{...structuredClone(after),answer:{blocks:after.answer.blocks.filter(block=>block.type!=='analysis-separator').map(block=>structuredClone(block))}}:before;
  const initialAnswer=markerOnly?after.answer.blocks.map(block=>block.type==='analysis-separator'?'<p style="text-align:left;direction:ltr" dir="ltr" align="left"><br></p>':render({blocks:[block]})).join(''):render(beforeTask.answer);
  records[1].answer=initialAnswer;
  const server=http.createServer(async(req,res)=>{
    if(req.method==='POST'){
      const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks));const index=requests.push(body);networkEvents.push({type:'request',index,at:Date.now()});
      if(responseMissing){res.destroy();return;}
      await new Promise(resolve=>setTimeout(resolve,reverseReplies&&index===1?400:10));
      records[1]={...records[1],question:body.question,answer:body.answer};if(changePrior)records[0].answer='<p>Unexpected change</p>';
      const response={errno:businessFailure?9:0,errmsg:businessFailure?'failed':'success',data:{seqIndex:2,shitiID:recordID,haveAnswer:true}};replies.push(index);networkEvents.push({type:'response',index,at:Date.now()});res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(response));return;
    }
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end('<!doctype html><input class="el-input__inner" value="2"><div id="contentedit"><div class="w-e-text" contenteditable="true">'+render(before.stem)+'</div></div><div id="answeredit"><div class="w-e-menu" tabindex="0">添加解析</div><div class="w-e-text" contenteditable="true">'+initialAnswer+'</div></div>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const origin='http://127.0.0.1:'+server.address().port;
  const page=await browser.newPage();t.after(()=>page.context().close());await page.route(ANALYSIS_SEPARATOR.src,route=>route.fulfill({contentType:'image/png',body:png}));
  await page.goto(origin+'/edu-shop-web/#/content-manager/teaching-content?textbookID='+book+'&textbookType=main');
  await page.evaluate(({src,stages,wrongID,badAnswer,missingFinal,extraSave,restoreIntermediateOnReply})=>{
    window.nativeClicks=0;window.posted=0;
    const editor=document.querySelector('#answeredit .w-e-text'),menu=document.querySelector('#answeredit .w-e-menu');
    const save=()=>{
      window.posted++;
      const body={textbookID:100001,nodeID:2001,seqIndex:2,shitiID:wrongID?9009:1002,mainPicNum:2,answerPicNum:244,question:document.querySelector('#contentedit .w-e-text').innerHTML,answer:badAnswer?'<p>Unreviewed replacement</p>':editor.innerHTML};
      fetch('/edushop/textbook/myproducecommit/editshiti',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(response=>response.json()).then(()=>{if(restoreIntermediateOnReply&&window.nativeClicks>0&&!body.answer.includes(src))editor.innerHTML=body.answer;}).catch(()=>{});
    };
    // A menu's native pointer event may autosave before inserting the marker.
    // Keep the native selection as wangEditor does, with no synthetic input.
    menu.addEventListener('mousedown',event=>{if(stages===2)save();event.preventDefault();});
    menu.addEventListener('click',()=>{window.nativeClicks++;document.execCommand('insertHTML',false,`<p><br><img style="display: block; width: 500px" src="${src}"></p>`);});
    editor.addEventListener('blur',()=>{if(!missingFinal||!editor.innerHTML.includes(src)){save();if(extraSave)setTimeout(save,10);}});
  },{src:ANALYSIS_SEPARATOR.src,stages,wrongID,badAnswer,missingFinal,extraSave,restoreIntermediateOnReply});
  const adapter=new NativeAnalysisCorrectionAdapter({page,baseDir,source:'fixture',origin,inputMode:'browser-command',timeout:2500});await adapter.connect(book);
  let reads=0;
  adapter.read=async(task,{refresh})=>{
    assert.equal(refresh,true);reads++;adapter._nodeID=nodeID;adapter._directoryRecords=structuredClone(records);
    const current=reads===1?beforeTask:after;
    assert.equal(records[1].question,render(current.stem));
    if(reads>1){assert.match(records[1].answer,/解析|Explanation/u);assert.ok(records[1].answer.includes(ANALYSIS_SEPARATOR.src));}
    return {status:'found',bookId:book,target:structuredClone(task.target),recordId:recordID,count:records.length,source:task.source,mainPicNum:2,answerPicNum:244,stem:side(current.stem),answer:side(current.answer)};
  };
  const checkpoint=async event=>{events.push(structuredClone(event));if(checkpointFailure&&event.phase==='save-cycle-event'&&event.event.kind==='response-observed')throw new Error('durable checkpoint failed');};
  return {adapter,page,requests,replies,events,networkEvents,beforeTask,markerOnly,checkpoint,get reads(){return reads;}};
}

for(const markerOnly of [true,false])for(const stages of [1,2])test(`${markerOnly?'marker-only':'serial full'} correction accounts for every real localhost POST and business reply (${stages} native save hooks)`,async t=>{
  const f=await fixture(t,{stages,markerOnly});if(!f)return;
  if(markerOnly)f.adapter._paste=async()=>{throw new Error('marker-only must never paste or replace existing text');};
  const count=markerOnly?stages:stages+1;
  const result=await f.adapter.replaceAnswer(after,{expectedBefore:f.beforeTask,checkpoint:f.checkpoint,markerOnly});
  assert.equal(result.saveRequests,count);assert.equal(result.receipts.length,count);assert.equal(result.analysisButtonClicks,1);assert.equal(result.plusClicks,0);assert.equal(result.preservedRecords,2);assert.equal(result.comparison.ok,true);
  assert.equal(f.requests.length,count);assert.equal(f.replies.length,count);assert.equal(await f.page.evaluate(()=>window.nativeClicks),1);assert.equal(f.reads,2);assert.equal(f.adapter._uncertain,false);
  const validated=result.saveCycleEvents.filter(event=>event.kind==='request-validated');assert.deepEqual(validated.map(event=>event.observation.answerState),[...Array(count-1).fill('intermediate'),'final']);
  assert.equal(result.saveCycleEvents.filter(event=>event.kind==='response-observed').length,count);
  assert.equal(f.events.find(event=>event.phase==='receipt').receipts.length,count);
  for(const body of f.requests)assert.deepEqual([body.textbookID,body.nodeID,body.seqIndex,body.shitiID,body.mainPicNum,body.answerPicNum],[book,nodeID,2,recordID,2,244]);
});

test('a delayed intermediate server write finishes before the native marker or final POST can be dispatched',async t=>{
  const f=await fixture(t,{stages:1,reverseReplies:true});if(!f)return;
  const result=await f.adapter.replaceAnswer(after,{expectedBefore:f.beforeTask,checkpoint:f.checkpoint});
  assert.equal(result.receipts.length,2);assert.equal(result.saveRequests,2);assert.deepEqual(f.replies,[1,2]);assert.equal(f.reads,2);
  assert.ok(f.networkEvents.find(e=>e.type==='response'&&e.index===1).at<=f.networkEvents.find(e=>e.type==='request'&&e.index===2).at);
});

test('marker-only rejects a before model that differs from the exact reviewed projection without any request',async t=>{
  const f=await fixture(t,{markerOnly:true});if(!f)return;const bad=structuredClone(f.beforeTask);bad.answer.blocks[0].text+=' changed';
  await assert.rejects(f.adapter.replaceAnswer(after,{expectedBefore:bad,markerOnly:true,checkpoint:f.checkpoint}),/markerOnly前置答案/u);assert.equal(f.requests.length,0);assert.equal(await f.page.evaluate(()=>window.nativeClicks),0);
});

for(const [name,options,pattern] of [
  ['wrong existing ID',{wrongID:true},/身份或来源/u],
  ['failed business reply',{businessFailure:true},/业务回执/u],
  ['unreviewed answer body',{badAnswer:true},/合法中间态/u],
  ['intermediate-only save',{missingFinal:true},/最终已审答案/u],
  ['over-limit autosave',{extraSave:true},/绑定上限/u],
  ['network failure',{responseMissing:true},/传输失败/u],
  ['changed other record',{changePrior:true},/其他题目/u],
  ['failed durable receipt checkpoint',{checkpointFailure:true},/durable checkpoint failed/u],
  ['intermediate response overwrites the local marker',{restoreIntermediateOnReply:true},/解析最终态/u],
])test(`real save-cycle fixture fails closed for ${name}`,async t=>{
  const f=await fixture(t,options);if(!f)return;
  await assert.rejects(f.adapter.replaceAnswer(after,{expectedBefore:f.beforeTask,checkpoint:f.checkpoint}),pattern);
  assert.equal(f.adapter._uncertain,true);assert.equal(f.adapter._busy,false);const saves=f.requests.length;
  await assert.rejects(f.adapter.replaceAnswer(after,{expectedBefore:f.beforeTask,checkpoint:f.checkpoint}),/拒绝修改/u);assert.equal(f.requests.length,saves);
  if(['wrong existing ID','failed business reply','unreviewed answer body','network failure','failed durable receipt checkpoint'].includes(name))assert.equal(await f.page.evaluate(()=>window.nativeClicks),0,'a failed intermediate stage must not insert the marker');
  assert.equal(f.page.listenerCount('response'),0);assert.equal(f.page.listenerCount('requestfailed'),0);
});
