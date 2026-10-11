import { createHash } from 'node:crypto';
import { assertRecorderDocumentSnapshot } from './browser-document-state.mjs';

/** Read the owned draft and its bound Vue/editor instances. Never invoke app methods. */
export function readAppendAutosaveSnapshot(expected) {
  const fatal = [], differences = [];
  const stem = document.querySelectorAll('#contentedit .w-e-text');
  const answer = document.querySelectorAll('#answeredit .w-e-text');
  const documentIdentity = {url:location.href,timeOrigin:performance.timeOrigin,readyState:document.readyState,
    visibilityState:document.visibilityState,hasFocus:document.hasFocus(),prerendering:document.prerendering===true,
    usable:Boolean(document.documentElement&&document.body)};
  if (stem.length !== 1 || answer.length !== 1) return {...documentIdentity,fatal:['Owned editors are not unique'],differences,ready:false};
  const contentEditor = stem[0], answerEditor = answer[0];
  const root = document.querySelector('#app')?.__vue__, visited = new Set(), queue = root ? [root] : [], candidates = [];
  while (queue.length && visited.size < 2000) {
    const component = queue.shift();
    if (!component || visited.has(component)) continue;
    visited.add(component);
    const refs = component.$refs;
    if (refs?.contentedit?.editor?.$textElem?.elems?.[0] === contentEditor
      && refs?.answeredit?.editor?.$textElem?.elems?.[0] === answerEditor) candidates.push(component);
    if (Array.isArray(component.$children)) queue.push(...component.$children);
  }
  if (queue.length || candidates.length !== 1) return {...documentIdentity,fatal:['Draft VM/editor binding is not unique'],differences,ready:false};
  const vm = candidates[0], model = vm.checkedShitiInfo;
  const identity = {vmUid:vm._uid,contentUid:vm.$refs.contentedit._uid,answerUid:vm.$refs.answeredit._uid};
  if (!Object.values(identity).every(Number.isSafeInteger)) fatal.push('Draft VM/editor identities are unavailable');
  if (Number(vm.textbookID) !== expected.bookId || Number(vm.currentDirectoryNode?.data?.id) !== expected.nodeID) fatal.push('Draft book or directory changed');
  if (!model || Number(model.index) !== expected.record - 1 || model.index === undefined) fatal.push('Draft index changed');
  const hasIdentity = value => value !== undefined && value !== null && value !== '';
  if (hasIdentity(model?.shitiID) || hasIdentity(model?.seqIndex)) fatal.push('Draft already has a saved identity');
  if (hasIdentity(model?.nodeID) && Number(model.nodeID) !== expected.nodeID) fatal.push('Draft node identity changed');
  if (model?.text !== '新增' || model?.questionStr !== '新增') fatal.push('Selected record is not the new append draft');
  if (Number(vm.docContentPicCurrent) !== expected.mainPicNum - 1 || Number(vm.docAnswerPicCurrent) !== expected.answerPicNum - 1) fatal.push('Draft source pages changed');
  const list = vm.shitiList;
  if (!Array.isArray(list) || list.length !== expected.record || hasIdentity(list?.at(-1)?.shitiID)) fatal.push('Draft list no longer ends in this new record');
  if (expected.record>1 && Number(list?.at(-2)?.seqIndex)!==expected.record-1) fatal.push('Last persisted sequence no longer precedes this draft');
  if (Array.isArray(expected.priorRecordIds) && (!Array.isArray(list) || expected.priorRecordIds.some((id,index)=>Number(list[index]?.shitiID)!==id))) fatal.push('Prior record identities changed');
  if (document.activeElement !== contentEditor) fatal.push('Owned content editor lost focus');
  if (vm.focus !== true) differences.push('Application onchange has not marked the draft dirty');
  // Compare every authored text character, paragraph, script/emphasis run and
  // image identity. Highlight backgrounds and wangEditor wrapper spans carry
  // no authored content, and may be added by the platform after onchange.
  const signature = html => {
    const container = document.createElement('div'); container.innerHTML = html;
    const paragraphs = [...container.children].map(paragraph => {
      if (!['P','DIV'].includes(paragraph.tagName)) throw new Error('Unsupported authored paragraph');
      const tokens = [];
      const visit = (node, inherited = []) => {
        if (node.nodeType === 3) {
          const value = node.nodeValue.replace(/\r\n?/gu,'\n').replace(/\u00a0/gu,' ');
          if (!value) return;
          const marks = [...new Set(inherited)].sort(), previous = tokens.at(-1);
          if (previous?.type === 'text' && JSON.stringify(previous.marks) === JSON.stringify(marks)) previous.text += value;
          else tokens.push({type:'text',text:value,marks});
          return;
        }
        if (node.nodeType !== 1) throw new Error('Unsupported authored node');
        if (node.tagName === 'BR') { visit({nodeType:3,nodeValue:'\n'},inherited); return; }
        if (node.tagName === 'IMG') {
          tokens.push({type:'image',attributes:[...node.attributes].filter(a=>!['style','class'].includes(a.name)).map(a=>[a.name,a.value]).sort((a,b)=>a[0].localeCompare(b[0])),
            display:node.style.display||'',width:node.style.width||''}); return;
        }
        if (!['P','DIV','SPAN','U','SUP','SUB','B','STRONG','I','EM'].includes(node.tagName)) throw new Error('Unsupported authored inline node');
        const marks = [...inherited];
        if (['SUP','SUB'].includes(node.tagName)) marks.push(node.tagName.toLowerCase());
        if (['B','STRONG'].includes(node.tagName)) marks.push('bold');
        if (['I','EM'].includes(node.tagName)) marks.push('italic');
        if (node.tagName === 'U' || node.style.textDecorationLine?.split(/\s/u).includes('underline')) marks.push('underline');
        const dot=node.style.textEmphasisStyle||node.style.webkitTextEmphasisStyle;
        if (dot && dot !== 'none') {
          const position=node.style.textEmphasisPosition||node.style.webkitTextEmphasisPosition;
          if (!/^(?:filled\s+)?dot$/u.test(dot) || !['under','under right'].includes(position)) throw new Error('Unsupported authored emphasis');
          marks.push('emphasis-dot');
        }
        for (const child of node.childNodes) visit(child,marks);
      };
      visit(paragraph);
      const direction=paragraph.style.direction||paragraph.getAttribute('dir')||'ltr';
      const align=(paragraph.style.textAlign||paragraph.getAttribute('align')||'left').replace(/^-webkit-(left|center|right)$/u,'$1');
      return {tokens,align:direction==='ltr'&&align==='start'?'left':align,direction};
    });
    if ([...container.childNodes].some(node=>node.nodeType!==1 && node.textContent.trim())) throw new Error('Authored content outside paragraphs');
    return JSON.stringify(paragraphs);
  };
  const dom = {stemHtml:contentEditor.innerHTML,answerHtml:answerEditor.innerHTML};
  const modelRead = {question:model?.question,answer:model?.answer,focus:vm.focus,index:model?.index,shitiID:model?.shitiID ?? null,seqIndex:model?.seqIndex ?? null};
  try {
    for (const [side,element,modelHtml,reviewedHtml] of [['stem',contentEditor,model?.question,expected.stemHtml],['answer',answerEditor,model?.answer,expected.answerHtml]]) {
      const reviewed = signature(reviewedHtml), actual = signature(element.innerHTML);
      if (actual !== reviewed) differences.push(side+' DOM does not match every reviewed field');
      if (typeof modelHtml !== 'string' || signature(modelHtml) !== actual) differences.push(side+' application model has not caught up with the reviewed DOM');
      if ([...element.querySelectorAll('img')].some(image=>!image.complete||image.naturalWidth<=0||image.naturalHeight<=0)) differences.push(side+' images are not loaded');
    }
  } catch (error) { fatal.push(error.message); }
  return {...documentIdentity,identity,bookId:Number(vm.textbookID),nodeID:Number(vm.currentDirectoryNode?.data?.id),
    mainPicNum:Number(vm.docContentPicCurrent)+1,answerPicNum:Number(vm.docAnswerPicCurrent)+1,
    activeEditor:'contentedit',editorIsFocus:{stem:vm.$refs.contentedit.editor.isFocus,answer:vm.$refs.answeredit.editor.isFocus},
    model:modelRead,dom,fatal,differences,ready:fatal.length===0&&differences.length===0};
}

/** Node polling avoids hidden-page timers; one deadline bounds every read/guard. */
export async function waitForAppendAutosaveReady(adapter, task, {
  stemHtml,answerHtml,mainPicNum=task?.source?.pages?.[0],answerPicNum=task?.source?.answerPages?.[0],
  timeoutMs=45000,pollMs=200,now=()=>performance.now(),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),
} = {}) {
  if (adapter?.focusMode !== 'background' || adapter?.windowMode !== 'minimized') throw new Error('Append model readiness is restricted to minimized background input');
  if (![adapter.bookId,adapter._nodeID,task?.target?.record,mainPicNum,answerPicNum].every(value=>Number.isSafeInteger(value)&&value>0)
    || typeof stemHtml!=='string' || typeof answerHtml!=='string' || !stemHtml || !answerHtml
    || !Number.isSafeInteger(timeoutMs) || timeoutMs<1 || timeoutMs>60000 || !Number.isSafeInteger(pollMs) || pollMs<1 || pollMs>1000) throw new Error('Invalid append model readiness bounds or expected draft');
  const page=adapter.page,pending=adapter._pendingWrite,started=now(),deadline=started+timeoutMs;
  const expected={bookId:adapter.bookId,nodeID:adapter._nodeID,record:task.target.record,mainPicNum,answerPicNum,stemHtml,answerHtml,
    priorRecordIds:adapter._pendingWrite?.priorRecords?.map(record=>record.shitiID)};
  let binding,identity,lastSnapshot,attempts=0;
  const bounded=async action=>{
    const remaining=deadline-now();
    if (remaining<=0) throw new Error('Append application model did not become ready before the deadline');
    let timer;
    try {
      const result=await Promise.race([Promise.resolve().then(action),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Append application model readiness read exceeded its deadline')),remaining);})]);
      if (now()>=deadline) throw new Error('Append application model readiness arrived after its deadline');
      return result;
    } finally {clearTimeout(timer);}
  };
  const guard=async()=>{
    if(adapter.page!==page||page.isClosed())throw new Error('Append application model page changed');
    if(adapter._pendingWrite!==pending||pending&&(pending.observedSaveRequests!==0||pending.receipt||pending.receiptConflict))throw new Error('Append application model observed an earlier save or changed intention');
    await bounded(()=>adapter.guard({waitForEditors:false}));
    const next=await bounded(()=>adapter._requireDocumentFocus('新增模型同步只读核验'));
    if(next?.minimized!==true||!(Number.isSafeInteger(next.windowId)&&next.windowId>0||typeof next.windowId==='string'&&/^[1-9]\d*$/u.test(next.windowId)))throw new Error('Append application model lacks a minimized window binding');
    if(binding){assertRecorderDocumentSnapshot(next,binding);if(String(next.windowId)!==String(binding.windowId))throw new Error('Append application model window changed');}
    binding=next;
  };
  try {
    while(true){
      await guard();
      lastSnapshot=await bounded(()=>page.evaluate(readAppendAutosaveSnapshot,expected));attempts++;
      assertRecorderDocumentSnapshot(lastSnapshot,binding);
      if(!Array.isArray(lastSnapshot.fatal)||!Array.isArray(lastSnapshot.differences))throw new Error('Append application model snapshot is malformed');
      if(lastSnapshot.fatal.length)throw new Error('Append application model binding failed: '+lastSnapshot.fatal.join('; '));
      if(identity&&JSON.stringify(identity)!==JSON.stringify(lastSnapshot.identity))throw new Error('Append application model/editor instance changed');
      identity=lastSnapshot.identity;
      await guard();
      if(lastSnapshot.ready===true&&lastSnapshot.differences.length===0){
        return {schemaVersion:1,kind:'new-system-append-model-ready',bookId:expected.bookId,nodeID:expected.nodeID,taskId:task.id,
          target:structuredClone(task.target),mainPicNum,answerPicNum,checkedAt:new Date().toISOString(),attempts,elapsedMs:now()-started,
          windowCheck:binding,identity,editorIsFocus:lastSnapshot.editorIsFocus,
          stemHtmlSha256:createHash('sha256').update(lastSnapshot.dom.stemHtml).digest('hex'),
          answerHtmlSha256:createHash('sha256').update(lastSnapshot.dom.answerHtml).digest('hex')};
      }
      await bounded(()=>sleep(Math.min(pollMs,Math.max(1,deadline-now()))));
    }
  } catch(error){error.appendModelReadiness={expected:{bookId:expected.bookId,nodeID:expected.nodeID,record:expected.record,mainPicNum,answerPicNum},attempts,elapsedMs:now()-started,windowCheck:binding,lastSnapshot};throw error;}
}
