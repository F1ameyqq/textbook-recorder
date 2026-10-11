const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const kinds = ['emphasis-dot', 'underline'];
const exactKeys = (value, keys) => Object.keys(value).every(key => keys.includes(key));
const escape = text => text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&#39;').replace(/\r\n?|\n/gu, '<br>');

/** Offsets are Unicode code points in the FINAL text; end is exclusive. */
export function assertNativeEmphasis(block) {
  if (!object(block)) throw new Error('格式块必须是对象');
  if (block.emphasis === undefined) return [];
  if (block.type !== 'text' || typeof block.text !== 'string' || !block.text.trim() || block.runs !== undefined || block.parts !== undefined) throw new Error('emphasis 仅支持纯 text 段落，不能混用 runs/parts');
  const spec = block.emphasis;
  if (!object(spec) || !exactKeys(spec, ['schemaVersion', 'indexUnit', 'marks']) || spec.schemaVersion !== 1 || spec.indexUnit !== 'unicode-code-points' || !Array.isArray(spec.marks) || !spec.marks.length) throw new Error('emphasis 必须明确版本1、unicode-code-points和非空marks；旧来源标注不可执行');
  if (!block.text.isWellFormed() || /\r/u.test(block.text)) throw new Error('emphasis 文本须为完整Unicode及LF换行');
  const chars = Array.from(block.text), boundaries = new Set([0, chars.length]);
  let offset = 0;
  for (const segment of new Intl.Segmenter('zh', {granularity:'grapheme'}).segment(block.text)) { boundaries.add(offset); offset += Array.from(segment.segment).length; boundaries.add(offset); }
  const marks = spec.marks.map(mark => {
    if (!object(mark) || !exactKeys(mark, ['type', 'start', 'end', 'text']) || !kinds.includes(mark.type) || !Number.isSafeInteger(mark.start) || !Number.isSafeInteger(mark.end) || mark.start < 0 || mark.end <= mark.start || mark.end > chars.length || typeof mark.text !== 'string') throw new Error('加点/下划线范围、类型或字段无效');
    const text = chars.slice(mark.start, mark.end).join('');
    if (text !== mark.text || !text.trim() || /[\r\n]/u.test(text) || !boundaries.has(mark.start) || !boundaries.has(mark.end)) throw new Error('格式范围须精确匹配最终文字，不跨换行或拆开完整字符');
    return {...mark};
  }).sort((a,b) => a.start-b.start || a.end-b.end || a.type.localeCompare(b.type));
  // Different kinds may overlap; duplicate/overlapping ranges of one kind may not.
  for (const kind of kinds) {
    let end = -1;
    for (const mark of marks.filter(mark => mark.type === kind)) { if (mark.start < end) throw new Error('同类格式范围重复或交叠'); end = mark.end; }
  }
  return marks;
}

export function renderNativeEmphasis(block) {
  const marks = assertNativeEmphasis(block), chars = Array.from(block.text);
  const points = [...new Set([0, chars.length, ...marks.flatMap(mark => [mark.start,mark.end])])].sort((a,b)=>a-b);
  return points.slice(0,-1).map((start,i) => {
    const end = points[i+1], active = marks.filter(mark=>mark.start<=start && mark.end>=end);
    let html = escape(chars.slice(start,end).join(''));
    if (block.strictSpacing === true) html = html.replace(/ /gu, '&nbsp;');
    if (active.some(mark=>mark.type==='underline')) html = `<u>${html}</u>`;
    if (active.some(mark=>mark.type==='emphasis-dot')) html = `<span style="text-emphasis-style:dot;text-emphasis-position:under right;-webkit-text-emphasis-style:dot;-webkit-text-emphasis-position:under right">${html}</span>`;
    return html;
  }).join('');
}

/** Canonical per-character signature catches moved, widened, lost or added marks. */
export function nativeEmphasisSignature(text, marks) {
  const chars=Array.from(text.replace(/\u00a0/gu,' '));
  const signature=chars.map(char=>[char,[]]);
  for(const mark of marks) {
    if(!Number.isSafeInteger(mark.start)||!Number.isSafeInteger(mark.end)||mark.start<0||mark.end<=mark.start||mark.end>chars.length||chars.slice(mark.start,mark.end).join('')!==mark.text.replace(/\u00a0/gu,' ')) throw new Error('回读格式范围或文字无效');
    for(let i=mark.start;i<mark.end;i++)signature[i][1].push(mark.type);
  }
  return JSON.stringify(signature.map(([char,types])=>[char,[...new Set(types)].sort()]));
}

/** Self-contained browser function. Read computed styling at each text node.
 * No DOM mutation, editor internals or framework state. BR counts as LF.
 */
export function readEditorNativeEmphasis(editor) {
  const read = paragraph => {
    let text='', marks=[];
    const visit = node => {
      if(node.nodeType===3) {
        const value=node.nodeValue.replace(/\u200b/gu,''), start=Array.from(text).length;
        let element=node.parentElement, underline=false, emphasis=null;
        // Emphasis inherits and can be explicitly reset to none; computed
        // styling on the immediate parent already accounts for that cascade.
        const nearest=getComputedStyle(element);
        const dot=nearest.textEmphasisStyle || nearest.webkitTextEmphasisStyle;
        const position=nearest.textEmphasisPosition || nearest.webkitTextEmphasisPosition;
        if(dot && dot!=='none')emphasis=/^(?:filled\s+)?dot$/u.test(dot) && ['under','under right'].includes(position) ? 'emphasis-dot' : 'unsupported-emphasis';
        while(element && paragraph.contains(element)) {
          const style=getComputedStyle(element);
          if(style.textDecorationLine.split(/\s/u).includes('underline'))underline=true;
          if(element===paragraph)break;
          element=element.parentElement;
        }
        text+=value;
        const end=Array.from(text).length;
        if(end>start)for(const type of [...(underline?['underline']:[]),...(emphasis?[emphasis]:[])])marks.push({type,start,end,text:value});
      } else if(node.nodeType===1) {
        if(node.matches('img,svg,math-tex,.formula-node'))return;
        if(node.tagName==='BR'){text+='\n';return;}
        for(const child of node.childNodes)visit(child);
      }
    };
    visit(paragraph);
    return {text,marks};
  };
  return [...editor.children].map(read);
}

/** Verify authored ranges against live DOM before a blur/save, in either input mode. */
export async function assertEditorNativeEmphasis(page, selector, html) {
  // Expected fragment is parsed in an isolated, inert local browser document.
  const expected = await page.locator(selector).evaluate((element,html)=> {
    const template=document.createElement('template'); template.innerHTML=html;
    return [...template.content.children].map(paragraph=>{
      let text='',marks=[];
      const walk=node=>{
        if(node.nodeType===3){const start=Array.from(text).length,value=node.nodeValue;text+=value;const end=Array.from(text).length;let e=node.parentElement,u=false,d=false,seen=false;while(e){u ||= e.tagName==='U'||e.style.textDecorationLine.split(/\s/u).includes('underline');const dot=e.style.textEmphasisStyle||e.style.webkitTextEmphasisStyle;if(!seen&&dot){seen=true;const position=e.style.textEmphasisPosition||e.style.webkitTextEmphasisPosition;d=/^(?:filled\s+)?dot$/u.test(dot)&&['under','under right'].includes(position);}if(e===paragraph)break;e=e.parentElement;}if(end>start)for(const type of [...(u?['underline']:[]),...(d?['emphasis-dot']:[])])marks.push({type,start,end,text:value});}
        else if(node.nodeType===1){if(node.matches('img,svg,math-tex,.formula-node'))return;if(node.tagName==='BR'){text+='\n';return;}for(const child of node.childNodes)walk(child);}
      };walk(paragraph);return{text,marks};
    });
  },html);
  const actual=await page.locator(selector).evaluate(readEditorNativeEmphasis);
  for(let i=0;i<Math.max(expected.length,actual.length);i++) {
    const want=expected[i],got=actual[i];
    if(!(want?.marks.length || got?.marks.length))continue;
    if(!want || !got || nativeEmphasisSignature(want.text,want.marks)!==nativeEmphasisSignature(got.text,got.marks))throw new Error(`原生加点/下划线输入回读不一致：段落${i+1}`);
  }
  return actual;
}
