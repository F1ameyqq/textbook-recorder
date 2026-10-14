import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { loadRecorderConfig, PLATFORM_ORIGIN, existingWorkspacePath } from '../src/recorder-config.mjs';
import { prepareHeadlessProfile } from '../src/recorder-browser-profile.mjs';
import { acquireRecorderResourceLease } from '../src/recorder-resource-lease.mjs';
import { safeDiagnosticMessage } from './run-new-system-extension.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Explicit one-time login only. Never attaches to, imports, or closes Default. */
export async function openRecorderBrowserLogin({ root = defaultRoot, configPath = 'config/recorder.json',
  launch = (profile, options) => chromium.launchPersistentContext(profile, options),
  acquireLease = acquireRecorderResourceLease, resourceLeaseDirectory, log = console.log, onPageReady = async () => {} } = {}) {
  root = path.resolve(root);
  const config = await loadRecorderConfig(root, configPath);
  if (config.browserBackend !== 'headless') throw new Error('独立登录入口仅用于 browserBackend=headless；不会采用当前 Edge/Default');
  try {
    const original = JSON.parse(await fs.readFile(await existingWorkspacePath(root, 'data/persistent-executor/session.json'), 'utf8'));
    if (original.schemaVersion !== 1 || original.bookId !== config.bookId || original.pending !== null
        || original.writeBlocked !== false || original.blockedContext !== null
        || (original.readOnly??false)!==(config.readOnly??false)) throw new Error('原会话有未完成命令、待核对保存或 readOnly 模式不符，禁止打开登录窗口');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const lease = await acquireLease(config, root, { ...(resourceLeaseDirectory ? { leaseDirectory: resourceLeaseDirectory } : {}) });
  let context, confirmedClosed = false, launchStarted = false;
  try {
    const profile = await prepareHeadlessProfile(config, root);
    await lease.markConnecting();
    launchStarted = true;
    context = await launch(profile, { channel: 'msedge', headless: false, viewport: { width: 1200, height: 900 } });
    const browser = context.browser();
    if (!browser || !browser.isConnected()) throw new Error('独立登录浏览器身份未确认，保留资源租约');
    const session = await browser.newBrowserCDPSession();
    try {
      const result = await session.send('SystemInfo.getProcessInfo');
      const own = result.processInfo?.filter(value => value.type === 'browser' && Number.isSafeInteger(value.id) && value.id > 0);
      if (own?.length !== 1) throw new Error('独立登录浏览器 PID 未确认，保留资源租约');
      await lease.updateServicePid(own[0].id);
    } finally { await session.detach(); }
    const closed = new Promise(resolve => context.once('close', resolve));
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(PLATFORM_ORIGIN + '/edu-shop-web/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    log('独立登录窗口已打开。请完成正常登录后关闭这个窗口；账号有效性由后续只读 probe 核对。');
    await onPageReady(page, { context, bookId: config.bookId, browserProfileDir: profile, readOnly: config.readOnly??false });
    await closed;
    // Context close can arrive before the browser's disconnect notification.
    // Wait only for this owned browser; never reconnect or close another one.
    const disconnectDeadline = Date.now() + 5000;
    while (browser.isConnected()) {
      if (Date.now() >= disconnectDeadline) throw new Error('独立登录窗口关闭后浏览器仍连接，保留资源租约');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    // The browser's close event can precede Windows process teardown slightly.
    let lastError;
    for (let attempt = 0; attempt < 40; attempt++) {
      try { await lease.confirmNoService(); lastError = null; break; }
      catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    if (lastError) throw lastError;
    confirmedClosed = true;
    const resources = await lease.release();
    return { bookId: config.bookId, browserBackend: 'headless', browserProfileDir: profile, readOnly: config.readOnly??false,
      loginWindowClosed: true, loginVerified: false, resourceLease: resources };
  } catch (error) {
    if (context && !confirmedClosed) {
      try { await context.close(); await lease.confirmNoService(); confirmedClosed = true; } catch {}
    }
    // An uncertain launch retains its lease. Never kill another browser or
    // clear a profile lock to obtain a usable login window.
    if (confirmedClosed || !launchStarted) await lease.release();
    throw error;
  }
}

export async function main(argv = process.argv.slice(2), options = {}) {
  if (argv.length > 1 || argv.length === 1 && !argv[0].startsWith('--config=')) throw new Error('只接受 --config=项目内配置路径');
  const result = await openRecorderBrowserLogin({ ...options, configPath: argv[0]?.slice(9) ?? 'config/recorder.json' });
  (options.log ?? console.log)(JSON.stringify(result, null, 2));
  return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) { console.error(safeDiagnosticMessage(error.message)); process.exitCode = 1; }
}
