import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {NewSystemAdapter} from '../src/new-system-adapter.mjs';
import {loadDraftRuntimePlan,runDraftRuntimeRoundtrip,restoreDraftRuntimeRoundtrip,reconcileDraftRuntimeRoundtrip,readDraftBookInfo,DRAFT_RUNTIME_MARKER_HTML} from '../src/draft-runtime-roundtrip.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const bookId=100103,nodeID=1003,recordId=8002,savePath='/edushop/textbook/myproducecommit/editshiti';
const rows=()=>[
  {seqIndex:1,shitiID:8001,nodeID,question:'<p>Neighbour question</p>',answer:'<p>Neighbour answer</p>',mainPicNum:1,answerPicNum:9,haveAnswer:true},
  {seqIndex:2,shitiID:recordId,nodeID,question:'<p style="direction: ltr;">Original question<br>second line</p>',answer:'<p style="direction: ltr;">Original answer</p><p>Second answer.</p>',mainPicNum:2,answerPicNum:9,haveAnswer:true},
];
async function files(t,mutate=()=>{},cleanup=true){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'draft-runtime-roundtrip-'));if(cleanup)t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const baseline={bookId,nodeID,chapterLabel:'Synthetic chapter',sectionLabel:'Synthetic section',serverSnapshotAt:new Date().toISOString(),at:new Date().toISOString(),records:rows()};
  const bytes=Buffer.from(JSON.stringify(baseline));await fs.writeFile(path.join(root,'scope-records.json'),bytes);
  const manifest={schemaVersion:1,kind:'draft-runtime-roundtrip',source:'server-snapshot',bookId,authorization:{source:'direct-user',userQuote:'Use these synthetic draft records for a runtime roundtrip.'},scope:{chapterLabel:baseline.chapterLabel,sectionLabel:baseline.sectionLabel,nodeID},target:{seqIndex:2,shitiID:recordId},baseline:{path:'scope-records.json',sha256:sha(bytes)}};
  mutate(manifest,baseline);await fs.writeFile(path.join(root,'plan.json'),JSON.stringify(manifest));
  return {root,manifest,baseline,statePath:path.join(root,'roundtrip.json'),planPath:path.join(root,'plan.json')};
}
let browserPromise;
after(async()=>{if(browserPromise)await(await browserPromise.catch(()=>null))?.close();});
async function fixture(t,options={}){
  const f=await files(t,undefined,false);let browser;
  try{browserPromise??=chromium.launch({channel:'msedge',headless:true});browser=await browserPromise;}catch{t.skip('Owned localhost browser unavailable');return null;}
  let stored=rows(),draft='草稿';const requests=[],responses=[],basicRequests=[],saveGets=[];
  const server=http.createServer(async(req,res)=>{
    if(req.method==='GET'&&req.url.split('?')[0]===savePath){saveGets.push(req.url);res.writeHead(200,{'Content-Type':'application/json'});res.end('{}');return;}
    if(req.method==='POST'&&req.url===savePath){
      const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks));const count=requests.push(body);
      if(options.wrongRequestId)body.shitiID=9001;
      stored[1]={...stored[1],question:body.question,answer:body.answer};
      if(options.changeNeighbour)stored[0].answer='<p>Changed neighbour</p>';
      if(options.nonDraftAfterTemporary&&count===1)draft='待复审';
      if(options.dropResponseAt&&count>=options.dropResponseAt){res.writeHead(200,{'Content-Type':'application/json'});res.write('{"errno":');setTimeout(()=>res.destroy(),30);return;}
      const reply={errno:options.responseErrno??(options.businessFailure?7:0),errmsg:options.businessFailure?'rejected':'success',data:{seqIndex:options.responseSeqIndex??(options.numericStringIds?'2':2),shitiID:options.responseRecordId??(options.wrongResponseId?9999:options.numericStringIds?String(recordId):recordId),haveAnswer:options.responseHaveAnswer??true}};
      responses.push(reply);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(reply));return;
    }
    if(req.url.startsWith('/edushop/textbook/detail/basicinfo?')){
      basicRequests.push(req.url);res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({errno:0,data:{textbookID:bookId,stateName:options.nonDraft?'待复审':draft,canEdit:options.canEdit??true}}));return;
    }
    if(req.url==='/records'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(stored));return;}
    res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});
    const outboundQuestion=options.wrongOutboundQuestion?JSON.stringify('<p>Unexpected serialized question</p>'):'document.querySelector("#contentedit .w-e-text").innerHTML';
    res.end('<!doctype html><style>.w-e-text{min-height:90px;border:1px solid}</style><input class="el-input__inner" value="2"><input class="el-input__inner" value="9"><div id="contentedit"><div class="w-e-text" contenteditable="true">'+stored[1].question+'</div></div><div id="answeredit"><div class="w-e-text" contenteditable="true">'+stored[1].answer+'</div></div><script>window.basicLoaded=false;fetch("/edushop/textbook/detail/basicinfo?textbookID='+bookId+'").then(r=>r.json()).then(()=>window.basicLoaded=true);document.querySelector("#answeredit .w-e-text").addEventListener("blur",()=>fetch("'+savePath+'",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({textbookID:'+bookId+',nodeID:'+nodeID+',seqIndex:2,shitiID:'+recordId+',mainPicNum:2,answerPicNum:9,question:'+outboundQuestion+',answer:document.querySelector("#answeredit .w-e-text").innerHTML})}).catch(()=>{}));</script>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const origin='http://127.0.0.1:'+server.address().port,context=await browser.newContext();t.after(()=>context.close());
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  const page=await context.newPage();await page.goto(origin+'/edu-shop-web/#/content-manager/teaching-content?textbookID='+bookId+'&textbookType=main');
  const adapter=new NewSystemAdapter({page,baseDir:f.root,origin,source:'fixture',inputMode:'browser-command',timeout:1800});await adapter.connect(bookId);
  adapter._reloadForFreshRead=async()=>{await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.basicLoaded);};
  adapter.read=async(task,{refresh})=>{
    assert.equal(refresh,true);await adapter._reloadForFreshRead();const result=await page.request.get(origin+'/records'),records=await result.json();adapter._directoryRecords=records;adapter._nodeID=nodeID;
    return {status:'found',bookId,recordId:records[1].shitiID,count:records.length,stem:{html:await page.locator('#contentedit .w-e-text').innerHTML()},answer:{html:await page.locator('#answeredit .w-e-text').innerHTML()}};
  };
  const plan=await loadDraftRuntimePlan(f.root,f.planPath);t.after(()=>fs.rm(f.root,{recursive:true,force:true,maxRetries:3,retryDelay:50}));
  return {...f,page,adapter,plan,requests,responses,basicRequests,saveGets,stored:()=>structuredClone(stored)};
}

test('plan rejects non-tail, wrong identity, extra replacement HTML and hash drift',async t=>{
  for(const [name,mutate] of [
    ['non-tail',m=>m.target.seqIndex=1],['identity',m=>m.target.shitiID=999],['arbitrary HTML',m=>m.replacementHTML='<p>Other</p>'],['hash',m=>m.baseline.sha256='0'.repeat(64)],
  ])await t.test(name,async t=>{const f=await files(t,mutate);await assert.rejects(loadDraftRuntimePlan(f.root,f.planPath));});
});

test('two native browser blur POSTs preserve original ID, raw HTML, sources and all neighbours',async t=>{
  const f=await fixture(t);if(!f)return;const events=[];
  const result=await runDraftRuntimeRoundtrip({...f,checkpoint:event=>events.push(event)});
  assert.equal(result.restored,true);assert.equal(result.saveRequests,2);assert.equal(result.originalRecordId,recordId);assert.equal(f.requests.length,2);
  assert.equal(f.requests[0].answer,rows()[1].answer+DRAFT_RUNTIME_MARKER_HTML);assert.equal(f.requests[1].answer,rows()[1].answer);
  for(const body of f.requests)assert.deepEqual([body.textbookID,body.nodeID,body.seqIndex,body.shitiID,body.mainPicNum,body.answerPicNum,body.question],[bookId,nodeID,2,recordId,2,9,rows()[1].question]);
  assert.deepEqual(f.stored(),rows());assert.equal(f.adapter._uncertain,false);assert.equal(f.adapter._pendingWrite,null);
  const journal=JSON.parse(await fs.readFile(f.statePath));assert.equal(journal.stateStatus,'completed');assert.deepEqual(journal.requests.map(row=>row.status),['responded','responded']);assert.deepEqual(journal.requests.map(row=>[row.method,row.pathname]),[['POST',savePath],['POST',savePath]]);assert.ok(f.basicRequests.length>=3);assert.ok(events.some(event=>event.phase==='restore-readback'));
  await assert.rejects(runDraftRuntimeRoundtrip(f),/journal已存在/u);assert.equal(f.requests.length,2);
  const recovery=await reconcileDraftRuntimeRoundtrip(f);assert.equal(recovery.writeUnlocked,true);assert.equal(recovery.recovery.receiptsComplete,true);assert.equal(recovery.writePerformed,false);assert.equal(f.requests.length,2);
});

test('non-draft or non-boolean canEdit rejects before native input and produces no POST',async t=>{
  for(const options of [{nonDraft:true},{canEdit:1},{canEdit:false}])await t.test(JSON.stringify(options),async t=>{const f=await fixture(t,options);if(!f)return;await assert.rejects(runDraftRuntimeRoundtrip(f),/草稿/u);assert.equal(f.requests.length,0);assert.equal(f.adapter._uncertain,false);});
});

test('raw scalar book metadata is diagnostic while write gate remains strict',async t=>{
  const f=await fixture(t,{canEdit:1});if(!f)return;const info=await readDraftBookInfo(f.adapter);assert.equal(info.canEdit,1);assert.equal(info.canEditType,'number');assert.equal(info.stateName,'草稿');assert.equal(f.requests.length,0);
});

test('canonical positive numeric-string response identity matches existing save contract and preserves raw receipt',async t=>{
  const f=await fixture(t,{numericStringIds:true});if(!f)return;const result=await runDraftRuntimeRoundtrip(f);
  assert.equal(f.requests.length,2);assert.deepEqual(f.stored(),rows());assert.equal(result.restored,true);
  for(const receipt of result.receipts){assert.equal(receipt.response.body.data.seqIndex,2);assert.equal(receipt.response.body.data.shitiID,recordId);assert.equal(receipt.response.rawBody.data.seqIndex,'2');assert.equal(receipt.response.rawBody.data.shitiID,String(recordId));}
  assert.equal((await reconcileDraftRuntimeRoundtrip(f)).writeUnlocked,true);
});

test('response identity normalization never weakens business, boolean or canonical integer gates',async t=>{
  for(const options of [{responseErrno:'0'},{responseHaveAnswer:'true'},{responseSeqIndex:true},{responseRecordId:'08002'},{responseRecordId:'8002.0'}])await t.test(JSON.stringify(options),async t=>{
    const f=await fixture(t,options);if(!f)return;await assert.rejects(runDraftRuntimeRoundtrip(f),/回执/u);assert.equal(f.requests.length,1);assert.equal(f.adapter._uncertain,true);
    const journal=JSON.parse(await fs.readFile(f.statePath));assert.equal(journal.requests[0].status,'invalid-response');assert.deepEqual(journal.requests[0].receipt.response.rawBody,f.responses[0]);
    assert.equal((await reconcileDraftRuntimeRoundtrip(f)).writeUnlocked,false);
  });
});

for(const [name,options,outcome] of [
  ['business rejection',{businessFailure:true},'temporary'],
  ['lost temporary response',{dropResponseAt:1},'temporary'],
  ['lost restore response',{dropResponseAt:2},'baseline'],
  ['wrong response ID',{wrongResponseId:true},'temporary'],
  ['neighbour changed',{changeNeighbour:true},'mismatch'],
  ['book leaves draft before restore',{nonDraftAfterTemporary:true},'temporary'],
])test(name+' retains unknown state and never replays a save',async t=>{
  const f=await fixture(t,options);if(!f)return;await assert.rejects(runDraftRuntimeRoundtrip(f));const count=f.requests.length;
  assert.ok(count>0&&count<=2);assert.equal(f.adapter._uncertain,true);assert.equal(f.adapter._pendingWrite.evidencePath,f.statePath);
  await assert.rejects(runDraftRuntimeRoundtrip(f));assert.equal(f.requests.length,count);
  const recovery=await reconcileDraftRuntimeRoundtrip(f);assert.equal(recovery.outcome,outcome);assert.equal(recovery.writeUnlocked,false);assert.equal(recovery.uncertain,true);assert.equal(f.requests.length,count);
});

test('stop after confirmed temporary save performs no restore and read-only reconcile cannot write',async t=>{
  const f=await fixture(t);if(!f)return;let stopping=false;
  await assert.rejects(runDraftRuntimeRoundtrip({...f,stopRequested:()=>stopping,checkpoint:event=>{if(event.phase==='temporary-readback')stopping=true;}}),/停止/u);
  assert.equal(f.requests.length,1);const recovery=await reconcileDraftRuntimeRoundtrip(f);assert.equal(recovery.outcome,'temporary');assert.equal(recovery.writeUnlocked,false);assert.equal(f.requests.length,1);
});

test('explicit restore-only uses continuous live capability once and finishes original two receipts',async t=>{
  const f=await fixture(t);if(!f)return;let stopping=false;
  await assert.rejects(runDraftRuntimeRoundtrip({...f,stopRequested:()=>stopping,checkpoint:event=>{if(event.phase==='temporary-readback')stopping=true;}}));
  const check=await reconcileDraftRuntimeRoundtrip(f);assert.equal(check.recovery.liveRestoreEligible,true);assert.equal(f.requests.length,1);
  const result=await restoreDraftRuntimeRoundtrip(f);assert.equal(result.restored,true);assert.equal(result.receipts.length,2);assert.deepEqual(f.stored(),rows());assert.equal(f.requests.length,2);
  await assert.rejects(restoreDraftRuntimeRoundtrip(f),/连续/u);assert.equal(f.requests.length,2);
});

test('zero native-input precheck rejection unlocks only with same live capability and fresh complete baseline',async t=>{
  const f=await fixture(t,{nonDraft:true});if(!f)return;await assert.rejects(runDraftRuntimeRoundtrip(f));
  const journal=JSON.parse(await fs.readFile(f.statePath));assert.equal(journal.requests.length,0);
  const check=await reconcileDraftRuntimeRoundtrip(f);assert.equal(check.writeUnlocked,true);assert.equal(check.recovery.zeroNativeInputConfirmed,true);assert.equal(f.requests.length,0);
  const second=await reconcileDraftRuntimeRoundtrip(f);assert.equal(second.writeUnlocked,false);assert.equal(second.recovery.zeroNativeInputConfirmed,false);
});

test('late mutation revokes restore capability and page route aborts it before localhost receives it',async t=>{
  const f=await fixture(t);if(!f)return;let stopping=false;
  await assert.rejects(runDraftRuntimeRoundtrip({...f,stopRequested:()=>stopping,checkpoint:event=>{if(event.phase==='temporary-readback')stopping=true;}}));
  await f.page.evaluate(async()=>{await fetch('/edushop/textbook/myproducecommit/editshiti',{method:'POST',body:'{}'}).catch(()=>{});});
  assert.equal(f.requests.length,1);await assert.rejects(restoreDraftRuntimeRoundtrip(f),/连续/u);assert.equal(f.requests.length,1);
});

test('native raw HTML normalization fails before blur and does not dispatch a save',async t=>{
  const f=await fixture(t);if(!f)return;const originalPaste=f.adapter._paste.bind(f.adapter);
  f.adapter._paste=async(...args)=>{await originalPaste(...args);await f.page.locator('#answeredit .w-e-text').evaluate(element=>element.setAttribute('data-fixture-change','yes'));await f.page.locator('#answeredit .w-e-text').evaluate(element=>element.firstElementChild.setAttribute('align','left'));};
  await assert.rejects(runDraftRuntimeRoundtrip(f),/原始HTML/u);assert.equal(f.requests.length,0);assert.deepEqual(f.stored(),rows());
});

test('current-phase serialized HTML mismatch is aborted by route before server mutation',async t=>{
  const f=await fixture(t,{wrongOutboundQuestion:true});if(!f)return;await assert.rejects(runDraftRuntimeRoundtrip(f));
  assert.equal(f.requests.length,0);assert.deepEqual(f.stored(),rows());const journal=JSON.parse(await fs.readFile(f.statePath));assert.equal(journal.requests.length,1);assert.equal(journal.requests[0].dispatchDecision,'aborted');assert.notEqual(journal.requests[0].status,'responded');
  const check=await reconcileDraftRuntimeRoundtrip(f);assert.equal(check.writeUnlocked,false);
});

test('known save endpoint GET is observed and aborted before server dispatch during native input',async t=>{
  const f=await fixture(t);if(!f)return;const originalPaste=f.adapter._paste.bind(f.adapter);
  f.adapter._paste=async(...args)=>{await originalPaste(...args);await f.page.evaluate(async()=>fetch('/edushop/textbook/myproducecommit/editshiti?textbookID=100103').catch(()=>{}));};
  await assert.rejects(runDraftRuntimeRoundtrip(f));assert.equal(f.saveGets.length,0);assert.equal(f.requests.length,0);assert.deepEqual(f.stored(),rows());
  const journal=JSON.parse(await fs.readFile(f.statePath));assert.ok(journal.unexpectedMutations.some(row=>row.method==='GET'&&row.pathname===savePath));assert.equal(f.adapter._uncertain,true);
});

test('a different adapter cannot inherit paused restore capability',async t=>{
  const f=await fixture(t);if(!f)return;let stopping=false;
  await assert.rejects(runDraftRuntimeRoundtrip({...f,stopRequested:()=>stopping,checkpoint:event=>{if(event.phase==='temporary-readback')stopping=true;}}));
  await assert.rejects(restoreDraftRuntimeRoundtrip({...f,adapter:{...f.adapter}}),/连续/u);assert.equal(f.requests.length,1);
  const journal=JSON.parse(await fs.readFile(f.statePath));journal.phase='restore-write-intent';await fs.writeFile(f.statePath,JSON.stringify(journal));
  await assert.rejects(restoreDraftRuntimeRoundtrip(f),/连续/u);assert.equal(f.requests.length,1);
});

test('a forged plan and modified frozen bytes cannot run',async t=>{
  const f=await fixture(t);if(!f)return;await assert.rejects(runDraftRuntimeRoundtrip({...f,plan:structuredClone(f.plan)}),/loadDraftRuntimePlan/u);
  await fs.appendFile(f.planPath,' ');await assert.rejects(runDraftRuntimeRoundtrip(f),/已改变/u);assert.equal(f.requests.length,0);
});
