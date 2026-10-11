import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {PersistentRecorderSession} from '../src/persistent-recorder-session.mjs';
import {recorderBookUrl} from '../src/recorder-config.mjs';
import {startRecorderService} from '../scripts/run-recorder-service.mjs';

const BOOK=101;
async function workspace(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'recorder-tab-lifecycle-'));t.after(async()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('recorder-tab-lifecycle-'));await fs.rm(root,{recursive:true,force:true});});return root;}
async function fakeSession(t,{existing=false,failNew=false,duplicateNew=false,failMarker=false,maxAutomaticReconnects=1}={}){
  const root=await workspace(t),connections=[],live=new Set(),calls=[],closedPages=[];let connects=0,pageSequence=0;
  const connect=async()=>{
    connects++;const callbacks=[],pages=[];let current,job=null;
    const makePage=url=>{const emptyEditor=()=>({textContent:'',innerText:'',nodes:[{tagName:'P'},{tagName:'BR'}],querySelectorAll(){return this.nodes;}}),page={id:++pageSequence,address:url,closed:false,editors:{'#contentedit .w-e-text':emptyEditor(),'#answeredit .w-e-text':emptyEditor()},url(){return this.address;},isClosed(){return this.closed;},context:()=>({pages:()=>pages}),evaluate:async fn=>{if(page.editorError)throw new Error('fake editor read failed');return vm.runInNewContext('('+fn.toString()+')()',{document:{querySelector:selector=>page.editors[selector]}});},close:async()=>{closedPages.push(page.id);page.closed=true;pages.splice(pages.indexOf(page),1);if(current===page)current=pages[0];}};page.__persistentRecorder={status:()=>({bookId:BOOK,focusMode:'foreground',windowMode:'normal',job}),pause:()=>({bookId:BOOK,stopRequested:true}),start:command=>{job={id:command.id,action:command.action,terminal:true,running:false,result:{bookId:BOOK,uncertain:false}};return {bookId:BOOK,id:command.id,started:true};}};pages.push(page);return page;};
    current=makePage(existing?recorderBookUrl(BOOK):'about:blank');const servicePid=60000+connects;live.add(servicePid);
    const connection={servicePid,authConfigured:true,pages,makePage,onClosed:fn=>callbacks.push(fn),disconnect:()=>{live.delete(servicePid);callbacks.forEach(fn=>fn());},close:async()=>{live.delete(servicePid);callbacks.forEach(fn=>fn());},client:{listTools:async()=>({tools:[{name:'browser_tabs',inputSchema:{properties:{action:{enum:['list','select','new','close']}}}},{name:'browser_run_code_unsafe',inputSchema:{properties:{code:{type:'string'}}}}]}),callTool:async({name,arguments:args})=>{
      calls.push({name,...args});let result;
      if(name==='browser_tabs'){
        if(args.action==='new'){if(failNew)throw new Error('fake creation failed');current=makePage(args.url);if(duplicateNew)makePage(args.url);}
        if(args.action==='select'){current=pages[args.index];assert.ok(current);}
        result={tabs:pages.map((page,index)=>({index,url:page.url()}))};
      }else if(name==='browser_run_code_unsafe'){result=await Function('page',`return (${args.code})(page);`)(current);if(failMarker&&args.code.includes('Object.defineProperty'))throw new Error('marker result lost');}
      else throw new Error('Unexpected fake tool');
      return {structuredContent:result};
    }}};connections.push(connection);return connection;
  };
  const session=new PersistentRecorderSession({root,bookId:BOOK,focusMode:'foreground',windowMode:'normal',connect,alive:pid=>live.has(pid),resolveAuth:async()=>({authConfigured:true}),maxAutomaticReconnects});await session.initialize();
  return {root,session,connections,calls,closedPages,get connects(){return connects;}};
}

test('many commands and polls share one connection and one owned book tab',async t=>{
  const fake=await fakeSession(t);for(let i=0;i<3;i++){await fake.session.command({id:'probe-'+i,action:'probe'});await fake.session.status();}
  assert.equal(fake.connects,1);assert.equal(fake.calls.filter(call=>call.name==='browser_tabs'&&call.action==='new').length,1);
  const owned=fake.connections[0].pages.find(page=>page.__textbookRecorderOwnedTab);assert.ok(owned);
  assert.equal(fake.session.snapshot().tabLifecycle.created[0].ownership,'confirmed');
  const closed=await fake.session.close();assert.equal(closed.tabCleanup.outcome,'closed');assert.deepEqual(fake.closedPages,[owned.id]);
  assert.equal(fake.connections[0].pages.length,1,'The pre-existing blank page belongs to the user');
});

test('an existing user book tab is never marked or closed',async t=>{
  const fake=await fakeSession(t,{existing:true});await fake.session.command({action:'probe'});const user=fake.connections[0].pages[0];
  assert.equal(user.__textbookRecorderOwnedTab,undefined);assert.equal(fake.calls.filter(call=>call.action==='new').length,0);
  const result=await fake.session.close();assert.equal(result.tabCleanup.outcome,'not-owned');assert.deepEqual(fake.closedPages,[]);
});

test('cleanup follows the unique page marker when indices and current tab change',async t=>{
  const fake=await fakeSession(t);await fake.session.command({action:'probe'});const connection=fake.connections[0],owned=connection.pages[1],user=connection.pages[0];
  connection.pages.reverse();await fake.session.call('browser_tabs',{action:'select',index:1});
  const result=await fake.session.close();assert.equal(result.tabCleanup.outcome,'closed');assert.deepEqual(fake.closedPages,[owned.id]);assert.equal(user.closed,false);
});

test('a navigated, replaced, or duplicated page identity is retained',async t=>{
  for(const mode of ['navigated','replaced','duplicated'])await t.test(mode,async child=>{
    const fake=await fakeSession(child);await fake.session.command({action:'probe'});const connection=fake.connections[0],owned=connection.pages[1];
    if(mode==='navigated')owned.address='about:blank';
    if(mode==='replaced'){connection.pages.splice(1,1);connection.makePage(recorderBookUrl(BOOK));}
    if(mode==='duplicated')Object.defineProperty(connection.makePage(recorderBookUrl(BOOK)),'__textbookRecorderOwnedTab',{value:owned.__textbookRecorderOwnedTab});
    const result=await fake.session.close();assert.equal(result.tabCleanup.outcome,'retained');assert.deepEqual(fake.closedPages,[]);
  });
});

test('unknown saves retain the owned page and pending commands prevent shutdown',async t=>{
  const uncertain=await fakeSession(t);await uncertain.session.command({action:'probe'});uncertain.session.state.writeBlocked=true;
  const closed=await uncertain.session.close();assert.equal(closed.tabCleanup.reason,'write-blocked');assert.deepEqual(uncertain.closedPages,[]);
  const pending=await fakeSession(t);await pending.session.command({action:'probe'});pending.session.state.pending={id:'pending'};
  await assert.rejects(pending.session.close(),/任务未确认终止/u);assert.deepEqual(pending.closedPages,[]);
  pending.session.state.pending=null;await pending.session.close();
});

test('manual edits, saved content, missing editors, and unreadable editor state all retain an owned tab',async t=>{
  for(const mode of ['manual-edit','saved-content','image-only','missing-editors','read-failed'])await t.test(mode,async child=>{
    const fake=await fakeSession(child);await fake.session.command({action:'probe'});const owned=fake.connections[0].pages[1];
    if(mode==='manual-edit'||mode==='saved-content')owned.editors['#contentedit .w-e-text'].textContent='synthetic text';
    if(mode==='saved-content')owned.editors['#answeredit .w-e-text'].innerText='synthetic saved answer';
    if(mode==='image-only')owned.editors['#contentedit .w-e-text'].nodes.push({tagName:'IMG'});
    if(mode==='missing-editors')delete owned.editors['#answeredit .w-e-text'];if(mode==='read-failed')owned.editorError=true;
    const result=await fake.session.close();assert.equal(result.tabCleanup.outcome,'retained');assert.equal(result.tabCleanup.reason,'editor-content-not-confirmed');assert.deepEqual(fake.closedPages,[]);
  });
});

test('a failed creation is not retried by repeated status heartbeats',async t=>{
  const fake=await fakeSession(t,{failNew:true});await assert.rejects(fake.session.command({action:'probe'}),/fake creation failed/u);
  for(let i=0;i<3;i++){const result=await fake.session.status();assert.match(result.error,/不会重复开页/u);}
  assert.equal(fake.connects,1);assert.equal(fake.calls.filter(call=>call.action==='new').length,1);await fake.session.close();
});

test('ambiguous creation or a lost marker result retains pages and reports uncertainty',async t=>{
  for(const mode of ['duplicateNew','failMarker'])await t.test(mode,async child=>{
    const fake=await fakeSession(child,{[mode]:true});await assert.rejects(fake.session.command({action:'probe'}));
    const result=await fake.session.close();assert.equal(result.tabCleanup.outcome,'retained');assert.deepEqual(fake.closedPages,[]);
    assert.equal(fake.calls.filter(call=>call.action==='new').length,1);
  });
});

test('a restarted service reports old ownership but never adopts it to close old pages',async t=>{
  const fake=await fakeSession(t);await fake.session.command({action:'probe'});
  const restarted=new PersistentRecorderSession({root:fake.root,bookId:BOOK,focusMode:'foreground',windowMode:'normal',connect:async()=>{throw new Error('Do not connect');}});await restarted.initialize();
  assert.equal(restarted.snapshot().tabCleanup.reason,'previous-service-page');const result=await restarted.close();assert.equal(result.tabCleanup.outcome,'retained');assert.deepEqual(fake.closedPages,[]);
  await fake.session.close();
});

test('automatic reconnection is bounded, explicit connection resets it, and polling never resends a task',async t=>{
  const fake=await fakeSession(t);await fake.session.command({id:'original-probe',action:'probe'});fake.connections[0].disconnect();
  await fake.session.status();assert.equal(fake.connects,2);assert.equal(fake.session.snapshot().reconnect.automaticAttempts,1);
  fake.connections[1].disconnect();for(let i=0;i<4;i++){const status=await fake.session.status();assert.match(status.error,/自动重连已达上限/u);}
  assert.equal(fake.connects,2);assert.equal(fake.calls.filter(call=>call.name==='browser_tabs'&&call.action==='new').length,2);
  await fake.session.status({connect:true});assert.equal(fake.connects,3);assert.equal(fake.session.snapshot().reconnect.automaticAttempts,0);
  assert.equal(fake.calls.filter(call=>call.code?.includes('.__persistentRecorder.start(')).length,1,'The original command is never sent again');
  const result=await fake.session.close();assert.equal(result.tabCleanup.outcome,'closed');assert.equal(fake.session.snapshot().tabLifecycle.created.filter(row=>row.cleanup?.reason==='connection-lost').length,2);
});

test('a missing result and disconnect preserve command identity without another start',async t=>{
  const fake=await fakeSession(t);await fake.session.bind();const original=fake.connections[0].client.callTool;let startAttempts=0;
  fake.connections[0].client.callTool=async request=>{if(request.arguments.code?.includes('.__persistentRecorder.start(')){startAttempts++;throw new Error('result lost');}return original(request);};
  const pending=await fake.session.command({id:'do-not-repeat',action:'probe'});assert.equal(pending.pending.id,'do-not-repeat');
  fake.connections[0].disconnect();await fake.session.status();assert.equal(fake.connects,2);assert.equal(fake.session.snapshot().last.id,'do-not-repeat');
  assert.equal(startAttempts,1);assert.equal(fake.calls.filter(call=>call.code?.includes('.__persistentRecorder.start(')).length,0);await fake.session.close();
});

test('custom session paths and authenticated local health reads never create a browser connection',async t=>{
  const root=await workspace(t);await fs.mkdir(path.join(root,'config'));await fs.writeFile(path.join(root,'config/recorder.json'),JSON.stringify({bookId:BOOK}));
  let connects=0;const statePath='data/jobs/synthetic/original-session.json',service=await startRecorderService({root,sessionStatePath:statePath,port:0,connect:async()=>{connects++;throw new Error('Health must stay local');},log:()=>{}});
  t.after(()=>service.shutdown());const control=JSON.parse(await fs.readFile(service.controlFile,'utf8'));
  assert.equal(control.sessionPath,path.join(root,statePath));const address='http://127.0.0.1:'+control.port;
  assert.equal((await fetch(address+'/health')).status,403);
  const health=await (await fetch(address+'/health',{headers:{'x-recorder-key':control.key}})).json();assert.equal(health.sessionPath,control.sessionPath);assert.equal(health.bookId,BOOK);assert.equal(health.connection,'disconnected');assert.equal(connects,0);
  const result=await service.shutdown();assert.equal(result.closed,true);assert.ok(result.tabCleanup);
});
