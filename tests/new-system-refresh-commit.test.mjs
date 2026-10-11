import test from 'node:test';
import assert from 'node:assert/strict';
import {NewSystemAdapter} from '../src/new-system-adapter.mjs';
import {chromium} from 'playwright';
import http from 'node:http';

function fake({error=null,wrongAfter=false}={}) {
  let guards=0,calls=0,front=0;
  const page={url:()=>'',context:()=>({}),isClosed:()=>false,on:()=>{},reload:async options=>{
    calls++;assert.deepEqual(options,{waitUntil:'commit',timeout:1500});
    assert.equal(adapter._directoryKey,null);assert.deepEqual(adapter._directoryRecords,[]);assert.equal(adapter._nodeID,null);
    if(error)throw error;
  },bringToFront:async()=>{front++;},evaluate:async()=>true};
  const adapter=new NewSystemAdapter({page,timeout:1500,inputMode:'browser-command'});
  adapter.guard=async({waitForEditors})=>{guards++;assert.equal(waitForEditors,false);if(wrongAfter&&calls)throw new Error('页面书ID改变');};
  adapter._directoryKey='old';adapter._directoryRecords=[{seqIndex:1}];adapter._nodeID=99;
  return {adapter,counts:()=>({guards,calls,front})};
}

test('refresh waits for a commit and discards the old server cache before navigation',async()=>{
  const f=fake();await f.adapter._reloadForFreshRead();assert.equal(f.counts().calls,1);assert.equal(f.counts().front,1);assert.ok(f.counts().guards>=2);
});
test('a failed navigation is not swallowed and cannot restore or use the old cache',async()=>{
  const failure=new Error('navigation failed'),f=fake({error:failure});
  await assert.rejects(f.adapter._reloadForFreshRead(),error=>error===failure);
  assert.deepEqual(f.counts(),{guards:1,calls:1,front:0});assert.deepEqual(f.adapter._directoryRecords,[]);
});
test('the post-commit book guard remains mandatory',async()=>{
  const f=fake({wrongAfter:true});await assert.rejects(f.adapter._reloadForFreshRead(),/书ID改变/u);
  assert.deepEqual(f.counts(),{guards:2,calls:1,front:0});
});

test('minimized reload binds its window only after the new directory becomes visible',async()=>{
  const f=fake(),events=[];let polls=0;
  f.adapter.focusMode='background';f.adapter.windowMode='minimized';
  f.adapter.page.locator=selector=>{
    assert.equal(selector,'.el-tree-node__content');
    return {first:()=>({evaluateAll:async()=>{
      events.push('directory');polls++;return {count:polls>1?1:0,visible:polls>1};
    }})};
  };
  f.adapter._activate=async()=>{assert.ok(polls>1);events.push('window');};
  await f.adapter._reloadForFreshRead();
  assert.deepEqual(events,['directory','directory','window']);
  assert.deepEqual(f.adapter._directoryRecords,[]);
});

test('missing refreshed directory prevents minimized window binding and cached reads',async()=>{
  const f=fake();let windowCalls=0;
  f.adapter.focusMode='background';f.adapter.windowMode='minimized';f.adapter.directoryTimeout=1;
  f.adapter.page.locator=()=>({first:()=>({evaluateAll:async()=>({count:0,visible:false})})});
  f.adapter._activate=async()=>{windowCalls++;};
  await assert.rejects(f.adapter._reloadForFreshRead(),error=>error.code==='TARGET_VISIBILITY_TIMEOUT');
  assert.equal(windowCalls,0);assert.equal(f.adapter._directoryKey,null);assert.deepEqual(f.adapter._directoryRecords,[]);
});

test('real committed reload can read visible DOM and a fresh server response while DOMContentLoaded is blocked',async t=>{
  let browser;try{browser=await chromium.launch({channel:'msedge',headless:true});}catch{t.skip('Edge unavailable');return;}
  t.after(()=>browser.close());
  const sockets=new Set();let listReads=0,visits=0;
  const server=http.createServer((request,response)=>{
    if(request.url==='/blocking.js')return; // An unfinished parser-blocking request.
    if(request.url==='/list'){listReads++;response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({recordId:77,visits}));return;}
    visits++;response.writeHead(200,{'Content-Type':'text/html'});
    response.end(`<button id="directory" onclick="fetch('/list').then(r=>r.json()).then(v=>document.querySelector('#record').textContent=v.recordId)">actual directory</button><p id="record"></p><script src="/blocking.js"></script>`);
  });
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{for(const socket of sockets)socket.destroy();server.close();});
  const page=await browser.newPage(),url=`http://127.0.0.1:${server.address().port}/`;
  await page.goto(url,{waitUntil:'commit'});
  await page.locator('#directory').waitFor({state:'visible'});
  const before=await page.evaluate(()=>performance.timeOrigin);
  await page.reload({waitUntil:'commit',timeout:1500});
  await page.locator('#directory').waitFor({state:'visible'});
  assert.notEqual(await page.evaluate(()=>performance.timeOrigin),before);
  assert.equal(await page.evaluate(()=>document.readyState),'loading');
  const response=page.waitForResponse(response=>response.url().endsWith('/list'));
  await page.locator('#directory').click();
  assert.equal((await(await response).json()).recordId,77);assert.equal(listReads,1);assert.equal(visits,2);
  await page.locator('#record').waitFor({state:'visible'});assert.equal(await page.locator('#record').textContent(),'77');
});
