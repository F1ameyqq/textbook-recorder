import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parseOptions, isBookTab, parseTabs, selectBookTab, validateToolSet, parseBridgeResult, buildBridgeSource, acquireLock, safeDiagnosticMessage, main } from '../scripts/run-new-system-extension.mjs';

const url = 'https://easylearn.baidu.com/edu-shop-web/#/content-manager/teaching-content?textbookID=100001&textbookType=main';
const productionManifest = () => ({ schemaVersion:1, kind:'new-system-batch', bookId:100001, source:'production', tasks:[{ id:'q1', target:{ chapterLabel:'第十三章 内能', sectionLabel:'第2节 分子动理论的初步知识', record:1 }, source:{ pages:[15], answerPages:[243] }, stem:{ blocks:[{ type:'text', text:'题干' }] }, answer:{ blocks:[{ type:'text', text:'D' }] }, review:{ status:'approved', issues:[] } }] });
test('extension defaults to local validation and rejects incompatible modes/profile relaunch options', () => {
  assert.equal(parseOptions(['--manifest=sample.json']).mode, 'validate');
  assert.equal(parseOptions(['--manifest', 'sample.json', '--verify-only', '--tab-index=0']).tabIndex, 0);
  for (const args of [['--validate', '--execute'], ['--profile-dir-name=Default'], ['--remote-debugging-port=9222'], ['--limit=0'], ['--tab-index=-1']]) assert.throws(() => parseOptions(['--manifest=x', ...args]));
});
test('input mode defaults to native paste and accepts only explicitly supported browser commands', () => {
  assert.equal(parseOptions(['--manifest=sample.json']).inputMode, 'native-paste');
  assert.equal(parseOptions(['--manifest=sample.json', '--input-mode=native-paste']).inputMode, 'native-paste');
  assert.equal(parseOptions(['--manifest=sample.json', '--execute', '--input-mode', 'browser-command']).inputMode, 'browser-command');
  for (const mode of ['clipboard', 'browser-command-unsafe', 'NATIVE-PASTE']) assert.throws(() => parseOptions(['--manifest=sample.json', `--input-mode=${mode}`]));
  assert.throws(() => parseOptions(['--manifest=sample.json', '--input-mode']));
});
test('strict tab guard rejects wrong book, old system, spoofed origin and duplicate IDs', () => {
  assert.equal(isBookTab(url, 100001), true);
  for (const wrong of [url.replace('100001', '146005'), url.replace('teaching-content', 'document-assistant'), url.replace('easylearn.baidu.com', 'easylearn.baidu.com.evil.test'), url.replace('/edu-shop-web/', '/different/'), `${url}&textbookID=100001`, url.replace('textbookType=main', 'textbookType=answer'), url.replace('https://', 'https://user:pass@')]) assert.equal(isBookTab(wrong, 100001), false);
});
test('official tabs formatting is parsed without logging or selecting unrelated tabs', () => {
  const tabs = parseTabs({ content:[{ type:'text', text:`### Open tabs\n- 0: (current) [Unrelated](https://private.example/foo)\n- 2: [百度教育](${url})` }] });
  assert.equal(selectBookTab(tabs, 100001).index, 2);
  assert.throws(() => selectBookTab(tabs, 100001, 0));
  assert.throws(() => selectBookTab([...tabs, { index:3, url }], 100001));
  assert.equal(selectBookTab([...tabs, { index:3, url }], 100001, 3).index, 3);
  assert.throws(() => parseTabs({ content:[{ type:'text', text:'unrecognized response' }] }));
});
test('missing tool capability and error replies fail closed', () => {
  const tools = [{ name:'browser_tabs', inputSchema:{ properties:{ action:{ enum:['list','select'] } } } }, { name:'browser_run_code_unsafe', inputSchema:{ properties:{ code:{ type:'string' } } } }];
  assert.doesNotThrow(() => validateToolSet(tools));
  assert.throws(() => validateToolSet(tools.slice(0, 1)));
  assert.throws(() => parseBridgeResult({ isError:true, content:[{ type:'text', text:'private connection token' }] }));
  assert.deepEqual(parseBridgeResult({ content:[{ type:'text', text:'### Result\n{"bookId":100001,"finished":true}\n### Ran Playwright code\nunsafe body' }] }), { bookId:100001, finished:true });
});

test('internal extension and blank tabs are inventoried but cannot be selected as a book', () => {
  const tabs = parseTabs({content:[{type:'text',text:`### Result\n- 0: (current) [Welcome](${'chrome-extension://'+'extension-id/connect.html?mcpRelayUrl=private'})\n- 1: [Blank](about:blank)\n- 2: [百度教育](${url})`}]});
  assert.equal(tabs.length,3); assert.equal(selectBookTab(tabs,100001).index,2);
  assert.throws(()=>selectBookTab(tabs,100001,0)); assert.throws(()=>selectBookTab(tabs,100001,1));
  const diagnostic=safeDiagnosticMessage('chrome-extension://'+'extension-id/connect.html?mcpRelayUrl=private PLAYWRIGHT_MCP_EXTENSION_TOKEN=hidden');
  assert.doesNotMatch(diagnostic,/private|hidden|extension-id/u);
});
test('diagnostics retain unsupported protocol method but omit URL/token credential details', () => {
  const message = safeDiagnosticMessage('Protocol error Browser.grantPermissions: unsupported; https://private.example/?token=secret#private token=abcdef\nCookie: session=private');
  assert.match(message, /Browser\.grantPermissions: unsupported/u);
  assert.doesNotMatch(message, /private|secret|abcdef|session=/u);
});
test('ordinary CJS init-page installs Node bridge accessible through a restricted VM', async () => {
  const config = { bookId:100001, mode:'verify-only', statePath:'C:\\owned\\progress.json', manifestPath:'C:\\owned\\manifest.json', baseDir:'C:\\owned' };
  const context = vm.createContext({ exports:{}, URL, URLSearchParams });
  vm.runInContext(buildBridgeSource(config), context);
  const page = { url:() => url };
  await context.exports.default({ page });
  assert.equal(typeof page.__localRecorderBridge.status, 'function');
  assert.equal(Object.getOwnPropertyDescriptor(page, '__localRecorderBridge').enumerable, false);
  const restrictedCall = vm.runInContext('async (page) => page.__localRecorderBridge.status()', vm.createContext({}));
  const status = await restrictedCall(page);
  assert.equal(status.bookId, 100001);
  assert.equal(status.inputMode, 'native-paste');
  assert.equal(status.started, false, 'installing bridge must not start a task');
  page.url = () => url.replace('100001', '146005');
  assert.throws(() => page.__localRecorderBridge.status(), /不一致/u);
});
test('bridge source preserves original absolute asset directory and never closes browser', () => {
  const source = buildBridgeSource({ baseDir:'D:\\Money\\原题目录', bookId:100001, mode:'execute' });
  assert.match(source, /baseDir:config\.baseDir/u);
  assert.match(source, /await atomic\(config\.statePath, snapshot\)/u);
  assert.doesNotMatch(source, /\.close\(|launchPersistentContext|cookies\(/u);
});
test('bridge forwards the selected input mode to its adapter and successful report', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-input-mode-'));
  t.after(() => fs.rm(dir, { recursive:true, force:true }));
  const manifestPath = path.join(dir, 'manifest.json'), statePath = path.join(dir, 'run.json'), reportPath = path.join(dir, 'report.json');
  const optionsPath = path.join(dir, 'adapter-options.json');
  await fs.writeFile(manifestPath, JSON.stringify(productionManifest()));
  await fs.writeFile(statePath, JSON.stringify({ status:'pending', tasks:[{ taskId:'q1', status:'pending' }] }));
  const adapterPath = path.join(dir, 'adapter.mjs'), corePath = path.join(dir, 'core.mjs');
  await fs.writeFile(adapterPath, `import fs from 'node:fs/promises'; export class NewSystemAdapter { constructor(options){ this.options=options; } async connect(bookId){ await fs.writeFile(${JSON.stringify(optionsPath)}, JSON.stringify({ inputMode:this.options.inputMode, source:this.options.source, bookId })); } }`);
  await fs.writeFile(corePath, "export async function runNewSystemBatch({state,persist}){ state.status='completed'; state.tasks[0].status='completed'; await persist(state); return state; }");
  const bridgePath = path.join(dir, 'bridge.cjs');
  await fs.writeFile(bridgePath, buildBridgeSource({ bookId:100001, mode:'execute', inputMode:'browser-command', manifestPath, statePath, reportPath, baseDir:dir, dataDir:dir, adapterModuleURL:pathToFileURL(adapterPath).href, coreModuleURL:pathToFileURL(corePath).href }));
  const loaded = createRequire(import.meta.url)(bridgePath);
  const page = { url:() => url, screenshot:async () => {} };
  await loaded.default({ page });
  page.__localRecorderBridge.start();
  let status;
  for (let i = 0; i < 50; i++) { status = page.__localRecorderBridge.status(); if (status.finished) break; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(status.finished, true);
  assert.equal(status.error, null);
  assert.equal(status.inputMode, 'browser-command');
  assert.deepEqual(JSON.parse(await fs.readFile(optionsPath, 'utf8')), { inputMode:'browser-command', source:'production', bookId:100001 });
  const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
  assert.equal(report.status, 'completed');
  assert.equal(report.inputMode, 'browser-command');
});
test('local validation never connects MCP or acquires browser state', async t => {
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'share-validation-'));
  t.after(()=>fs.rm(temporary,{recursive:true,force:true}));
  const filename=path.join(temporary,'sample.json');
  const manifest=productionManifest();manifest.source='fixture';
  await fs.writeFile(filename,JSON.stringify(manifest));
  let calls = 0;
  const code = await main(['--manifest', filename], { connect:async () => { calls++; throw new Error('must not connect'); }, log:() => {}, installSignals:false });
  assert.equal(code, 0); assert.equal(calls, 0);
});
test('held batches reject execute before connection, state creation or either lock', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-held-execute-'));
  t.after(() => fs.rm(dir, { recursive:true, force:true }));
  const filename = path.join(dir, 'approved.json'), statePath = path.join(dir, 'run.json'), browserLockPath = path.join(dir, 'extension.lock');
  const holdPath = path.join(dir, 'task-hold.json');
  const hold = JSON.stringify({ batchHeld:true, reason:'input verification pending' });
  await fs.writeFile(filename, JSON.stringify(productionManifest()));
  await fs.writeFile(holdPath, hold);
  let calls = 0;
  await assert.rejects(main(['--manifest', filename, '--state', statePath, '--execute', '--input-mode=browser-command'], { connect:async () => { calls++; throw new Error('must not connect'); }, log:() => {}, installSignals:false, browserLockPath }), /task-hold\.json.*batchHeld=true.*暂停/u);
  assert.equal(calls, 0);
  for (const candidate of [statePath, `${statePath}.lock`, `${statePath}.bridge.cjs`, `${statePath}.report.json`, browserLockPath]) await assert.rejects(fs.stat(candidate), { code:'ENOENT' });
  assert.equal(await fs.readFile(holdPath, 'utf8'), hold);
});
test('held batches still allow local validation and read-only verification', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-held-readonly-'));
  t.after(() => fs.rm(dir, { recursive:true, force:true }));
  const filename = path.join(dir, 'approved.json'), statePath = path.join(dir, 'verify.json'), browserLockPath = path.join(dir, 'extension.lock');
  const holdPath = path.join(dir, 'task-hold.json');
  const hold = JSON.stringify({ batchHeld:true, reason:'input verification pending' });
  await fs.writeFile(filename, JSON.stringify(productionManifest()));
  await fs.writeFile(holdPath, hold);
  let connectCalls = 0, closed = 0;
  const calls = [];
  const connect = async bridgePath => {
    connectCalls++;
    assert.match(await fs.readFile(bridgePath, 'utf8'), /"inputMode":"browser-command"/u);
    return { client:{
      async listTools() { return { tools:[{ name:'browser_tabs', inputSchema:{ properties:{ action:{ enum:['list','select'] } } } }, { name:'browser_run_code_unsafe', inputSchema:{ properties:{ code:{ type:'string' } } } }] }; },
      async callTool(request) {
        calls.push(request);
        if (request.name === 'browser_tabs' && request.arguments.action === 'list') return { structuredContent:{ tabs:[{ index:0, url }] } };
        if (request.name === 'browser_tabs') return { content:[] };
        return { structuredContent:request.arguments.code.includes('.start()') ? { started:true, bookId:100001, mode:'verify-only' } : { started:true, finished:true, running:false, bookId:100001, mode:'verify-only', stateStatus:'completed', counts:{ skipped_existing:1 }, error:null } };
      },
    }, close:async () => { closed++; } };
  };
  const dependencies = { connect, log:() => {}, pause:async () => {}, installSignals:false, browserLockPath };
  assert.equal(await main(['--manifest', filename, '--validate'], dependencies), 0);
  assert.equal(connectCalls, 0);
  await assert.rejects(fs.stat(statePath), { code:'ENOENT' });
  assert.equal(await main(['--manifest', filename, '--state', statePath, '--verify-only', '--input-mode=browser-command'], dependencies), 0);
  assert.equal(connectCalls, 1);
  assert.equal(closed, 1);
  assert.equal(calls.filter(call => call.name === 'browser_run_code_unsafe' && call.arguments.code.includes('.start()')).length, 1);
  assert.equal(await fs.readFile(holdPath, 'utf8'), hold);
  await assert.rejects(fs.stat(browserLockPath), { code:'ENOENT' });
});
test('run lock prevents simultaneous starts and releases its own lock', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-lock-'));
  t.after(() => fs.rm(dir, { recursive:true, force:true }));
  const filename = path.join(dir, 'run.lock');
  const unlock = await acquireLock(filename);
  await assert.rejects(acquireLock(filename), /正在运行/u);
  await unlock();
  const second = await acquireLock(filename); await second();
});
test('legacy CLI cannot steal a lock with dead supervisor and live MCP service', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-orphan-service-lock-'));
  t.after(() => fs.rm(dir, { recursive:true, force:true }));
  const filename = path.join(dir, 'run.lock');
  const saved = JSON.stringify({ pid:2147483647, servicePid:process.pid, bookId:100001 });
  await fs.writeFile(filename, saved);
  await assert.rejects(acquireLock(filename), /MCP 服务进程仍在运行/u);
  assert.equal(await fs.readFile(filename, 'utf8'), saved, 'must preserve the orphan service lock byte-for-byte');
});
test('legacy CLI cannot steal an unconfirmed service lock even when both recorded PIDs are dead', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-unconfirmed-lock-'));
  t.after(() => fs.rm(dir, { recursive:true, force:true }));
  const filename = path.join(dir, 'run.lock');
  for (const details of [{servicePid:2147483647},{}]) {
    const saved = JSON.stringify({pid:2147483647,unconfirmedService:true,...details});
    await fs.writeFile(filename, saved);
    await assert.rejects(acquireLock(filename), /服务退出尚未确认.*禁止接管/u);
    assert.equal(await fs.readFile(filename, 'utf8'), saved);
  }
});
test('legacy CLI may recover a confirmed stale lock only after supervisor and service are both absent', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-stale-service-lock-'));
  t.after(() => fs.rm(dir, { recursive:true, force:true }));
  const filename = path.join(dir, 'run.lock');
  await fs.writeFile(filename, JSON.stringify({pid:2147483647,servicePid:2147483647,unconfirmedService:false}));
  const unlock = await acquireLock(filename, {bookId:100001});
  assert.deepEqual(JSON.parse(await fs.readFile(filename, 'utf8')), {bookId:100001,pid:process.pid});
  await unlock(); await assert.rejects(fs.stat(filename), {code:'ENOENT'});
});
test('legacy CLI rejects malformed service PIDs rather than treating them as stale', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-invalid-service-lock-'));
  t.after(() => fs.rm(dir, { recursive:true, force:true }));
  const filename = path.join(dir, 'run.lock');
  for (const servicePid of [0,-1,'2147483647',1.5]) {
    const saved = JSON.stringify({pid:2147483647,servicePid});
    await fs.writeFile(filename, saved);
    await assert.rejects(acquireLock(filename), /服务进程标识无效/u);
    assert.equal(await fs.readFile(filename, 'utf8'), saved);
  }
});
test('MCP entry selects the existing exact-book tab and starts bridge once without browser close', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-cli-'));
  t.after(() => fs.rm(dir, { recursive:true, force:true }));
  const manifest = { schemaVersion:1, kind:'new-system-batch', bookId:100001, source:'production', tasks:[{ id:'q1', target:{ chapterLabel:'第十三章 内能', sectionLabel:'第2节 分子动理论的初步知识', record:1 }, source:{ pages:[15], answerPages:[243] }, stem:{ blocks:[{ type:'text', text:'题干' }] }, answer:{ blocks:[{ type:'text', text:'D' }] }, review:{ status:'approved', issues:[] } }] };
  const filename = path.join(dir, 'approved.json');
  await fs.writeFile(filename, JSON.stringify(manifest));
  const calls = [], logs = [];
  let closed = 0, bridge;
  const client = {
    async listTools() { return { tools:[{ name:'browser_tabs', inputSchema:{ properties:{ action:{ enum:['list','select'] } } } }, { name:'browser_run_code_unsafe', inputSchema:{ properties:{ code:{ type:'string' } } } }] }; },
    async callTool(request) {
      calls.push(request);
      if (request.name === 'browser_tabs' && request.arguments.action === 'list') return { content:[{ type:'text', text:`### Open tabs\n- 0: [PRIVATE](https://private.example/secret)\n- 1: [百度教育](${url})` }] };
      if (request.name === 'browser_tabs') return { content:[] };
      const result = request.arguments.code.includes('.start()') ? { started:true, bookId:100001, mode:'verify-only' } : { started:true, finished:true, running:false, bookId:100001, mode:'verify-only', stateStatus:'completed', counts:{ skipped_existing:1 }, error:null };
      return { content:[{ type:'text', text:`### Result\n${JSON.stringify(result)}\n### Ran Playwright code\nbody` }] };
    },
  };
  const code = await main(['--manifest', filename, '--verify-only'], { connect:async bridgePath => { bridge = await fs.readFile(bridgePath, 'utf8'); return { client, close:async () => { closed++; } }; }, log:message => logs.push(message), pause:async () => {}, installSignals:false, browserLockPath:path.join(dir, 'extension.lock') });
  assert.equal(code, 0);
  assert.equal(closed, 1);
  assert.equal(calls.filter(call => call.name === 'browser_run_code_unsafe' && call.arguments.code.includes('.start()')).length, 1);
  assert.deepEqual(calls.filter(call => call.name === 'browser_tabs').map(call => call.arguments), [{ action:'list' }, { action:'select', index:1 }]);
  assert.doesNotMatch(logs.join('\n'), /private\.example|secret/u);
  assert.doesNotMatch(bridge, /context\.close|browser\.close|page\.close/u);
});
test('bootstrap failure writes actionable sanitized diagnostic report before finished', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-bootstrap-'));
  t.after(() => fs.rm(dir, { recursive:true, force:true }));
  const manifestPath = path.join(dir, 'manifest.json'), statePath = path.join(dir, 'run.json'), reportPath = path.join(dir, 'report.json');
  await fs.writeFile(manifestPath, JSON.stringify({ bookId:100001 }));
  await fs.writeFile(statePath, '{}');
  const adapterPath = path.join(dir, 'adapter.mjs'), corePath = path.join(dir, 'core.mjs');
  await fs.writeFile(adapterPath, "export class NewSystemAdapter { async connect(){ throw new Error('Protocol error Browser.grantPermissions: unsupported https://private.example/?token=credential'); } }");
  await fs.writeFile(corePath, "export async function runNewSystemBatch(){ throw new Error('must not reach core'); }");
  const bridgePath = path.join(dir, 'bridge.cjs');
  await fs.writeFile(bridgePath, buildBridgeSource({ bookId:100001, mode:'verify-only', manifestPath, statePath, reportPath, baseDir:dir, dataDir:dir, adapterModuleURL:pathToFileURL(adapterPath).href, coreModuleURL:pathToFileURL(corePath).href }));
  const loaded = createRequire(import.meta.url)(bridgePath);
  const page = { url:() => url };
  await loaded.default({ page });
  assert.equal(page.__localRecorderBridge.start().started, true);
  let status;
  for (let i = 0; i < 50; i++) { status = page.__localRecorderBridge.status(); if (status.finished) break; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(status.finished, true);
  const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
  assert.equal(report.failureStage, 'connecting_page');
  assert.equal(report.inputMode, 'native-paste');
  assert.match(report.error, /Browser\.grantPermissions/u);
  assert.doesNotMatch(JSON.stringify(report), /private\.example|credential/u);
});
