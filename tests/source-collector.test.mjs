import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {collectSourcePages} from '../src/source-collector.mjs';
import {validateRecorderCommand,recorderBookUrl} from '../src/recorder-config.mjs';
import {PersistentRecorderSession} from '../src/persistent-recorder-session.mjs';
import {installPersistentBridge} from '../src/persistent-recorder-bridge.mjs';

const BOOK=101,PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1QAAAAASUVORK5CYII=','base64');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function workspace(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'source-collector-test-'));t.after(async()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('source-collector-test-'));await fs.rm(root,{recursive:true,force:true});});return root;}
function ownedPage({totalPages=2,initial=1,initialSrcPage=initial,refreshBlobEachNavigation=false,freezeSrc=false,unrouteFailure=false,editors=['','<p><br></p>'],wrongBook=false,drift=false,mutation=false,invalidBytes=false}={}){
  let current=initial,generation=0,src=`blob:https://easylearn.baidu.com/page-${initialSrcPage}`,handler=null;const listeners=new Set(),calls={fills:[],presses:[],blobs:[],aborts:0,continues:0,unroutes:0};
  const page={
    url:()=>recorderBookUrl(wrongBook?BOOK+1:BOOK),bringToFront:async()=>{},
    on:(event,listener)=>{assert.equal(event,'request');listeners.add(listener);},off:(event,listener)=>{assert.equal(event,'request');listeners.delete(listener);},
    route:async(pattern,listener)=>{assert.equal(pattern,'**/*');assert.equal(handler,null);handler=listener;},
    unroute:async(pattern,listener)=>{assert.equal(pattern,'**/*');assert.equal(handler,listener);handler=null;calls.unroutes++;if(unrouteFailure)throw new Error('cleanup fixture unroute failed');},
    locator:selector=>{assert.equal(selector,'input.el-input__inner');return {first:()=>({
      fill:async value=>{calls.fills.push(Number(value));current=Number(value);},
      press:async key=>{assert.equal(key,'Tab');calls.presses.push(key);if(!freezeSrc)src=`blob:https://easylearn.baidu.com/page-${current}${refreshBlobEachNavigation?'-navigation-'+(++generation):''}`;if(mutation){const request={url:()=> 'https://easylearn.baidu.com/edushop/textbook/myproducecommit/editshiti',method:()=> 'POST'};listeners.forEach(fn=>fn(request));assert.ok(handler);await handler({request:()=>request,abort:async()=>{calls.aborts++;},continue:async()=>{calls.continues++;}});}}
    })};},
    evaluate:async(_fn,args)=>{
      if(args.operation==='collector-editors')return editors.map(html=>({count:1,html}));
      if(args.operation==='collector-source-snapshot')return {inputCount:2,imageCount:2,page:current,totals:[totalPages,totalPages],src,complete:true,width:1,height:1};
      assert.equal(args.operation,'collector-blob-bytes');assert.equal(args.number,current);assert.equal(args.src,src);calls.blobs.push(current);
      const bytes=invalidBytes?Buffer.from('not an image'):PNG;
      if(drift)src='blob:https://easylearn.baidu.com/changed-after-read';
      return {dataUrl:'data:image/png;base64,'+bytes.toString('base64'),bytes:bytes.length};
    }
  };
  return {page,calls,get current(){return current;},get routed(){return handler!==null;},get listenerCount(){return listeners.size;}};
}
function options(root,page,extra={}){return {page,root,bookId:BOOK,from:1,to:2,output:'data/jobs/fixture-source',timeout:150,...extra};}

test('standard source capture writes OCR-compatible indexed bytes and restores the original page',async t=>{
  const root=await workspace(t),owned=ownedPage(),progress=[];
  const result=await collectSourcePages(options(root,owned.page,{onProgress:async row=>progress.push(row)}));
  assert.equal(result.status,'downloaded');assert.equal(result.downloaded,2);assert.equal(result.writePerformed,false);assert.equal(result.indexPath,path.join(await fs.realpath(root),'data/jobs/fixture-source/index.json'));
  assert.deepEqual(owned.calls.blobs,[1,2]);assert.equal(owned.current,1);assert.equal(owned.routed,false);assert.equal(owned.listenerCount,0);assert.equal(progress.length,2);
  const index=JSON.parse(await fs.readFile(result.indexPath,'utf8'));
  assert.equal(index.system,'teaching-content');assert.equal(index.totalPages,2);assert.equal(index.pages.length,2);
  for(const row of index.pages){assert.equal(row.sha256,sha(PNG));assert.equal(row.bytes,PNG.length);assert.equal(row.width,1);assert.equal(row.height,1);assert.deepEqual(await fs.readFile(path.join(result.outputDirectory,row.file)),PNG);}
  assert.equal(JSON.stringify(result).includes(PNG.toString('base64')),false);
});
test('stale initial page input requires a controlled detour and return before reading authorized bytes',async t=>{
  const root=await workspace(t),owned=ownedPage({initial:2,initialSrcPage:1,refreshBlobEachNavigation:true});
  const result=await collectSourcePages(options(root,owned.page,{from:2,to:2}));
  assert.equal(result.status,'partial');assert.deepEqual(owned.calls.fills,[1,2]);assert.deepEqual(owned.calls.blobs,[2]);assert.equal(owned.current,2);
  const index=JSON.parse(await fs.readFile(result.indexPath,'utf8')),proof=index.pages[0].navigationProof;
  assert.equal(index.pages[0].systemPage,2);assert.equal(proof.kind,'controlled-source-navigation');assert.deepEqual(proof.steps.map(step=>[step.fromPage,step.toPage]),[[2,1],[1,2]]);
  for(const step of proof.steps){assert.notEqual(step.fromBlobSrcSha256,step.toBlobSrcSha256);assert.ok(Date.parse(step.loadedAt)>=Date.parse(step.startedAt));}
  await assert.rejects(fs.stat(path.join(result.outputDirectory,'images/page-0001.png')),{code:'ENOENT'});
});
test('unchanged source blob and single-page books fail closed instead of trusting the page input',async t=>{
  const root=await workspace(t);
  for(const [name,setup,pattern] of [['stale',{initial:2,initialSrcPage:1,freezeSrc:true},/新图片身份等待超时/u],['single',{totalPages:1},/单页书.*证明/u]]){
    const owned=ownedPage(setup);await assert.rejects(collectSourcePages(options(root,owned.page,{from:setup.initial??1,to:setup.initial??1,output:'data/jobs/'+name})),pattern);
    assert.deepEqual(owned.calls.blobs,[]);const index=JSON.parse(await fs.readFile(path.join(root,'data/jobs',name,'index.json'),'utf8'));assert.equal(index.status,'paused');assert.deepEqual(index.pages,[]);assert.equal(index.failures.length,1);
  }
});
test('cleanup failure preserves the primary capture error and its paused collection evidence',async t=>{
  const root=await workspace(t),owned=ownedPage({drift:true,unrouteFailure:true});let failure;
  try{await collectSourcePages(options(root,owned.page));assert.fail('capture must reject');}catch(error){failure=error;}
  assert.match(failure.message,/读取前后.*不一致/u);assert.match(failure.cleanupError,/cleanup fixture/u);assert.equal(failure.collection.paused,true);assert.equal(failure.collection.status,'paused');assert.equal(failure.collection.indexPath,path.join(await fs.realpath(root),'data/jobs/fixture-source/index.json'));
  const index=JSON.parse(await fs.readFile(failure.collection.indexPath,'utf8'));assert.equal(index.status,'paused');assert.equal(index.pages.length,0);assert.equal(index.failures.length,2);assert.match(index.failures[0].message,/不一致/u);assert.equal(index.failures[1].phase,'cleanup');assert.equal(owned.listenerCount,0);
});
test('successful capture followed by cleanup failure reports paused rather than successful collection',async t=>{
  const root=await workspace(t),owned=ownedPage({unrouteFailure:true});let failure;
  try{await collectSourcePages(options(root,owned.page));assert.fail('cleanup failure must reject');}catch(error){failure=error;}
  assert.match(failure.message,/清理失败/u);assert.match(failure.cleanupError,/cleanup fixture/u);assert.equal(failure.collection.status,'paused');assert.equal(failure.collection.paused,true);assert.equal(failure.collection.downloaded,2);
  const index=JSON.parse(await fs.readFile(failure.collection.indexPath,'utf8'));assert.equal(index.status,'paused');assert.equal(index.pages.length,2);assert.equal(index.failures.length,1);assert.equal(index.failures[0].phase,'cleanup');
});
test('resume validates cached hashes and recollects a corrupt owned image without changing other pages',async t=>{
  const root=await workspace(t),first=await collectSourcePages(options(root,ownedPage().page));
  const cached=ownedPage(),resumed=await collectSourcePages(options(root,cached.page));assert.equal(resumed.skipped,2);assert.equal(resumed.downloaded,0);assert.deepEqual(cached.calls.blobs,[]);
  await fs.writeFile(path.join(first.outputDirectory,'images/page-0002.png'),'corrupt');
  const repaired=ownedPage(),result=await collectSourcePages(options(root,repaired.page));assert.equal(result.skipped,1);assert.equal(result.downloaded,1);assert.deepEqual(repaired.calls.blobs,[2]);
  assert.equal(sha(await fs.readFile(path.join(first.outputDirectory,'images/page-0002.png'))),sha(PNG));
});
test('dirty or nonempty editors reject collection before source navigation and file output',async t=>{
  const root=await workspace(t);
  for(const html of ['<p>unsaved</p>','<p>\u00a0</p>','<p><img src="x"></p>','<p></p><p></p>']){
    const owned=ownedPage({editors:[html,'']});await assert.rejects(collectSourcePages(options(root,owned.page)),/编辑器都为空/u);
    assert.deepEqual(owned.calls.fills,[]);assert.deepEqual(owned.calls.blobs,[]);
  }
  await assert.rejects(fs.stat(path.join(root,'data/jobs')),{code:'ENOENT'});
});
test('wrong book and out-of-bounds ranges stop without reading bytes',async t=>{
  const root=await workspace(t),wrong=ownedPage({wrongBook:true});await assert.rejects(collectSourcePages(options(root,wrong.page)),/书籍录入页/u);assert.deepEqual(wrong.calls.blobs,[]);
  const bounds=ownedPage();await assert.rejects(collectSourcePages(options(root,bounds.page,{to:3})),/页段超出/u);assert.deepEqual(bounds.calls.fills,[]);
  await assert.rejects(fs.stat(path.join(root,'data/jobs')),{code:'ENOENT'});
});
test('changed source identity and invalid file signature reject captured bytes and persist a paused index',async t=>{
  const root=await workspace(t);
  for(const [name,extra,pattern] of [['drift',{drift:true},/不一致/u],['bad',{invalidBytes:true},/签名/u]]){
    const owned=ownedPage(extra);await assert.rejects(collectSourcePages(options(root,owned.page,{output:'data/jobs/'+name})),pattern);
    const index=JSON.parse(await fs.readFile(path.join(root,'data/jobs',name,'index.json'),'utf8'));assert.equal(index.status,'paused');assert.equal(index.pages.length,0);assert.equal(index.failures.length,1);assert.equal(owned.routed,false);assert.equal(owned.listenerCount,0);
  }
});
test('same-page mutation requests are aborted and stop collection before any image is accepted',async t=>{
  const root=await workspace(t),owned=ownedPage({initial:2,mutation:true});
  await assert.rejects(collectSourcePages(options(root,owned.page)),/写请求/u);
  assert.equal(owned.calls.aborts,1);assert.equal(owned.calls.continues,0);assert.deepEqual(owned.calls.blobs,[]);
  const index=JSON.parse(await fs.readFile(path.join(root,'data/jobs/fixture-source/index.json'),'utf8'));assert.equal(index.pages.length,0);assert.equal(index.blockedWrites.length,1);assert.equal(index.blockedWrites[0].method,'POST');assert.equal(owned.routed,false);
});
test('foreign output junctions and cached image junctions cannot read or write outside the collection directory',async t=>{
  const root=await workspace(t),outside=await workspace(t);await fs.mkdir(path.join(root,'data/jobs'),{recursive:true});
  await fs.symlink(outside,path.join(root,'data/jobs/escape'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(collectSourcePages(options(root,ownedPage().page,{output:'data/jobs/escape'})),/项目|越出|越界/u);assert.deepEqual(await fs.readdir(outside),[]);
  const first=await collectSourcePages(options(root,ownedPage().page));
  const sourceImages=path.join(first.outputDirectory,'images');await fs.rename(sourceImages,path.join(first.outputDirectory,'original-images'));
  await fs.writeFile(path.join(outside,'page-0001.png'),PNG);await fs.symlink(outside,sourceImages,process.platform==='win32'?'junction':'dir');
  await assert.rejects(collectSourcePages(options(root,ownedPage().page)),/项目/u);assert.deepEqual(await fs.readdir(outside),['page-0001.png']);
});
test('internal data/jobs redirects and job aliases are rejected while project-root aliases remain valid',async t=>{
  const root=await workspace(t),redirect=path.join(root,'internal-jobs');await fs.mkdir(path.join(root,'data'),{recursive:true});await fs.mkdir(redirect);await fs.symlink(redirect,path.join(root,'data/jobs'),process.platform==='win32'?'junction':'dir');
  const owned=ownedPage();await assert.rejects(collectSourcePages(options(root,owned.page)),/越界|真实 data\/jobs/u);assert.deepEqual(owned.calls.blobs,[]);assert.deepEqual(await fs.readdir(redirect),[]);
  const project=await workspace(t);await fs.mkdir(path.join(project,'data/jobs/actual'),{recursive:true});await fs.symlink(path.join(project,'data/jobs/actual'),path.join(project,'data/jobs/alias'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(collectSourcePages(options(project,ownedPage().page,{output:'data/jobs/alias'})),/子 junction/u);assert.deepEqual(await fs.readdir(path.join(project,'data/jobs/actual')),[]);
  const holder=await workspace(t),alias=path.join(holder,'project-alias');await fs.symlink(project,alias,process.platform==='win32'?'junction':'dir');
  const result=await collectSourcePages(options(alias,ownedPage().page));assert.equal(result.indexPath,path.join(await fs.realpath(project),'data/jobs/fixture-source/index.json'));assert.equal(result.downloaded,2);
});
test('a malformed prior index is not overwritten and explicit pause leaves a resumable index',async t=>{
  const root=await workspace(t),directory=path.join(root,'data/jobs/fixture-source');await fs.mkdir(directory,{recursive:true});const malformed='{"bookId":999}';await fs.writeFile(path.join(directory,'index.json'),malformed);
  await assert.rejects(collectSourcePages(options(root,ownedPage().page)),/已有原图索引/u);assert.equal(await fs.readFile(path.join(directory,'index.json'),'utf8'),malformed);
  const result=await collectSourcePages(options(root,ownedPage().page,{output:'data/jobs/paused',stopRequested:()=>true}));assert.equal(result.paused,true);assert.equal(result.status,'paused');assert.equal(result.downloaded,0);
});
test('one page cannot run two collectors, and navigation safety failure does not create output',async t=>{
  const root=await workspace(t),owned=ownedPage();let release;const hold=new Promise(resolve=>{release=resolve;});let entered;const started=new Promise(resolve=>{entered=resolve;});
  const running=collectSourcePages(options(root,owned.page,{guardNavigation:async()=>{entered();await hold;}}));await started;
  await assert.rejects(collectSourcePages(options(root,owned.page)),/已有原图采集/u);release();await running;
  await assert.rejects(collectSourcePages(options(root,ownedPage().page,{output:'data/jobs/blocked',guardNavigation:async()=>{throw new Error('pending save');}})),/pending save/u);
  await assert.rejects(fs.stat(path.join(root,'data/jobs/blocked')),{code:'ENOENT'});
});
test('typed collect validates only explicit page-range/output fields and a session save lock prevents dispatch',async t=>{
  const root=await workspace(t);assert.deepEqual(validateRecorderCommand({action:'collect',args:{from:1,to:2}},root).args,{from:1,to:2});
  for(const args of [{from:1},{from:2,to:1},{from:1,to:2,manifest:'data/a.json'},{from:1,to:2,output:'../outside'},{from:1,to:2,output:'data/jobs/a/nested'}])assert.throws(()=>validateRecorderCommand({action:'collect',args},root));
  let connections=0;const session=new PersistentRecorderSession({root,bookId:BOOK,connect:async()=>{connections++;throw new Error('must not connect');}});await session.initialize();session.state.writeBlocked=true;
  await assert.rejects(session.command({action:'collect',args:{from:1,to:2}}),/写入锁/u);assert.equal(connections,0);assert.equal(session.state.writeBlocked,true);assert.equal(session.state.pending,null);await session.close();
});
test('typed bridge collects without a manifest and emits only summary/job evidence',async t=>{
  const root=await workspace(t),owned=ownedPage(),adapter={_busy:false,_uncertain:false,connect:async()=>{}};
  const bridge=await installPersistentBridge({page:owned.page,config:{root,bookId:BOOK},adapterFactory:()=>adapter});bridge.start({id:'owned-collect',action:'collect',args:{from:1,to:2}});
  const deadline=Date.now()+3000;let state;do{state=bridge.status();if(state.job?.terminal)break;await new Promise(resolve=>setTimeout(resolve,5));}while(Date.now()<deadline);
  assert.equal(state.job.terminal,true);assert.equal(state.job.error,undefined);assert.equal(state.job.result.status,'downloaded');assert.equal(state.job.result.writePerformed,false);assert.equal(state.job.result.indexPath,path.join(await fs.realpath(root),'data/jobs/owned-collect/index.json'));assert.equal(JSON.stringify(state).includes(PNG.toString('base64')),false);
});
