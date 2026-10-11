import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {chromium} from 'playwright';
import {NewSystemAdapter} from '../src/new-system-adapter.mjs';
import {completeReviewedRecordRepair} from '../src/complete-reviewed-record-repair.mjs';

async function fixture(t,{wrongReceipt=false,neighborDrift=false,alreadyAttempted=false}={}){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'record-completion-'));
  const task={id:'q',target:{chapterLabel:'章',sectionLabel:'节',record:2,expectedRecordId:92},
    source:{pages:[7],answerPages:[72]},answerStatus:'provided',review:{status:'approved',issues:[]},
    stem:{blocks:[{type:'text',text:'\u3000\u3000原文。',strictSpacing:true,emphasis:{schemaVersion:1,indexUnit:'unicode-code-points',marks:[{type:'emphasis-dot',start:2,end:3,text:'原'}]}}]},
    answer:{blocks:[{type:'text',parts:['（1）①B','②B'],strictSpacing:true}]}};
  const rows=[{seqIndex:1,shitiID:91,nodeID:23,question:'<p>邻题</p>',answer:'<p>A</p>',mainPicNum:6,answerPicNum:72,haveAnswer:true},
    {seqIndex:2,shitiID:92,nodeID:23,question:'<p>   原文。</p>',answer:'',mainPicNum:0,answerPicNum:0,haveAnswer:false}];
  const snapshot={schemaVersion:1,kind:'reviewed-empty-answer-source-repair-baseline',bookId:146965,
    target:task.target,nodeID:23,authorization:{source:'direct-user',userQuote:'补回答案和来源页，并修正缩进'},records:structuredClone(rows)};
  if(neighborDrift)rows[0].question='<p>其他变化</p>';
  const bodies=[],server=http.createServer(async(req,res)=>{
    if(req.method==='POST'){
      let raw='';for await(const chunk of req)raw+=chunk;assert.ok(req.headers['content-type'].startsWith('application/json'));const body=JSON.parse(raw);bodies.push(body);
      assert.equal(req.url,'/edushop/textbook/myproducecommit/editshiti');
      Object.assign(rows[1],{question:body.question,answer:body.answer,mainPicNum:Number(body.mainPicNum),answerPicNum:Number(body.answerPicNum),haveAnswer:true});
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify({errno:0,errmsg:'success',data:{seqIndex:2,shitiID:wrongReceipt?93:92,haveAnswer:true}}));return;
    }
    if(req.url.startsWith('/edushop/textbook/detail/basicinfo')){assert.ok(req.url.includes('textbookID=146965'));res.setHeader('Content-Type','application/json');res.end(JSON.stringify({errno:0,data:{uploadID:'synthetic-book'}}));return;}
    if(req.url.startsWith('/edushop/textbook/file/progress')){assert.ok(req.url.includes('uploadID=synthetic-book'));res.setHeader('Content-Type','application/json');res.end(JSON.stringify({errno:0,data:{data:Array.from({length:72},(_,i)=>({pageURL:'https://synthetic.cdn.bcebos.com/page-'+(i+1)+'.jpg'}))}}));return;}
    res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<div id="contentedit"><div class="w-e-text">'+rows[1].question+'</div></div><div id="answeredit"><div class="w-e-text">'+(rows[1].answer||'<p><br></p>')+'</div></div>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port,browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage();
  await page.goto(origin);
  const adapter=new NewSystemAdapter({page,baseDir:dir,origin,inputMode:'browser-command',source:'fixture'});
  adapter.bookId=146965;adapter._uncertain=true;
  adapter.guard=async()=>assert.equal(page.url(),origin+'/');
  adapter.read=async()=>{await page.reload();adapter._nodeID=23;adapter._directoryRecords=structuredClone(rows);
    return {status:'found',bookId:146965,target:task.target,count:2,recordId:92,mainPicNum:rows[1].mainPicNum,answerPicNum:rows[1].answerPicNum,
      source:{pages:[rows[1].mainPicNum],answerPages:[rows[1].answerPicNum]},haveAnswer:rows[1].haveAnswer,
      stem:await adapter._editorRead('#contentedit .w-e-text'),answer:await adapter._editorRead('#answeredit .w-e-text')};};
  const pending={status:'pending',phase:'correction',task,priorRecords:structuredClone(snapshot.records)},pendingPath=path.join(dir,'original.pending.json');
  await fs.writeFile(pendingPath,JSON.stringify(pending));
  if(alreadyAttempted)await fs.writeFile(pendingPath+'.completion.json','{"status":"pending"}');
  const events=[];const run=()=>completeReviewedRecordRepair(adapter,task,{snapshot,pending,pendingPath,checkpoint:async event=>events.push(event)});
  t.after(async()=>{await browser.close();await new Promise(resolve=>server.close(resolve));await fs.rm(dir,{recursive:true,force:true});});
  return {run,adapter,bodies,rows,snapshot,pendingPath,events};
}
test('approved final completion makes one real existing-ID POST and verifies sources, native dot and two fullwidth spaces',async t=>{
  const f=await fixture(t),original=await fs.readFile(f.pendingPath,'utf8'),result=await f.run();
  assert.equal(f.bodies.length,1);assert.equal(f.bodies[0].shitiID,92);assert.equal(f.bodies[0].mainPicNum,7);assert.equal(f.bodies[0].answerPicNum,72);
  assert.equal(f.bodies[0].mainPicURL,'https://synthetic.cdn.bcebos.com/page-7.jpg');assert.equal(f.bodies[0].answerPicURL,'https://synthetic.cdn.bcebos.com/page-72.jpg');
  assert.equal(result.recovery.writeUnlocked,true);assert.equal(f.adapter._uncertain,false);assert.deepEqual(f.rows[0],f.snapshot.records[0]);
  assert.ok(result.stem.paragraphs[0].text.startsWith('\u3000\u3000'));assert.deepEqual(result.stem.paragraphs[0].nativeEmphasis.marks,[{type:'emphasis-dot',start:2,end:3,text:'原'}]);
  assert.equal(await fs.readFile(f.pendingPath,'utf8'),original);assert.equal(f.events.at(-1).phase,'completion-fresh-readback');
  await f.run();assert.equal(f.bodies.length,1);
});
test('wrong completion receipt keeps unknown status and never retries its request',async t=>{
  const f=await fixture(t,{wrongReceipt:true});await assert.rejects(f.run(),/回执/);assert.equal(f.bodies.length,1);assert.equal(f.adapter._uncertain,true);
});
test('neighbor drift and an unknown prior completion prevent any new POST',async t=>{
  for(const options of [{neighborDrift:true},{alreadyAttempted:true}]){const f=await fixture(t,options);await assert.rejects(f.run());assert.equal(f.bodies.length,0);assert.equal(f.adapter._uncertain,true);}
});
