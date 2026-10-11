import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {EventEmitter} from 'node:events';
import {ensureRecorderService} from '../scripts/ensure-recorder-service.mjs';

const fixtureModes={focusMode:'background',windowMode:'normal'};

async function workspace(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'recorder-start-'));
  t.after(async()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('recorder-start-'));await fs.rm(root,{recursive:true,force:true});});
  await fs.mkdir(path.join(root,'config'));await fs.mkdir(path.join(root,'scripts'));await fs.mkdir(path.join(root,'data/persistent-executor'),{recursive:true});
  await fs.writeFile(path.join(root,'config/recorder.json'),JSON.stringify({bookId:101,port:8789,...fixtureModes}));
  await fs.writeFile(path.join(root,'scripts/run-recorder-service.mjs'),'// owned local service fixture');return root;
}
const control=root=>({schemaVersion:1,bookId:101,pid:50001,port:8789,...fixtureModes,key:'b'.repeat(64),sessionPath:path.join(root,'data/persistent-executor/session.json')});
async function putControl(root,value=control(root)){await fs.writeFile(path.join(root,'data/persistent-executor/control.json'),JSON.stringify(value));}
const health=root=>async(url,options)=>{assert.ok(url.endsWith('/health'));assert.equal(options.headers['x-recorder-key'],'b'.repeat(64));return {ok:true,json:async()=>({bookId:101,...fixtureModes,sessionPath:control(root).sessionPath,connection:'disconnected',pending:null,writeBlocked:false})};};

test('reuses the authenticated local service without spawning or connecting a browser',async t=>{
  const root=await workspace(t);await putControl(root);let launches=0;
  const result=await ensureRecorderService(root,{alive:()=>true,fetchImpl:health(root),spawnProcess:()=>{launches++;throw new Error('must not spawn');}});
  assert.equal(result.reused,true);assert.equal(result.connection,'disconnected');assert.equal(launches,0);assert.doesNotMatch(JSON.stringify(result),/bbbbbbbb/u);
  assert.equal(result.focusMode,fixtureModes.focusMode);assert.equal(result.windowMode,fixtureModes.windowMode);
});

test('a single hidden supervisor launch is reused by later commands',async t=>{
  const root=await workspace(t);let launches=0;const writes=[];
  const spawnProcess=(command,args,options)=>{
    launches++;assert.equal(command,process.execPath);assert.equal(options.windowsHide,true);assert.equal(options.detached,true);assert.equal(options.stdio[0],'ignore');assert.equal(args[0],path.join(root,'scripts/run-recorder-service.mjs'));
    writes.push(putControl(root));const child=new EventEmitter();child.pid=50001;child.exitCode=null;child.unref=()=>{};return child;
  };
  const first=await ensureRecorderService(root,{alive:()=>true,fetchImpl:health(root),spawnProcess,pause:async()=>{await Promise.all(writes);}});
  const second=await ensureRecorderService(root,{alive:()=>true,fetchImpl:health(root),spawnProcess});
  assert.equal(first.reused,false);assert.equal(second.reused,true);assert.equal(launches,1);
});

test('wrong book, original-session identity or failed health never starts a second writer',async t=>{
  const root=await workspace(t);let launches=0;const spawnProcess=()=>{launches++;throw new Error('must not spawn');};
  for(const changes of [{bookId:202},{sessionPath:path.join(root,'data/other-session.json')},{port:8790}]){
    await putControl(root,{...control(root),...changes});await assert.rejects(ensureRecorderService(root,{alive:()=>true,fetchImpl:health(root),spawnProcess}),/现有服务/u);
  }
  await putControl(root);await assert.rejects(ensureRecorderService(root,{alive:()=>true,fetchImpl:async()=>({ok:false}),spawnProcess}),/身份检查/u);assert.equal(launches,0);
});

test('startup timeout preserves the one launched process and never retries spawn',async t=>{
  const root=await workspace(t);let launches=0,clock=0;
  const spawnProcess=()=>{launches++;const child=new EventEmitter();child.pid=50001;child.exitCode=null;child.unref=()=>{};return child;};
  await assert.rejects(ensureRecorderService(root,{spawnProcess,timeoutMs:1,now:()=>clock,pause:async()=>{clock++;}}),/启动等待超时/u);assert.equal(launches,1);
});

test('a transient health failure after replacement rechecks only the same new child once',async t=>{
  const root=await workspace(t);let launches=0,checks=0;const writes=[];
  const spawnProcess=()=>{launches++;writes.push(putControl(root));const child=new EventEmitter();child.pid=50001;child.exitCode=null;child.unref=()=>{};return child;};
  const fetchImpl=async(url,options)=>{checks++;assert.equal(options.headers.connection,'close');return checks===1?{ok:false}:health(root)(url,options);};
  const result=await ensureRecorderService(root,{spawnProcess,alive:()=>true,fetchImpl,pause:async()=>{await Promise.all(writes);}});
  assert.equal(result.reused,false);assert.equal(checks,2);assert.equal(launches,1);
});
