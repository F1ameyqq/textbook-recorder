import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {PersistentRecorderSession} from '../src/persistent-recorder-session.mjs';
import {recorderCommandFingerprint} from '../src/recorder-terminal-evidence.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
async function fixture(t,handle){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'recorder-draft-session-'));
  t.after(async()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('recorder-draft-session-'));await fs.rm(root,{recursive:true,force:true});});
  const baseline={bookId:701,chapterLabel:'Synthetic chapter',sectionLabel:'Synthetic section',nodeID:801,serverSnapshotAt:new Date().toISOString(),records:[
    {seqIndex:1,shitiID:901,nodeID:801,question:'<p>Original question</p>',answer:'<p>Original answer</p>',mainPicNum:1,answerPicNum:2,haveAnswer:true}]};
  const bytes=Buffer.from(JSON.stringify(baseline));await fs.mkdir(path.join(root,'data'));
  await fs.writeFile(path.join(root,'data/baseline.json'),bytes);
  const plan={schemaVersion:1,kind:'draft-runtime-roundtrip',source:'server-snapshot',bookId:701,
    authorization:{source:'direct-user',userQuote:'Synthetic offline authorization for a temporary answer and exact restore.'},
    scope:{chapterLabel:baseline.chapterLabel,sectionLabel:baseline.sectionLabel,nodeID:801},target:{seqIndex:1,shitiID:901},baseline:{path:'baseline.json',sha256:sha(bytes)}};
  await fs.writeFile(path.join(root,'data/plan.json'),JSON.stringify(plan));
  const args={manifest:'data/plan.json',state:'data/journal.json'},starts=[];
  const session=new PersistentRecorderSession({root,bookId:701,browserBackend:'headless',readOnly:false,alive:()=>false});await session.initialize();
  let job=null,connections=0;
  session.bind=async()=>{if(!session.connection){connections++;session.connection={servicePid:65001,close:async()=>{}};session.state.connectionCount++;session.pageBindingId=randomUUID();}session.binding=true;};
  const completed=context=>({kind:context.kind,bookId:701,manifestPath:context.manifest,manifestSha256:context.manifestSha256,statePath:context.state,
    baselineSha256:context.baselineSha256,stateStatus:'completed',uncertain:false,pendingWrite:null,restored:true,receipts:[{synthetic:1},{synthetic:2}]});
  session.bridge=async(action,payload)=>{
    if(action==='status')return {bookId:701,job};
    assert.equal(action,'start');const saved=JSON.parse(await fs.readFile(session.statePath,'utf8')),context=saved.pending.reviewContext;
    assert.equal(saved.pending.id,payload.id);assert.equal(saved.pending.action,payload.action);assert.equal(saved.writeBlocked,true);
    assert.equal(saved.blockedContext.kind,'draft-runtime-roundtrip');assert.equal(saved.blockedContext.manifestSha256,context.manifestSha256);
    assert.equal(context.manifest,path.join(root,'data/plan.json'));assert.equal(context.state,path.join(root,'data/journal.json'));
    assert.equal(context.manifestSha256,sha(await fs.readFile(context.manifest)));starts.push(payload);
    if(payload.action==='draft-roundtrip')await fs.writeFile(context.state,'{}',{flag:'wx'});
    const outcome=await handle({payload,context,completed,session,starts});
    job={id:payload.id,action:payload.action,bookId:701,servicePid:65001,startedAt:saved.pending.at,finishedAt:new Date().toISOString(),
      commandSha256:recorderCommandFingerprint(payload),running:false,terminal:true,...outcome};
    return {bookId:701,id:payload.id,started:true};
  };
  return {root,args,plan,session,starts,get job(){return job;},get connections(){return connections;}};
}
const unknown=context=>({kind:context.kind,bookId:701,manifestPath:context.manifest,manifestSha256:context.manifestSha256,statePath:context.state,
  uncertain:true,pendingWrite:{kind:context.kind,status:'pending',evidencePath:context.state},restored:false});

test('draft dispatch persists its own plan/hash/state lock before bridge and only a complete restored result clears it',async t=>{
  const f=await fixture(t,async({context,completed})=>({result:completed(context)}));
  const result=await f.session.command({id:'draft-success',action:'draft-roundtrip',args:f.args});
  assert.equal(result.writeBlocked,false);assert.equal(result.blockedContext,null);assert.equal(result.pending,null);assert.equal(f.connections,1);
  await assert.rejects(f.session.command({action:'draft-roundtrip',args:f.args}),/journal/u);assert.equal(f.starts.length,1);
});

test('unknown draft blocks a second write and permits exactly the same-plan restore in its original live connection',async t=>{
  const f=await fixture(t,async({payload,context,completed})=>payload.action==='draft-roundtrip'?{error:'synthetic phase failure',result:unknown(context)}:{result:completed(context)});
  await f.session.command({id:'draft-unknown',action:'draft-roundtrip',args:f.args});assert.equal(f.session.state.writeBlocked,true);
  await assert.rejects(f.session.command({action:'draft-roundtrip',args:f.args}),/写入锁/u);
  const restored=await f.session.command({id:'draft-restore',action:'draft-roundtrip-restore',args:f.args});
  assert.equal(restored.writeBlocked,false);assert.equal(restored.pending,null);assert.equal(f.connections,1);assert.equal(f.starts.length,2);
});

test('restart, changed connection binding and changed plan cannot grant restore or release the original lock',async t=>{
  for(const mode of ['restart','binding','manifest'])await t.test(mode,async child=>{
    const f=await fixture(child,async({context})=>({error:'synthetic unknown',result:unknown(context)}));
    await f.session.command({action:'draft-roundtrip',args:f.args});
    let target=f.session;
    if(mode==='restart'){target=new PersistentRecorderSession({root:f.root,bookId:701,browserBackend:'headless',readOnly:false,connect:async()=>{throw new Error('must not connect');}});await target.initialize();}
    if(mode==='binding')target.pageBindingId=randomUUID();
    if(mode==='manifest'){f.plan.authorization.userQuote+=' Changed local plan.';await fs.writeFile(path.join(f.root,f.args.manifest),JSON.stringify(f.plan));}
    await assert.rejects(target.command({action:'draft-roundtrip-restore',args:f.args}),/原计划|连续活|恢复/u);
    assert.equal(target.state.writeBlocked,true);assert.equal(f.starts.length,1);assert.equal(target.state.pending,null);
  });
});

test('readonly draft reconciliation needs bound complete receipts or a continuous live zero-native-input capability',async t=>{
  for(const mode of ['incomplete','receipts','zero-live','zero-new-binding'])await t.test(mode,async child=>{
    const f=await fixture(child,async({payload,context,completed})=>{
      if(payload.action==='draft-roundtrip')return {error:'synthetic unknown',result:unknown(context)};
      const zero=mode.startsWith('zero'),result={...completed(context),writePerformed:false,recovery:{kind:context.kind,bookId:701,writeUnlocked:true,
        baselineRestored:true,allSaveRequestsSettled:mode!=='incomplete',receiptsComplete:mode==='receipts',zeroNativeInputConfirmed:zero}};
      return {result};
    });
    await f.session.command({action:'draft-roundtrip',args:f.args});if(mode==='zero-new-binding')f.session.pageBindingId=randomUUID();
    const result=await f.session.command({action:'reconcile',args:f.args});
    assert.equal(result.writeBlocked,!['receipts','zero-live'].includes(mode));assert.equal(f.connections,1);
    assert.equal(f.starts[1].action,'reconcile');
  });
});

test('a durable local draft terminal retires its command without promoting a write or recovery result',async t=>{
  const f=await fixture(t,async({context})=>({running:true,terminal:false,result:unknown(context)}));
  await f.session.command({id:'draft-local-terminal',action:'draft-roundtrip',args:f.args});const pending=f.session.state.pending;
  assert.ok(pending);const context=pending.reviewContext,job={...f.job,running:false,terminal:true,finishedAt:new Date().toISOString(),result:{
    kind:context.kind,bookId:701,manifestPath:context.manifest,manifestSha256:context.manifestSha256,statePath:context.state,uncertain:false,restored:true}};
  const directory=path.join(f.root,'data/persistent-executor/jobs',pending.id);await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,'job-result.json'),JSON.stringify(job));
  const result=await f.session.localTerminalStatus('synthetic transport unavailable');
  assert.equal(result.statusSource,'local-terminal');assert.equal(result.pending,null);assert.equal(result.writeBlocked,true);
  assert.equal(result.last.localTerminalProof.kind,'bound-draft-terminal');assert.equal(f.starts.length,1);
});
