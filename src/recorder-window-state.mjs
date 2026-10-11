import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const helper = fileURLToPath(new URL('../scripts/recorder-window-state.ps1', import.meta.url));
const markerPattern = /^recorder-window-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;

export function recorderWindowHelperLaunch(marker, action) {
  if (!markerPattern.test(marker) || !['read', 'minimize'].includes(action)) throw new Error('Invalid recorder window helper arguments');
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  if (!path.win32.isAbsolute(systemRoot)) throw new Error('Windows system directory is not absolute');
  return {
    command: path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Marker', marker, '-Action', action],
    options: { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  };
}

function executeWindowHelper(launch) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(launch.command, launch.args, launch.options); }
    catch { reject(new Error('Windows recorder window helper could not start')); return; }
    let stdout = '', failed = false;
    const fail = message => {
      if (failed) return;
      failed = true; clearTimeout(timer); child.kill(); reject(new Error(message));
    };
    const timer = setTimeout(() => fail('Windows recorder window helper timed out'), 10000);
    child.stdout.on('data', data => {
      stdout += data;
      if (stdout.length > 1024) fail('Windows recorder window helper returned excessive output');
    });
    // Never export another window title, process diagnostics or helper stderr.
    child.stderr.on('data', () => {});
    child.once('error', () => fail('Windows recorder window helper could not start'));
    child.once('close', code => {
      clearTimeout(timer);
      if (failed) return;
      if (code !== 0) {
        const reason = {11:'window-not-found',12:'ambiguous-window',13:'window-binding-changed',14:'window-process-mismatch',15:'minimization-refused',16:'not-minimized'}[code] ?? 'unknown';
        failed = true; reject(new Error('Windows recorder window helper failed: ' + reason)); return;
      }
      resolve(stdout);
    });
  });
}

function windowReceipt(output, action) {
  let value;
  try { value = JSON.parse(output); } catch { throw new Error('Windows recorder window helper returned an invalid receipt'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'backend,windowId,windowState'
      || value.backend !== 'win32' || typeof value.windowId !== 'string' || !/^[1-9]\d{0,19}$/u.test(value.windowId)
      || BigInt(value.windowId) > 0x7fffffffffffffffn || !['normal', 'minimized'].includes(value.windowState)
      || action === 'minimize' && value.windowState !== 'minimized') throw new Error('Windows recorder window helper returned an invalid receipt');
  return { windowId: value.windowId, windowState: value.windowState, backend: 'win32' };
}

/** Bind only the selected tab's existing Edge window; never select or activate it.
 * The injectable executor is for isolated tests and returns the helper's JSON stdout. */
export async function manageRecorderWindow(page, action = 'read', guard = async () => {}, { execute = executeWindowHelper } = {}) {
  if (!page || typeof page.evaluate !== 'function' || !['read', 'minimize'].includes(action) || typeof guard !== 'function' || typeof execute !== 'function') throw new Error('Invalid recorder window operation');
  const bridge = page.context?.().browser?.()?.__textbookRecorderWindowBridge;
  if (bridge) {
    if (typeof bridge.manage !== 'function') throw new Error('Recorder extension window bridge is invalid');
    await guard();
    const before = await page.evaluate(() => ({ url:location.href, timeOrigin:performance.timeOrigin }));
    if (typeof before?.url !== 'string' || !Number.isFinite(before.timeOrigin)) throw new Error('Recorder page document identity was not readable');
    await guard();
    const receipt = await bridge.manage(page, action);
    await guard();
    if (!receipt || Object.keys(receipt).sort().join(',') !== 'tabId,windowId,windowState'
        || !Number.isSafeInteger(receipt.tabId) || receipt.tabId <= 0
        || !Number.isSafeInteger(receipt.windowId) || receipt.windowId <= 0
        || !['normal','minimized','maximized','fullscreen'].includes(receipt.windowState)
        || action === 'minimize' && receipt.windowState !== 'minimized') throw new Error('Recorder extension returned an invalid window receipt');
    const intact = await page.evaluate(binding => location.href === binding.url && performance.timeOrigin === binding.timeOrigin, before);
    await guard();
    if (!intact) throw new Error('Recorder page document changed during window operation');
    return { windowId:String(receipt.windowId), windowState:receipt.windowState, backend:'extension' };
  }
  if (process.platform !== 'win32' && execute === executeWindowHelper) throw new Error('Recorder window helper requires Windows');
  const marker = `recorder-window-${randomUUID()}`;
  let binding, markerAttempted = false, primaryError;
  try {
    await guard();
    // A committed reload can still replace document.title during startup.
    // Bind a window marker only after the actual document has loaded.
    if (typeof page.waitForLoadState === 'function') {
      await page.waitForLoadState('load', { timeout:10000 });
      await guard();
    }
    binding = await page.evaluate(() => ({ originalTitle:document.title, url:location.href, timeOrigin:performance.timeOrigin }));
    if (!binding || typeof binding.originalTitle !== 'string' || typeof binding.url !== 'string' || !Number.isFinite(binding.timeOrigin)) throw new Error('Recorder page document identity was not readable');
    await guard();
    markerAttempted = true;
    await page.evaluate(({ marker, binding }) => {
      if (document.title !== binding.originalTitle || location.href !== binding.url || performance.timeOrigin !== binding.timeOrigin) throw new Error('Recorder page document changed before window binding');
      document.title = marker;
      if (document.title !== marker) throw new Error('Recorder window marker was not applied');
    }, { marker, binding });
    await guard();
    await guard();
    let output;
    try { output = await execute(recorderWindowHelperLaunch(marker, action)); }
    catch (error) {
      await guard();
      const intact = await page.evaluate(({ marker, binding }) => document.title === marker && location.href === binding.url && performance.timeOrigin === binding.timeOrigin, { marker, binding });
      await guard();
      if (!intact) throw new Error('Recorder page document or title changed during window discovery');
      throw error;
    }
    await guard();
    const receipt = windowReceipt(output, action);
    await guard();
    const bound = await page.evaluate(({ marker, binding }) => document.title === marker && location.href === binding.url && performance.timeOrigin === binding.timeOrigin, { marker, binding });
    await guard();
    if (!bound) throw new Error('Recorder window marker changed during the operation');
    return receipt;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (markerAttempted && binding) {
      try {
        await guard();
        const restored = await page.evaluate(({ marker, binding }) => {
          if (document.title !== marker || location.href !== binding.url || performance.timeOrigin !== binding.timeOrigin) return false;
          document.title = binding.originalTitle;
          return document.title === binding.originalTitle;
        }, { marker, binding });
        await guard();
        if (!restored && !primaryError) throw new Error('Recorder page title cleanup lost its window binding');
      } catch (error) {
        if (!primaryError) throw error;
      }
    }
  }
}
