import { checkedPointerClick } from './checked-pointer-click.mjs';
import { assertEditorNativeEmphasis } from './native-emphasis.mjs';
import { assertEditorNativeScripts } from './native-scripts.mjs';
import { activateRecorderPage, validateBrowserFocusMode, validateBrowserWindowMode } from './browser-focus.mjs';
import { requireRecorderDocumentReady, assertRecorderDocumentSnapshot } from './browser-document-state.mjs';
import { prepareReviewedLiteralDollarHtml, assertEditorLiteralDollarSafety } from './literal-dollar.mjs';

/**
 * Insert already reviewed HTML through the browser's editing command.
 * The caller remains responsible for book/record scope and server receipts.
 * This uses normal DOM/keyboard APIs, not an editor framework or save endpoint.
 */
export async function insertReviewedEditorHtml(page, selector, html, { replace = false, timeoutMs = 20000, guard = async () => {}, allowGeneratedTrailingEmptyParagraph = false, focusMode = 'foreground', windowMode = 'normal' } = {}) {
  validateBrowserFocusMode(focusMode);
  validateBrowserWindowMode(windowMode);
  if (focusMode === 'foreground' && windowMode === 'minimized') throw new Error('minimized 窗口只允许 background 模式');
  if (!page || typeof page.locator !== 'function') throw new Error('A Playwright page is required');
  if (typeof selector !== 'string' || !selector.trim()) throw new Error('An explicit editor selector is required');
  if (typeof html !== 'string' || !html.trim() || html.includes('\0')) throw new Error('Reviewed HTML must be nonempty and contain no NUL');
  if (typeof replace !== 'boolean' || typeof allowGeneratedTrailingEmptyParagraph !== 'boolean' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Invalid editor command options');
  const editor = page.locator(selector);
  if (await editor.count() !== 1) throw new Error('Editor selector must match exactly one element');
  const initial = await editor.evaluate(element => ({
    editable: element.isContentEditable,
    empty: !element.textContent.trim() && !element.querySelector('img,svg,canvas,video,audio,iframe,object,.formula-node'),
  }));
  if (!initial.editable) throw new Error('Target is not contenteditable');
  if (!replace && !initial.empty) throw new Error('Append command requires an empty editor; no content changed');
  const literalDollars = await page.evaluate(prepareReviewedLiteralDollarHtml, html);

  await activateRecorderPage(page, focusMode, {windowMode,guard});
  await checkedPointerClick(page, editor, {timeout:timeoutMs,guard,focusMode,windowMode});
  // Genuine keyboard input establishes a browser selection/caret in the editor.
  await editor.press(replace ? 'Control+KeyA' : 'Control+Home');
  await guard();
  const backgroundBinding = focusMode === 'background'
    ? await requireRecorderDocumentReady(page, {focusMode,windowMode,guard}) : null;
  const result = await editor.evaluate((element, { html, replace, backgroundBinding }) => {
    // Recheck actionability synchronously before editing, after trusted keyboard
    // input. A lost focus, hidden document or changed target must stop here.
    if (backgroundBinding) {
      if (location.href !== backgroundBinding.url || performance.timeOrigin !== backgroundBinding.timeOrigin
          || !['visible','hidden'].includes(document.visibilityState) || document.prerendering
          || !['interactive','complete'].includes(document.readyState)
          || !backgroundBinding.minimized && document.visibilityState !== 'visible') throw new Error('Editor document changed after background-window verification');
    } else if (document.visibilityState !== 'visible' || !document.hasFocus()) throw new Error('Editor document is hidden or has lost DOM focus');
    const rect = element.getBoundingClientRect(), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    const style = getComputedStyle(element), hit = document.elementFromPoint(x, y);
    if (!element.isConnected || rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden'
        || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight || !(hit === element || hit && element.contains(hit))) throw new Error('Editor is hidden, outside the viewport or covered before insertion');
    const selection = window.getSelection();
    const inside = node => !!node && (node === element || element.contains(node));
    if (!element.isContentEditable || document.activeElement !== element || !selection || selection.rangeCount !== 1 || !inside(selection.anchorNode) || !inside(selection.focusNode)) throw new Error('Active selection is not confined to the target editor');
    // Chromium Ctrl+A may stop before an atomic SVG at the editor's end.
    // Select the explicit editor's complete contents through a normal Range.
    if (replace) {
      const range=document.createRange();range.selectNodeContents(element);
      selection.removeAllRanges();selection.addRange(range);
    }
    if (!replace && (!selection.isCollapsed || element.textContent.trim() || element.querySelector('img,svg,canvas,video,audio,iframe,object,.formula-node'))) throw new Error('Empty-editor caret or content changed before insertion');
    if (replace && element.textContent.trim() && selection.isCollapsed) throw new Error('Replace requires a noncollapsed editor selection');

    const expected = document.createElement('div');
    expected.innerHTML = html; // Detached parsing of the caller's reviewed fragment only.
    if (expected.querySelector('script,iframe,object,embed') || [...expected.querySelectorAll('*')].some(node => [...node.attributes].some(attribute => /^on/iu.test(attribute.name)))) throw new Error('Reviewed fragment contains executable elements or handlers');
    if (!expected.textContent.trim() && !expected.querySelector('img')) throw new Error('Reviewed fragment contains no text or image');
    const inputEvents = [];
    const listener = event => { if (event.target === element || element.contains(event.target)) inputEvents.push({ type:event.type, inputType:event.inputType, isTrusted:event.isTrusted }); };
    element.addEventListener('beforeinput', listener);
    element.addEventListener('input', listener);
    let succeeded;
    try { succeeded = document.execCommand('insertHTML', false, html); }
    finally { element.removeEventListener('beforeinput', listener); element.removeEventListener('input', listener); }
    if (!succeeded) throw new Error('Browser insertHTML command declined the insertion');
    return { command:'insertHTML', succeeded, selectionVerified:true, inputEvents };
  }, { html: literalDollars.html, replace, backgroundBinding });
  if (backgroundBinding) {
    const after = await requireRecorderDocumentReady(page, {focusMode,windowMode,guard});
    assertRecorderDocumentSnapshot(after, backgroundBinding);
    if (String(after.windowId) !== String(backgroundBinding.windowId)) throw new Error('Editor window identity changed during insertion');
  }
  await assertEditorLiteralDollarSafety(page,selector,literalDollars);

  await page.waitForFunction(({ selector, html }) => {
    const actual = document.querySelector(selector);
    const expected = document.createElement('div');
    expected.innerHTML = html;
    const signature = value => {
      const copy=value.cloneNode(true), formulas=[];
      const selector='math-tex,.formula-node[data-latex]';
      // The actual platform keeps math-tex as a wrapper around its rendered
      // formula-node. Read that one node's source instead of counting both.
      const roots=[...copy.querySelectorAll(selector)].filter(node=>!node.parentElement?.closest(selector));
      for(const node of roots) {
        let latex;
        const nested=[...node.querySelectorAll('.formula-node[data-latex]')];
        if((node.matches('math-tex')&&nested.length>1)||(!node.matches('math-tex')&&nested.length)) throw new Error('Formula contains multiple nested identities');
        const native=node.matches('.formula-node[data-latex]')?node:nested[0];
        if(native) {
          try {latex=decodeURIComponent(native.getAttribute('data-latex'));} catch {throw new Error('Formula data-latex encoding is invalid');}
          latex=latex.replace(/\u200b/gu,'').trim();
        } else {
          latex=node.textContent.replace(/\u200b/gu,'').trim();
          if(latex.startsWith('$$')&&latex.endsWith('$$'))latex=latex.slice(2,-2).trim();
          else if(latex.startsWith('$')&&latex.endsWith('$'))latex=latex.slice(1,-1).trim();
          else if(latex.startsWith('$')||latex.endsWith('$'))throw new Error('Formula delimiters are incomplete');
        }
        if(!latex)throw new Error('Formula LaTeX is empty');
        formulas.push(latex);node.remove();
      }
      const text=copy.textContent.replace(/\r\n?/gu,'\n').replace(/\u00a0/gu,' ').replace(/\u200b/gu,'').replace(/ *\n */gu,'\n').trim();
      return JSON.stringify([text,formulas]);
    };
    return !!actual && signature(actual) === signature(expected) && actual.querySelectorAll('img').length === expected.querySelectorAll('img').length;
  }, { selector, html }, { timeout:timeoutMs, polling:80 });

  const checked = await editor.evaluate((element, html) => {
    const expected = document.createElement('div');
    expected.innerHTML = html;
    const wanted = [...expected.children];
    const actual = [...element.children];
    const errors = [];
    
    for (let i = 0; i < wanted.length; i++) {
      const want = wanted[i], got = actual[i];
      if (!got || want.tagName !== got.tagName) { errors.push(`Paragraph ${i + 1} structure changed`); continue; }
      // Browser editing may normalize left to start in an LTR paragraph.
      // Accept that equivalent layout, but never repair a live editor by
      // assigning innerHTML or dispatching synthetic input after the command.
      for (const attribute of [...want.attributes]) {
        if (attribute.name === 'style') {
          for (const property of [...want.style]) {
            const value = want.style.getPropertyValue(property);
            const computed = getComputedStyle(got);
            const equivalentLeft = property === 'text-align' && value === 'left' && ['start', '-webkit-left'].includes(computed.textAlign) && computed.direction === 'ltr';
            if (!equivalentLeft && got.style.getPropertyValue(property) !== value && computed.getPropertyValue(property) !== value) errors.push(`Paragraph ${i + 1} style ${property} changed`);
          }
        } else if (got.getAttribute(attribute.name) !== attribute.value) errors.push(`Paragraph ${i + 1} attribute ${attribute.name} changed`);
      }
      if (got.querySelectorAll('img').length !== want.querySelectorAll('img').length) errors.push(`Paragraph ${i + 1} image count changed`);
    }
    const images = [...element.querySelectorAll('img')];
    const expectedImages = [...expected.querySelectorAll('img')];
    if (images.some((image, i) => image.getAttribute('src') !== expectedImages[i]?.getAttribute('src'))) errors.push('Image source or order changed');
    const last=actual.at(-1);return { errors, paragraphCount:actual.length, wantedParagraphCount:wanted.length, trailingParagraph:last?{tag:last.tagName,attributeCount:last.attributes.length,childNodeCount:last.childNodes.length,isLastNode:element.lastChild===last}:null, imageCount:images.length };
  }, html);
  const profile=reviewedParagraphCountProfile(checked,allowGeneratedTrailingEmptyParagraph);if(!profile.accepted)checked.errors.unshift('Top-level paragraph count changed');
  if (checked.errors.length) throw new Error('Browser command readback mismatch: ' + checked.errors.join('; '));
  await assertEditorNativeEmphasis(page,selector,html);
  await assertEditorNativeScripts(page,selector,html);
  await assertEditorLiteralDollarSafety(page,selector,literalDollars);
  return { ...result, paragraphCount:checked.paragraphCount, imageCount:checked.imageCount, addedGeneratedTrailingEmptyParagraph:profile.addedGeneratedTrailingEmptyParagraph, protectedLiteralDollarCount:literalDollars.count };
}

/** Opt-in permits only one entirely empty, unstyled native tail paragraph. */
export function reviewedParagraphCountProfile({paragraphCount,wantedParagraphCount,trailingParagraph},allowGeneratedTrailingEmptyParagraph=false){
  if(typeof allowGeneratedTrailingEmptyParagraph!=='boolean'||!Number.isSafeInteger(paragraphCount)||!Number.isSafeInteger(wantedParagraphCount)||paragraphCount<0||wantedParagraphCount<0)throw new Error('Invalid paragraph count profile');
  const addedGeneratedTrailingEmptyParagraph=allowGeneratedTrailingEmptyParagraph&&paragraphCount===wantedParagraphCount+1&&trailingParagraph?.tag==='P'&&trailingParagraph.attributeCount===0&&trailingParagraph.childNodeCount===0&&trailingParagraph.isLastNode===true;
  return {accepted:paragraphCount===wantedParagraphCount||addedGeneratedTrailingEmptyParagraph,addedGeneratedTrailingEmptyParagraph};
}
