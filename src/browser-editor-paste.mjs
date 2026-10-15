import { insertReviewedEditorHtml } from './browser-editor-command.mjs';
import { validateBrowserFocusMode, validateBrowserWindowMode } from './browser-focus.mjs';
import { assertEditorNativeScripts } from './native-scripts.mjs';

/** Preserve the full reviewed fragment, then paste only each native formula.
 * The platform's whole-fragment paste formatter removes unit spaces after sup.
 * A formula-only paste renders MathJax without reformatting ordinary text.
 */
export async function pasteReviewedEditorHtml(page, selector, html, {replace=false,timeoutMs=20000,guard=async()=>{},allowGeneratedTrailingEmptyParagraph=false,protectFormulaBoundarySpaces=false,focusMode='foreground',windowMode='normal'}={}) {
  validateBrowserFocusMode(focusMode);
  validateBrowserWindowMode(windowMode);
  if (focusMode === 'foreground' && windowMode === 'minimized') throw new Error('minimized 窗口只允许 background 模式');
  if (!page || typeof page.locator!=='function' || typeof selector!=='string' || !selector || typeof html!=='string' || !html.trim() || html.includes('\0') || typeof replace!=='boolean' || typeof allowGeneratedTrailingEmptyParagraph!=='boolean' || typeof protectFormulaBoundarySpaces!=='boolean' || !Number.isSafeInteger(timeoutMs) || timeoutMs<1) throw new Error('Invalid reviewed paste arguments');
  const editor=page.locator(selector);
  if(await editor.count()!==1) throw new Error('Paste requires one explicit editor');
  const parsed=await editor.evaluate((element,{html,protectFormulaBoundarySpaces})=>{
    if(!element.isContentEditable)throw new Error('Paste target is not editable');
    const fragment=document.createElement('div');fragment.innerHTML=html;
    if(fragment.querySelector('script,iframe,object,embed')||[...fragment.querySelectorAll('*')].some(node=>[...node.attributes].some(attr=>/^on/iu.test(attr.name))))throw new Error('Reviewed paste contains executable content');
    if(!fragment.textContent.trim()&&!fragment.querySelector('img'))throw new Error('Reviewed paste is empty');
    const formulas=[...fragment.querySelectorAll('math-tex')];
    if(formulas.some(node=>node.querySelector('math-tex,.formula-node')||!/^\$[^$]+\$$/u.test(node.textContent.trim())))throw new Error('Reviewed formulas must have one plain delimited source');
    // Chromium normalizes consecutive unprotected NBSP at a paste boundary.
    // Protect only an authored, exact eight-NBSP separator immediately before
    // a formula. This detached inline span retains all eight original bytes;
    // the ordinary-text verifier still compares every character after input.
    let protectedAnswerSeparators=0;
    for(const node of formulas){
      const previous=node.previousSibling;
      if(previous?.nodeType!==3||!/(?<!\u00a0)\u00a0{8}$/u.test(previous.nodeValue))continue;
      const tail=previous.splitText(previous.length-8),span=document.createElement('span');
      span.style.whiteSpace='pre';span.textContent=tail.nodeValue;tail.replaceWith(span);protectedAnswerSeparators++;
    }
    const protectedFormulaBoundarySpaces=[];
    if(protectFormulaBoundarySpaces)for(const [formulaIndex,node]of formulas.entries()){
      const previous=node.previousSibling,previousMatch=previous?.nodeType===3?previous.nodeValue.match(/[ \u00a0]+$/u):null;
      if(previousMatch){const text=previousMatch[0],tail=previous.splitText(previous.length-text.length),span=document.createElement('span');span.style.whiteSpace='pre';span.textContent=text;tail.replaceWith(span);protectedFormulaBoundarySpaces.push({formulaIndex,side:'before',text});}
      const next=node.nextSibling,nextMatch=next?.nodeType===3?next.nodeValue.match(/^[ \u00a0]+/u):null;
      if(nextMatch){const text=nextMatch[0];next.splitText(text.length);const span=document.createElement('span');span.style.whiteSpace='pre';span.textContent=text;next.replaceWith(span);protectedFormulaBoundarySpaces.push({formulaIndex,side:'after',text});}
    }
    return {html:fragment.innerHTML,protectedAnswerSeparators,protectedFormulaBoundarySpaces,formulas:formulas.map(node=>({html:node.outerHTML,plain:node.textContent,latex:node.textContent.trim().slice(1,-1),previousText:node.previousSibling?.nodeType===3?node.previousSibling.nodeValue:null})),empty:!element.textContent.trim()&&!element.querySelector('img,svg,math-tex,.formula-node')};
  },{html,protectFormulaBoundarySpaces});
  if (focusMode === 'background' && parsed.formulas.length) throw new Error('后台模式禁止需要原生剪贴板的公式粘贴；尚未修改编辑框');
  if(!replace&&!parsed.empty)throw new Error('Paste append requires an empty editor');
  await guard();
  const inserted=await insertReviewedEditorHtml(page,selector,parsed.html,{replace,timeoutMs,guard,allowGeneratedTrailingEmptyParagraph,focusMode,windowMode});
  const inputEvents=[...inserted.inputEvents];
  let formulaPasteCount=0;
  for(let index=0;index<parsed.formulas.length;index++) {
  const formula=parsed.formulas[index];
  const alreadyRendered=await editor.evaluate((element,{index,latex})=>{
    const selector='math-tex,.formula-node[data-latex]',roots=[...element.querySelectorAll(selector)].filter(node=>!node.parentElement?.closest(selector));
    const node=roots[index],native=node?.matches('.formula-node[data-latex]')?node:node?.querySelector('.formula-node[data-latex]');
    if(!native)return false;
    let actual;try{actual=decodeURIComponent(native.getAttribute('data-latex')).replace(/\u200b/gu,'').trim();}catch{throw new Error('Rendered formula identity is invalid');}
    if(actual!==latex)throw new Error('Rendered formula identity changed');
    const svg=node.querySelector('.MathJax_SVG svg,svg'),box=svg?.getBoundingClientRect();
    return !!box&&box.width>0&&box.height>0&&!node.querySelector('script,.MathJax_Preview');
  },{index,latex:formula.latex});
  if(alreadyRendered)continue;
  // Write only these reviewed MIME payloads; never read the user's clipboard.
  await page.evaluate(async ({html,plain})=>{
    if(!navigator.clipboard?.write||typeof ClipboardItem!=='function')throw new Error('Native HTML clipboard is unavailable');
    await navigator.clipboard.write([new ClipboardItem({'text/html':new Blob([html],{type:'text/html'}),'text/plain':new Blob([plain],{type:'text/plain'})})]);
  },formula);
  await guard();
  await editor.evaluate((element,{index,latex})=>{
    const selector='math-tex,.formula-node[data-latex]',roots=[...element.querySelectorAll(selector)].filter(node=>!node.parentElement?.closest(selector));
    const node=roots[index];
    if(!node||node.querySelector('math-tex,.formula-node,svg')||node.textContent.trim()!=='$'+latex+'$')throw new Error('Formula source changed before native paste');
    element.focus();
    const range=document.createRange();range.selectNode(node);
    const selected=window.getSelection();selected.removeAllRanges();selected.addRange(range);
    const selection=window.getSelection(),inside=node=>!!node&&(node===element||element.contains(node));
    if(document.activeElement!==element||!selection||selection.rangeCount!==1||!inside(selection.anchorNode)||!inside(selection.focusNode))throw new Error('Paste selection escaped the editor');
    if(selection.isCollapsed||selection.getRangeAt(0).commonAncestorContainer!==node.parentNode)throw new Error('Formula replacement selection changed');
  },{index,latex:formula.latex});
  // A genuine keyup updates the editor's ordinary selection bookmark.
  await page.keyboard.press('Shift');
  await editor.evaluate((element,{index,latex})=>{
    const selector='math-tex,.formula-node[data-latex]',roots=[...element.querySelectorAll(selector)].filter(node=>!node.parentElement?.closest(selector));
    const node=roots[index],selection=window.getSelection(),range=selection?.rangeCount===1?selection.getRangeAt(0):null;
    const position=node?[...node.parentNode.childNodes].indexOf(node):-1;
    if(!node||node.textContent.trim()!=='$'+latex+'$'||document.activeElement!==element||!range||range.startContainer!==node.parentNode||range.endContainer!==node.parentNode||range.startOffset!==position||range.endOffset!==position+1)throw new Error('Trusted keyup changed the exact formula selection');
  },{index,latex:formula.latex});
  const capture=await editor.evaluateHandle(element=>{
    const events=[];
    const host=element.ownerDocument.defaultView;
    const listen=event=>{if(event.target===element||element.contains(event.target))events.push({type:event.type,inputType:event.inputType??null,isTrusted:event.isTrusted});};
    // The real editor consumes paste on its target listener. Observe the
    // capture phase first, without changing or suppressing that event.
    for(const name of ['paste','beforeinput','input'])host.addEventListener(name,listen,true);
    return {events,close:()=>{for(const name of ['paste','beforeinput','input'])host.removeEventListener(name,listen,true);}};
  });
  let pasteEvents;
  try {
    await guard();await editor.press('Control+KeyV');
    // In a headed browser the OS clipboard read can finish after keyup.
    // Keep the observer installed until the real paste arrives.
    pasteEvents=await capture.evaluate(async(state,timeoutMs)=>{
      const deadline=Date.now()+timeoutMs;
      while(!state.events.some(event=>event.type==='paste'&&event.isTrusted)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,25));
      return state.events;
    },timeoutMs);
    if(!pasteEvents.some(event=>event.type==='paste'&&event.isTrusted))throw new Error('No trusted native paste reached the editor');
    inputEvents.push(...pasteEvents);
    formulaPasteCount++;
    await guard();
  } finally {await capture.evaluate(state=>state.close());await capture.dispose();}
  await page.waitForFunction(({selector,index,latex})=>{
    const element=document.querySelector(selector);
    const selectorNative='math-tex,.formula-node[data-latex]',roots=[...element.querySelectorAll(selectorNative)].filter(node=>!node.parentElement?.closest(selectorNative));
    const node=roots[index],native=node?.matches('.formula-node[data-latex]')?node:node?.querySelector('.formula-node[data-latex]');
    if(!native)return false;
    let actual;try{actual=decodeURIComponent(native.getAttribute('data-latex')).replace(/\u200b/gu,'').trim();}catch{return false;}
    const svg=node.querySelector('.MathJax_SVG svg,svg'),box=svg?.getBoundingClientRect();
    return actual===latex&&!!box&&box.width>0&&box.height>0&&!node.querySelector('script,.MathJax_Preview');
  },{selector,index,latex:formula.latex},{timeout:timeoutMs,polling:50});
  await guard();
  }
  // Some single-formula pastes create a bare native atom and two caret markers
  // immediately before it. Delete only the two proven additions, by editing
  // the exact public Range; preserve every authored zero-width character.
  await guard();
  const markerEdits=await editor.evaluate((element,formulas)=>{
    const selector='math-tex,.formula-node[data-latex]',roots=[...element.querySelectorAll(selector)].filter(node=>!node.parentElement?.closest(selector));
    if(roots.length!==formulas.length)throw new Error('Native paste changed formula count');
    let removed=0;
    for(let index=0;index<roots.length;index++){
      const node=roots[index],want=formulas[index];
      const textBefore=()=>{const nodes=[];for(let cursor=node.previousSibling;cursor?.nodeType===3;cursor=cursor.previousSibling)nodes.unshift(cursor);return {nodes,text:nodes.map(value=>value.nodeValue).join('')};};
      const before=textBefore(),wanted=want.previousText??'';
      if(!node.matches('.formula-node[data-latex]')||before.text===wanted)continue;
      if(before.text!==wanted+'\u200b\u200b'||node.getAttribute('data-rendered')!=='1'||!node.querySelector('svg')||!node.querySelector('[data-formula-locked="1"]'))throw new Error('Native caret markers are not the exact two input additions');
      if(decodeURIComponent(node.getAttribute('data-latex')).replace(/\u200b/gu,'').trim()!==want.latex)throw new Error('Native marker formula identity changed');
      const endNode=before.nodes.at(-1);let startNode=endNode,remaining=2;
      while(startNode.length<remaining){remaining-=startNode.length;startNode=startNode.previousSibling;if(startNode?.nodeType!==3)throw new Error('Native marker range crossed authored structure');}
      element.focus();const range=document.createRange();range.setStart(startNode,startNode.length-remaining);range.setEnd(endNode,endNode.length);
      const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
      if(!document.execCommand('delete',false)||textBefore().text!==wanted||!element.contains(node))throw new Error('Native marker deletion did not preserve the reviewed text and formula');
      removed+=2;
    }
    return removed;
  },parsed.formulas);
  await guard();
  const counts=await editor.evaluate(element=>({paragraphCount:element.children.length,imageCount:element.querySelectorAll('img').length}));
  await assertEditorNativeScripts(page,selector,html);
  return {command:formulaPasteCount?'insertHTML+formula-paste':'insertHTML',succeeded:true,selectionVerified:true,clipboardFormats:formulaPasteCount?['text/html','text/plain']:[],formulaPasteCount,removedNativeCaretMarkers:markerEdits,protectedAnswerSeparators:parsed.protectedAnswerSeparators,protectedFormulaBoundarySpaces:parsed.protectedFormulaBoundarySpaces,addedGeneratedTrailingEmptyParagraph:inserted.addedGeneratedTrailingEmptyParagraph,inputEvents,...counts};
}
