import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateNewSystemManifest, createNewSystemRun } from '../src/new-system-core.mjs';
import { EXTENSION_TOKEN_ENV, resolveExtensionAuth } from '../src/extension-auth.mjs';
import { writableWorkspacePath } from '../src/recorder-config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const usage = `复用已登录 Edge 页面的独立执行器（默认只校验）
  node scripts/run-new-system-extension.mjs --manifest=题单.json --validate
  node scripts/run-new-system-extension.mjs --manifest=题单.json --verify-only
  node scripts/run-new-system-extension.mjs --manifest=题单.json --execute --limit=20
  可选 --state=进度.json --tab-index=0 --connect-timeout=600 --input-mode=native-paste|browser-command
  首次连接请在原 Edge 窗口授权 Playwright 扩展并选择百度教育页。
  Ctrl+C 会中断连接；当次写入效果可能不确定，恢复时先核对进度，禁止直接重跑。`;

export function parseOptions(argv) {
  const options = { mode: 'validate', limit: 20, connectTimeout: 600, pollMs: 750, inputMode:'native-paste' };
  const modes = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (['--help', '-h'].includes(arg)) { options.help = true; continue; }
    if (['--validate', '--verify-only', '--execute'].includes(arg)) { options.mode = arg.slice(2); modes.add(options.mode); continue; }
    const match = arg.match(/^--(manifest|state|tab-index|limit|connect-timeout|poll-ms|input-mode)(?:=(.*))?$/u);
    if (!match) throw new Error(`未知参数：${arg}`);
    const value = match[2] ?? argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`${match[1]} 缺少值`);
    const key = { 'tab-index': 'tabIndex', 'connect-timeout': 'connectTimeout', 'poll-ms': 'pollMs', 'input-mode':'inputMode' }[match[1]] ?? match[1];
    options[key] = ['tabIndex', 'limit', 'connectTimeout', 'pollMs'].includes(key) ? Number(value) : value;
  }
  if (modes.size > 1) throw new Error('校验、只读核对和正式录入只能选一种');
  if (!options.help && !options.manifest) throw new Error('必须指定 --manifest');
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 1000) throw new Error('limit 必须为 1–1000');
  if (!Number.isSafeInteger(options.connectTimeout) || options.connectTimeout < 1 || options.connectTimeout > 3600) throw new Error('connect-timeout 必须为 1–3600 秒');
  if (!Number.isSafeInteger(options.pollMs) || options.pollMs < 100 || options.pollMs > 10000) throw new Error('poll-ms 必须为 100–10000 毫秒');
  if (options.tabIndex !== undefined && (!Number.isSafeInteger(options.tabIndex) || options.tabIndex < 0)) throw new Error('tab-index 必须是非负整数');
  if (!['native-paste', 'browser-command'].includes(options.inputMode)) throw new Error('input-mode 必须是 native-paste 或 browser-command');
  return options;
}

export function isBookTab(urlString, bookId) {
  try {
    const url = new URL(urlString);
    if (url.origin !== 'https://easylearn.baidu.com' || url.pathname !== '/edu-shop-web/' || url.username || url.password) return false;
    const [route, query] = url.hash.split('?');
    if (route !== '#/content-manager/teaching-content' || query === undefined || url.hash.split('?').length !== 2) return false;
    const params = new URLSearchParams(query);
    return params.getAll('textbookID').length === 1 && /^[1-9]\d*$/u.test(params.get('textbookID') ?? '') && Number(params.get('textbookID')) === bookId && params.getAll('textbookType').length === 1 && params.get('textbookType') === 'main';
  } catch { return false; }
}

function assertToolResult(result) {
  if (!result || result.isError) throw new Error('扩展工具未完成调用；请检查原 Edge 中的连接授权。');
  return result;
}

/** Read only official tab records, never log other tabs or extension connection URLs. */
export function parseTabs(result) {
  assertToolResult(result);
  const structured = result.structuredContent?.tabs;
  if (Array.isArray(structured)) return structured.filter(tab => Number.isSafeInteger(tab.index) && tab.index >= 0 && typeof tab.url === 'string').map(tab => ({ index: tab.index, url: tab.url }));
  const text = (result.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n');
  const tabs = [];
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*-\s+(\d+):\s+(?:\(current\)\s+)?\[.*\]\(([^\r\n]+)\)(?:\s+\[crashed\])?\s*$/u);
    if (match) tabs.push({ index: Number(match[1]), url: match[2] });
  }
  if (!tabs.length) {
    const format = { fields:Object.keys(result), contentTypes:(result.content ?? []).map(item => item.type), structuredKeys:Object.keys(result.structuredContent ?? {}), headers:text.split('\n').filter(line => line.startsWith('### ')), noOpenTabs:text.includes('No open tabs') };
    throw new Error('无法读取扩展标签格式：'+JSON.stringify(format));
  }
  return tabs;
}

export function selectBookTab(tabs, bookId, explicitIndex) {
  const matches = tabs.filter(tab => isBookTab(tab.url, bookId));
  if (explicitIndex !== undefined) {
    const selected = matches.find(tab => tab.index === explicitIndex);
    if (!selected) throw new Error('指定 tab-index 不是当前书籍的新系统录入页。');
    return selected;
  }
  if (matches.length !== 1) throw new Error(matches.length ? '发现多个相同书籍页面；请关闭重复页面或指定 --tab-index。' : '扩展中没有当前书籍的新系统录入页；请选择已登录的百度教育页面。');
  return matches[0];
}

export function validateToolSet(tools) {
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  const tabs = byName.get('browser_tabs');
  const run = byName.get('browser_run_code_unsafe');
  if (!tabs?.inputSchema?.properties?.action?.enum?.includes('select') || !tabs.inputSchema.properties.action.enum.includes('list') || run?.inputSchema?.properties?.code?.type !== 'string') throw new Error('官方扩展服务缺少已验证的 tabs/run-code 接口，停止连接。');
}

/** Keep actionable protocol/module errors while removing URLs and credential fields. */
export function safeDiagnosticMessage(value) {
  return String(value ?? '执行失败')
    .replace(/(?:https?|wss?|file|chrome-extension|extension):\/\/[^\s"'<>]+/giu, '[网址省略]')
    .replace(/\b(?:authorization|cookie|set-cookie)\s*[:=][^\r\n]*/giu, '[凭据字段省略]')
    .replace(/\b(?:PLAYWRIGHT_MCP_EXTENSION_TOKEN|token|access_token|refresh_token|password|secret)\s*[:=]\s*[^\s,;]+/giu, '[凭据字段省略]')
    .replace(/[\r\n]+/gu, ' ').slice(0, 600);
}

async function atomicJson(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temp = `${filename}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(temp, filename);
}

export async function acquireLock(filename, details = {}) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  let handle;
  try { handle = await fs.open(filename, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let saved;
    try { saved = JSON.parse(await fs.readFile(filename, 'utf8')); } catch { throw new Error('运行锁无效，请先检查其来源。'); }
    if (!saved || saved.unconfirmedService === true) throw new Error('运行锁的 MCP 服务退出尚未确认，禁止接管；请先核对常驻服务状态。');
    if (!Number.isSafeInteger(saved.pid) || saved.pid <= 0) throw new Error('运行锁无效，请先检查其来源。');
    if (saved.servicePid !== undefined && saved.servicePid !== null) {
      if (!Number.isSafeInteger(saved.servicePid) || saved.servicePid <= 0) throw new Error('运行锁服务进程标识无效，请先检查其来源。');
      let serviceAlive = true;
      try { process.kill(saved.servicePid, 0); } catch (e) { if (e.code === 'ESRCH') serviceAlive = false; }
      if (serviceAlive) throw new Error('常驻 MCP 服务进程仍在运行，禁止接管原 Edge 运行锁。');
    }
    let alive = true;
    try { process.kill(saved.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
    if (alive) throw new Error('同一进度或原 Edge 扩展执行器正在运行，禁止同时启动。');
    await fs.unlink(filename);
    handle = await fs.open(filename, 'wx');
  }
  await handle.writeFile(JSON.stringify({ ...details, pid: process.pid }));
  return async () => { await handle.close(); await fs.unlink(filename).catch(() => {}); };
}

/** Node-only page property; no DOM/framework mutation and no operation during init. */
export function buildBridgeSource(config) {
  return `'use strict';
const config = ${JSON.stringify(config)};
const sanitize = ${safeDiagnosticMessage.toString()};
let job = { started:false, running:false, finished:false, bookId:config.bookId, mode:config.mode, inputMode:config.inputMode || 'native-paste', stateStatus:'pending', stage:'waiting', counts:{}, lastTask:null, error:null };
let stopping = false;
function safeUrl(page) {
  const url = new URL(page.url());
  const parts = url.hash.split('?');
  const params = new URLSearchParams(parts[1] || '');
  if (url.origin !== 'https://easylearn.baidu.com' || url.pathname !== '/edu-shop-web/' || url.username || url.password || parts.length !== 2 || parts[0] !== '#/content-manager/teaching-content' || params.getAll('textbookID').length !== 1 || Number(params.get('textbookID')) !== config.bookId || params.getAll('textbookType').length !== 1 || params.get('textbookType') !== 'main') throw new Error('选中页面与题单书籍不一致');
}
exports.default = async ({ page }) => {
  if (Object.prototype.hasOwnProperty.call(page, '__localRecorderBridge')) return;
  const bridge = {
    status: () => { safeUrl(page); return JSON.parse(JSON.stringify(job)); },
    stop: () => { stopping = true; return { stopRequested:true }; },
    start: () => {
      safeUrl(page);
      if (job.started) throw new Error('本次桥接任务已启动，禁止重复启动');
      job.started = true; job.running = true; job.stage = 'loading_modules';
      (async () => {
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        const { NewSystemAdapter } = await import(config.adapterModuleURL);
        const { runNewSystemBatch } = await import(config.coreModuleURL);
        const atomic = async (filename, value) => {
          await fs.mkdir(path.dirname(filename), { recursive:true });
          const temp = filename + '.' + process.pid + '.tmp';
          await fs.writeFile(temp, JSON.stringify(value, null, 2), 'utf8');
          await fs.rename(temp, filename);
        };
        const manifest = JSON.parse(await fs.readFile(config.manifestPath, 'utf8'));
        const state = JSON.parse(await fs.readFile(config.statePath, 'utf8'));
        const persist = async snapshot => {
          await atomic(config.statePath, snapshot);
          job.stateStatus = snapshot.status;
          job.counts = {};
          for (const row of snapshot.tasks) { job.counts[row.status] = (job.counts[row.status] || 0) + 1; if (!['pending','completed','skipped_existing'].includes(row.status)) job.lastTask = { id:row.taskId, status:row.status }; }
        };
        const adapter = new NewSystemAdapter({ page, baseDir:config.baseDir, dataDir:config.dataDir, source:'production', inputMode:config.inputMode || 'native-paste' });
        job.stage = 'connecting_page';
        await adapter.connect(config.bookId);
        safeUrl(page);
        job.stage = 'running';
        const startedAt = Date.now();
        const result = await runNewSystemBatch({ manifest, adapter, state, persist, baseDir:config.baseDir, limit:config.limit, verifyOnly:config.mode === 'verify-only', stopRequested:() => stopping });
        job.stateStatus = result.status;
        const stoppedTask = result.tasks.find(row => row.lastError);
        job.stopReason = stoppedTask ? sanitize(stoppedTask.lastError) : null;
        let screenshotPath = null;
        if (result.status === 'completed') {
          try {
            safeUrl(page);
            screenshotPath = config.reportPath + '.png';
            await page.screenshot({ path:screenshotPath, fullPage:false, timeout:5000 });
          } catch { screenshotPath = null; }
        }
        job.stage = 'finished';
        await atomic(config.reportPath, { bookId:config.bookId, mode:config.mode, inputMode:config.inputMode || 'native-paste', status:result.status, counts:job.counts, stopReason:job.stopReason, elapsedSeconds:(Date.now()-startedAt)/1000, statePath:config.statePath, screenshotPath, existingBrowser:true, auditSubmitted:false });
      })().catch(async error => {
        job.error = sanitize(error.message || '执行失败'); job.failureStage = job.stage; job.stage = 'failed'; job.stateStatus = 'failed';
        try {
          const fs = await import('node:fs/promises');
          const temp = config.reportPath + '.' + process.pid + '.tmp';
          await fs.writeFile(temp, JSON.stringify({ bookId:config.bookId, mode:config.mode, inputMode:config.inputMode || 'native-paste', status:'failed', failureStage:job.failureStage, error:job.error, counts:job.counts, statePath:config.statePath, existingBrowser:true, auditSubmitted:false }, null, 2), 'utf8');
          await fs.rename(temp, config.reportPath);
        } catch {}
      }).finally(() => { job.running = false; job.finished = true; });
      return { started:true, bookId:config.bookId, mode:config.mode };
    }
  };
  Object.defineProperty(page, '__localRecorderBridge', { value:bridge, enumerable:false, configurable:false, writable:false });
};
`;
}

function bridgeCode(action, bookId) {
  if (!['start', 'status', 'stop'].includes(action)) throw new Error('无效桥接动作');
  return `async (page) => {
    if (!page.__localRecorderBridge) throw new Error('Node桥接未安装');
    const result = await page.__localRecorderBridge.${action}();
    if (${JSON.stringify(action)} !== 'stop' && result.bookId !== ${bookId}) throw new Error('桥接书籍不一致');
    return result;
  }`;
}

export function parseBridgeResult(result) {
  assertToolResult(result);
  if (result.structuredContent && typeof result.structuredContent === 'object' && 'bookId' in result.structuredContent) return result.structuredContent;
  const text = (result.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n');
  const section = text.match(/(?:^|\n)### Result\s*\n([\s\S]*?)(?:\n### |$)/u)?.[1]?.trim() ?? text.trim();
  try { const value = JSON.parse(section); if (value && typeof value === 'object') return value; } catch {}
  throw new Error('桥接没有返回可验证状态；停止执行，不会自动重跑。');
}

export async function connectMcp(bridgePath, { browserBackend = 'extension', browserProfileDir, readOnly = false, authOptions, resolveAuth = resolveExtensionAuth, ClientClass, TransportClass, processAlive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}, closeTimeoutMs = 5000, closePollMs = 50, pause = sleep } = {}) {
  const packagePath = require.resolve('@playwright/mcp/package.json');
  const metadata = JSON.parse(await fs.readFile(packagePath, 'utf8'));
  if (metadata.version !== '0.0.83') throw new Error('此入口已验证 @playwright/mcp 0.0.83，请使用项目固定版本。');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  if(typeof readOnly!=='boolean'||readOnly&&browserBackend!=='headless')throw new Error('readOnly transport 仅允许独立无头浏览器');
  if(!['extension','headless'].includes(browserBackend))throw new Error('不支持的 browserBackend');
  if(browserBackend==='headless'&&(typeof browserProfileDir!=='string'||!path.isAbsolute(browserProfileDir)))throw new Error('headless 必须绑定已规范化的独立 browserProfileDir');
  const auth = browserBackend==='extension'?await resolveAuth(authOptions):{authConfigured:false,authSource:'owned-profile',childEnv:{}};
  const transportEnv = { ...auth.childEnv };
  // Headless launches a new browser process with a book-specific directory. It
  // never uses --extension, CDP endpoints, the Default profile, or extension auth.
  let browserArgs;
  if(browserBackend==='extension')browserArgs=['--extension','--browser','msedge','--profile-dir-name','Default'];
  else{
    // MCP's assistant mode omits --enable-automation by default. Add this fixed
    // switch so CDP can prove the actual launch/profile, rather than trusting a
    // config assertion. The launch config is local and contains no credentials.
    const launchConfig=bridgePath+'.headless.json';
    await writableWorkspacePath(path.dirname(bridgePath),launchConfig);
    await fs.writeFile(launchConfig,JSON.stringify({browser:{launchOptions:{args:['--enable-automation']}}}));
    browserArgs=['--headless','--browser','msedge','--user-data-dir',browserProfileDir,'--config',launchConfig,'--block-service-workers'];
  }
  const transport = new (TransportClass ?? StdioClientTransport)({ command:process.execPath, args:[path.join(path.dirname(packagePath), 'cli.js'), ...browserArgs, '--init-page', bridgePath, '--snapshot-mode', 'none', '--image-responses', 'omit', '--output-dir', path.dirname(bridgePath)], env:transportEnv, stderr:'pipe' });
  const client = new (ClientClass ?? Client)({ name:'textbook-recorder-local', version:'1.0.0' });
  let closed = false, servicePid = null, closing;
  const closedListeners = new Set(), priorOnClose = client.onclose;
  const notifyClosed = () => {
    if (closed) return;
    closed = true;
    for (const callback of closedListeners) { closedListeners.delete(callback); try { callback(); } catch {} }
  };
  client.onclose = (...args) => { notifyClosed(); try { priorOnClose?.apply(client, args); } catch {} };
  const unconfirmedExit = () => Object.assign(new Error('MCP 服务进程尚未确认退出；必须保留运行锁。'), { code:'MCP_EXIT_UNCONFIRMED', servicePid });
  const confirmExit = async () => {
    if (!Number.isSafeInteger(servicePid) || servicePid <= 0) return;
    const deadline = Date.now() + closeTimeoutMs;
    for (;;) {
      let alive;
      try { alive = processAlive(servicePid); } catch { throw unconfirmedExit(); }
      if (!alive) return;
      if (Date.now() >= deadline) throw unconfirmedExit();
      await pause(closePollMs);
    }
  };
  // Drain without echoing connection tokens or unrelated browser URLs.
  transport.stderr?.on('data', () => {});
  try { await client.connect(transport); servicePid = transport.pid ?? null; }
  catch (error) {
    servicePid = transport.pid ?? null;
    await client.close().catch(() => {});
    await confirmExit();
    let message = String(error?.message ?? '连接失败');
    if (transportEnv[EXTENSION_TOKEN_ENV]) message = message.replaceAll(transportEnv[EXTENSION_TOKEN_ENV], '[令牌省略]');
    throw new Error(`${browserBackend==='headless'?'独立无头':'扩展'} MCP 连接失败：${safeDiagnosticMessage(message)}`);
  } finally { delete transportEnv[EXTENSION_TOKEN_ENV]; }
  transport.stderr?.on('data', () => {});
  const close = () => {
    if (!closing) closing = (async () => { try { await client.close(); } catch { throw unconfirmedExit(); } await confirmExit(); notifyClosed(); })().catch(error => { closing = null; throw error; });
    return closing;
  };
  return { client, servicePid, isClosed:() => closed, onClosed:callback => {
    if (typeof callback !== 'function') throw new TypeError('onClosed 需要回调函数');
    closedListeners.add(callback);
    if (closed) queueMicrotask(() => { if (closedListeners.delete(callback)) { try { callback(); } catch {} } });
    return () => closedListeners.delete(callback);
  }, authConfigured:auth.authConfigured, authSource:auth.authSource, profile:browserBackend==='headless'?{browser:'msedge',browserBackend,headless:true,readOnly,userDataDir:browserProfileDir,existingBrowser:false}:{ browser:'msedge', profileDirName:'Default', existingBrowser:true }, close };
}

export async function main(argv = process.argv.slice(2), { connect = connectMcp, log = console.log, pause = sleep, installSignals = true, browserLockPath = path.join(ROOT, 'data', 'new-system-browser', 'extension-Default.lock') } = {}) {
  const options = parseOptions(argv);
  if (options.help) { log(usage); return 0; }
  const manifestPath = path.resolve(options.manifest);
  const baseDir = path.dirname(manifestPath);
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const validation = validateNewSystemManifest(manifest, baseDir);
  if (!validation.valid) throw new Error(`题单不能执行：${validation.errors.join('；')}`);
  if (options.mode === 'execute') {
    let hold;
    try { hold = JSON.parse(await fs.readFile(path.join(baseDir, 'task-hold.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('task-hold.json 无法验证，拒绝连接和写入'); }
    if (hold?.batchHeld === true) throw new Error('task-hold.json 标记 batchHeld=true：批量录入已暂停，拒绝连接和写入');
  }
  log(`书 ${manifest.bookId}，${manifest.tasks.length} 条，模式 ${options.mode}`);
  if (options.mode === 'validate') { log('本地题单及资产校验通过；没有连接浏览器。'); return 0; }
  if (manifest.source !== 'production') throw new Error('扩展入口只接受 production 题单。');
  const statePath = path.resolve(options.state ?? `${manifestPath}.extension.${options.mode}.run.json`);
  if (statePath === manifestPath) throw new Error('进度路径不能覆盖题单。');
  const bridgePath = `${statePath}.bridge.cjs`;
  const reportPath = `${statePath}.report.json`;
  const unlockState = await acquireLock(`${statePath}.lock`, { bookId:manifest.bookId, mode:options.mode });
  let unlockBrowser, connection, interrupted = false, finished = false;
  const controller = new AbortController();
  const requestStop = () => { interrupted = true; controller.abort(); };
  if (installSignals) { process.on('SIGINT', requestStop); process.on('SIGTERM', requestStop); }
  try {
    unlockBrowser = await acquireLock(browserLockPath, { bookId:manifest.bookId });
    let state;
    try { state = JSON.parse(await fs.readFile(statePath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; state = createNewSystemRun(manifest, { baseDir }); }
    await atomicJson(statePath, state);
    const config = { manifestPath, baseDir, statePath, reportPath, bookId:manifest.bookId, mode:options.mode, inputMode:options.inputMode, limit:options.limit,
      dataDir:path.join(ROOT, 'data', 'new-system-browser'), adapterModuleURL:pathToFileURL(path.join(ROOT, 'src', 'new-system-adapter.mjs')).href, coreModuleURL:pathToFileURL(path.join(ROOT, 'src', 'new-system-core.mjs')).href };
    await fs.writeFile(bridgePath, buildBridgeSource(config), 'utf8');
    connection = await connect(bridgePath);
    const client = connection.client;
    validateToolSet((await client.listTools()).tools);
    log('请在原 Edge 窗口授权 Playwright 扩展连接，并选择已登录的百度教育页面。');
    const call = async (name, args) => assertToolResult(await client.callTool({ name, arguments:args }, undefined, { timeout:options.connectTimeout * 1000, signal:controller.signal }));
    const selected = selectBookTab(parseTabs(await call('browser_tabs', { action:'list' })), manifest.bookId, options.tabIndex);
    await call('browser_tabs', { action:'select', index:selected.index });
    const start = parseBridgeResult(await call('browser_run_code_unsafe', { code:bridgeCode('start', manifest.bookId) }));
    if (start.started !== true || start.bookId !== manifest.bookId || start.mode !== options.mode) throw new Error('桥接未确认正确任务范围。');
    log(options.mode === 'verify-only' ? '已连接原页面，只读核对开始。' : '已连接原页面，独立批量录入开始。');
    let lastProgress = '';
    while (true) {
      if (interrupted) throw new Error('interrupted');
      const status = parseBridgeResult(await call('browser_run_code_unsafe', { code:bridgeCode('status', manifest.bookId) }));
      if (status.bookId !== manifest.bookId || status.mode !== options.mode) throw new Error('桥接任务身份不一致。');
      const progress = JSON.stringify({ status:status.stateStatus, counts:status.counts });
      if (progress !== lastProgress) { lastProgress = progress; log(`进度：${progress}`); }
      if (status.finished) {
        finished = true;
        if (status.error) {
          const diagnostic = safeDiagnosticMessage(status.error);
          await atomicJson(reportPath, { bookId:manifest.bookId, mode:options.mode, inputMode:options.inputMode, status:'failed', failureStage:status.failureStage, counts:status.counts, errorCode:'bridge_failed', error:diagnostic, effectsUncertain:options.mode === 'execute', statePath, existingBrowser:true, auditSubmitted:false });
          log(`停止于 ${status.failureStage ?? 'bridge'}：${diagnostic}`);
          throw new Error('本地执行器未完成，安全诊断已保存到报告；不会自动重跑。');
        }
        if (status.stopReason) log(`停止原因：${safeDiagnosticMessage(status.stopReason)}`);
        log(`运行结束：${status.stateStatus}。进度与核对报告已保存，原网页及登录会保留。`);
        return ['failed', 'review_required', 'blocked'].includes(status.stateStatus) ? 2 : 0;
      }
      await pause(options.pollMs);
    }
  } catch (error) {
    if (!interrupted) throw error;
    log('已取消连接。当次写入效果可能不确定；保留进度，恢复时先回读核对，禁止直接重跑。');
    return 130;
  } finally {
    if (installSignals) { process.removeListener('SIGINT', requestStop); process.removeListener('SIGTERM', requestStop); }
    await connection?.close().catch(() => {}); // Disconnect service; never close the original page/context.
    if (interrupted || !finished) await atomicJson(reportPath, { bookId:manifest.bookId, mode:options.mode, inputMode:options.inputMode, status:interrupted ? 'interrupted' : 'not_confirmed', effectsUncertain:options.mode === 'execute', statePath, existingBrowser:true, auditSubmitted:false }).catch(() => {});
    await fs.unlink(bridgePath).catch(() => {});
    await unlockBrowser?.();
    await unlockState();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(() => {
    // Shareable entrypoint writes through the configured persistent service.
    // Keep the connection exports for that service and historical unit tests.
    if (parseOptions(process.argv.slice(2)).mode !== 'validate') throw new Error('共享版浏览器操作请使用 recorder:verify 或 recorder:execute；它们会核对本地书籍配置和前置审校。');
    return main();
  }).then(code => { process.exitCode = code; }).catch(error => { console.error(safeDiagnosticMessage(error.message)); process.exitCode = 1; });
}
