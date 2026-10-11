import { activateRecorderPage as activateForegroundPage } from './activate-recorder-page.mjs';
import { manageRecorderWindow } from './recorder-window-state.mjs';

// The official extension cannot attach a browser-level CDP session. Other
// protocol failures keep their original stop behavior.
const needsWindowsWindowControl = (error, platform) => platform === 'win32' && /Target\.attachToBrowserTarget.*Not allowed/isu.test(String(error?.message ?? ''));

/** Window activation is separate from DOM focus and editor selection. */
export function validateBrowserFocusMode(value = 'foreground') {
  if (!['background', 'foreground'].includes(value)) throw new Error('focusMode 必须是 background 或 foreground');
  return value;
}

export function validateBrowserWindowMode(value = 'normal') {
  if (!['normal', 'minimized'].includes(value)) throw new Error('windowMode 必须是 normal 或 minimized');
  return value;
}

/** Read only the window containing the already guarded recorder Page. */
export async function readRecorderWindowState(page, guard = async () => {}, { platform = process.platform, windowController = manageRecorderWindow } = {}) {
  await guard();
  let session;
  try { session = await page.context().newCDPSession(page); }
  catch (error) {
    if (!needsWindowsWindowControl(error, platform)) throw error;
    await guard();
    return windowController(page, 'read', guard);
  }
  try {
    await guard();
    const { windowId, bounds } = await session.send('Browser.getWindowForTarget');
    if (!Number.isSafeInteger(windowId) || !bounds) throw new Error('未取得指定书页的浏览器窗口身份');
    await guard();
    return { windowId, windowState: bounds.windowState };
  } finally { await session.detach(); }
}

/** Background mode never restores or brings a window to the foreground. */
export async function activateRecorderPage(page, focusMode = 'foreground', { windowMode = 'normal', guard = async () => {}, platform = process.platform, windowController = manageRecorderWindow } = {}) {
  validateBrowserFocusMode(focusMode);
  validateBrowserWindowMode(windowMode);
  if (focusMode === 'foreground' && windowMode !== 'normal') throw new Error('minimized 只支持 background 模式');
  await guard();
  if (focusMode === 'foreground') return activateForegroundPage(page, guard);
  if (windowMode === 'normal') return;
  let session;
  try { session = await page.context().newCDPSession(page); }
  catch (error) {
    if (!needsWindowsWindowControl(error, platform)) throw error;
    await guard();
    const actual = await windowController(page, 'minimize', guard);
    await guard();
    if (actual.windowState !== 'minimized') throw new Error('指定书页窗口未保持最小化，停止操作');
    return;
  }
  try {
    await guard();
    const { windowId, bounds } = await session.send('Browser.getWindowForTarget');
    if (!Number.isSafeInteger(windowId) || !bounds) throw new Error('未取得指定书页的浏览器窗口身份');
    if (bounds.windowState !== 'minimized') {
      await guard();
      await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    }
    await guard();
    const actual = await session.send('Browser.getWindowBounds', { windowId });
    if (actual.bounds?.windowState !== 'minimized') throw new Error('指定书页窗口未保持最小化，停止操作');
  } finally { await session.detach(); }
  await guard();
}
