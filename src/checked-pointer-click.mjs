import { requireRecorderDocumentReady, assertRecorderDocumentSnapshot, recorderDocumentSnapshot } from './browser-document-state.mjs';
import { validateBrowserFocusMode, validateBrowserWindowMode } from './browser-focus.mjs';
import { randomUUID } from 'node:crypto';
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
export async function checkedPointerClick(page, locator, { guard, timeout = 20000, focusMode = 'foreground', windowMode = 'normal', preserveEditorFocus = false, beforeInput } = {}) {
  validateBrowserFocusMode(focusMode); validateBrowserWindowMode(windowMode);
  if (focusMode === 'foreground' && windowMode === 'minimized') throw new Error('minimized 只支持 background 模式');
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
  let documentBinding;
  const background = focusMode === 'background';
  const minimized = focusMode === 'background' && windowMode === 'minimized';
  if (typeof preserveEditorFocus !== 'boolean' || preserveEditorFocus && !minimized) throw new Error('Preserving editor focus is restricted to minimized background Save activation');
  if(beforeInput!==undefined&&(!preserveEditorFocus||typeof beforeInput!=='function'))throw new Error('Pre-Save assertion is restricted to preserved editor focus');
  const checkBackgroundWindow = async () => {
    const next = await requireRecorderDocumentReady(page, { focusMode, windowMode, guard });
    if (documentBinding) {
      assertRecorderDocumentSnapshot(next, documentBinding);
      if (String(next.windowId) !== String(documentBinding.windowId)) throw new Error('Recorder window identity changed during input checks');
    }
    documentBinding = next;
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
    if (background) assertRecorderDocumentSnapshot(await page.evaluate(recorderDocumentSnapshot), documentBinding);
    if (!minimized && !state.visibleDocument) throw new Error('Checked pointer document is hidden');
    if (!state.inViewport) throw new Error('Checked pointer target center is outside the viewport');
    if (!state.hitTarget) throw new Error('Checked pointer target is covered by another element');
    return state;
  };

  await guard();
  if (background) await checkBackgroundWindow();
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
  // Page.mouse sends native input at the checked viewport coordinates, with no
  // locator's additional scrolling/actionability cycle after these checks.
  if (background) {
    await checkBackgroundWindow();
    const checked = await sample();
    if (!sameRect(final.rect, checked.rect)) throw new Error('Checked pointer target moved before input');
  }
  const clickKey = '__recorderPointer_' + randomUUID().replaceAll('-', '');
  await locator.evaluate((element,{key,preserveEditorFocus})=>{
    const events=[];
    const listener=event=>events.push({trusted:event.isTrusted,inside:event.target===element||element.contains(event.target),x:event.clientX,y:event.clientY});
    const activeEditor=document.activeElement,blurEvents=[];
    if(preserveEditorFocus&&(!element.matches('button.top-btn')||element.textContent.trim()!=='保存'
      ||document.querySelectorAll('#contentedit .w-e-text').length!==1||activeEditor!==document.querySelector('#contentedit .w-e-text')))throw new Error('No-focus activation requires the real Save button and active owned content editor');
    const blurListener=event=>{if(event.target===document.querySelector('#contentedit .w-e-text')||event.target===document.querySelector('#answeredit .w-e-text'))blurEvents.push({editor:event.target.closest('#contentedit')?'contentedit':'answeredit',trusted:event.isTrusted});};
    window[key]={events,listener,blurEvents,blurListener,activeEditor};document.addEventListener('click',listener,true);
    if(preserveEditorFocus)document.addEventListener('blur',blurListener,true);
  },{key:clickKey,preserveEditorFocus});
  let events;
  let editorFocus;
  try {
    remaining();
    if(beforeInput){await beforeInput();remaining();}
    if (minimized) {
      await locator.evaluate((element,{point,binding,preserveEditorFocus,key})=>{
        if(location.href!==binding.url||performance.timeOrigin!==binding.timeOrigin)throw new Error('Background activation document changed');
        const rect=element.getBoundingClientRect(),hit=document.elementFromPoint(point.x,point.y),style=getComputedStyle(element);
        if(!(element instanceof HTMLElement)||!element.isConnected||rect.width<=0||rect.height<=0
            ||style.display==='none'||style.visibility==='hidden'||!(hit===element||hit&&element.contains(hit)))throw new Error('Background activation target is hidden or covered');
        // Standard browser focus/activation: no fabricated events, framework
        // state mutation or save endpoint. Focus also performs ordinary blur.
        if(preserveEditorFocus){
          const slot=window[key];
          if(!slot||document.activeElement!==slot.activeEditor||slot.activeEditor!==document.querySelector('#contentedit .w-e-text')
            ||!element.matches('button.top-btn')||element.textContent.trim()!=='保存')throw new Error('Owned editor focus changed before Save activation');
        }else element.focus({preventScroll:true});
        // Activate the actual hit-tested child, so child label/icon handlers
        // receive the same target as a pointer at the checked coordinates.
        let activationTarget=hit;
        while(activationTarget&&!(activationTarget instanceof HTMLElement))activationTarget=activationTarget.parentElement;
        if(!activationTarget||!(activationTarget===element||element.contains(activationTarget)))throw new Error('Background activation hit target changed');
        HTMLElement.prototype.click.call(activationTarget);
        if(preserveEditorFocus&&document.activeElement!==window[key].activeEditor)throw new Error('Save activation changed owned editor focus');
      },{point:final.point,binding:documentBinding,preserveEditorFocus,key:clickKey});
    } else await page.mouse.click(final.point.x,final.point.y);
  } finally {
    const observation=await page.evaluate(({key,preserveEditorFocus})=>{const slot=window[key];if(!slot)throw new Error('Pointer event observation lost its document');document.removeEventListener('click',slot.listener,true);if(preserveEditorFocus)document.removeEventListener('blur',slot.blurListener,true);delete window[key];return {events:slot.events,editorFocus:preserveEditorFocus?{preserved:document.activeElement===slot.activeEditor,blurEvents:slot.blurEvents}:null};},{key:clickKey,preserveEditorFocus});
    events=observation.events;editorFocus=observation.editorFocus;
  }
  if(events.length!==1||(!minimized&&!events[0].trusted)||!events[0].inside) {
    const error=new Error('Native pointer click did not reach the checked target: '+JSON.stringify(events));
    error.nativePointer={point:final.point,rect:final.rect,events,documentCheck:documentBinding};throw error;
  }
  if(preserveEditorFocus&&(!editorFocus?.preserved||editorFocus.blurEvents.length)){
    const error=new Error('Save activation blurred an owned editor; retain the write lock');
    error.nativePointer={point:final.point,rect:final.rect,events,editorFocus,documentCheck:documentBinding};throw error;
  }
  await guard();
  if (background) await checkBackgroundWindow();
  return { clicked: true, point: final.point, rect: final.rect, samples: SAMPLE_COUNT, totalSamples, tolerancePx: RECT_TOLERANCE_PX,
    nativeClick:events[0],
    activationMethod:minimized?(preserveEditorFocus?'HTMLElement.click/preserve-editor-focus':'HTMLElement.focus/click'):'page.mouse.click',
    ...(preserveEditorFocus?{editorFocus}:{}),
    ...(background ? {documentCheck:{...documentBinding,checkedAt:new Date().toISOString()}} : {}) };
}
