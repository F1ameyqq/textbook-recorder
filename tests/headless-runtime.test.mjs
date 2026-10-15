import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { validateRecorderConfig, loadRecorderConfig } from '../src/recorder-config.mjs';
import { prepareHeadlessProfile } from '../src/recorder-browser-profile.mjs';
import { validateHeadlessLaunchArguments, assertOwnedHeadlessPage } from '../src/owned-headless-browser.mjs';
import { connectMcp, parseBridgeResult, validateToolSet } from '../scripts/run-new-system-extension.mjs';
import { openRecorderBrowserLogin } from '../scripts/recorder-browser-login.mjs';
import { startRecorderService } from '../scripts/run-recorder-service.mjs';
import { EventEmitter } from 'node:events';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const selectorLabel = 'Starter Unit 2 What\'s this / quoted \u0060 >> English?';
const temporary = async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'recorder-headless-offline-'));
  t.after(async () => { await t.headlessConnection?.close(); await fs.rm(root, { recursive: true, force: true }); });
  return root;
};

test('headless configuration is explicit, isolated, and does not reinterpret extension modes', () => {
  const config = validateRecorderConfig({ bookId: 102, browserBackend: 'headless' });
  assert.equal(config.focusMode, 'background');
  assert.equal(config.windowMode, 'headless');
  assert.equal(config.browserProfileDir, path.join('data', 'browser-profiles', 'book-102'));
  for (const value of [{ windowMode: 'headless' }, { browserBackend: 'headless', focusMode: 'foreground' },
    { browserBackend: 'headless', windowMode: 'normal' }, { browserProfileDir: 'existing-profile' }]) {
    assert.throws(() => validateRecorderConfig({ bookId: 102, ...value }));
  }
  assert.throws(() => assertOwnedHeadlessPage({ context: () => ({}) }), /已证明身份/u);
});

test('every owned headless MCP launch blocks service workers, including explicit write mode', async t => {
  const root=await temporary(t),bridge=path.join(root,'fixture.bridge.cjs');await fs.writeFile(bridge,'// offline transport fixture');
  for(const readOnly of [false,true]){
    let parameters;
    const connection=await connectMcp(bridge,{browserBackend:'headless',browserProfileDir:root,readOnly,
      TransportClass:class{constructor(value){parameters=value;}},ClientClass:class{async connect(){}async close(){}},
      resolveAuth:()=>{throw new Error('owned headless must not use extension credentials');}});
    assert.ok(parameters.args.includes('--block-service-workers'));assert.ok(!parameters.args.includes('--extension'));await connection.close();
  }
});

test('headless launch config rejects an external directory link before constructing a transport', async t => {
  const root = await temporary(t), outside = await temporary(t), bridge = path.join(root, 'bridge.cjs');
  await fs.writeFile(bridge, '// offline fixture');
  const sentinel = path.join(outside, 'sentinel.txt'); await fs.writeFile(sentinel, 'preserve');
  await fs.symlink(outside, bridge + '.headless.json', process.platform === 'win32' ? 'junction' : 'dir');
  let constructed = 0;
  await assert.rejects(connectMcp(bridge, { browserBackend: 'headless', browserProfileDir: root,
    TransportClass: class { constructor() { constructed++; } },
    resolveAuth: () => { throw new Error('headless must not read credentials'); }
  }), /项目内/u);
  assert.equal(constructed, 0); assert.equal(await fs.readFile(sentinel, 'utf8'), 'preserve');
});

test('profile ownership rejects existing unregistered storage and cross-book reuse', async t => {
  const root = await temporary(t), config = validateRecorderConfig({ bookId: 102, browserBackend: 'headless' });
  const profile = await prepareHeadlessProfile(config, root);
  assert.equal(await prepareHeadlessProfile(config, root), profile);
  await assert.rejects(prepareHeadlessProfile({ ...config, bookId: 103 }, root), /其他书籍/u);
  const unregistered = path.join(root, 'data/browser-profiles/unregistered');
  await fs.mkdir(unregistered, { recursive: true });
  await fs.writeFile(path.join(unregistered, 'Cookies'), 'sentinel');
  await assert.rejects(prepareHeadlessProfile({ ...config, browserProfileDir: unregistered }, root), /拒绝采用或复制/u);
  await fs.mkdir(path.join(root, 'config'), { recursive: true });
  await fs.writeFile(path.join(root, 'config/recorder.json'), JSON.stringify({ bookId: 102, browserBackend: 'headless', browserProfileDir: '../outside' }));
  await assert.rejects(loadRecorderConfig(root), /项目内|专属子目录/u);
  assert.throws(() => validateHeadlessLaunchArguments(['--headless', '--remote-debugging-pipe', '--user-data-dir=/wrong'], profile), /profile/u);
  assert.throws(() => validateHeadlessLaunchArguments(['--remote-debugging-pipe', '--user-data-dir=' + profile], profile), /启动模式/u);
});

test('profile marker symlink outside the project cannot import identity or credentials', async t => {
  const base = await temporary(t), root = path.join(base, 'project'), profileDir = path.join(root, 'data/browser-profiles/book-102');
  await fs.mkdir(profileDir, { recursive: true });
  const outside = path.join(base, 'outside-marker.json');
  await fs.writeFile(outside, JSON.stringify({ schemaVersion: 1, kind: 'textbook-recorder-owned-profile', bookId: 102 }));
  try { await fs.symlink(outside, path.join(profileDir, '.recorder-profile.json'), 'file'); }
  catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
    // Windows junctions are available without symlink privileges. The same
    // canonical marker-path check must reject them before attempting a read.
    const externalDirectory = path.join(base, 'external-marker-directory');
    await fs.mkdir(externalDirectory);
    await fs.symlink(externalDirectory, path.join(profileDir, '.recorder-profile.json'), 'junction');
  }
  await assert.rejects(prepareHeadlessProfile({ bookId: 102, browserBackend: 'headless', browserProfileDir: profileDir }, root), /身份文件无效/u);
  assert.equal((await fs.stat(outside)).isFile(), true);
});

test('login explicitly launches only the owned profile and returns unverified login state', async t => {
  const root = await temporary(t); await fs.mkdir(path.join(root, 'config'));
  await fs.writeFile(path.join(root, 'config/recorder.json'), JSON.stringify({ bookId: 102, browserBackend: 'headless' }));
  const calls = [], context = new EventEmitter();
  let connected = true;
  const browser = { isConnected: () => connected, newBrowserCDPSession: async () => ({ send: async method => {
    assert.equal(method, 'SystemInfo.getProcessInfo'); return { processInfo: [{ type: 'browser', id: 4242 }] };
  }, detach: async () => {} }) };
  context.browser = () => browser;
  context.pages = () => [{ goto: async url => { calls.push(['goto', url]); context.emit('close'); setTimeout(() => { connected = false; }, 10); } }];
  const lease = { markConnecting: async () => calls.push(['connecting']), updateServicePid: async pid => calls.push(['pid', pid]),
    confirmNoService: async () => calls.push(['closed']), release: async () => ({ released: true }) };
  const result = await openRecorderBrowserLogin({ root, acquireLease: async () => lease,
    launch: async (profile, options) => { calls.push(['launch', profile, options]); return context; }, log: () => {} });
  assert.equal(result.loginVerified, false); assert.equal(result.loginWindowClosed, true);
  const launched = calls.find(value => value[0] === 'launch');
  assert.equal(launched[2].headless, false); assert.equal(launched[2].channel, 'msedge');
  assert.ok(launched[1].startsWith(root));
  assert.deepEqual(calls.find(value => value[0] === 'pid'), ['pid', 4242]);
  await fs.mkdir(path.join(root, 'data/persistent-executor'), { recursive: true });
  await fs.writeFile(path.join(root, 'data/persistent-executor/session.json'), JSON.stringify({ schemaVersion: 1, bookId: 102, pending: {}, writeBlocked: true, blockedContext: {} }));
  await assert.rejects(openRecorderBrowserLogin({ root, acquireLease: async () => { throw new Error('must not acquire'); }, launch: async () => { throw new Error('must not launch'); } }), /待核对保存/u);
});

test('login releases safe resources on a profile-preparation failure before attempting launch', async t => {
  const root = await temporary(t), profile = path.join(root, 'data/browser-profiles/book-102');
  await fs.mkdir(path.join(root, 'config')); await fs.mkdir(profile, { recursive: true });
  await fs.writeFile(path.join(root, 'config/recorder.json'), JSON.stringify({ bookId: 102, browserBackend: 'headless' }));
  await fs.writeFile(path.join(profile, 'Cookies'), 'unregistered sentinel');
  let releases = 0, launches = 0, connecting = 0;
  await assert.rejects(openRecorderBrowserLogin({ root, log: () => {}, acquireLease: async () => ({
    release: async () => { releases++; return { released: true }; }, markConnecting: async () => { connecting++; },
  }), launch: async () => { launches++; } }), /未由录入器登记/u);
  assert.equal(releases, 1); assert.equal(launches, 0); assert.equal(connecting, 0);
});

test('headless lazy supervisor pause and close retain precise identity without browser connection', async t => {
  const root = await temporary(t); await fs.mkdir(path.join(root, 'config'));
  await fs.writeFile(path.join(root, 'config/recorder.json'), JSON.stringify({ bookId: 102, browserBackend: 'headless' }));
  let connections = 0;
  const service = await startRecorderService({ root, port: 0, resourceLeaseDirectory: path.join(root, 'test-leases'),
    connect: async () => { connections++; throw new Error('must not connect'); }, log: () => {} });
  t.after(() => service.shutdown());
  const control = JSON.parse(await fs.readFile(service.controlFile, 'utf8'));
  const response = await fetch('http://127.0.0.1:' + control.port + '/command', { method: 'POST',
    headers: { 'x-recorder-key': control.key, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'pause' }) });
  assert.equal(response.status, 200);
  const paused = await response.json(); assert.equal(paused.remotePauseConfirmed, false); assert.equal(paused.pauseControl.paused, true);
  const closed = await service.shutdown();
  assert.equal(closed.browserBackend, 'headless'); assert.equal(closed.windowMode, 'headless');
  assert.equal(closed.browserProfileDir, control.browserProfileDir); assert.equal(closed.closed, true); assert.equal(connections, 0);
});

test('fixed MCP headless transport uses a fresh persistent profile and real checked editor input on offline fixture', { timeout: 60000 }, async t => {
  const root = await temporary(t), profile = await prepareHeadlessProfile(validateRecorderConfig({ bookId: 102, browserBackend: 'headless' }), root);
  const bridge = path.join(root, 'fixture.bridge.cjs'), bindingId = randomUUID();
  const helper = pathToFileURL(path.join(repository, 'src/owned-headless-browser.mjs')).href;
  const input = pathToFileURL(path.join(repository, 'src/browser-editor-command.mjs')).href;
  const ready = pathToFileURL(path.join(repository, 'src/browser-document-state.mjs')).href;
  const adapter = pathToFileURL(path.join(repository, 'src/new-system-adapter.mjs')).href;
  await fs.writeFile(bridge, `exports.default=async({page})=>{
    const context=page.context();
    if(!context.__offlineHeadlessFixture){
      const requests=[];await context.route('**/*',async route=>{requests.push(route.request().url());await route.abort('blockedbyclient');});
      const {establishOwnedHeadlessContext}=await import(${JSON.stringify(helper)});
      const {insertReviewedEditorHtml}=await import(${JSON.stringify(input)});
      const {requireRecorderDocumentReady}=await import(${JSON.stringify(ready)});
      context.__offlineHeadlessFixture={requests,bind:target=>establishOwnedHeadlessContext(target,{profileDir:${JSON.stringify(profile)},bindingId:${JSON.stringify(bindingId)}}),insert:target=>insertReviewedEditorHtml(target,'#target','<p>　　已审正文 <sub>2</sub> <sup>3</sup></p>',{focusMode:'background',windowMode:'headless',timeoutMs:5000,guard:async()=>{if(target.url()!=='about:blank')throw new Error('offline-only');}}),ready:target=>requireRecorderDocumentReady(target,{focusMode:'background',windowMode:'headless'}),parentLabel:async(target,label)=>{const {NewSystemAdapter}=await import(${JSON.stringify(adapter)});const instance=new NewSystemAdapter({page:target,inputMode:'browser-command',directoryTimeout:5000});const {node}=await instance._directoryNode(label);return node.evaluate(element=>element.dataset.fixture);}};
    }
    await context.__offlineHeadlessFixture.bind(page);
    page.bringToFront=async()=>{throw new Error('offline fixture forbids window activation');};
  };`);
  const connection = await connectMcp(bridge, { browserBackend: 'headless', browserProfileDir: profile, resolveAuth: () => { throw new Error('headless must not read extension credentials'); } });
  t.headlessConnection = connection;
  assert.equal(connection.profile.existingBrowser, false);
  validateToolSet((await connection.client.listTools()).tools);
  const rawResult = await connection.client.callTool({ name: 'browser_run_code_unsafe', arguments: { code: `async (page)=>{
    const fixture=page.context().__offlineHeadlessFixture;
    await page.setContent('<!doctype html><body><div id="target" style="margin:30px;width:600px;min-height:90px;border:1px solid" contenteditable="true"></div><div id="sentinel">unchanged</div></body>');
    const before=await fixture.ready(page),inserted=await fixture.insert(page);
    const savedHtml=await page.locator('#target').innerHTML();
    const label=${JSON.stringify(selectorLabel)};
    await page.evaluate(label=>{const node=document.createElement('div');node.className='el-tree-node';node.dataset.fixture='exact-parent';const content=document.createElement('div');content.className='el-tree-node__content';content.textContent=label;node.appendChild(content);document.body.appendChild(node);},label);
    const selectorParent=await fixture.parentLabel(page,label);
    const rejected=[];await page.locator('#target').evaluate(element=>{element.replaceChildren();const overlay=document.createElement('div');overlay.id='overlay';overlay.style='position:fixed;inset:0;z-index:9999';document.body.appendChild(overlay);});
    try{await fixture.insert(page);}catch(error){rejected.push(error.message);}
    return {before,inserted,selectorParent,sentinel:await page.locator('#sentinel').textContent(),html:savedHtml,rejected,requests:fixture.requests};
  }` } }, undefined, { timeout: 45000 });
  if (rawResult.isError) console.error(JSON.stringify(rawResult));
  assert.notEqual(rawResult.isError, true, JSON.stringify(rawResult));
  const result = parseBridgeResult(rawResult);
  assert.equal(result.before.headless, true);
  assert.equal(result.before.visibilityState, 'visible');
  assert.equal(result.inserted.succeeded, true);
  assert.equal(result.inserted.selectionVerified, true);
  assert.equal(result.selectorParent,'exact-parent');
  assert.equal(result.sentinel, 'unchanged');
  assert.match(result.html, /已审正文/u);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0], /covered/u);
  assert.deepEqual(result.requests, []);
  await connection.close();
});
