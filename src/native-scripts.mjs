const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const kinds = ['sup', 'sub'];

/** Native script ranges use Unicode code points in one final paragraph. */
export function expectedNativeScripts(block) {
  if (!object(block)) throw new Error('上下标段落必须是对象');
  if (['image', 'analysis-separator'].includes(block.type)) return {text:'',marks:[]};
  if (!['text', ...kinds].includes(block.type)) throw new Error('上下标只支持 text/sup/sub 段落');
  if (block.parts !== undefined) {
    if (block.type !== 'text' || block.text !== undefined || block.runs !== undefined || !Array.isArray(block.parts)
        || block.parts.length < 2 || block.parts.some(part => typeof part !== 'string' || !part.trim())) throw new Error('上下标段落 parts 无效');
    return {text:block.parts.join('\u00a0'.repeat(8)),marks:[]};
  }
  const runs = block.runs === undefined ? [{type:block.type,text:block.text}] : block.runs;
  if (block.runs !== undefined && (block.type !== 'text' || block.text !== undefined || !Array.isArray(runs) || !runs.length)) throw new Error('上下标 runs 无效或与 text 冲突');
  let text = ''; const marks = [];
  for (const run of runs) {
    if (!object(run) || Object.keys(run).some(key => !['type','text'].includes(key)) || !['text', ...kinds].includes(run.type)
        || typeof run.text !== 'string' || !run.text.trim() || !run.text.isWellFormed()) throw new Error('上下标 runs 必须明确完整 Unicode 的 type/text');
    const value = run.text.replace(/\r\n?/gu,'\n'), start = Array.from(text).length;
    text += value;
    if (kinds.includes(run.type)) marks.push({type:run.type,start,end:Array.from(text).length,text:value});
  }
  return {text,marks};
}

/** Equivalent split text nodes keep their locations; unknown or overlapping
 * script declarations cannot silently become a valid native signature. */
export function nativeScriptsSignature(text, marks) {
  if (typeof text !== 'string' || !text.isWellFormed() || !Array.isArray(marks)) throw new Error('上下标回读文字或范围无效');
  const normalized = text.replace(/\u00a0/gu,' '), chars = Array.from(normalized);
  const signature = chars.map(char => [char,[]]);
  for (const mark of marks) {
    if (!object(mark) || Object.keys(mark).some(key => !['type','start','end','text'].includes(key)) || !kinds.includes(mark.type)
        || !Number.isSafeInteger(mark.start) || !Number.isSafeInteger(mark.end) || mark.start < 0 || mark.end <= mark.start
        || mark.end > chars.length || typeof mark.text !== 'string' || chars.slice(mark.start,mark.end).join('') !== mark.text.replace(/\u00a0/gu,' ')) throw new Error('上下标回读范围、类型或文字无效');
    for (let index = mark.start; index < mark.end; index++) {
      if (signature[index][1].includes(mark.type)) throw new Error('上下标回读范围重复或交叠');
      signature[index][1].push(mark.type);
    }
  }
  return JSON.stringify(signature.map(([char,types]) => [char,types.sort()]));
}

/** Self-contained, read-only browser callback. HTML, when supplied internally,
 * is parsed only in an inert template; ordinary calls inspect the live editor.
 * Formula atoms/images are checked separately and do not contribute offsets. */
export function readEditorNativeScripts(editor, html) {
  const inert = html !== undefined;
  let root = editor;
  if (inert) {
    if (typeof html !== 'string') throw new Error('Expected native script HTML must be text');
    const template = document.createElement('template'); template.innerHTML = html; root = template.content;
  }
  const read = paragraph => {
    let text = ''; const marks = [];
    const append = (value,node) => {
      value = value.replace(/\u200b/gu,'');
      if (!value) return;
      const start = Array.from(text).length, active = [];
      let element = node.nodeType === 1 ? node : node.parentElement;
      while (element && paragraph.contains(element)) {
        const tag = element.tagName.toLowerCase();
        const align = inert ? element.style.verticalAlign : getComputedStyle(element).verticalAlign;
        let type = align === 'super' ? 'sup' : align === 'sub' ? 'sub' : inert && ['sup','sub'].includes(tag) && !align ? tag : null;
        if (!inert && ['sup','sub'].includes(tag) && type !== tag) {
          const style=getComputedStyle(element), parentStyle=getComputedStyle(element.parentElement);
          // A normalizer can implement semantic SUP/SUB using relative offsets.
          // Chromium resolves the opposite auto offset to its negation, so the
          // two computed offsets must agree with that one displacement.
          const px = value => /^-?(?:\d+\.?\d*|\.\d+)px$/u.test(value) ? Number.parseFloat(value) : NaN;
          const close = (actual,expected) => Number.isFinite(actual) && Number.isFinite(expected)
            && Math.abs(actual-expected) <= Math.max(.01,Math.abs(expected)*.001);
          const fontSize=px(style.fontSize), parentFontSize=px(parentStyle.fontSize), top=px(style.top), bottom=px(style.bottom);
          const normalized = align === 'baseline' && style.position === 'relative' && style.display === 'inline'
            && style.transform === 'none' && px(style.lineHeight) === 0 && fontSize > 0 && parentFontSize > 0
            && close(fontSize,parentFontSize*.75) && close(top,-bottom)
            && (tag === 'sup' ? close(top,-fontSize*.5) : close(bottom,-fontSize*.25));
          if (normalized) type=tag;
          else {
            const alignment=['baseline','super','sub','top','bottom','middle','text-top','text-bottom'].includes(align)?align:'other';
            const position=['static','relative','absolute','fixed','sticky'].includes(style.position)?style.position:'other';
            const dimension=value=>value==='auto'?'auto':Number.isFinite(parseFloat(value))?parseFloat(value):'other';
            throw new Error(`原生上下标的真实纵向样式改变 (tag=${tag},align=${alignment},position=${position},top=${dimension(style.top)},bottom=${dimension(style.bottom)},fontSize=${dimension(style.fontSize)},parentFontSize=${dimension(parentStyle.fontSize)},lineHeight=${dimension(style.lineHeight)})`);
          }
        }
        if (type) {
          if (active.includes(type)) throw new Error('原生上下标存在重复嵌套');
          active.push(type);
        }
        if (element === paragraph) break;
        element = element.parentElement;
      }
      text += value;
      const end = Array.from(text).length;
      for (const type of active) marks.push({type,start,end,text:value});
    };
    const visit = node => {
      if (node.nodeType === 3) append(node.nodeValue,node);
      else if (node.nodeType === 1) {
        if (node.matches('img,svg,math-tex,.formula-node')) return;
        if (node.tagName === 'BR') { append('\n',node); return; }
        for (const child of node.childNodes) visit(child);
      }
    };
    visit(paragraph);
    return {text,marks};
  };
  return [...root.children].map(read);
}

/** Runs before save/blur; never repairs or mutates an editor that failed. */
export async function assertEditorNativeScripts(page, selector, html) {
  const editor = page.locator(selector);
  const expected = await editor.evaluate(readEditorNativeScripts,html);
  const actual = await editor.evaluate(readEditorNativeScripts);
  for (let index = 0; index < Math.max(expected.length,actual.length); index++) {
    const want = expected[index], got = actual[index];
    if (!(want?.marks.length || got?.marks.length)) continue;
    if (!want || !got || nativeScriptsSignature(want.text,want.marks) !== nativeScriptsSignature(got.text,got.marks)) throw new Error(`原生上下标输入回读不一致：段落${index+1}`);
  }
  return actual;
}
