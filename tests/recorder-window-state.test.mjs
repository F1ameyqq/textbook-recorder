import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import fs from 'node:fs/promises';
import { manageRecorderWindow, recorderWindowHelperLaunch } from '../src/recorder-window-state.mjs';

function fixture({ beforeEvaluate, afterEvaluate, guard: guardHook, execute: executeHook } = {}) {
  const context = { document:{ title:'Original title', editorText:'Protected reviewed content' }, location:{ href:'about:blank' }, performance:{ timeOrigin:1000 } };
  const events = []; let evaluations = 0, launches = 0, guards = 0;
  const page = { async evaluate(fn, argument) {
    evaluations++; events.push('evaluate');
    await beforeEvaluate?.(evaluations, context, argument);
    const result = vm.runInNewContext(`(${fn.toString()})(argument)`, { ...context, argument });
    await afterEvaluate?.(evaluations, context, argument);
    return result;
  } };
  const guard = async () => { guards++; events.push('guard'); await guardHook?.(guards, context); };
  const execute = async launch => {
    launches++; events.push('execute');
    const marker = launch.args[launch.args.indexOf('-Marker') + 1], action = launch.args[launch.args.indexOf('-Action') + 1];
    assert.match(marker, /^recorder-window-[a-f0-9-]{36}$/u);
    assert.equal(context.document.title, marker);
    assert.equal(launch.options.windowsHide, true);
    const value = await executeHook?.(launch, context);
    return value ?? JSON.stringify({ windowId:'4294967297', windowState:action === 'minimize' ? 'minimized' : 'normal', backend:'win32' });
  };
  return { page, guard, execute, context, events, get evaluations(){return evaluations;}, get launches(){return launches;} };
}

test('window helper uses an absolute hidden PowerShell child with structured marker/action arguments', () => {
  const marker = 'recorder-window-11111111-2222-3333-4444-555555555555';
  const launch = recorderWindowHelperLaunch(marker, 'read');
  assert.equal(path.win32.isAbsolute(launch.command), true);
  assert.match(launch.command, /\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/iu);
  assert.equal(launch.options.windowsHide, true);
  assert.equal(launch.args.includes('-Command'), false);
  assert.deepEqual(launch.args.slice(launch.args.indexOf('-ExecutionPolicy'), launch.args.indexOf('-File')), ['-ExecutionPolicy','Bypass']);
  assert.deepEqual(launch.args.slice(-4), ['-Marker',marker,'-Action','read']);
  for (const value of ['restore','activate','read; arbitrary']) assert.throws(() => recorderWindowHelperLaunch(marker,value));
  for (const value of ['arbitrary','recorder-window-$(command)',marker+' suffix']) assert.throws(() => recorderWindowHelperLaunch(value,'read'));
});

test('read and minimize bind a fresh marker and restore only the original title without editor mutations', async t => {
  const markers = new Set();
  for (const action of ['read','minimize']) await t.test(action, async () => {
    const f = fixture({ execute:async launch => { markers.add(launch.args.at(-3)); } });
    const result = await manageRecorderWindow(f.page,action,f.guard,{execute:f.execute});
    assert.deepEqual(result,{windowId:'4294967297',windowState:action === 'minimize' ? 'minimized' : 'normal',backend:'win32'});
    assert.equal(f.context.document.title,'Original title');
    assert.equal(f.context.document.editorText,'Protected reviewed content');
    assert.equal(f.launches,1);
    const dispatch=f.events.indexOf('execute');
    assert.equal(f.events[dispatch-1],'guard');assert.equal(f.events[dispatch+1],'guard');
  });
  assert.equal(markers.size,2);
});

test('lost marker-write response restores the captured original title and never invokes the window helper', async () => {
  const f = fixture({ afterEvaluate:async count => { if(count===2)throw new Error('Lost transport response'); } });
  await assert.rejects(manageRecorderWindow(f.page,'minimize',f.guard,{execute:f.execute}),/Lost transport response/u);
  assert.equal(f.launches,0);assert.equal(f.context.document.title,'Original title');
  assert.equal(f.context.document.editorText,'Protected reviewed content');
});

test('failed marker-write before mutation leaves the title unchanged and performs no window action', async () => {
  const f = fixture({ beforeEvaluate:async count => { if(count===2)throw new Error('Transport stopped before mutation'); } });
  await assert.rejects(manageRecorderWindow(f.page,'minimize',f.guard,{execute:f.execute}),/before mutation/u);
  assert.equal(f.launches,0);assert.equal(f.context.document.title,'Original title');
});

test('a changed document between capture and marker assignment is not modified or dispatched', async t => {
  for (const change of ['epoch','url','title']) await t.test(change, async () => {
    const f=fixture({beforeEvaluate:async(count,context)=>{
      if(count!==2)return;
      if(change==='epoch')context.performance.timeOrigin++;
      if(change==='url')context.location.href='about:blank#new';
      if(change==='title')context.document.title='New application title';
    }});
    await assert.rejects(manageRecorderWindow(f.page,'read',f.guard,{execute:f.execute}),/document changed/u);
    assert.equal(f.launches,0);assert.equal(f.context.document.title,change==='title'?'New application title':'Original title');
  });
});

test('scope guard failure before dispatch prevents the helper and forbids title cleanup on another scope', async () => {
  let scopeChanged=false;
  const f=fixture({afterEvaluate:async count=>{if(count===2)scopeChanged=true;},guard:async()=>{if(scopeChanged)throw new Error('Book scope changed');}});
  await assert.rejects(manageRecorderWindow(f.page,'minimize',f.guard,{execute:f.execute}),/Book scope changed/u);
  assert.equal(f.launches,0);assert.match(f.context.document.title,/^recorder-window-/u);
});

test('post-helper scope loss fails closed and cannot restore a title in the changed scope', async () => {
  let scopeChanged=false;
  const f=fixture({execute:async()=>{scopeChanged=true;},guard:async()=>{if(scopeChanged)throw new Error('Book scope changed');}});
  await assert.rejects(manageRecorderWindow(f.page,'minimize',f.guard,{execute:f.execute}),/Book scope changed/u);
  assert.equal(f.launches,1);assert.match(f.context.document.title,/^recorder-window-/u);
});

test('helper failure restores its own marker while preserving the original failure', async () => {
  const f=fixture({execute:async()=>{throw new Error('Synthetic helper refusal');}});
  await assert.rejects(manageRecorderWindow(f.page,'read',f.guard,{execute:f.execute}),/Synthetic helper refusal/u);
  assert.equal(f.context.document.title,'Original title');
});

test('a committed reload finishes loading before capturing and marking the document', async () => {
  const f = fixture();
  f.page.waitForLoadState = async (state, options) => {
    assert.equal(state, 'load'); assert.equal(options.timeout, 10000);
    assert.equal(f.evaluations, 0); assert.equal(f.launches, 0);
    f.context.document.title = 'Loaded application title';
  };
  await manageRecorderWindow(f.page, 'read', f.guard, {execute:f.execute});
  assert.equal(f.context.document.title, 'Loaded application title');
});

test('application title replacement during failed discovery is reported without overwriting it', async () => {
  const f = fixture({execute:async (_launch, context) => {
    context.document.title = 'Loaded application title';
    throw new Error('Synthetic helper refusal');
  }});
  await assert.rejects(manageRecorderWindow(f.page, 'read', f.guard, {execute:f.execute}), /title changed during window discovery/u);
  assert.equal(f.context.document.title, 'Loaded application title');
  assert.equal(f.context.document.editorText, 'Protected reviewed content');
});

test('changed marker, URL or same-URL document epoch after the helper is never overwritten', async t => {
  for(const change of ['marker','url','epoch'])await t.test(change,async()=>{
    const f=fixture({execute:async(_launch,context)=>{
      if(change==='marker')context.document.title='New application title';
      if(change==='url')context.location.href='about:blank#new';
      if(change==='epoch')context.performance.timeOrigin++;
    }});
    await assert.rejects(manageRecorderWindow(f.page,'read',f.guard,{execute:f.execute}),/marker changed/u);
    assert.equal(f.context.document.title==='Original title',false);
    assert.equal(f.context.document.editorText,'Protected reviewed content');
  });
});

test('strict receipts reject unknown fields, window IDs, backend, malformed JSON and unverified minimization', async t => {
  const good={windowId:'1',windowState:'minimized',backend:'win32'};
  const invalid={extra:{...good,title:'private title'},numberID:{...good,windowId:1},zeroID:{...good,windowId:'0'},negativeID:{...good,windowId:'-1'},oversizedID:{...good,windowId:'9223372036854775808'},badBackend:{...good,backend:'other'},wrongState:{...good,windowState:'normal'},malformed:'not-json'};
  for(const[name,value]of Object.entries(invalid))await t.test(name,async()=>{
    const f=fixture({execute:async()=>typeof value==='string'?value:JSON.stringify(value)});
    await assert.rejects(manageRecorderWindow(f.page,'minimize',f.guard,{execute:f.execute}),/invalid receipt/u);
    assert.equal(f.context.document.title,'Original title');
  });
});

test('PowerShell implementation only permits no-activate minimization and bounded unique Edge window checks', async () => {
  const source=await fs.readFile(new URL('../scripts/recorder-window-state.ps1',import.meta.url),'utf8');
  assert.equal(/[^\x00-\x7f]/u.test(source),false);
  assert.match(source,/ShowWindowAsync\(\$owned\.Handle, 7\)/u);
  assert.doesNotMatch(source,/SetForegroundWindow|BringWindowToTop|SetFocus|SetWindowPos|chrome\.tabs|SW_RESTORE/u);
  assert.match(source,/\$current\.Count -ne 1/u);
  assert.match(source,/\$current\[0\]\.Handle -ne \$Expected\.Handle/u);
  assert.match(source,/\$current\[0\]\.ProcessId -ne \$Expected\.ProcessId/u);
  assert.match(source,/ProcessName -ine 'msedge'/u);
  assert.match(source,/discovery\.ElapsedMilliseconds -ge 2000/u);
  assert.match(source,/verification\.ElapsedMilliseconds -ge 2000/u);
  assert.match(source,/Assert-MarkerWindow \$owned\s+if \(-not \[RecorderWindowNative\]::ShowWindowAsync/u);
});

test('extension window proof does not mutate the title or invoke the Windows fallback', async () => {
  const f=fixture();
  f.page.context=()=>({browser:()=>({__textbookRecorderWindowBridge:{manage:async(page,action)=>{
    assert.equal(page,f.page);assert.equal(action,'minimize');
    assert.equal(f.context.document.title,'Original title');
    return {tabId:11,windowId:22,windowState:'minimized'};
  }}})});
  assert.deepEqual(await manageRecorderWindow(f.page,'minimize',f.guard,{execute:f.execute}),{windowId:'22',windowState:'minimized',backend:'extension'});
  assert.equal(f.launches,0);assert.equal(f.context.document.title,'Original title');
});

test('extension failure or document replacement never falls back to a caption or accepts proof', async t => {
  for(const change of ['failure','epoch','url','extra'])await t.test(change,async()=>{
    const f=fixture();
    f.page.context=()=>({browser:()=>({__textbookRecorderWindowBridge:{manage:async()=>{
      if(change==='failure')throw new Error('Extension binding lost');
      if(change==='epoch')f.context.performance.timeOrigin++;
      if(change==='url')f.context.location.href='about:blank#replacement';
      return {tabId:11,windowId:22,windowState:'minimized',...(change==='extra'?{unexpected:true}:{})};
    }}})});
    await assert.rejects(manageRecorderWindow(f.page,'minimize',f.guard,{execute:f.execute}),/Extension binding lost|document changed|invalid window receipt/u);
    assert.equal(f.launches,0);assert.equal(f.context.document.title,'Original title');
  });
});
