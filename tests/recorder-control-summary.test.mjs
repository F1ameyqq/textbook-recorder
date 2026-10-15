import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {summarizeRecorderStatus} from '../src/recorder-status-summary.mjs';
import {main,waitRecorderCommand} from '../scripts/recorder-control.mjs';

async function workspace(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'recorder-summary-'));
  t.after(async()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('recorder-summary-'));await fs.rm(root,{recursive:true,force:true});});
  await fs.mkdir(path.join(root,'config'));await fs.mkdir(path.join(root,'data/persistent-executor'),{recursive:true});
  await fs.writeFile(path.join(root,'config/recorder.json'),JSON.stringify({bookId:101}));
  await fs.writeFile(path.join(root,'data/persistent-executor/control.json'),JSON.stringify({schemaVersion:1,bookId:101,port:8789,key:'a'.repeat(64)}));
  return root;
}
const terminal=id=>({bookId:101,connection:'connected',connectionCount:1,pending:null,writeBlocked:false,last:{id,action:'probe',terminal:true,result:{recordCount:3,recordsPath:'data/job/scope-records.json',writePerformed:false}}});

test('summary retains recovery identity but omits exported contents, arguments and duplicate job timings',()=>{
  const job={id:'owned',action:'execute',terminal:true,timings:Array(400).fill({privateDetail:'evidence-only'}),result:{counts:{completed:20},stateStatus:'failed',uncertain:true,records:[{stem:'private textbook'}],recovery:{outcome:'unknown',writeUnlocked:false,evidencePath:'data/pending.json'},pendingWrite:{task:{id:'q20',stem:'private textbook'},phase:'save',evidencePath:'data/pending.json'}}};
  const status={bookId:101,pending:null,writeBlocked:true,last:job,remote:{job},continuationFence:{schemaVersion:1,previousTerminalId:'owned',pauseGeneration:2,paused:true},recovery:{required:true,taskId:'q20',pendingPath:'data/pending.json'},blockedContext:{manifest:'private-context'}};
  const summary=summarizeRecorderStatus(status),json=JSON.stringify(summary);
  assert.equal(summary.job.id,'owned');assert.equal(summary.job.result.uncertain,true);assert.equal(summary.recovery.taskId,'q20');assert.equal(summary.job.result.pendingWrite.task.id,'q20');
  assert.deepEqual(summary.continuationFence,status.continuationFence);
  assert.doesNotMatch(json,/private textbook|private-context|evidence-only|timings|"remote"/u);assert.ok(json.length<1000);
  assert.deepEqual(summarizeRecorderStatus(summary),summary);
});

test('pending summary cannot present a previous terminal job as current',()=>{
  const summary=summarizeRecorderStatus({...terminal('old'),pauseControl:{schemaVersion:1,generation:2,paused:true},pending:{id:'new',action:'collect',args:{output:'private-data'}}});
  assert.deepEqual(summary.pending,{id:'new',action:'collect'});assert.equal(summary.job,undefined);
  assert.deepEqual(summary.pauseControl,{schemaVersion:1,generation:2,paused:true});
});

test('draft summary retains lock and receipt diagnostics while its full blocked context stays in details',()=>{
  const status={bookId:101,pending:null,writeBlocked:true,blockedContext:{kind:'draft-runtime-roundtrip',manifest:'private-plan',state:'private-journal',
    baselinePath:'private-baseline',manifestSha256:'private-plan-hash',authorization:{userQuote:'private-authorization'}},
    last:{id:'draft-owned',action:'draft-roundtrip',terminal:true,result:{kind:'draft-runtime-roundtrip',originalRecordId:901,saveRequests:1,uncertain:true,
      recovery:{kind:'draft-runtime-roundtrip',writeUnlocked:false,baselineRestored:false,receiptsComplete:false,zeroNativeInputConfirmed:false,liveRestoreEligible:true}}}};
  const summary=summarizeRecorderStatus(status);
  assert.equal(summary.writeBlocked,true);assert.equal(summary.blockedContext,undefined);assert.equal(summary.job.action,'draft-roundtrip');
  assert.equal(summary.job.result.originalRecordId,901);assert.equal(summary.job.result.saveRequests,1);
  assert.equal(summary.job.result.recovery.liveRestoreEligible,true);assert.doesNotMatch(JSON.stringify(summary),/private-/u);
  assert.equal(status.blockedContext.manifest,'private-plan');assert.deepEqual(summarizeRecorderStatus(summary),summary);
});

test('status request summary exposes lifecycle without private response details',()=>{
  const summary=summarizeRecorderStatus({...terminal('old'),statusRequest:{state:'blocked',dispatched:true,transportReturned:false,servicePid:123,connectionCount:1,controlKey:'private key',rawResponse:'private response'}});
  assert.equal(summary.statusRequest.state,'blocked');assert.equal(summary.statusRequest.transportReturned,false);assert.equal(summary.statusRequest.servicePid,123);assert.doesNotMatch(JSON.stringify(summary),/private key|private response|rawResponse|controlKey/u);
});

test('wait submits one command and polls locally until its own terminal proof',async t=>{
  const root=await workspace(t),commands=[];let id;
  const request=async(_root,command)=>{commands.push(command);if(command.action==='probe'){id=command.id;return {...terminal('old'),pending:{id,action:'probe'}};}return commands.length<4?{...terminal('old'),pending:{id,action:'probe'},remote:{job:{id,action:'probe',running:true,terminal:false}}}:terminal(id);};
  const result=await waitRecorderCommand(root,{action:'probe',args:{}},{request,pause:async()=>{}});
  assert.equal(result.last.id,id);assert.equal(commands.filter(row=>row.action==='probe').length,1);assert.equal(commands.filter(row=>row.action==='status').length,3);
});

test('lost response, wrong identity and missing terminal proof never resubmit',async t=>{
  const root=await workspace(t);
  for(const response of [()=>{throw new Error('transport failed');},()=>terminal('other'),command=>({...terminal(command.id),bookId:202}),command=>({...terminal(command.id),last:{id:command.id,terminal:false}})]){
    let calls=0;await assert.rejects(waitRecorderCommand(root,{action:'probe'},{request:async(_root,command)=>{calls++;return response(command);},pause:async()=>{}}));assert.equal(calls,1);
  }
});

test('waiting timeout leaves the original task pending and sends no replay or cancellation',async t=>{
  const root=await workspace(t),commands=[];let clock=0,id;
  await assert.rejects(waitRecorderCommand(root,{action:'collect',args:{from:1,to:2}},{timeoutMs:2,pollMs:1,now:()=>clock,pause:async ms=>{clock+=ms;},request:async(_root,command)=>{commands.push(command);id??=command.id;return {bookId:101,pending:{id,action:'collect'},writeBlocked:false};}}),/等待超时/u);
  assert.equal(commands.filter(command=>command.action==='collect').length,1);assert.equal(commands.filter(command=>command.action!=='collect'&&command.action!=='status').length,0);
});

test('controller defaults to compact output, details is explicit, invalid waits do not contact service',async t=>{
  const root=await workspace(t),logs=[];let calls=0;
  const request=async()=>{calls++;return {...terminal('owned'),remote:{job:{timings:['private evidence']}},last:{...terminal('owned').last,timings:['private evidence']}};};
  await main(['status'],{root,request,log:value=>logs.push(value)});assert.doesNotMatch(logs[0],/private evidence/u);
  await main(['status','--details'],{root,request,log:value=>logs.push(value)});assert.match(logs[1],/private evidence/u);
  for(const argv of [['status','--wait'],['probe','--timeout-ms=5'],['status','--summary','--details'],['probe','--wait','--timeout-ms=0']])await assert.rejects(main(argv,{root,request,log:()=>{}}));
  assert.equal(calls,2);
});
