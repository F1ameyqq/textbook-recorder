import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import {NewSystemAdapter} from '../src/new-system-adapter.mjs';
import {establishOwnedHeadlessContext} from '../src/owned-headless-browser.mjs';
import {recorderDocumentSnapshot,requireRecorderDocumentReady,waitForRecorderDocumentReady} from '../src/browser-document-state.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const executable=()=>[chromium.executablePath(),path.join(process.env['ProgramFiles(x86)']??'C:/Program Files (x86)','Microsoft/Edge/Application/msedge.exe'),
  path.join(process.env.ProgramFiles??'C:/Program Files','Microsoft/Edge/Application/msedge.exe')].find(value=>existsSync(value));

async function fixture(t,{directoryTimeout=3000}={}){
  const executablePath=executable();if(!executablePath){t.skip('No installed Chromium/Edge executable; no download or visible launch attempted');return null;}
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'recorder-directory-loading-browser-')),profile=path.join(temporary,'owned-profile');await fs.mkdir(profile);
  let loading=false,scriptResponse,gateResolve;const gateRequested=new Promise(resolve=>{gateResolve=resolve;});
  const requests=[],responses=new Set(),server=http.createServer((request,response)=>{
    requests.push({method:request.method,path:request.url});responses.add(response);response.once('close',()=>responses.delete(response));
    response.writeHead(200,{'Content-Type':request.url==='/gate.js'?'text/javascript':'text/html; charset=utf-8','Cache-Control':'no-store'});
    if(request.url==='/gate.js'){scriptResponse=response;gateResolve();return;}
    response.end('<!doctype html><html><head><title>Offline loading fixture</title>'+(loading?'<script src="/gate.js"></script>':'')
      +'</head><body><main id="fixture">unchanged offline fixture</main></body></html>');
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const origin='http://127.0.0.1:'+server.address().port,url=origin+'/edu-shop-web/#/content-manager/teaching-content?textbookID=101&textbookType=main';
  let context;
  t.after(async()=>{for(const response of responses)response.destroy();await context?.close();await new Promise(resolve=>server.close(resolve));
    assert.equal(path.dirname(temporary),path.resolve(os.tmpdir()));assert.ok(path.basename(temporary).startsWith('recorder-directory-loading-browser-'));await fs.rm(temporary,{recursive:true,force:true});});
  context=await chromium.launchPersistentContext(profile,{executablePath,headless:true,args:['--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run']});
  const blocked=[];await context.route('**/*',async route=>{const requested=new URL(route.request().url());
    if(requested.origin===origin&&['/edu-shop-web/','/gate.js','/favicon.ico'].includes(requested.pathname))return route.continue();
    blocked.push(route.request().url());return route.abort('blockedbyclient');});
  const page=context.pages()[0]??await context.newPage();await page.goto(url,{waitUntil:'domcontentloaded'});
  await establishOwnedHeadlessContext(page,{profileDir:await fs.realpath(profile),bindingId:randomUUID()});
  const adapter=new NewSystemAdapter({page,source:'fixture',origin,inputMode:'browser-command',focusMode:'background',windowMode:'headless',timeout:3000,directoryTimeout});adapter.bookId=101;
  const scopes=[];adapter._scopeMatches=async()=>{const state=await page.evaluate(recorderDocumentSnapshot);scopes.push(state);
    assert.ok(['interactive','complete'].includes(state.readyState));assert.equal(state.usable,true);assert.equal(state.visibilityState,'visible');
    throw new Error('synthetic reached original directory scope checks');};
  return {page,context,adapter,url,requests,blocked,scopes,beginLoading:()=>{loading=true;},gateRequested,
    release:()=>{assert.ok(scriptResponse);scriptResponse.end('window.offlineGateLoaded=true;');}};
}

test('real committed reload waits through loading without a body and preserves strict input checks', {timeout:20000},async t=>{
  const f=await fixture(t);if(!f)return;f.beginLoading();
  const outcome=f.adapter.read({id:'synthetic',target:{chapterLabel:'合成章',sectionLabel:'合成节',record:1}},{refresh:true})
    .then(value=>({value}),error=>({error}));
  await f.gateRequested;const committed=await f.page.evaluate(recorderDocumentSnapshot);
  assert.equal(committed.readyState,'loading');assert.equal(committed.usable,false);assert.equal(committed.visibilityState,'visible');
  await assert.rejects(requireRecorderDocumentReady(f.page,{focusMode:'background',windowMode:'headless'}),/not ready for input/u);
  await delay(50);assert.equal(f.scopes.length,0);f.release();
  const result=await outcome;assert.match(result.error?.message??'',/synthetic reached original directory scope checks/u);assert.equal(f.scopes.length,1);
  assert.equal(await f.page.locator('#fixture').textContent(),'unchanged offline fixture');
  assert.ok(f.requests.some(row=>row.path==='/gate.js'));assert.ok(f.requests.every(row=>row.method==='GET'));assert.deepEqual(f.blocked,[]);
});

test('real loading that never becomes interactive consumes only its bounded directory budget', {timeout:20000},async t=>{
  const f=await fixture(t,{directoryTimeout:180});if(!f)return;f.beginLoading();const started=Date.now();
  const outcome=f.adapter.read({id:'synthetic',target:{chapterLabel:'合成章',sectionLabel:'合成节',record:1}},{refresh:true})
    .then(value=>({value}),error=>({error}));
  await f.gateRequested;const result=await outcome;
  assert.equal(result.error?.code,'DOCUMENT_READINESS_TIMEOUT');assert.equal(result.error.documentReadiness.lastState.readyState,'loading');
  assert.equal(result.error.documentReadiness.lastState.usable,false);assert.equal(f.scopes.length,0);assert.ok(Date.now()-started<1500);
  assert.equal(f.adapter.directoryTimeout,180);assert.ok(f.requests.every(row=>row.method==='GET'));f.release();
});

test('a real unowned headless page cannot wait out a loading state to acquire another page identity', {timeout:20000},async t=>{
  const f=await fixture(t);if(!f)return;f.beginLoading();const unowned=await f.context.newPage();await unowned.goto(f.url,{waitUntil:'commit'});await f.gateRequested;
  const state=await unowned.evaluate(recorderDocumentSnapshot);assert.equal(state.readyState,'loading');const started=Date.now();
  await assert.rejects(waitForRecorderDocumentReady(unowned,{focusMode:'background',windowMode:'headless',timeoutMs:3000}),/已证明身份/u);
  assert.ok(Date.now()-started<500);assert.ok(f.requests.every(row=>row.method==='GET'));f.release();
});
