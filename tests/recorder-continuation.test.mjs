import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {runReviewedBatch} from '../scripts/run-reviewed-batch-service.mjs';
import {createNewSystemRun} from '../src/new-system-core.mjs';

const BOOK=900001;
function manifest(count){
  return {schemaVersion:1,kind:'new-system-batch',bookId:BOOK,source:'production',
    tasks:Array.from({length:count},(_,index)=>({id:'synthetic-'+(index+1),
      target:{chapterLabel:'合成章',sectionLabel:'合成节',record:index+1},source:{pages:[1],answerPages:[2]},
      stem:{blocks:[{type:'text',text:'填写合成答案。'}]},answer:{blocks:[{type:'text',text:'合成答案'}]},
      answerRequirement:{kind:'fill-in',evidence:'填写合成答案。'},answerStatus:'provided',
      review:{status:'approved',issues:[],checks:{sourceText:true,answerMatch:true,wholeQuestion:true,format:true}}})),
    coverage:{pages:[{page:1,candidates:Array.from({length:count},(_,index)=>({id:'candidate-'+(index+1),type:'question',decision:'include',taskIds:['synthetic-'+(index+1)]}))}]}};
}
async function fixture(t,count=5){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'recorder-continuation-'));
  t.after(async()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('recorder-continuation-'));await fs.rm(root,{recursive:true,force:true});});
  await fs.mkdir(path.join(root,'config'));await fs.mkdir(path.join(root,'data'));
  await fs.writeFile(path.join(root,'config/recorder.json'),JSON.stringify({bookId:BOOK}));
  const value=manifest(count),manifestPath=path.join(root,'data/batch.json'),statePath=path.join(root,'data/run.json');
  await fs.writeFile(manifestPath,JSON.stringify(value));
  const run=createNewSystemRun(value,{baseDir:path.dirname(manifestPath)});
  return {root,value,run,manifestPath,statePath,reportPath:statePath+'.execute.report.json',
    argv:['--manifest=data/batch.json','--state=data/run.json','--action=execute','--limit=2','--continue'],
    putRun:async()=>fs.writeFile(statePath,JSON.stringify(run))};
}
const idle=()=>({bookId:BOOK,connection:'connected',connectionCount:1,pending:null,writeBlocked:false,recovery:{required:false},continuationFence:{schemaVersion:1,previousTerminalId:null,pauseGeneration:0,paused:false}});
function controller(f,{step,onStatus,beforeDispatch,preflight=idle()}={}){
  const commands=[],attempts=[];let latest=null;
  const request=async(_root,command)=>{
    if(command.action==='status')return latest?(onStatus?onStatus(latest,commands):structuredClone(latest)):structuredClone(preflight);
    attempts.push(structuredClone(command));
    if(beforeDispatch)await beforeDispatch({command,latest,preflight,accepted:commands.length});
    if(command.continuationGuard){
      const status=latest??preflight,fence=status.continuationFence,guard=command.continuationGuard;
      if(!fence||fence.paused||guard.pauseGeneration!==fence.pauseGeneration||guard.previousTerminalId!==fence.previousTerminalId||guard.connectionCount!==status.connectionCount)throw new Error('接续保护拒绝：暂停、原终止身份或连接已变化，未启动下一轮');
    }
    commands.push(structuredClone(command));
    const previous=f.run.tasks.filter(row=>['completed','skipped_existing'].includes(row.status)).length;
    const completed=Math.min(f.run.tasks.length,previous+command.args.limit);
    f.run.tasks.forEach((row,index)=>{row.status=index<completed?'completed':'pending';});
    f.run.status=completed===f.run.tasks.length?'completed':'stopped';
    latest={...idle(),continuationFence:{schemaVersion:1,previousTerminalId:command.id,pauseGeneration:command.continuationGuard?.pauseGeneration??0,paused:false},
      last:{id:command.id,terminal:true,continuationGuardAccepted:command.continuationGuard?{...command.continuationGuard,bookId:BOOK,commandId:command.id}:undefined,
      result:{stopReason:f.run.status==='stopped'?'limit':null,uncertain:false,pendingWrite:null},timings:[{phase:'synthetic',elapsedMs:1}]}};
    if(step)await step({command,latest,run:f.run,round:commands.length});
    await f.putRun();return structuredClone(latest);
  };
  return {commands,attempts,request};
}
const options=(f,c)=>({root:f.root,request:c.request,log:()=>{},pause:async()=>{}});

test('continue uses unique commands, fixed paths, bounded progress and per-round evidence',async t=>{
  const f=await fixture(t),c=controller(f),logs=[];
  const result=await runReviewedBatch(f.argv,{...options(f,c),log:value=>logs.push(JSON.parse(value))});
  assert.equal(result.ok,true);assert.equal(result.rounds,3);assert.equal(result.continued,true);
  assert.equal(result.continuationStopReason,'all-tasks-completed');
  assert.equal(new Set(c.commands.map(command=>command.id)).size,3);
  for(const command of c.commands)assert.deepEqual(command.args,{manifest:f.manifestPath,state:f.statePath,limit:2});
  assert.deepEqual(c.commands.map(command=>command.continuationGuard),c.commands.map((command,index)=>({schemaVersion:1,previousTerminalId:index?c.commands[index-1].id:null,pauseGeneration:0,phase:index?'limit':'initial',connectionCount:1})));
  const report=JSON.parse(await fs.readFile(f.reportPath,'utf8'));
  assert.equal(report.maxRounds,5);assert.equal(report.boundRunId,f.run.id);assert.equal(report.preflightStatus.pending,null);
  assert.deepEqual(report.rounds.map(round=>[round.completedBefore,round.completedAfter]),[[0,2],[2,4],[4,5]]);
  assert.ok(report.rounds.every(round=>round.terminal&&round.timings[0].phase==='synthetic'));
  assert.ok(report.rounds.every(round=>round.continuationGuardAccepted.commandId===round.commandId));
  assert.ok(logs.length<=5);assert.equal(logs.at(-1).rounds,3);assert.equal(logs.some(row=>Array.isArray(row.timings)),false);
});

test('without continue a normal limit remains a single command and single-question trials stay bounded',async t=>{
  const f=await fixture(t),c=controller(f);
  const result=await runReviewedBatch(f.argv.filter(argument=>argument!=='--continue').map(argument=>argument==='--limit=2'?'--limit=1':argument),options(f,c));
  assert.equal(result.ok,true);assert.equal(result.limitReached,true);assert.equal(c.commands.length,1);
  assert.equal(c.commands[0].args.limit,1);assert.equal(result.continuationEnabled,false);
});

test('continue is a unique bare flag for execute only',async t=>{
  const f=await fixture(t);let calls=0;
  const opts={root:f.root,request:async()=>{calls++;throw new Error('must not dispatch');},log:()=>{}};
  await assert.rejects(runReviewedBatch(f.argv.map(argument=>argument==='--action=execute'?'--action=verify':argument),opts),/仅用于 execute/u);
  await assert.rejects(runReviewedBatch(f.argv.map(argument=>argument==='--continue'?'--continue=true':argument),opts),/只接受/u);
  await assert.rejects(runReviewedBatch([...f.argv,'--continue'],opts),/重复参数/u);assert.equal(calls,0);
});

test('verify defaults to all tasks; an explicit smaller limit remains respected',async t=>{
  for(const explicit of [false,true]){
    const f=await fixture(t,23),c=controller(f);
    const result=await runReviewedBatch(['--manifest=data/batch.json','--state=data/run.json','--action=verify',...(explicit?['--limit=3']:[])],options(f,c));
    assert.equal(c.commands.length,1);assert.equal(c.commands[0].args.limit,explicit?3:23);assert.equal(result.ok,true);
  }
});

test('default whole-manifest verify over 1000 fails before requesting the service',async t=>{
  const f=await fixture(t,1001);let calls=0;
  await assert.rejects(runReviewedBatch(['--manifest=data/batch.json','--state=data/run.json','--action=verify'],
    {root:f.root,request:async()=>{calls++;throw new Error('must not dispatch');},log:()=>{}}),/超过 1000/u);assert.equal(calls,0);
});

test('pause and non-limit terminal outcomes cannot trigger another command',async t=>{
  for(const reason of ['pause','other']){
    const f=await fixture(t),c=controller(f,{step:({latest})=>{latest.last.result.stopReason=reason;}});
    const result=await runReviewedBatch(f.argv,options(f,c));assert.equal(c.commands.length,1);
    assert.equal(result.ok,reason==='pause');assert.equal(result.continuationStopReason,reason==='pause'?'pause':'not-a-limit-stop');
  }
});

test('unknown saves, write locks, evidence errors and unsafe run entries never continue',async t=>{
  const cases=[
    ({latest})=>{latest.last.result.uncertain=true;},
    ({latest})=>{latest.writeBlocked=true;},
    ({latest})=>{latest.last.result.pendingWrite={task:{id:'synthetic-1'},evidencePath:'original-pending.json'};},
    ({latest})=>{latest.last.error='synthetic save error';},
    ({latest})=>{latest.last.result.evidenceError='synthetic evidence error';},
    ({latest})=>{delete latest.last.result.uncertain;},
    ({run})=>{run.tasks[2].status='writing';run.tasks[2].recoveryRequired=true;},
    ({run})=>{run.status='failed';run.tasks[2].status='failed';run.tasks[2].lastError='synthetic failure';}
  ];
  for(const step of cases){
    const f=await fixture(t),c=controller(f,{step}),result=await runReviewedBatch(f.argv,options(f,c));
    assert.equal(result.ok,false);assert.equal(result.continuationStopReason,'unsafe-terminal-state');assert.equal(c.commands.length,1);
    assert.equal(JSON.parse(await fs.readFile(f.reportPath,'utf8')).rounds.length,1);
  }
});

test('no progress and replaced completed task identities cannot loop',async t=>{
  for(const regress of [false,true]){
    const f=await fixture(t);
    if(regress){f.run.tasks[0].status='completed';await f.putRun();}
    const c=controller(f,{step:({run})=>{
      if(regress){run.tasks[0].status='pending';run.tasks[3].status='completed';}
      else run.tasks.forEach(row=>{row.status='pending';});
    }});
    const result=await runReviewedBatch(f.argv,options(f,c));
    assert.equal(result.ok,false);assert.equal(result.continuationStopReason,regress?'progress-regressed':'no-progress');assert.equal(c.commands.length,1);
  }
});

test('busy or blocked preflight and unsafe initial progress dispatch nothing',async t=>{
  for(const preflight of [{...idle(),pending:{id:'another-task'}},{...idle(),writeBlocked:true},{...idle(),error:'synthetic status error'}]){
    const f=await fixture(t),c=controller(f,{preflight});
    await assert.rejects(runReviewedBatch(f.argv,options(f,c)),/本地执行器已有任务/u);assert.equal(c.commands.length,0);
    assert.equal(JSON.parse(await fs.readFile(f.reportPath,'utf8')).rounds.length,0);
  }
  const f=await fixture(t);f.run.tasks[0].status='writing';f.run.tasks[0].recoveryRequired=true;await f.putRun();
  const c=controller(f);await assert.rejects(runReviewedBatch(f.argv,options(f,c)),/原进度有错误/u);assert.equal(c.commands.length,0);
});

test('a lost command response records one attempted ID without a retry',async t=>{
  const f=await fixture(t);let commands=0;
  const request=async(_root,command)=>{if(command.action==='status')return idle();commands++;throw new Error('synthetic response lost');};
  await assert.rejects(runReviewedBatch(f.argv,{root:f.root,request,log:()=>{}}),/response lost/u);
  assert.equal(commands,1);const report=JSON.parse(await fs.readFile(f.reportPath,'utf8'));
  assert.equal(report.ok,false);assert.equal(report.rounds.length,1);assert.equal(report.rounds[0].terminal,false);
  assert.equal(report.rounds[0].submissionAttempted,true);
});

test('disconnect, reconnect, pending pause and incomplete terminal proof never replay',async t=>{
  for(const step of [
    ({latest})=>{latest.connection='disconnected';},
    ({latest})=>{latest.error='synthetic transport error';},
    ({latest})=>{latest.pending={id:latest.last.id};latest.remote={job:{stopRequested:true}};},
    ({latest})=>{latest.last.terminal=false;}
  ]){
    const f=await fixture(t),c=controller(f,{step});
    await assert.rejects(runReviewedBatch(f.argv,options(f,c)),/连接|暂停|终止证明/u);assert.equal(c.commands.length,1);
  }
  const f=await fixture(t),c=controller(f,{onStatus:latest=>({...latest,connectionCount:2})});
  await assert.rejects(runReviewedBatch(f.argv,options(f,c)),/连接已重建/u);assert.equal(c.commands.length,1);
});

test('changed terminal command, manifest bytes, run ID or progress block the next round',async t=>{
  const mutations=[
    async(f,latest)=>({...latest,last:{...latest.last,id:'another-command'}}),
    async(f,latest)=>{await fs.appendFile(f.manifestPath,'\n');return latest;},
    async(f,latest)=>{f.run.id='replacement-run';await f.putRun();return latest;},
    async(f,latest)=>{f.run.tasks[2].status='completed';await f.putRun();return latest;}
  ];
  for(const mutate of mutations){
    const f=await fixture(t),c=controller(f,{onStatus:latest=>mutate(f,latest)});
    await assert.rejects(runReviewedBatch(f.argv,options(f,c)),/安全终止状态已变化|原题单.*变化|run.id 已变化|原进度在轮次之间变化|明确接受证明/u);
    assert.equal(c.commands.length,1);
  }
});

test('internal pending polling submits execute once and does not emit unchanged status repeatedly',async t=>{
  const f=await fixture(t,2),c=controller(f);let polls=0,commands=0,terminalStatus,logs=0;
  const request=async(root,command)=>{
    if(command.action==='status'&&!terminalStatus)return idle();
    if(command.action!=='status'){commands++;terminalStatus=await c.request(root,command);}
    if(++polls<30)return {...terminalStatus,pending:{id:terminalStatus.last.id},remote:{job:{phase:'synthetic-working',progress:{completed:0}}}};
    return terminalStatus;
  };
  const result=await runReviewedBatch(f.argv,{root:f.root,request,log:()=>{logs++;},pause:async()=>{}});
  assert.equal(result.ok,true);assert.equal(commands,1);assert.equal(polls,30);assert.ok(logs<=3);
});

test('missing fences, disconnected services and paused fences fail before dispatch',async t=>{
  const missing=idle();delete missing.continuationFence;
  for(const preflight of [missing,{...idle(),connection:'disconnected'}, {...idle(),continuationFence:{...idle().continuationFence,paused:true}}]){
    const f=await fixture(t),c=controller(f,{preflight});
    await assert.rejects(runReviewedBatch(f.argv,options(f,c)),/缺少有效接续保护|先显式 probe|已请求暂停/u);assert.equal(c.commands.length,0);
  }
});

test('a pause after terminal or any changed generation stops before another submission',async t=>{
  for(const paused of [false,true]){
    const f=await fixture(t),c=controller(f,{onStatus:latest=>({...latest,continuationFence:{...latest.continuationFence,pauseGeneration:1,paused}})});
    await assert.rejects(runReviewedBatch(f.argv,options(f,c)),/已请求暂停|generation 已变化/u);
    assert.equal(c.commands.length,1);assert.equal(c.attempts.length,1);
  }
});

test('server fence rejects a pause between checking status and submitting the next round',async t=>{
  const f=await fixture(t),c=controller(f,{beforeDispatch:({latest,accepted})=>{
    if(accepted===1){latest.continuationFence.pauseGeneration++;latest.continuationFence.paused=true;}
  }});
  await assert.rejects(runReviewedBatch(f.argv,options(f,c)),/接续保护拒绝/u);
  assert.equal(c.attempts.length,2);assert.equal(c.commands.length,1);
  const report=JSON.parse(await fs.readFile(f.reportPath,'utf8'));
  assert.equal(report.rounds.length,2);assert.equal(report.rounds[1].terminal,false);
  assert.equal(report.rounds[1].continuationGuard.pauseGeneration,0);
  assert.equal(report.rounds[1].continuationGuard.connectionCount,1);
  assert.equal(report.rounds[1].continuationGuard.previousTerminalId,c.commands[0].id);
});

test('initial guard carries an existing terminal ID and requires explicit acceptance proof',async t=>{
  const f=await fixture(t),preflight={...idle(),continuationFence:{...idle().continuationFence,previousTerminalId:'previous-probe'}};
  const c=controller(f,{preflight,step:({latest})=>{delete latest.last.continuationGuardAccepted;}});
  await assert.rejects(runReviewedBatch(f.argv,options(f,c)),/明确接受证明/u);
  assert.equal(c.commands.length,1);assert.equal(c.commands[0].continuationGuard.previousTerminalId,'previous-probe');
});

test('continue requires a positive connection count in the initial preflight',async t=>{
  for(const connectionCount of [0,-1,undefined,1.5]){
    const f=await fixture(t),c=controller(f,{preflight:{...idle(),connectionCount}});
    await assert.rejects(runReviewedBatch(f.argv,options(f,c)),/初始状态缺少有效连接身份/u);
    assert.equal(c.commands.length,0);assert.equal(c.attempts.length,0);
  }
});

test('reconnection during the first submission cannot be adopted or reported as success',async t=>{
  const f=await fixture(t,2),c=controller(f,{step:({latest})=>{latest.connectionCount=2;}});
  await assert.rejects(runReviewedBatch(f.argv,options(f,c)),/连接已重建/u);
  assert.equal(c.commands.length,1);assert.equal(c.attempts.length,1);
  const report=JSON.parse(await fs.readFile(f.reportPath,'utf8'));
  assert.equal(report.preflightStatus.connectionCount,1);assert.equal(report.ok,false);
  assert.equal(report.rounds[0].terminal,false);assert.equal(report.continuationStopReason,'supervision-error');
  assert.equal(f.run.status,'completed');
});

test('server rejects the initial guard if connection changes between preflight and dispatch',async t=>{
  const f=await fixture(t),c=controller(f,{beforeDispatch:({preflight})=>{preflight.connectionCount=2;}});
  await assert.rejects(runReviewedBatch(f.argv,options(f,c)),/接续保护拒绝/u);
  assert.equal(c.attempts.length,1);assert.equal(c.commands.length,0);
  assert.equal(c.attempts[0].continuationGuard.connectionCount,1);
  const report=JSON.parse(await fs.readFile(f.reportPath,'utf8'));
  assert.equal(report.ok,false);assert.equal(report.rounds[0].terminal,false);
  assert.equal(report.rounds[0].continuationGuard.connectionCount,1);
});
