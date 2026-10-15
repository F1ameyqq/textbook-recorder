import fs from 'node:fs/promises';
import path from 'node:path';

// A Node-side ownership registry, never a property injected into the document.
// Only a browser launched with the exact independent persistent profile may
// enter this registry. The document's visibility/focus properties remain native.
const contexts = new WeakMap();
const pages = new WeakMap();
const samePath = (left, right) => process.platform === 'win32'
  ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
  : path.resolve(left) === path.resolve(right);

export function validateHeadlessLaunchArguments(args, profileDir) {
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string')
      || !args.some(value => /^--headless(?:=new)?$/u.test(value))) throw new Error('独立无头浏览器的实际启动模式未确认');
  const profiles = args.filter(value => value.startsWith('--user-data-dir='));
  if (profiles.length !== 1 || !samePath(profiles[0].slice(16), profileDir)) throw new Error('独立无头浏览器的实际 profile 不匹配');
  if (!args.includes('--remote-debugging-pipe')) throw new Error('独立无头浏览器缺少专属 Playwright 连接');
  return true;
}

/** Establish ownership once per launched context and native state per page. */
export async function establishOwnedHeadlessContext(page, { profileDir, bindingId }) {
  if (typeof profileDir !== 'string' || !path.isAbsolute(profileDir)
      || typeof bindingId !== 'string' || !/^[a-f0-9-]{36}$/u.test(bindingId)) throw new Error('独立无头浏览器绑定无效');
  const canonical = await fs.realpath(profileDir), context = page.context(), browser = context.browser();
  if (page.isClosed() || !browser || !browser.isConnected()) throw new Error('独立无头浏览器已断开');
  let proof = contexts.get(context);
  if (proof && (proof.browser !== browser || proof.bindingId !== bindingId || !samePath(proof.profileDir, canonical))) throw new Error('独立无头浏览器已绑定其他会话');
  const session = await context.newCDPSession(page);
  try {
    if (!proof) {
      const commandLine = await session.send('Browser.getBrowserCommandLine');
      validateHeadlessLaunchArguments(commandLine.arguments, canonical);
      proof = Object.freeze({ schemaVersion: 1, backend: 'headless', bindingId, profileDir: canonical, browser });
      contexts.set(context, proof);
    }
    // Playwright normally enables focus emulation. Disable it only on this
    // already-proven owned target; never fabricate focus for input checks.
    await session.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    pages.set(page, proof);
  } finally { await session.detach(); }
  return { schemaVersion: 1, backend: 'headless', bindingId, profileDir: canonical };
}

export function assertOwnedHeadlessPage(page) {
  const context = page?.context?.(), proof = contexts.get(context);
  if (!proof || pages.get(page) !== proof || page.isClosed()
      || context.browser() !== proof.browser || !proof.browser.isConnected()
      || !context.pages().includes(page)) throw new Error('当前页不是已证明身份的独立无头浏览器页面');
  return { headless: true, browserBindingId: proof.bindingId, windowState: 'headless' };
}
