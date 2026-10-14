import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {PersistentRecorderSession} from '../src/persistent-recorder-session.mjs';
import {installPersistentBridge} from '../src/persistent-recorder-bridge.mjs';
import {recorderBookUrl} from '../src/recorder-config.mjs';

const BOOK=101;
async function terminal(session){const deadline=Date.now()+5000;for(;;){const status=await session.status();if(status.error)throw new Error(status.error);if(!status.pending)return status;if(Date.now()>deadline)throw new Error('Synthetic task did not terminate');await new Promise(resolve=>setTimeout(resolve,5));}}
async function fixture(t,{existing=true,focusMode='background',windowMode=focusMode==='background'?'minimized':'normal',loseStart=false,loseBind=false}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'recorder-background-binding-'));
  t.after(async()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('recorder-background-binding-'));await fs.rm(root,{recursive:true,force:true});});
  await fs.mkdir(path.join(root,'src'));
  const actualBridge=new URL('../src/persistent-recorder-bridge.mjs',import.meta.url).href,actualConfig=new URL('../src/recorder-config.mjs',import.meta.url).href;
  await fs.writeFile(path.join(root,'src/persistent-recorder-bridge.mjs'),`import {installPersistentBridge as install} from ${JSON.stringify(actualBridge)}; export function installPersistentBridge(options){return install({...options,adapterFactory:config=>{options.page.factoryOptions.push(config);return options.page.fakeAdapter;}});}`);
  await fs.writeFile(path.join(root,'src/recorder-config.mjs'),`export {assertRecorderPage} from ${JSON.stringify(actualConfig)};`);
  const calls=[],connections=[],live=new Set(),fronts=[],closed=[],windowCalls=[];let sequence=0,connects=0;
  const connect=async bridgePath=>{
    connects++;const pages=[],callbacks=[],servicePid=60000+connects;live.add(servicePid);let current;
    const context={pages:()=>pages,newCDPSession:async target=>({send:async(action,args)=>{windowCalls.push({pageId:target.id,action,args});if(action==='Browser.getWindowForTarget')return {windowId:target.id,bounds:{windowState:target.windowState}};if(args?.windowId!==target.id)throw new Error('Wrong synthetic window');if(action==='Browser.setWindowBounds'){target.windowState=args.bounds.windowState;return {};}if(action==='Browser.getWindowBounds')return {bounds:{windowState:target.windowState}};throw new Error('Unexpected synthetic CDP command');},detach:async()=>{}})};
    const makePage=(address,{withBridge=false,bridgeMode=focusMode,bridgeWindowMode=windowMode}={})=>{
      const editor=()=>({textContent:'',innerText:'',querySelectorAll:()=>[]});
      const page={id:++sequence,address,closed:false,windowState:'normal',factoryOptions:[],reads:0,appends:0,editors:{'#contentedit .w-e-text':editor(),'#answeredit .w-e-text':editor()},url(){return this.address;},isClosed(){return this.closed;},context:()=>context,bringToFront:async()=>{fronts.push(page.id);current=page;},evaluate:async fn=>vm.runInNewContext('('+fn.toString()+')()',{document:{visibilityState:'visible',querySelector:selector=>page.editors[selector]}}),close:async()=>{closed.push(page.id);page.closed=true;pages.splice(pages.indexOf(page),1);if(current===page)current=pages[0];}};
      page.fakeAdapter={source:'production',bookId:BOOK,connect:async()=>{},read:async()=>{page.reads++;return {status:'missing',bookId:BOOK};},append:async()=>{page.appends++;throw new Error('No platform writes in this synthetic fixture');}};
      if(withBridge)page.__persistentRecorder={status:()=>({bookId:BOOK,focusMode:bridgeMode,windowMode:bridgeWindowMode,job:null})};
      pages.push(page);return page;
    };
    current=makePage('https://example.test/other-work');if(existing)makePage(recorderBookUrl(BOOK));
    const bootstrap={};Function('exports',await fs.readFile(bridgePath,'utf8'))(bootstrap);await bootstrap.default({page:current});
    assert.equal(current.__persistentRecorder,undefined,'Bootstrap must not attach a bridge to unrelated work');
    const connection={servicePid,authConfigured:true,pages,makePage,get current(){return current;},set current(value){current=value;},onClosed:callback=>callbacks.push(callback),disconnect(){live.delete(servicePid);callbacks.forEach(callback=>callback());},close:async()=>{live.delete(servicePid);callbacks.forEach(callback=>callback());},client:{listTools:async()=>({tools:[{name:'browser_tabs',inputSchema:{properties:{action:{enum:['list','new','select','close']}}}},{name:'browser_run_code_unsafe',inputSchema:{properties:{code:{type:'string'}}}}]}),callTool:async({name,arguments:args})=>{
      calls.push({name,...args});let result;
      if(name==='browser_tabs'){if(args.action==='new'){const created=makePage('about:blank');await bootstrap.default({page:created});created.address=args.url;}if(args.action==='select'){current=pages[args.index];await current.bringToFront();}result={tabs:pages.map((page,index)=>({index,url:page.url()}))};}
      else if(name==='browser_run_code_unsafe'){assert.doesNotMatch(args.code,/\bimport\s*\(/u,'MCP run-code VM has no dynamic-import callback');result=await vm.runInNewContext('('+args.code+')',{URL,URLSearchParams})(current);if(loseStart&&args.code.includes('.__persistentRecorder.start('))throw new Error('Synthetic start response lost');if(loseBind&&args.code.includes("Object.defineProperty(target,'__textbookRecorderSessionPage'"))throw new Error('Synthetic binding response lost');}
      else throw new Error('Unexpected synthetic tool');return {structuredContent:result};
    }}};connections.push(connection);return connection;
  };
  const session=new PersistentRecorderSession({root,bookId:BOOK,focusMode,windowMode,connect,alive:pid=>live.has(pid),resolveAuth:async()=>({authConfigured:true})});await session.initialize();
  return {root,session,calls,connections,fronts,closed,windowCalls,get connects(){return connects;}};
}
async function reviewedManifest(root){
  const task={id:'synthetic-question',target:{chapterLabel:'Synthetic chapter',sectionLabel:'Synthetic section',record:1},source:{pages:[1],answerPages:[2]},stem:{blocks:[{type:'text',text:'Synthetic complete question'}]},answer:{blocks:[{type:'text',text:'Synthetic complete answer'}]},answerStatus:'provided',answerRequirement:{kind:'question',evidence:'Synthetic complete question'},review:{status:'approved',issues:[],checks:{sourceText:true,answerMatch:true,wholeQuestion:true,format:true}}};
  await fs.writeFile(path.join(root,'batch.json'),JSON.stringify({schemaVersion:1,kind:'new-system-batch',source:'production',bookId:BOOK,tasks:[task],coverage:{pages:[{page:1,candidates:[{id:'synthetic-candidate',type:'question',decision:'include',taskIds:[task.id]}]}]}}));
  return {manifest:'batch.json',state:'run.json',limit:1};
}

test('MCP VM rejects dynamic import while the init-page Node loader installs the exact book bridge',async t=>{
  const oldBinder=vm.runInNewContext("(async () => { await import('node:path'); })");
  await assert.rejects(oldBinder(),error=>error.code==='ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING');
  const fake=await fixture(t);await fake.session.bind();const [user,book]=fake.connections[0].pages;
  assert.equal(user.__persistentRecorder,undefined);assert.ok(book.__persistentRecorder);assert.equal(book.__persistentRecorder.status().windowMode,'minimized');
  assert.ok(fake.calls.some(call=>call.code?.includes('await loader.install(target)')));await fake.session.close();
});

test('the Node loader rejects unrelated, foreign-context or ambiguous Pages before bridge side effects',async t=>{
  const fake=await fixture(t);await fake.session.connect();const [user,book]=fake.connections[0].pages,loader=user.context().__textbookRecorderBridgeBootstrap;
  assert.ok(Object.isFrozen(loader));assert.equal(loader.bindingId,fake.session.pageBindingId);
  await assert.rejects(loader.install(user),/书籍录入页/u);
  const foreign={url:()=>recorderBookUrl(BOOK),isClosed:()=>false,context:()=>({})};await assert.rejects(loader.install(foreign),/不属于本连接/u);
  fake.connections[0].makePage(recorderBookUrl(BOOK));await assert.rejects(loader.install(book),/不能唯一确认/u);
  assert.equal(user.__persistentRecorder,undefined);assert.equal(book.__persistentRecorder,undefined);assert.deepEqual(user.factoryOptions,[]);assert.deepEqual(book.factoryOptions,[]);
  await assert.rejects(fs.access(path.join(fake.root,'data/persistent-executor/jobs')),error=>error.code==='ENOENT');await fake.session.close();
});

test('a missing or stale loader cannot install a bridge through the MCP VM',async t=>{
  for(const mode of ['missing','stale-binding','wrong-window'])await t.test(mode,async child=>{
    const fake=await fixture(child);await fake.session.connect();const [user,book]=fake.connections[0].pages,context=user.context(),original=context.__textbookRecorderBridgeBootstrap;
    const loader=mode==='missing'?undefined:{...original,...(mode==='stale-binding'?{bindingId:'old-connection'}:{windowMode:'normal'})};
    book.context=()=>({pages:()=>fake.connections[0].pages,__textbookRecorderBridgeBootstrap:loader});
    await assert.rejects(fake.session.bind(),/加载器身份不匹配/u);assert.equal(book.__persistentRecorder,undefined);assert.deepEqual(book.factoryOptions,[]);assert.deepEqual(fake.fronts,[]);await fake.session.close();
  });
});

test('background binds the exact book Page and never selects or fronts an unrelated active tab',async t=>{
  const fake=await fixture(t);await fake.session.command({id:'first-probe',action:'probe'});await terminal(fake.session);
  const connection=fake.connections[0],book=connection.pages.find(page=>page.url()===recorderBookUrl(BOOK)),user=connection.pages[0];
  assert.equal(connection.current,user);assert.ok(book.__textbookRecorderSessionPage);assert.equal(user.__persistentRecorder,undefined);
  const other=connection.makePage(recorderBookUrl(BOOK+1));connection.current=other;
  const status=await fake.session.status();assert.equal(status.remote.bookId,BOOK);assert.equal(status.focusMode,'background');assert.equal(status.remote.focusMode,'background');assert.equal(status.windowMode,'minimized');assert.equal(status.remote.windowMode,'minimized');
  await fake.session.command({action:'pause'});assert.equal(book.__persistentRecorder.status().continuationFence.paused,true);assert.equal(other.__persistentRecorder,undefined);
  await fake.session.command({id:'paused-probe',action:'probe'});await terminal(fake.session);assert.equal(book.__persistentRecorder.status().continuationFence.paused,true);
  assert.equal(fake.calls.filter(call=>call.name==='browser_tabs'&&call.action==='select').length,0);assert.deepEqual(fake.fronts,[]);
  assert.equal(book.factoryOptions[0].focusMode,'background');assert.equal(book.factoryOptions[0].windowMode,'minimized');assert.equal(book.windowState,'minimized');assert.ok(fake.windowCalls.length>0);assert.ok(fake.windowCalls.every(call=>call.pageId===book.id));assert.equal(fake.connects,1);await fake.session.close();assert.deepEqual(fake.closed,[]);
});

test('a newly created background book tab is marked and cleaned without adopting the active user tab',async t=>{
  const fake=await fixture(t,{existing:false});await fake.session.command({action:'probe'});await terminal(fake.session);
  const [user,book]=fake.connections[0].pages;assert.ok(book.__textbookRecorderOwnedTab);assert.ok(book.__textbookRecorderSessionPage);assert.equal(user.__textbookRecorderOwnedTab,undefined);assert.equal(user.__persistentRecorder,undefined);
  const result=await fake.session.close();assert.equal(result.tabCleanup.outcome,'closed');assert.deepEqual(fake.closed,[book.id]);assert.equal(user.closed,false);assert.deepEqual(fake.fronts,[]);
});

test('background never substitutes an active or replacement tab after bound identity changes',async t=>{
  for(const mode of ['duplicate-book','navigated','replaced','duplicate-marker','foreign-binding'])await t.test(mode,async child=>{
    const fake=await fixture(child);await fake.session.bind();const connection=fake.connections[0],book=connection.pages[1];
    if(mode==='duplicate-book')connection.current=connection.makePage(recorderBookUrl(BOOK));
    if(mode==='navigated')book.address=recorderBookUrl(BOOK+1);
    if(mode==='replaced'){connection.pages.splice(1,1);connection.current=connection.makePage(recorderBookUrl(BOOK));}
    if(mode==='duplicate-marker')Object.defineProperty(connection.pages[0],'__textbookRecorderSessionPage',{value:book.__textbookRecorderSessionPage});
    if(mode==='foreign-binding'){connection.pages.splice(1,1);const foreign=connection.makePage(recorderBookUrl(BOOK));Object.defineProperty(foreign,'__textbookRecorderSessionPage',{value:'another-connection'});fake.session.binding=false;}
    const status=await fake.session.status();assert.ok(status.error);assert.equal(book.appends,0);assert.deepEqual(fake.fronts,[]);assert.equal(fake.calls.filter(call=>call.action==='select').length,0);
    if(mode!=='foreign-binding'){
      const callsBefore=fake.calls.length;await assert.rejects(fake.session.close(),/原远端状态未确认结束/u);assert.equal(fake.calls.length,callsBefore);assert.deepEqual(fake.closed,[]);
      await assert.rejects(fake.session.command({action:'execute',args:{manifest:'batch.json'}}),/原远端状态/u);assert.equal(book.appends,0);assert.equal(fake.calls.length,callsBefore);
      connection.disconnect();assert.equal(fake.session.dead,true);
    }
    await fake.session.close();
  });
});

test('legacy or mismatched focus bridges fail closed instead of activating the book Page',async t=>{
  for(const mode of ['foreground',undefined])await t.test(String(mode),async child=>{
    const fake=await fixture(child);await fake.session.connect();const page=fake.connections[0].pages[1];page.__persistentRecorder={status:()=>({bookId:BOOK,focusMode:mode,windowMode:'minimized',job:null})};
    await assert.rejects(fake.session.bind(),/focusMode/u);assert.equal(page.__textbookRecorderSessionPage,undefined);assert.deepEqual(fake.fronts,[]);await fake.session.close();
  });
});

test('legacy or mismatched window identity is rejected before binding or any window activation',async t=>{
  for(const mode of ['normal',undefined])await t.test(String(mode),async child=>{
    const fake=await fixture(child);await fake.session.connect();const page=fake.connections[0].pages[1];page.__persistentRecorder={status:()=>({bookId:BOOK,focusMode:'background',windowMode:mode,job:null})};
    await assert.rejects(fake.session.bind(),/windowMode/u);assert.equal(page.__textbookRecorderSessionPage,undefined);assert.deepEqual(fake.windowCalls,[]);assert.deepEqual(fake.fronts,[]);await fake.session.close();
  });
});

test('background normal leaves window state alone while still binding the exact Page',async t=>{
  const fake=await fixture(t,{windowMode:'normal'});await fake.session.command({action:'probe'});await terminal(fake.session);
  const book=fake.connections[0].pages[1];assert.equal(book.factoryOptions[0].windowMode,'normal');assert.equal(fake.session.snapshot().windowMode,'normal');assert.equal(book.windowState,'normal');assert.deepEqual(fake.windowCalls,[]);assert.deepEqual(fake.fronts,[]);assert.equal(fake.calls.filter(call=>call.action==='select').length,0);await fake.session.close();
});

test('a bridge mode changed after binding blocks every later status, pause or start',async t=>{
  const fake=await fixture(t);await fake.session.bind();const book=fake.connections[0].pages[1];let invoked=0;
  book.__persistentRecorder.status=()=>({bookId:BOOK,focusMode:'background',windowMode:'normal',job:null});book.__persistentRecorder.pause=()=>{invoked++;};book.__persistentRecorder.start=()=>{invoked++;};
  for(const action of ['status','pause','start'])await assert.rejects(fake.session.bridge(action,action==='start'?{id:'changed-mode',action:'probe',args:{}}:undefined),/windowMode/u);
  assert.equal(invoked,0);assert.deepEqual(fake.windowCalls,[]);assert.deepEqual(fake.fronts,[]);await fake.session.close();
});

test('wrong URL bridge installation has no filesystem, Page or adapter side effects',async t=>{
  for(const address of ['about:blank',recorderBookUrl(BOOK+1),recorderBookUrl(BOOK)+'&textbookID='+BOOK])await t.test(address,async child=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'recorder-background-guard-'));child.after(async()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('recorder-background-guard-'));await fs.rm(root,{recursive:true,force:true});});const page={url:()=>address};let constructed=0;
    await assert.rejects(installPersistentBridge({page,config:{root,bookId:BOOK,focusMode:'background'},adapterFactory:()=>{constructed++;throw new Error('Unexpected adapter');}}),/书籍录入页/u);
    assert.equal(page.__persistentRecorder,undefined);assert.equal(constructed,0);assert.deepEqual(await fs.readdir(root),[]);
  });
});

test('foreground retains tab selection and adapter activation with the explicit mode identity',async t=>{
  const fake=await fixture(t,{focusMode:'foreground'});await fake.session.command({action:'probe'});await terminal(fake.session);
  const book=fake.connections[0].pages[1];assert.ok(fake.calls.some(call=>call.action==='select'));assert.ok(fake.fronts.includes(book.id));assert.equal(book.factoryOptions[0].focusMode,'foreground');assert.equal(fake.session.snapshot().focusMode,'foreground');await fake.session.close();
});

test('foreground can lazily install a new tab after its about:blank init-page callback',async t=>{
  const fake=await fixture(t,{existing:false,focusMode:'foreground'});await fake.session.command({action:'probe'});await terminal(fake.session);
  const [user,book]=fake.connections[0].pages;assert.equal(user.__persistentRecorder,undefined);assert.ok(book.__persistentRecorder);assert.equal(book.__persistentRecorder.status().windowMode,'normal');assert.ok(book.__textbookRecorderOwnedTab);
  assert.ok(fake.calls.some(call=>call.code?.includes('await loader.install(page)')));await fake.session.close();assert.deepEqual(fake.closed,[book.id]);
});

test('a response lost after background start keeps the original pending id and never resends it',async t=>{
  const fake=await fixture(t,{loseStart:true});const first=await fake.session.command({id:'lost-background-probe',action:'probe'});assert.equal(first.pending.id,'lost-background-probe');assert.match(first.error,/response lost/u);
  const connection=fake.connections[0];connection.current=connection.makePage('https://example.test/changed-work');const settled=await terminal(fake.session);assert.equal(settled.last.id,'lost-background-probe');
  assert.equal(fake.calls.filter(call=>call.code?.includes('.__persistentRecorder.start(')).length,1);assert.deepEqual(fake.fronts,[]);await fake.session.close();
});

test('a lost background ownership binding response preserves the new page instead of closing it',async t=>{
  const fake=await fixture(t,{existing:false,loseBind:true});await assert.rejects(fake.session.command({action:'probe'}),/binding response lost/u);
  const result=await fake.session.close();assert.equal(result.tabCleanup.outcome,'retained');assert.equal(result.tabCleanup.reason,'ownership-unconfirmed');assert.deepEqual(fake.closed,[]);assert.deepEqual(fake.fronts,[]);
});

test('background reconnect restores durable pause and rejects a guard from an earlier connection before writes',async t=>{
  const fake=await fixture(t);await fake.session.bind();const before=fake.session.snapshot();await fake.session.command({action:'pause'});fake.connections[0].disconnect();
  const status=await fake.session.status();assert.equal(fake.connects,2);assert.equal(status.pauseControl.paused,true);assert.equal(status.remote.continuationFence.paused,true);assert.deepEqual(fake.fronts,[]);
  const args=await reviewedManifest(fake.root),guard={schemaVersion:1,previousTerminalId:null,pauseGeneration:before.pauseControl.generation,phase:'initial',connectionCount:before.connectionCount};
  await assert.rejects(fake.session.command({id:'stale-background-execute',action:'execute',args,continuationGuard:guard}),/连接、暂停版本/u);assert.equal(fake.session.state.pending,null);assert.equal(fake.connections.flatMap(connection=>connection.pages).reduce((total,page)=>total+page.appends,0),0);await fake.session.close();
});

test('a changed book identity at normal execute dispatch preserves pending and the unknown-save write lock',async t=>{
  const fake=await fixture(t);await fake.session.bind();const args=await reviewedManifest(fake.root),connection=fake.connections[0],book=connection.pages[1],invoke=fake.session.invokeBridge.bind(fake.session);
  fake.session.invokeBridge=async(action,payload)=>{if(action==='start')connection.makePage(recorderBookUrl(BOOK));return invoke(action,payload);};
  const result=await fake.session.command({id:'uncertain-background-execute',action:'execute',args});assert.equal(result.pending.id,'uncertain-background-execute');assert.equal(result.writeBlocked,true);assert.match(result.error,/不能唯一确认/u);assert.equal(book.appends,0);assert.deepEqual(fake.fronts,[]);
  fake.session.state.pending=null;await fake.session.close();
});
