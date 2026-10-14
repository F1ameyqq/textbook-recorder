import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {startRecorderService} from '../scripts/run-recorder-service.mjs';

test('service heartbeat queries only a connected nonbusy pending command and stops at terminal',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'recorder-heartbeat-test-'));
  await fs.mkdir(path.join(root,'config'));await fs.writeFile(path.join(root,'config/recorder.json'),JSON.stringify({bookId:101}));
  t.mock.timers.enable({apis:['setInterval']});
  const service=await startRecorderService({root,port:0,connect:async()=>{throw new Error('Synthetic heartbeat must not connect a browser');},log:()=>{}}),session=service.session;
  t.after(async()=>{session.state.pending=null;await service.shutdown();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('recorder-heartbeat-test-'));await fs.rm(root,{recursive:true,force:true});});
  let remoteCalls=0;const connection={servicePid:60001,close:async()=>{}};session.connection=connection;session.binding=true;session.bind=async()=>{};
  const terminal={id:'synthetic-reader',action:'probe',running:false,terminal:true,result:{bookId:101,writePerformed:false}};
  session.invokeBridge=async action=>{assert.equal(action,'status');remoteCalls++;return {bookId:101,job:terminal};};
  t.mock.timers.tick(15000);assert.equal(remoteCalls,0,'An idle connected service must not touch the browser');assert.equal(session.statusOperation,undefined);
  session.state.pending={id:terminal.id,action:'probe',args:{},servicePid:connection.servicePid,at:new Date().toISOString()};session.state.seenIds.push(terminal.id);
  session.busy=true;t.mock.timers.tick(3000);assert.equal(remoteCalls,0,'A command being prepared remains excluded');session.busy=false;
  session.connection=null;t.mock.timers.tick(3000);assert.equal(remoteCalls,0,'A disconnected pending command must not connect automatically');session.connection=connection;
  t.mock.timers.tick(3000);await session.statusPromise;
  assert.equal(remoteCalls,1);assert.equal(session.state.pending,null);assert.equal(session.state.last.id,terminal.id);assert.equal(session.state.last.terminal,true);assert.equal(session.state.writeBlocked,false);
  t.mock.timers.tick(15000);assert.equal(remoteCalls,1,'A completed command must return to an idle heartbeat');
});
