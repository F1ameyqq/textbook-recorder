import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {NewSystemAdapter} from '../src/new-system-adapter.mjs';
import {installPersistentBridge} from '../src/persistent-recorder-bridge.mjs';

const bookId=100001;
const bookUrl='https://easylearn.baidu.com/edu-shop-web/#/content-manager/teaching-content?textbookID='+bookId+'&textbookType=main';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function rootFixture({directoryRootTimeout=200,directoryTimeout=20,timeout=10,rootDelay=50,rootCount=1}={}){
  const events=[];let reloadedAt;
  const context={newCDPSession:async()=>({send:async()=>({windowId:7,bounds:{windowState:'minimized'}}),detach:async()=>{}})};
  const page=new EventEmitter();page.context=()=>context;page.isClosed=()=>false;page.url=()=>bookUrl;
  page.reload=async options=>{events.push({action:'reload',options});reloadedAt=Date.now();};
  page.locator=selector=>{assert.equal(selector,'.el-tree-node__content');return {first:()=>({evaluateAll:async()=>{
    const visible=Date.now()-reloadedAt>=rootDelay;events.push({action:'root-poll',visible});return {count:visible?rootCount:0,visible:visible&&rootCount>0};
  }})};};
  const adapter=new NewSystemAdapter({page,inputMode:'browser-command',focusMode:'background',windowMode:'minimized',timeout,directoryTimeout,directoryRootTimeout});adapter.bookId=bookId;
  adapter.guard=async()=>{events.push({action:'scope-guard'});};adapter._activate=async()=>{events.push({action:'window-policy'});};
  return {adapter,page,events};
}

test('root directory deadline inherits the existing directory deadline unless explicitly supplied',()=>{
  assert.equal(new NewSystemAdapter().directoryRootTimeout,20000);
  assert.equal(new NewSystemAdapter({timeout:1234}).directoryRootTimeout,1234);
  assert.equal(new NewSystemAdapter({timeout:25,directoryTimeout:60000}).directoryRootTimeout,60000);
  const adapter=new NewSystemAdapter({timeout:25,directoryTimeout:60000,directoryRootTimeout:90000});
  assert.equal(adapter.directoryRootTimeout,90000);assert.equal(adapter.directoryTimeout,60000);assert.equal(adapter.timeout,25);
});

test('root directory deadline strictly rejects invalid or excessive values',()=>{
  for(const directoryRootTimeout of [0,-1,0.1,120001,NaN,Infinity,'90000',null,false])assert.throws(()=>new NewSystemAdapter({directoryRootTimeout}),/directoryRootTimeout/u);
  for(const directoryRootTimeout of [1,90000,120000])assert.doesNotThrow(()=>new NewSystemAdapter({directoryRootTimeout}));
});

test('a late fresh-reload root is accepted under its separate budget without repeating navigation',async()=>{
  const {adapter,events}=rootFixture();adapter._directoryKey='old';adapter._directoryRecords=[{shitiID:1}];adapter._nodeID=2;
  await adapter._reloadForFreshRead();
  assert.equal(events.filter(event=>event.action==='reload').length,1);assert.equal(events.filter(event=>event.action==='window-policy').length,1);
  assert.deepEqual(events.find(event=>event.action==='reload').options,{waitUntil:'commit',timeout:10});
  assert.equal(adapter.directoryTimeout,20);assert.equal(adapter.directoryRootTimeout,200);assert.equal(adapter.timeout,10);
  assert.equal(adapter._directoryKey,null);assert.deepEqual(adapter._directoryRecords,[]);assert.equal(adapter._nodeID,null);
});

test('an absent fresh-reload root stops at its own budget with no additional reload or activation',async()=>{
  const {adapter,events}=rootFixture({directoryRootTimeout:20,directoryTimeout:200,rootDelay:10000});
  await assert.rejects(adapter._reloadForFreshRead(),error=>error.code==='TARGET_VISIBILITY_TIMEOUT'&&error.targetRole==='directory-root'&&error.visibilityDiagnostic.timeout===20);
  assert.equal(events.filter(event=>event.action==='reload').length,1);assert.equal(events.some(event=>event.action==='window-policy'),false);
  assert.equal(adapter.directoryTimeout,200);assert.equal(adapter.timeout,10);
});

test('root budget does not change navigation failure handling or continue into input',async()=>{
  const {adapter,page,events}=rootFixture();page.reload=async options=>{events.push({action:'reload',options});throw new Error('navigation failed');};
  await assert.rejects(adapter._reloadForFreshRead(),/navigation failed/u);
  assert.equal(events.filter(event=>event.action==='reload').length,1);assert.equal(events.some(event=>['root-poll','window-policy'].includes(event.action)),false);
});

async function bridgeFixture(t,{focusMode='background',windowMode='normal',failure}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'directory-root-budget-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  let adapterOptions,reads=0;
  const browser={__textbookRecorderWindowBridge:{prepareNormalWindow:async()=>({tabId:1,windowId:7,windowState:'normal',bookTabActive:true,helperTabActive:false,windowFocused:false,created:false,documentTimeOrigin:1000})}};
  const page={url:()=>bookUrl,bringToFront:async()=>{},evaluate:async()=>true,context:()=>({browser:()=>browser,newCDPSession:async()=>({send:async()=>({windowId:7,bounds:{windowState:'minimized'}}),detach:async()=>{}})})};
  const bridge=await installPersistentBridge({page,config:{root,bookId,focusMode,windowMode},adapterFactory:options=>{
    adapterOptions=options;return {connect:async()=>{},read:async()=>{reads++;if(failure)throw await failure(root);},_directoryRecords:[]};
  }});
  bridge.start({id:'root-budget-probe',action:'probe',args:{chapterLabel:'Synthetic chapter',sectionLabel:'Synthetic section'}});
  const deadline=Date.now()+3000;while(!bridge.status().job.terminal&&Date.now()<deadline)await pause(5);
  const job=bridge.status().job;assert.equal(job.terminal,true);return {root,job,adapterOptions,reads};
}

for(const [focusMode,windowMode,expectedRoot] of [['background','minimized',90000],['background','normal',60000],['foreground','normal',60000]])test(`${focusMode}/${windowMode} bridge changes only the fresh root deadline`,async t=>{
  const {job,adapterOptions,reads}=await bridgeFixture(t,{focusMode,windowMode});
  assert.equal(job.error,undefined);assert.equal(adapterOptions.directoryRootTimeout,expectedRoot);assert.equal(adapterOptions.directoryTimeout,60000);
  assert.equal(adapterOptions.timeout,undefined);assert.equal(reads,1);assert.equal(job.result.writePerformed,false);
});

test('probe failure returns the existing directory diagnostic path and phase without retry or raw fields',async t=>{
  const {root,job,reads}=await bridgeFixture(t,{failure:async root=>{
    const evidencePath=path.join(root,'data/persistent-executor/directory-visibility-diagnostics/root.json');await fs.writeFile(evidencePath,'{}');
    const error=new Error('Synthetic root not visible');Object.assign(error,{code:'TARGET_VISIBILITY_TIMEOUT',targetRole:'directory-root',directoryVisibilityEvidencePath:evidencePath,privatePayload:'never exported'});return error;
  }});
  assert.equal(reads,1);assert.equal(job.result.writePerformed,false);assert.equal(job.result.uncertain,false);assert.equal(job.result.pendingWrite,null);
  assert.deepEqual(job.result.directoryVisibilityDiagnostic,{code:'TARGET_VISIBILITY_TIMEOUT',targetRole:'directory-root',phase:'refresh-directory-root',evidencePath:path.join(root,'data/persistent-executor/directory-visibility-diagnostics/root.json')});
  assert.equal(JSON.stringify(job).includes('never exported'),false);
  const disk=JSON.parse(await fs.readFile(path.join(root,'data/persistent-executor/jobs/root-budget-probe/job-result.json'),'utf8'));
  assert.deepEqual(disk.result.directoryVisibilityDiagnostic,job.result.directoryVisibilityDiagnostic);
});

test('probe diagnostics cannot export an unrelated workspace file or unknown error role',async t=>{
  for(const targetRole of ['directory-root','unrecognized'])await t.test(targetRole,async child=>{
    const {job}=await bridgeFixture(child,{failure:async root=>{const file=path.join(root,'unrelated.json');await fs.writeFile(file,'{}');return Object.assign(new Error('synthetic timeout'),{code:'TARGET_VISIBILITY_TIMEOUT',targetRole,directoryVisibilityEvidencePath:file});}});
    assert.equal(JSON.stringify(job).includes('unrelated.json'),false);
    if(targetRole==='directory-root')assert.deepEqual(job.result.directoryVisibilityDiagnostic,{code:'TARGET_VISIBILITY_TIMEOUT',targetRole,phase:'refresh-directory-root'});
    else assert.equal(job.result.directoryVisibilityDiagnostic,undefined);
  });
});
