import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {diagnoseRecorder,summarizeRecordedTimings} from '../src/recorder-diagnostics.mjs';

async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'recorder-diagnostics-'));
  t.after(async()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('recorder-diagnostics-'));await fs.rm(root,{recursive:true,force:true});});
  const directory=path.join(root,'data/persistent-executor');await fs.mkdir(directory,{recursive:true});
  return {root,directory,put:async(file,value)=>{const target=path.join(directory,file);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,JSON.stringify(value));return target;}};
}
const session={schemaVersion:1,bookId:101,pending:{id:'original',action:'execute',at:'2026-10-14T00:00:00Z',args:{private:'textbook content'}},writeBlocked:true,blockedContext:{manifest:'data/original.json',state:'data/run.json',manifestSha256:'a'.repeat(64),taskId:'q1',pendingPath:'data/intent.json'},pauseControl:{generation:4,paused:true},last:null};
const job={id:'original',action:'execute',bookId:101,terminal:true,running:false,phase:'terminal',startedAt:'2026-10-14T00:00:00Z',finishedAt:'2026-10-14T00:00:02Z',timings:[{phase:'saved-record-readback',elapsedMs:1200},{phase:'local-review',elapsedMs:100},{phase:'saved-record-readback',elapsedMs:500}],result:{stateStatus:'failed',uncertain:true,records:[{stem:'private textbook content'}]}};

test('diagnostics preserve original lock/pause/files and report timings without contents',async t=>{
  const f=await fixture(t),sessionPath=await f.put('session.json',session),jobPath=await f.put('jobs/original/job-result.json',job);
  const before=await Promise.all([fs.readFile(sessionPath),fs.readFile(jobPath)]),report=await diagnoseRecorder(f.root);
  assert.equal(report.readOnly,true);assert.equal(report.productionChecked,false);assert.equal(report.source,'local-files');assert.equal(report.writeBlocked,true);
  assert.equal(report.nextStep.code,'reconcile-original-save');assert.equal(report.nextStep.binding.taskId,'q1');assert.deepEqual(report.pauseControl,{generation:4,paused:true});
  assert.deepEqual(report.job.timings.phases[0],{phase:'saved-record-readback',calls:2,elapsedMs:1700,maxMs:1200});assert.equal(report.job.timings.wallTimeMs,2000);
  assert.doesNotMatch(JSON.stringify(report),/private textbook content|"args"|"records"/u);
  assert.deepEqual(await Promise.all([fs.readFile(sessionPath),fs.readFile(jobPath)]),before);
});
test('terminal evidence cannot recommend retry or unlock',async t=>{
  const f=await fixture(t);await f.put('session.json',{...session,writeBlocked:false,blockedContext:null});await f.put('jobs/original/job-result.json',job);
  const report=await diagnoseRecorder(f.root);assert.equal(report.nextStep.code,'terminal-evidence-available');assert.equal(report.pending.id,'original');
});
test('no local session is diagnosed without creating runtime files',async t=>{
  const f=await fixture(t),before=await fs.readdir(f.directory);const report=await diagnoseRecorder(f.root);assert.equal(report.nextStep.code,'no-local-session');assert.deepEqual(await fs.readdir(f.directory),before);
});
test('historical job evidence cannot stand in for the current pending job',async t=>{
  const f=await fixture(t);await f.put('session.json',session);await f.put('jobs/older/job-result.json',{...job,id:'older'});
  const report=await diagnoseRecorder(f.root,{jobId:'older'});assert.equal(report.boundToCurrent,false);assert.equal(report.nextStep.code,'historical-command');assert.equal(report.pending.id,'original');assert.equal(report.writeBlocked,true);
});
test('cross-book, renamed command, and traversing job IDs are rejected',async t=>{
  const f=await fixture(t);await f.put('session.json',session);
  for(const changed of [{...job,bookId:202},{...job,id:'renamed'}]){await f.put('jobs/original/job-result.json',changed);await assert.rejects(diagnoseRecorder(f.root),/不符/u);}
  await assert.rejects(diagnoseRecorder(f.root,{jobId:'../../outside'}),/原命令/u);
});

test('malformed current commands cannot fall back to a previous terminal job',async t=>{
  const f=await fixture(t);await f.put('jobs/original/job-result.json',job);
  for(const pending of ['corrupt',{}, {id:'original'}, {id:'original',action:'unexpected'}]){
    const file=await f.put('session.json',{...session,pending,last:{id:'original',action:'execute',terminal:true}}),before=await fs.readFile(file);
    await assert.rejects(diagnoseRecorder(f.root),/命令或锁状态无效/u);assert.deepEqual(await fs.readFile(file),before);
  }
  await f.put('session.json',{...session,schemaVersion:2});await assert.rejects(diagnoseRecorder(f.root),/无效/u);
});

test('a same-ID terminal file for another action cannot describe the current command',async t=>{
  const f=await fixture(t);await f.put('session.json',session);await f.put('jobs/original/job-result.json',{...job,action:'verify'});
  await assert.rejects(diagnoseRecorder(f.root),/原命令动作不符/u);
});
test('credential fields in errors are omitted and invalid timing samples cannot distort totals',async t=>{
  const f=await fixture(t);await f.put('session.json',session);await f.put('jobs/original/job-result.json',{...job,error:'token=private-secret https://example.com/private'});
  const report=await diagnoseRecorder(f.root);assert.doesNotMatch(JSON.stringify(report),/private-secret|example\.com/u);
  const timing=summarizeRecordedTimings({...job,timings:[...job.timings,{phase:'fake',elapsedMs:-5000},{phase:'private text',elapsedMs:999999}]});
  assert.equal(timing.recordedPhaseTimeMs,1800);assert.equal(timing.invalidSamples,2);
});
