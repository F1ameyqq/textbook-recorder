const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const kinds = ['emphasis-dot', 'underline', 'underline-wavy', 'italic', 'bold'];
const exactKeys = (value, keys) => Object.keys(value).every(key => keys.includes(key));
const escape = text => text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&#39;').replace(/\r\n?|\n/gu, '<br>');

function graphemeBoundaries(text) {
  const boundaries = new Set([0, Array.from(text).length]);
  let offset = 0;
  for (const segment of new Intl.Segmenter('zh', {granularity:'grapheme'}).segment(text)) {
    boundaries.add(offset); offset += Array.from(segment.segment).length; boundaries.add(offset);
  }
  return boundaries;
}

/** Exact final paragraph text, including indentation and sup/sub characters. */
export function nativeEmphasisText(block) {
  if (!object(block) || block.type !== 'text' || block.parts !== undefined
    || (block.text !== undefined) === (block.runs !== undefined)) throw new Error('emphasis 仅支持 text 或 runs 段落，两者互斥且不能混用 parts');
  const complete = text => typeof text === 'string' && Boolean(text.trim()) && text.isWellFormed() && !/\r/u.test(text);
  if (block.runs === undefined) {
    if (!complete(block.text)) throw new Error('emphasis 文本须为非空完整Unicode及LF换行');
    return block.text;
  }
  if (!Array.isArray(block.runs) || !block.runs.length || block.runs.some(run => !object(run)
    || !exactKeys(run,['type','text']) || !['text','sup','sub'].includes(run.type) || !complete(run.text))) {
    throw new Error('emphasis runs 须为仅含 type/text 的非空 text/sup/sub，文本须为完整Unicode且无CR');
  }
  const text = block.runs.map(run=>run.text).join(''), boundaries = graphemeBoundaries(text);
  let offset = 0;
  for (const run of block.runs) {
    offset += Array.from(run.text).length;
    if (!boundaries.has(offset)) throw new Error('run 边界不能拆开完整字符或grapheme');
  }
  return text;
}

/** Offsets are Unicode code points in the FINAL text; end is exclusive. */
export function assertNativeEmphasis(block) {
  if (!object(block)) throw new Error('格式块必须是对象');
  if (block.emphasis === undefined) { if (block.runs !== undefined) nativeEmphasisText(block); return []; }
  const text = nativeEmphasisText(block);
  const spec = block.emphasis;
  if (!object(spec) || !exactKeys(spec, ['schemaVersion', 'indexUnit', 'marks']) || spec.schemaVersion !== 1 || spec.indexUnit !== 'unicode-code-points' || !Array.isArray(spec.marks) || !spec.marks.length) throw new Error('emphasis 必须明确版本1、unicode-code-points和非空marks；旧来源标注不可执行');
  const chars = Array.from(text), boundaries = graphemeBoundaries(text);
  const marks = spec.marks.map(mark => {
    if (!object(mark) || !exactKeys(mark, ['type', 'start', 'end', 'text']) || !kinds.includes(mark.type) || !Number.isSafeInteger(mark.start) || !Number.isSafeInteger(mark.end) || mark.start < 0 || mark.end <= mark.start || mark.end > chars.length || typeof mark.text !== 'string') throw new Error('原生格式范围、类型或字段无效');
    const text = chars.slice(mark.start, mark.end).join('');
    if (text !== mark.text || !text.trim() || /[\r\n]/u.test(text) || !boundaries.has(mark.start) || !boundaries.has(mark.end)) throw new Error('格式范围须精确匹配最终文字，不跨换行或拆开完整字符');
    return {...mark};
  }).sort((a,b) => a.start-b.start || a.end-b.end || a.type.localeCompare(b.type));
  // Different kinds may overlap; duplicate/overlapping ranges of one kind may not.
  for (const kind of kinds) {
    let end = -1;
    for (const mark of marks.filter(mark => mark.type === kind)) { if (mark.start < end) throw new Error('同类格式范围重复或交叠'); end = mark.end; }
  }
  for (const solid of marks.filter(mark=>mark.type==='underline')) {
    if (marks.some(mark=>mark.type==='underline-wavy' && mark.start<solid.end && solid.start<mark.end)) throw new Error('实线与波浪下划线范围不能交叠');
  }
  return marks;
}

export function renderNativeEmphasis(block) {
  const marks = assertNativeEmphasis(block), chars = Array.from(nativeEmphasisText(block));
  let offset = 0;
  const runs = (block.runs ?? [{type:'text',text:block.text}]).map(run=> {
    const start=offset; offset += Array.from(run.text).length; return {type:run.type,start,end:offset};
  });
  const points = [...new Set([0, chars.length, ...runs.flatMap(run=>[run.start,run.end]), ...marks.flatMap(mark => [mark.start,mark.end])])].sort((a,b)=>a-b);
  return runs.map(run=>{
    const runPoints=points.filter(point=>point>=run.start&&point<=run.end);
    const html=runPoints.slice(0,-1).map((start,i) => {
      const end = runPoints[i+1], active = marks.filter(mark=>mark.start<=start && mark.end>=end);
      let fragment = escape(chars.slice(start,end).join(''));
      if (block.strictSpacing === true) fragment = fragment.replace(/ /gu, '&nbsp;');
      if (active.some(mark=>mark.type==='underline')) fragment = `<u>${fragment}</u>`;
      if (active.some(mark=>mark.type==='underline-wavy')) fragment = `<u style="text-decoration-style:wavy">${fragment}</u>`;
      if (active.some(mark=>mark.type==='emphasis-dot')) fragment = `<span style="text-emphasis-style:dot;text-emphasis-position:under right;-webkit-text-emphasis-style:dot;-webkit-text-emphasis-position:under right">${fragment}</span>`;
      if (active.some(mark=>mark.type==='italic')) fragment = `<i>${fragment}</i>`;
      if (active.some(mark=>mark.type==='bold')) fragment = `<b>${fragment}</b>`;
      return fragment;
    }).join('');
    // One script element per authored run retains its exact text/identity while
    // its children carry any overlapping inline marks.
    return run.type==='text'?html:`<${run.type}>${html}</${run.type}>`;
  }).join('');
}

/** Canonical per-character signature catches moved, widened, lost or added marks. */
export function nativeEmphasisSignature(text, marks) {
  if (typeof text !== 'string' || !text.isWellFormed() || !Array.isArray(marks)) throw new Error('回读格式文字或范围无效');
  const chars=Array.from(text.replace(/\u00a0/gu,' '));
  const signature=chars.map(char=>[char,[]]);
  for(const mark of marks) {
    if(!object(mark)||!exactKeys(mark,['type','start','end','text'])||!kinds.includes(mark.type)||typeof mark.text!=='string'||!Number.isSafeInteger(mark.start)||!Number.isSafeInteger(mark.end)||mark.start<0||mark.end<=mark.start||mark.end>chars.length||chars.slice(mark.start,mark.end).join('')!==mark.text.replace(/\u00a0/gu,' ')) throw new Error('回读格式范围、类型或文字无效');
    for(let i=mark.start;i<mark.end;i++) {
      if(signature[i][1].includes(mark.type)) throw new Error('回读同类格式范围重复或交叠');
      if(['underline','underline-wavy'].includes(mark.type) && signature[i][1].some(type=>['underline','underline-wavy'].includes(type))) throw new Error('回读实线与波浪下划线范围交叠');
      signature[i][1].push(mark.type);
    }
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
        let element=node.parentElement, underlines=new Set(), emphasis=null;
        // Emphasis inherits and can be explicitly reset to none; computed
        // styling on the immediate parent already accounts for that cascade.
        const nearest=getComputedStyle(element);
        const fonts=[];
        if(nearest.fontStyle==='italic')fonts.push('italic');
        else if(nearest.fontStyle && nearest.fontStyle!=='normal')fonts.push('unsupported-italic');
        if(nearest.fontWeight==='bold'||Number.parseFloat(nearest.fontWeight)>=700)fonts.push('bold');
        const dot=nearest.textEmphasisStyle || nearest.webkitTextEmphasisStyle;
        const position=nearest.textEmphasisPosition || nearest.webkitTextEmphasisPosition;
        if(dot && dot!=='none')emphasis=/^(?:filled\s+)?dot$/u.test(dot) && ['under','under right'].includes(position) ? 'emphasis-dot' : 'unsupported-emphasis';
        while(element && paragraph.contains(element)) {
          const style=getComputedStyle(element);
          if(style.textDecorationLine.split(/\s/u).includes('underline')) {
            underlines.add(style.textDecorationStyle==='solid'?'underline':style.textDecorationStyle==='wavy'?'underline-wavy':'unsupported-underline');
          }
          if(element===paragraph)break;
          element=element.parentElement;
        }
        text+=value;
        const end=Array.from(text).length;
        if(end>start)for(const type of [...underlines,...(emphasis?[emphasis]:[]),...fonts])marks.push({type,start,end,text:value});
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
        if(node.nodeType===3){
          const start=Array.from(text).length,value=node.nodeValue;text+=value;const end=Array.from(text).length;
          let e=node.parentElement,d=false,seen=false,italic=null,bold=null;const underlines=new Set();
          while(e){
            if(italic===null){
              const value=e.style.fontStyle;
              if(value && !['inherit','unset'].includes(value)){
                if(!['normal','italic'].includes(value))throw new Error('已审原生格式不支持该 font-style');
                italic=value==='italic';
              } else if(!value && ['I','EM'].includes(e.tagName))italic=true;
            }
            if(bold===null){
              const value=e.style.fontWeight;
              if(value && !['inherit','unset'].includes(value)){
                if(value==='normal')bold=false;
                else if(value==='bold')bold=true;
                else if(/^(?:\d+(?:\.\d+)?|\.\d+)$/u.test(value) && Number(value)>=1 && Number(value)<=1000)bold=Number(value)>=700;
                else throw new Error('已审原生格式不支持该 font-weight');
              } else if(!value && ['B','STRONG'].includes(e.tagName))bold=true;
            }
            if(e.tagName==='U'||e.style.textDecorationLine.split(/\s/u).includes('underline')) {
              const style=e.style.textDecorationStyle||'solid';
              underlines.add(style==='solid'?'underline':style==='wavy'?'underline-wavy':'unsupported-underline');
            }
            const dot=e.style.textEmphasisStyle||e.style.webkitTextEmphasisStyle;
            if(!seen&&dot){seen=true;const position=e.style.textEmphasisPosition||e.style.webkitTextEmphasisPosition;d=/^(?:filled\s+)?dot$/u.test(dot)&&['under','under right'].includes(position);}
            if(e===paragraph)break;e=e.parentElement;
          }
          if(end>start)for(const type of [...underlines,...(d?['emphasis-dot']:[]),...(italic?['italic']:[]),...(bold?['bold']:[])])marks.push({type,start,end,text:value});
        }
        else if(node.nodeType===1){if(node.matches('img,svg,math-tex,.formula-node'))return;if(node.tagName==='BR'){text+='\n';return;}for(const child of node.childNodes)walk(child);}
      };walk(paragraph);return{text,marks};
    });
  },html);
  const actual=await page.locator(selector).evaluate(readEditorNativeEmphasis);
  for(let i=0;i<Math.max(expected.length,actual.length);i++) {
    const want=expected[i],got=actual[i];
    if(!(want?.marks.length || got?.marks.length))continue;
    let matches=false;
    try { matches=!!want && !!got && nativeEmphasisSignature(want.text,want.marks)===nativeEmphasisSignature(got.text,got.marks); }
    catch(error) { throw new Error(`原生加点/下划线/粗斜体回读无效：段落${i+1}: ${error.message}`); }
    if(!matches)throw new Error(`原生加点/下划线/粗斜体输入回读不一致：段落${i+1}`);
  }
  return actual;
}
