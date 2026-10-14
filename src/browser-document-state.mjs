import { readRecorderWindowState, validateBrowserFocusMode, validateBrowserWindowMode } from './browser-focus.mjs';

// Read actual browser state. Never emulate focus or change visibility properties.
export function recorderDocumentSnapshot() {
  return { url: location.href, timeOrigin: performance.timeOrigin,
    visibilityState: document.visibilityState, hasFocus: document.hasFocus(),
    readyState: document.readyState, prerendering: document.prerendering === true,
    usable: Boolean(document.documentElement && document.body) };
}

export function assertRecorderDocumentSnapshot(state, binding) {
  if (!state?.usable || !['interactive', 'complete'].includes(state.readyState) || state.prerendering
      || !['visible', 'hidden'].includes(state.visibilityState) || typeof state.hasFocus !== 'boolean'
      || typeof state.url !== 'string' || !Number.isFinite(state.timeOrigin)) throw new Error('Recorder document is not ready for input');
  if (binding && (state.url !== binding.url || state.timeOrigin !== binding.timeOrigin)) throw new Error('Recorder document changed during input checks');
}

/** Background input binds the actual recorder window without requiring OS
 * focus. Normal windows must keep a visible document; minimized windows may
 * hide it. Active editor and selection remain independent input checks. */
export async function requireRecorderDocumentReady(page, { focusMode = 'foreground', windowMode = 'normal',
  guard = async () => {}, windowReader = readRecorderWindowState } = {}) {
  validateBrowserFocusMode(focusMode); validateBrowserWindowMode(windowMode);
  if (focusMode === 'foreground' && windowMode === 'minimized') throw new Error('minimized 只支持 background 模式');
  await guard();
  const before = await page.evaluate(recorderDocumentSnapshot);
  assertRecorderDocumentSnapshot(before);
  if (focusMode !== 'background') {
    if (before.visibilityState !== 'visible' || !before.hasFocus) throw new Error('Recorder document is hidden or has lost DOM focus');
    return { ...before, minimized: false };
  }
  const actual = await windowReader(page, guard);
  const actualState = actual?.windowState;
  const validId = Number.isSafeInteger(actual?.windowId) && actual.windowId > 0
    || typeof actual?.windowId === 'string' && /^[1-9]\d*$/u.test(actual.windowId);
  if (!validId || (windowMode === 'minimized' ? actualState !== 'minimized'
    : !['normal','maximized','fullscreen'].includes(actualState))) {
    const state = actualState === undefined ? 'missing' : ['normal','minimized','maximized','fullscreen'].includes(actualState) ? actualState : 'invalid';
    const prefix = windowMode === 'minimized' ? '指定教材页的窗口未保持最小化，停止输入' : '指定教材页没有可确认的正常窗口，停止输入';
    throw new Error(`${prefix} (window-proof validId=${validId},state=${state})`);
  }
  if (windowMode === 'normal' && before.visibilityState !== 'visible') throw new Error('Recorder background document is hidden');
  await guard();
  const after = await page.evaluate(recorderDocumentSnapshot);
  assertRecorderDocumentSnapshot(after, before);
  if (windowMode === 'normal' && after.visibilityState !== 'visible') throw new Error('Recorder background document became hidden');
  return { ...after, minimized: windowMode === 'minimized', windowId: actual.windowId, windowState:actual.windowState };
}
