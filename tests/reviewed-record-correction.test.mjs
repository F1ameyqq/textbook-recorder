import test,{after as afterTests} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {ReviewedRecordCorrectionAdapter} from '../src/reviewed-record-correction.mjs';
import {renderEditorHtml} from '../src/new-system-core.mjs';

const baseDir=await fs.mkdtemp(path.join(os.tmpdir(),'reviewed-record-correction-fixture-'));
afterTests(()=>fs.rm(baseDir,{recursive:true,force:true}));
let browserPromise;
afterTests(async()=>{if(browserPromise)await (await browserPromise.catch(()=>null))?.close();});
const bookId=100001,nodeID=2001,recordId=1002,savePath='/edushop/textbook/myproducecommit/editshiti';
const render=content=>renderEditorHtml(content,baseDir);
const before={
  id:'reviewed-existing-record',
  target:{chapterLabel:'Fixture chapter',sectionLabel:'Fixture section',record:2,expectedRecordId:recordId},
  source:{pages:[4],answerPages:[72]},
  answerStatus:'provided',
  stem:{blocks:[{type:'text',text:'1. Choose one: ( )'},{type:'text',runs:[{type:'text',text:'A. 10'},{type:'sup',text:'8'},{type:'text',text:' H'},{type:'sub',text:'2'},{type:'text',text:'O'}]}]},
  answer:{blocks:[{type:'text',text:'1. C'},{type:'text',text:'A项说明；B项说明。'}]},
  review:{status:'approved',issues:[]},
};
const corrected={...structuredClone(before),
  stem:{blocks:[{type:'text',text:'1. Choose one: (        )',strictSpacing:true},{type:'text',text:'   阅读这段文字。',strictSpacing:true},{type:'text',text:'A. 袭 xiè        禀 bǐn        汲 jí',strictSpacing:true}]},
  answer:{blocks:[{type:'text',text:'1. C'},{type:'text',text:'A项说明。'},{type:'text',text:'B项说明。'}]},
};
const recordsBefore=()=>[
  {seqIndex:1,shitiID:1001,nodeID,question:'<p>Neighbour question</p>',answer:'<p>Neighbour answer</p>',mainPicNum:3,answerPicNum:72,haveAnswer:true},
  {seqIndex:2,shitiID:recordId,nodeID,question:render(before.stem),answer:render(before.answer),mainPicNum:4,answerPicNum:72,haveAnswer:true},
];

/** Real browser POST/HTTP receipts and fresh HTTP GET readback on owned localhost.
 * Only directory selection is modelled; readback HTML always comes from persisted
 * server records and is parsed in Edge, never replaced with expected task content.
 */
async function fixture(t,{baselineMismatch=false,repairBaseline=false,sourceAutosaves=false,wrongRequestId=false,wrongResponseId=false,businessFailure=false,changeNeighbour=false,stripSpaces=false,unreviewedAnswer=false,networkFailure=false,firstReplyDelay=10}={}){
  let browser;
  try{browserPromise??=chromium.launch({channel:'msedge',headless:true});browser=await browserPromise;}
  catch{t.skip('Edge unavailable for owned localhost network fixture');return null;}
  const requests=[],replies=[],networkEvents=[],checkpoints=[],readSnapshots=[];
  let records=recordsBefore();
  if(repairBaseline)Object.assign(records[1],{answer:'',mainPicNum:0,answerPicNum:0,haveAnswer:false});
  if(baselineMismatch)records[1].question='<p>Current content differs from approved baseline</p>';
  const server=http.createServer(async(req,res)=>{
    if(req.method==='POST'&&req.url===savePath){
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const body=JSON.parse(Buffer.concat(chunks).toString());const index=requests.push(body);
      networkEvents.push({kind:'request',index,at:Date.now()});
      if(networkFailure){res.destroy();return;}
      await new Promise(resolve=>setTimeout(resolve,index===1?firstReplyDelay:10));
      records[1]={...records[1],question:stripSpaces?body.question.replace(/&nbsp;|\u00a0/gu,''):body.question,answer:body.answer,mainPicNum:body.mainPicNum,answerPicNum:body.answerPicNum,haveAnswer:Boolean(body.answer)};
      if(changeNeighbour)records[0].answer='<p>Unexpected neighbouring change</p>';
      const reply={errno:businessFailure?9:0,errmsg:businessFailure?'failed':'success',data:{seqIndex:2,shitiID:wrongResponseId?9009:recordId,haveAnswer:Boolean(body.answer)}};
      replies.push(reply);networkEvents.push({kind:'response',index,at:Date.now()});
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(reply));return;
    }
    if(req.method==='GET'&&req.url==='/records'){
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(records));return;
    }
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
    res.end('<!doctype html><style>.w-e-text{min-height:100px;border:1px solid black;}</style><input class="el-input__inner" value="2"><div id="contentedit"><div class="w-e-text" contenteditable="true">'+records[1].question+'</div></div><div id="answeredit"><div class="w-e-text" contenteditable="true">'+records[1].answer+'</div></div>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const origin='http://127.0.0.1:'+server.address().port;
  const context=await browser.newContext();t.after(()=>context.close());
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  const page=await context.newPage();
  await page.goto(origin+'/edu-shop-web/#/content-manager/teaching-content?textbookID='+bookId+'&textbookType=main');
  await page.evaluate(({wrongRequestId,unreviewedAnswer,repairBaseline})=>{
    window.fixtureSaves=0;window.fixturePosts=[];
    window.fixtureMainPicNum=repairBaseline?0:4;window.fixtureAnswerPicNum=repairBaseline?0:72;
    window.fixturePost=()=>{
      window.fixtureSaves++;
      const body={textbookID:100001,nodeID:2001,seqIndex:2,shitiID:wrongRequestId?9009:1002,mainPicNum:window.fixtureMainPicNum,answerPicNum:window.fixtureAnswerPicNum,
        question:document.querySelector('#contentedit .w-e-text').innerHTML,
        answer:unreviewedAnswer?'<p>Unreviewed answer</p>':document.querySelector('#answeredit .w-e-text').innerHTML};
      const post=fetch('/edushop/textbook/myproducecommit/editshiti',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).catch(()=>{});window.fixturePosts.push(post);return post;
    };
    for(const editor of document.querySelectorAll('.w-e-text'))editor.addEventListener('blur',window.fixturePost);
  },{wrongRequestId,unreviewedAnswer,repairBaseline});
  const adapter=new ReviewedRecordCorrectionAdapter({page,baseDir,source:'fixture',origin,inputMode:'browser-command',timeout:2500});
  await adapter.connect(bookId);
  if(repairBaseline)adapter._navigateSources=async task=>{
    for(const [field,value] of [['fixtureMainPicNum',task.source.pages[0]],['fixtureAnswerPicNum',task.source.answerPages[0]]])await page.evaluate(async({field,value,sourceAutosaves})=>{window[field]=value;if(sourceAutosaves)await window.fixturePost();},{field,value,sourceAutosaves});
    return [task.source.pages[0],task.source.answerPages[0]];
  };
  adapter.read=async(task,{refresh})=>{
    assert.equal(refresh,true);
    const response=await page.request.get(origin+'/records');assert.equal(response.status(),200);
    const stored=await response.json();readSnapshots.push(structuredClone(stored));
    adapter._nodeID=nodeID;adapter._directoryRecords=structuredClone(stored);
    const current=stored.find(row=>row.seqIndex===task.target.record);
    const parse=html=>page.evaluate(html=>{
      const root=document.createElement('div');root.innerHTML=html;
      const paragraphs=[...root.children].map(element=>{
        const copy=element.cloneNode(true);for(const br of copy.querySelectorAll('br'))br.replaceWith('\n');
        return {text:copy.textContent,imageCount:element.querySelectorAll('img').length,align:element.style.textAlign||element.getAttribute('align')||'left',direction:element.style.direction||element.getAttribute('dir')||'ltr'};
      });
      return {html,text:paragraphs.map(p=>p.text).join('\n'),paragraphs,images:[]};
    },html);
    return {status:'found',bookId,target:structuredClone(task.target),recordId:current.shitiID,count:stored.length,
      source:{pages:[current.mainPicNum],answerPages:[current.answerPicNum]},mainPicNum:current.mainPicNum,answerPicNum:current.answerPicNum,haveAnswer:current.haveAnswer,
      stem:await parse(current.question),answer:await parse(current.answer)};
  };
  return {adapter,page,origin,requests,replies,networkEvents,checkpoints,readSnapshots,
    checkpoint:async event=>checkpoints.push(structuredClone(event)),
    flush:()=>page.evaluate(async()=>{await Promise.allSettled(window.fixturePosts);}),
    stored:async()=>{const response=await page.request.get(origin+'/records');return response.json();}};
}

test('reviewed record correction saves stem then answer serially, binds every business receipt, and rereads actual persisted HTML',async t=>{
  const f=await fixture(t,{firstReplyDelay:350});if(!f)return;
  const result=await f.adapter.replaceRecord(corrected,{expectedBefore:before,checkpoint:f.checkpoint});
  assert.equal(result.saveRequests,2);assert.equal(result.preservedRecords,2);assert.equal(result.plusClicks,0);assert.equal(result.comparison.ok,true);
  assert.equal(f.requests.length,2);assert.equal(f.replies.length,2);assert.equal(f.readSnapshots.length,2);
  assert.deepEqual(f.checkpoints.filter(event=>event.phase==='save-response').map(event=>event.observation.state),[1,2]);
  const observed=f.checkpoints.find(event=>event.phase==='readback').observations;
  assert.deepEqual(observed.map(row=>row.status),['responded','responded']);
  for(const row of observed){assert.equal(row.receipt.response.body.errno,0);assert.equal(row.receipt.response.body.errmsg,'success');assert.equal(row.receipt.response.body.data.shitiID,recordId);}
  assert.equal(f.requests[0].answer,render(before.answer));
  assert.match(f.requests[1].answer,/1\. C<\/p><p[^>]*>A项说明。<\/p><p[^>]*>B项说明。<\/p>/u);
  assert.equal(f.requests[0].question,f.requests[1].question);
  assert.ok(f.networkEvents.find(event=>event.kind==='response'&&event.index===1).at<=f.networkEvents.find(event=>event.kind==='request'&&event.index===2).at);
  for(const body of f.requests)assert.deepEqual([body.textbookID,body.nodeID,body.seqIndex,body.shitiID,body.mainPicNum,body.answerPicNum],[bookId,nodeID,2,recordId,4,72]);
  const stored=await f.stored();assert.deepEqual(stored[0],recordsBefore()[0]);
  assert.deepEqual(f.readSnapshots.at(-1),stored);assert.equal(result.readback.stem.html,stored[1].question);assert.equal(result.readback.answer.html,stored[1].answer);
  assert.match(result.readback.stem.paragraphs[0].text,/\(\u00a0{8}\)/u);assert.match(result.readback.stem.paragraphs[1].text,/^\u00a0{3}阅读/u);
  assert.equal(f.adapter._uncertain,false);assert.equal(f.adapter._pendingWrite,null);assert.equal(f.adapter._busy,false);
});

test('mismatched approved baseline is rejected before any editor change or POST',async t=>{
  const f=await fixture(t,{baselineMismatch:true});if(!f)return;
  const html=await f.page.locator('#contentedit .w-e-text').innerHTML();
  await assert.rejects(f.adapter.replaceRecord(corrected,{expectedBefore:before,checkpoint:f.checkpoint}),/修订基线/u);
  assert.equal(f.requests.length,0);assert.equal(await f.page.evaluate(()=>window.fixtureSaves),0);assert.equal(await f.page.locator('#contentedit .w-e-text').innerHTML(),html);
  assert.equal(f.adapter._uncertain,false);assert.equal(f.adapter._pendingWrite,null);assert.equal(f.adapter._busy,false);
});

for(const [name,options,pattern,expectedRequests] of [
  ['wrong request ID',{wrongRequestId:true},/身份或来源改变/u,1],
  ['wrong receipt ID',{wrongResponseId:true},/业务回执不符/u,1],
  ['business failure',{businessFailure:true},/业务回执不符/u,1],
  ['unreviewed request answer',{unreviewedAnswer:true},/不是已审/u,1],
  ['changed neighbouring record',{changeNeighbour:true},/其他题目/u,2],
  ['server drops strictSpacing spaces',{stripSpaces:true},/严格空格间隔或段首空格不一致/u,2],
])test(`reviewed record correction fails closed after ${name} and refuses another edit`,async t=>{
  const f=await fixture(t,options);if(!f)return;
  await assert.rejects(f.adapter.replaceRecord(corrected,{expectedBefore:before,checkpoint:f.checkpoint}),pattern);
  await f.flush();
  assert.equal(f.requests.length,expectedRequests);assert.equal(f.adapter._uncertain,true);assert.equal(f.adapter._busy,false);assert.equal(f.adapter._pendingWrite.status,'pending');
  const saves=f.requests.length;
  await assert.rejects(f.adapter.replaceRecord(corrected,{expectedBefore:before,checkpoint:f.checkpoint}),/上次保存尚未核对/u);
  assert.equal(f.requests.length,saves);
  if(expectedRequests===1)assert.equal(await f.page.locator('#answeredit .w-e-text').innerHTML(),render(before.answer),'failed stem save must stop before answer editing');
  if(options.stripSpaces){const actual=await f.stored();assert.notEqual(actual[1].question,render(corrected.stem));assert.equal(f.readSnapshots.length,2);}
  assert.equal(f.page.listenerCount('response'),0);assert.equal(f.page.listenerCount('requestfailed'),0);
});

async function repairSnapshot(f){return {schemaVersion:1,kind:'reviewed-empty-answer-source-repair-baseline',bookId,target:structuredClone(corrected.target),nodeID,authorization:{source:'direct-user',userQuote:'补回答案和来源页，并修正缩进'},records:await f.stored()};}
const repaired={...structuredClone(corrected),stem:{blocks:corrected.stem.blocks.map((b,i)=>i===1?{...b,text:'\u3000\u3000阅读这段文字。'}:b)}};

for(const sourceAutosaves of [false,true])test(`approved empty answer and zero source repair restores original ID and two full-width spaces; source autosaves=${sourceAutosaves}`,async t=>{
 const f=await fixture(t,{repairBaseline:true,sourceAutosaves});if(!f)return;
 const snapshot=await repairSnapshot(f);
 const result=await f.adapter.replaceRecord(repaired,{expectedBefore:before,repairSnapshot:snapshot,checkpoint:f.checkpoint});
 assert.equal(result.comparison.ok,true);assert.equal(result.plusClicks,0);assert.equal(result.saveRequests,sourceAutosaves?4:2);
 const stored=await f.stored();assert.deepEqual(stored[0],snapshot.records[0]);assert.equal(stored.length,2);
 assert.equal(stored[1].shitiID,recordId);assert.equal(stored[1].mainPicNum,4);assert.equal(stored[1].answerPicNum,72);assert.equal(stored[1].haveAnswer,true);
 assert.match(result.readback.stem.paragraphs[1].text,/^\u3000\u3000阅读/u);
 assert.equal(result.receipt.response.body.data.haveAnswer,true);
 if(sourceAutosaves){assert.deepEqual(f.requests.map(r=>[r.mainPicNum,r.answerPicNum]),[[4,0],[4,72],[4,72],[4,72]]);assert.deepEqual(f.replies.map(r=>r.data.haveAnswer),[false,false,false,true]);}
 assert.equal(f.adapter._uncertain,false);assert.equal(f.adapter._pendingWrite,null);
});

test('repair snapshot rejects further directory drift before editing or saving',async t=>{
 const f=await fixture(t,{repairBaseline:true});if(!f)return;
 const snapshot=await repairSnapshot(f);snapshot.records[0].answer='<p>Not the observed neighbour</p>';
 await assert.rejects(f.adapter.replaceRecord(repaired,{expectedBefore:before,repairSnapshot:snapshot}),/当前完整目录不同/u);
 assert.equal(f.requests.length,0);assert.equal(f.adapter._uncertain,false);
});

test('repair snapshot cannot authorize a different ID or a record with a nonempty answer',async t=>{
 const f=await fixture(t,{repairBaseline:true});if(!f)return;
 const snapshot=await repairSnapshot(f);snapshot.target.expectedRecordId=9009;
 await assert.rejects(f.adapter.replaceRecord(repaired,{expectedBefore:before,repairSnapshot:snapshot}),/修复快照/u);
 snapshot.target.expectedRecordId=recordId;snapshot.records[1].answer='<p>Already has an answer</p>';
 await assert.rejects(f.adapter.replaceRecord(repaired,{expectedBefore:before,repairSnapshot:snapshot}),/修复快照仅允许/u);
 assert.equal(f.requests.length,0);assert.equal(f.adapter._uncertain,false);
});
