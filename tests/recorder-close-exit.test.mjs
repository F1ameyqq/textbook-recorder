import test from 'node:test';
import assert from 'node:assert/strict';
import {main} from '../scripts/recorder-control.mjs';

const historicalFailure=()=>({bookId:101,pending:null,writeBlocked:false,blockedContext:null,recovery:{required:false},
  last:{id:'old-probe',action:'probe',terminal:true,error:'historical readiness failure',evidenceError:'historical diagnostic',result:{uncertain:true,comparison:{ok:false}}}});

async function invoke(t,action,value){
  const beforeExit=process.exitCode;process.exitCode=undefined;t.after(()=>{process.exitCode=beforeExit;});
  const requests=[],logs=[],before=structuredClone(value),result=await main([action],{request:async(_root,command)=>{requests.push(command);return value;},log:message=>logs.push(message)});
  assert.deepEqual(requests,[{action,args:{}}]);assert.deepEqual(value,before);
  return {result,logs,exitCode:process.exitCode};
}

test('a confirmed safe close exits successfully while preserving historical failed-job diagnostics',async t=>{
  const reply={...historicalFailure(),closed:true},result=await invoke(t,'close',reply);
  assert.equal(result.exitCode,undefined);assert.equal(result.result.closed,true);assert.match(result.logs[0],/historical readiness failure/u);
});

for(const [name,change] of [
  ['missing close receipt',{closed:undefined}],['unclosed reply',{closed:false}],['actual close error',{closed:true,error:'close refused'}],
  ['pending original command',{closed:true,pending:{id:'still-pending',action:'execute'}}],
  ['unknown save lock',{closed:true,writeBlocked:true}],['retained original recovery binding',{closed:true,blockedContext:{taskId:'original'}}],
  ['required original recovery',{closed:true,recovery:{required:true}}],
])test('close remains unsuccessful for '+name,async t=>{
  const result=await invoke(t,'close',{...historicalFailure(),...change});assert.equal(result.exitCode,1);
});

for(const action of ['status','probe'])test(action+' retains the previous task-failure exit behavior',async t=>{
  const result=await invoke(t,action,historicalFailure());assert.equal(result.exitCode,1);
});

test('a failed close request is propagated without another close or status command',async()=>{
  const commands=[];await assert.rejects(main(['close'],{request:async(_root,command)=>{commands.push(command);throw new Error('synthetic HTTP close rejection');},log:()=>{throw new Error('no result to log');}}),/HTTP close rejection/u);
  assert.deepEqual(commands,[{action:'close',args:{}}]);
});
