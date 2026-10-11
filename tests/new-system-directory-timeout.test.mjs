import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {NewSystemAdapter} from '../src/new-system-adapter.mjs';
import {installPersistentBridge} from '../src/persistent-recorder-bridge.mjs';

const bookId=100001;
const origin='https://easylearn.baidu.com';
const bookUrl=origin+'/edu-shop-web/#/content-manager/teaching-content?textbookID='+bookId+'&textbookType=main';
const target={chapterLabel:'Synthetic chapter',sectionLabel:'Synthetic training',record:1,expectedRecordId:1001};
const task={id:'synthetic-directory-timeout',target,source:{pages:[1],answerPages:[9]}};
const record={seqIndex:1,shitiID:1001,nodeID:2001,question:'<p>Original question</p>',answer:'<p>Original answer</p>',mainPicNum:1,answerPicNum:9,haveAnswer:true};

/** Pure directory/list page double, never attached to a browser. Timer polls,
 * LIST request ordering, response validation and scope checks run in the real
 * adapter. Only pointer dispatch and the final editor content are isolated.
 */
function fixture({timeout=400,directoryTimeout=1000,chapterDelay=0,sectionDelay=0,chapterCount=1,scopeChanged=false,wrongRecordId=false,businessFailure=false,clickCheckDelay=0}={}){
  const events=[],listeners=new Map();
  const started=Date.now();let selected=false,waiter=null;
  const responseFor=(request,rows=[record])=>({request:()=>request,url:request.url,ok:()=>true,json:async()=>({errno:businessFailure?1:0,errmsg:businessFailure?'failed':'success',data:rows})});
  const request={method:()=> 'GET',url:()=>origin+'/edushop/textbook/detail/shitilist?textbookID='+bookId+'&nodeID=2001'};
  const staleRequest={method:()=> 'GET',url:request.url};
  const emit=(name,value)=>{for(const callback of listeners.get(name)??[])callback(value);};
  const visibleState=(role,delay,count)=>{
    const visible=Date.now()-started>=delay;
    events.push({kind:role+'-poll',at:Date.now()-started,visible});
    return {count:visible?count:0,visible:visible&&count>0};
  };
  const chapter={
    count:async()=>chapterCount,
    evaluateAll:async()=>visibleState('chapter',chapterDelay,chapterCount),
    locator:selector=>{assert.equal(selector,'xpath=..');return chapterNode;},
  };
  const section={
    count:async()=>1,
    evaluateAll:async()=>visibleState('section',sectionDelay,1),
    click:async()=>{
      events.push({kind:'select-section',at:Date.now()-started});selected=true;
      assert.ok(listeners.get('response')?.length,'LIST observer must be installed before the section click');
      emit('request',request);
      const response=responseFor(request,[wrongRecordId?{...record,shitiID:1002}:record]);
      emit('response',response);
      if(clickCheckDelay)await new Promise(resolve=>setTimeout(resolve,clickCheckDelay));
    },
  };
  const chapterNode={evaluate:async()=>true,locator:selector=>{
    assert.equal(selector,'.el-tree-node__content');
    return {filter:({hasText})=>{assert.ok(hasText.test(target.sectionLabel));return section;}};
  }};
  const page={
    context:()=>({}),isClosed:()=>false,url:()=>bookUrl,bringToFront:async()=>{},
    on:(name,callback)=>{if(!listeners.has(name))listeners.set(name,[]);listeners.get(name).push(callback);if(name==='response'){events.push({kind:'wait-list',options:{timeout}});emit('response',responseFor(staleRequest));const wrongBook={method:()=> 'GET',url:()=>request.url().replace('textbookID='+bookId,'textbookID=999999')};emit('request',wrongBook);emit('response',responseFor(wrongBook));}},
    off:(name,callback)=>{listeners.set(name,(listeners.get(name)??[]).filter(value=>value!==callback));},
    reload:async options=>{events.push({kind:'reload',options});selected=false;},
    locator:selector=>{
      if(selector==='.el-tree-node__content')return {filter:({hasText})=>{assert.ok(hasText.test(target.chapterLabel));return chapter;}};
      assert.ok(['#contentedit .w-e-text','#answeredit .w-e-text'].includes(selector));
      return {evaluateAll:async()=>{assert.ok(selected,'editor visibility must only be awaited after section selection');return {count:1,visible:true};}};
    },
    evaluate:async fn=>{
      if(fn.toString().includes('.shiti-cont .shiti-sort'))return {numbers:selected?[1]:[],loading:false};
      return selected?{chapterLabel:scopeChanged?'Another chapter':target.chapterLabel,sectionLabel:target.sectionLabel}:{chapterLabel:'',sectionLabel:''};
    },
    waitForResponse:(predicate,options)=>{
      events.push({kind:'wait-list',options});
      assert.equal(predicate(responseFor(staleRequest)),false,'old observed LIST is not a fresh response');
      const wrongBook={url:()=>request.url().replace('textbookID='+bookId,'textbookID=999999')};
      emit('request',wrongBook);assert.equal(predicate(responseFor(wrongBook)),false,'another book LIST must reject');
      return new Promise(resolve=>{waiter={predicate,resolve};});
    },
  };
  const adapter=new NewSystemAdapter({page,timeout,directoryTimeout,inputMode:'browser-command'});adapter.bookId=bookId;
  emit('request',staleRequest);
  adapter._click=async locator=>{await adapter.guard({waitForEditors:false});await locator.click();};
  adapter._selectRecord=async found=>{assert.equal(found.shitiID,1001);events.push({kind:'select-record'});};
  adapter._editorRead=async selector=>({html:selector.startsWith('#contentedit')?record.question:record.answer,images:[]});
  return {adapter,page,events};
}

test('directory timeout defaults to the ordinary timeout and explicit override does not change it',()=>{
  const implicit=new NewSystemAdapter();assert.equal(implicit.timeout,20000);assert.equal(implicit.directoryTimeout,20000);
  const inherited=new NewSystemAdapter({timeout:1200});assert.equal(inherited.directoryTimeout,1200);
  const configured=new NewSystemAdapter({timeout:400,directoryTimeout:60000});assert.equal(configured.directoryTimeout,60000);assert.equal(configured.timeout,400);
});

test('directory timeout rejects unsafe, noninteger, nonpositive and excessive values',()=>{
  for(const directoryTimeout of [0,-1,0.5,NaN,Infinity,120001,Number.MAX_SAFE_INTEGER+1,'60000',null,false])assert.throws(()=>new NewSystemAdapter({directoryTimeout}));
  assert.doesNotThrow(()=>new NewSystemAdapter({directoryTimeout:1}));
  assert.doesNotThrow(()=>new NewSystemAdapter({directoryTimeout:120000}));
});

for(const role of ['chapter','section'])test(`a ${role} appearing after the ordinary timeout is accepted only after a unique scope and fresh LIST`,async()=>{
  const f=fixture({[role+'Delay']:450});
  const found=await f.adapter.read(task);
  assert.equal(found.status,'found');assert.equal(found.recordId,1001);assert.equal(found.count,1);
  assert.equal(f.adapter._nodeID,2001);assert.equal(f.adapter._directoryKey,JSON.stringify([target.chapterLabel,target.sectionLabel]));
  const visible=f.events.find(event=>event.kind===role+'-poll'&&event.visible);
  assert.ok(visible.at>f.adapter.timeout,'target must actually appear later than the ordinary timeout');
  const waitIndex=f.events.findIndex(event=>event.kind==='wait-list'),clickIndex=f.events.findIndex(event=>event.kind==='select-section');
  assert.ok(waitIndex>=0&&waitIndex<clickIndex);
  assert.equal(f.events[waitIndex].options.timeout,400,'the network LIST deadline remains unchanged');
  assert.deepEqual(f.adapter._directoryRecords.map(row=>row.shitiID),[1001]);
});

test('a directory still absent at its own deadline stops without a LIST wait or record selection',async()=>{
  const f=fixture({timeout:1000,directoryTimeout:120,chapterDelay:10000});
  await assert.rejects(f.adapter.read(task),error=>error.code==='TARGET_VISIBILITY_TIMEOUT'&&error.targetRole==='directory-chapter'&&error.visibilityDiagnostic.timeout===120);
  assert.equal(f.events.some(event=>['wait-list','select-section','select-record'].includes(event.kind)),false);
  assert.equal(f.adapter._directoryKey,null);assert.deepEqual(f.adapter._directoryRecords,[]);
});

test('fresh LIST received during lengthy guarded click is retained without spending its response deadline',async()=>{
  const f=fixture({timeout:400,directoryTimeout:1000,clickCheckDelay:550});
  const found=await f.adapter.read(task);assert.equal(found.recordId,1001);assert.equal(f.adapter.timeout,400);
  assert.equal(f.events.filter(event=>event.kind==='select-section').length,1);
});

test('a longer directory deadline does not permit duplicate chapters or invalid scope, business response or target ID',async t=>{
  for(const [name,options,pattern] of [
    ['duplicate chapter',{chapterCount:2},/唯一/u],
    ['scope changed after click',{scopeChanged:true},/目录已改变/u],
    ['LIST business error',{businessFailure:true},/业务响应/u],
    ['different persisted ID',{wrongRecordId:true},/其他服务器 ID/u],
  ])await t.test(name,async()=>{
    const f=fixture(options);await assert.rejects(f.adapter.read(task),pattern);
    assert.equal(f.events.some(event=>event.kind==='select-record'),false);
  });
});

test('navigation and save response continue using the ordinary timeout after directory override',async()=>{
  const f=fixture({timeout:40,directoryTimeout:300});
  await f.adapter._reloadForFreshRead();
  const navigation=f.events.find(event=>event.kind==='reload');
  assert.deepEqual(navigation.options,{waitUntil:'commit',timeout:40});
  const save=f.adapter._captureSaveResponse();
  await assert.rejects(save.wait(),error=>error.code==='SAVE_RESPONSE_TIMEOUT'&&error.message.includes('Timeout 40ms'));
  assert.equal(f.adapter.timeout,40);assert.equal(f.adapter.directoryTimeout,300);
});

test('production bridge explicitly gives its adapter a 60-second directory deadline without a global override',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'recorder-directory-timeout-'));
  t.after(async()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('recorder-directory-timeout-'));await fs.rm(root,{recursive:true,force:true});});
  let options;
  const page={url:()=>bookUrl,bringToFront:async()=>{}};
  const bridge=await installPersistentBridge({page,config:{root,bookId,focusMode:'background',windowMode:'normal'},adapterFactory:value=>{options=value;return {connect:async()=>{},bookId};}});
  bridge.start({id:'owned-directory-timeout-config',action:'probe'});
  const deadline=Date.now()+3000;
  while(!bridge.status().job.terminal&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));
  const job=bridge.status().job;assert.equal(job.terminal,true);assert.equal(job.error,undefined);
  assert.equal(options.directoryTimeout,60000);assert.equal(options.timeout,undefined);
  assert.equal(job.result.writePerformed,false);
});
