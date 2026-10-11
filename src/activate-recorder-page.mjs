/** Restore only the guarded recorder page's Chromium window when tab activation
 * leaves a minimized document hidden. All input actionability checks still run. */
export async function activateRecorderPage(page, guard) {
  await guard();
  await page.bringToFront();
  if (await page.evaluate(() => document.visibilityState === 'visible')) return;
  // Tab activation may finish before Chromium publishes its visibility event.
  // Wait for the actual state; this does not override or emulate visibility.
  if (typeof page.waitForFunction === 'function') {
    try {
      const ready = await page.waitForFunction(() => document.visibilityState === 'visible', undefined, { polling: 80, timeout: 2000 });
      await ready?.dispose?.();
      await guard();
      if (await page.evaluate(() => document.visibilityState === 'visible')) return;
    } catch (error) {
      if (error.name !== 'TimeoutError') throw error;
    }
  }
  const session = await page.context().newCDPSession(page);
  try {
    await guard();
    const {windowId, bounds} = await session.send('Browser.getWindowForTarget');
    if (bounds.windowState === 'minimized') {
      await session.send('Browser.setWindowBounds', {windowId, bounds: {windowState: 'normal'}});
    }
    await page.bringToFront();
  } finally { await session.detach(); }
  await guard();
  if (!await page.evaluate(() => document.visibilityState === 'visible')) {
    throw new Error('录入页仍隐藏，停止输入');
  }
}
