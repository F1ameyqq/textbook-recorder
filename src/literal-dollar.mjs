/** Browser callback: prepare only a detached reviewed fragment, never a live editor.
 * MathJax pairs dollar delimiters within one parent. Separate inline parents
 * preserve literal text; white-space:pre prevents Chromium dropping empty-style
 * spans during insertHTML. The span contains only '$', so no spacing is added.
 * https://docs.mathjax.org/en/latest/input/tex/delimiters.html
 */
export function prepareReviewedLiteralDollarHtml(html) {
  if (typeof html !== 'string' || !html.trim() || html.includes('\0')) throw new Error('Invalid reviewed literal-dollar HTML');
  const fragment = document.createElement('div');
  fragment.innerHTML = html;
  const before = fragment.textContent;
  const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let count = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.parentElement?.closest('math-tex,.formula-node') && node.data.includes('$')) nodes.push(node);
  }
  let changed = false;
  for (const node of nodes) {
    count += node.data.split('$').length - 1;
    const parent = node.parentElement;
    if (node.data === '$' && parent.tagName === 'SPAN' && parent.childNodes.length === 1 && parent.style.whiteSpace === 'pre') continue;
    const parts = node.data.split('$'), replacement = document.createDocumentFragment();
    parts.forEach((part, index) => {
      if (index) {
        const span = document.createElement('span');
        span.style.whiteSpace = 'pre';
        span.textContent = '$';
        replacement.append(span);
      }
      if (part) replacement.append(document.createTextNode(part));
    });
    node.replaceWith(replacement);
    changed = true;
  }
  if (fragment.textContent !== before) throw new Error('Literal-dollar preparation changed reviewed characters');
  const ordinary = fragment.cloneNode(true);
  ordinary.querySelectorAll('math-tex,.formula-node').forEach(node => node.remove());
  const formulaCount = [...fragment.querySelectorAll('math-tex,.formula-node')].filter(node => !node.parentElement?.closest('math-tex,.formula-node')).length;
  return {html: changed ? fragment.innerHTML : html, count, text:ordinary.textContent, formulaCount};
}

/** Browser callback: ordinary dollars only, including all direct text siblings.
 * Single-dollar legacy paragraphs are safe without requiring new markup.
 */
export function readEditorLiteralDollarSafety(element) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const parents = new Map();
  let count = 0, isolatedCount = 0, text = '';
  while (walker.nextNode()) {
    const node = walker.currentNode, parent = node.parentElement;
    if (!parent || parent.closest('math-tex,.formula-node')) continue;
    text += node.data;
    const dollars = node.data.split('$').length - 1;
    count += dollars;
    if (dollars) parents.set(parent, (parents.get(parent) ?? 0) + dollars);
    if (node.data === '$' && parent.tagName === 'SPAN' && parent.childNodes.length === 1) isolatedCount++;
  }
  const unsafeCount = [...parents.values()].filter(value => value > 1).reduce((sum, value) => sum + value, 0);
  const formulaCount = [...element.querySelectorAll('math-tex,.formula-node')].filter(node => !node.parentElement?.closest('math-tex,.formula-node')).length;
  return {count, unsafeCount, isolatedCount, text, formulaCount};
}

/** Never repairs a failed editor or retries with a second input method. */
export async function assertEditorLiteralDollarSafety(page, selector, expected) {
  if (!expected.count) return;
  const actual = await page.locator(selector).evaluate(readEditorLiteralDollarSafety);
  const spaces = text => text.replace(/\u00a0/gu, ' ');
  if (actual.count !== expected.count || actual.isolatedCount !== expected.count || actual.unsafeCount !== 0
      || actual.formulaCount !== expected.formulaCount
      || spaces(actual.text) !== spaces(expected.text)) throw new Error('普通货币 $ 原字符、空格或隔离结构在输入后丢失，或出现额外公式；保留现场，禁止退回粘贴重试');
}

/** Conservative check for unsupported native formula markup in plain manifests.
 * Formula-list evidence is checked independently by the caller.
 */
export function hasNativeFormulaMarkup(html) {
  if (typeof html !== 'string') return false;
  for (const match of html.matchAll(/<([a-z][\w:-]*)\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>/giu)) {
    if (match[1].toLowerCase() === 'math-tex') return true;
    // Consume complete attributes so a quoted title containing `class=...`
    // cannot hide the real class or masquerade as a formula node.
    for (const attribute of match[2].matchAll(/\s+([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu)) {
      if (attribute[1].toLowerCase() !== 'class') continue;
      const value = (attribute[2] ?? attribute[3] ?? attribute[4] ?? '').replace(/&#(?:x([0-9a-f]+)|(\d+));/giu, (entity, hex, decimal) => {
        const code = Number.parseInt(hex ?? decimal, hex ? 16 : 10);
        return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
      });
      if (value.split(/\s+/u).includes('formula-node')) return true;
    }
  }
  return false;
}
