const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const SAMPLE_COUNT = 3;
const SAMPLE_INTERVAL_MS = 80;
const RECT_TOLERANCE_PX = 0.5;
const sameRect = (left, right) => ['x', 'y', 'width', 'height']
  .every(field => Math.abs(left[field] - right[field]) <= RECT_TOLERANCE_PX);

/**
 * Send one native pointer click after timer-based actionability checks.
 * Playwright's normal stability check needs utility-world animation frames,
 * which can stop in an attached tab. This replaces that check without changing
 * application state, dispatching events, or bypassing an obstructing element.
 * The caller's guard owns page/book/editor identity and post-click verification.
 */
export async function checkedPointerClick(page, locator, { guard, timeout = 20000 } = {}) {
  if (!page || typeof page.isClosed !== 'function' || !locator || typeof locator.page !== 'function'
      || locator.page() !== page) throw new Error('Checked pointer click requires a locator on the supplied page');
  if (typeof guard !== 'function') throw new Error('Checked pointer click requires a scope guard');
  if (!Number.isSafeInteger(timeout) || timeout < 1) throw new Error('Checked pointer click timeout must be a positive integer');
  const deadline = Date.now() + timeout;
  const remaining = () => {
    const value = deadline - Date.now();
    if (value <= 0) throw new Error('Checked pointer click timed out before sending input');
    return value;
  };
  const ready = async () => {
    remaining();
    if (page.isClosed()) throw new Error('Checked pointer page is closed');
    if (await locator.count() !== 1) throw new Error('Checked pointer target must be unique');
    if (!await locator.isVisible()) throw new Error('Checked pointer target is not visible');
    if (!await locator.isEnabled({ timeout: remaining() })) throw new Error('Checked pointer target is disabled');
  };
  const sample = async () => {
    const state = await locator.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      const style = getComputedStyle(element);
      // Playwright's explicit position is relative to the padding box; its
      // _offsetPoint adds integer border widths to the bounding-box origin.
      const border = { left: parseInt(style.borderLeftWidth || '', 10), top: parseInt(style.borderTopWidth || '', 10) };
      const hit = document.elementFromPoint(point.x, point.y);
      return {
        connected: element.isConnected,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        point,
        border,
        position: { x: rect.width / 2 - border.left, y: rect.height / 2 - border.top },
        visibleDocument: document.visibilityState === 'visible',
        inViewport: point.x >= 0 && point.x < innerWidth && point.y >= 0 && point.y < innerHeight,
        hitTarget: hit === element || Boolean(hit && element.contains(hit)),
      };
    }, undefined, { timeout: remaining() });
    if (!state.connected || state.rect.width <= 0 || state.rect.height <= 0
        || !Object.values(state.rect).every(Number.isFinite)
        || !Object.values(state.position).every(Number.isFinite)) throw new Error('Checked pointer target has no connected visible rectangle');
    if (!state.visibleDocument) throw new Error('Checked pointer document is hidden');
    if (!state.inViewport) throw new Error('Checked pointer target center is outside the viewport');
    if (!state.hitTarget) throw new Error('Checked pointer target is covered by another element');
    return state;
  };

  await guard();
  await ready();
  // scrollIntoViewIfNeeded also waits for rAF stability. Ordinary instant
  // scrolling changes only the viewport and is checked before sending input.
  await locator.evaluate(element => element.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' }),
    undefined, { timeout: remaining() });
  let anchor;
  let final;
  let stableSamples = 0;
  let totalSamples = 0;
  while (!final) {
    // Only normal layout motion is retried. Scope changes, ambiguous targets,
    // disabled/hidden nodes and obstructing elements still fail immediately.
    await guard();
    await ready();
    const current = await sample();
    totalSamples++;
    if (!anchor || !sameRect(anchor.rect, current.rect)) {
      anchor = current;
      stableSamples = 1;
    } else stableSamples++;
    if (stableSamples >= SAMPLE_COUNT) {
      await guard();
      await ready();
      const checked = await sample();
      totalSamples++;
      if (sameRect(anchor.rect, checked.rect)) {
        final = checked;
        break;
      }
      anchor = checked;
      stableSamples = 1;
    }
    if (remaining() <= SAMPLE_INTERVAL_MS) throw new Error('Checked pointer target did not settle before timeout');
    await pause(SAMPLE_INTERVAL_MS);
  }
  // Force skips the broken rAF check. All actionability checks above still
  // apply; no second scroll may invalidate the final hit-test coordinates.
  await locator.click({ force: true, scroll: 'none', position: final.position, timeout: remaining() });
  await guard();
  return { clicked: true, point: final.point, rect: final.rect, samples: SAMPLE_COUNT, totalSamples, tolerancePx: RECT_TOLERANCE_PX };
}
