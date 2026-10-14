import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {assertNativeEmphasis,renderNativeEmphasis,readEditorNativeEmphasis,assertEditorNativeEmphasis,nativeEmphasisSignature} from '../src/native-emphasis.mjs';
import {insertReviewedEditorHtml} from '../src/browser-editor-command.mjs';
import {renderEditorHtml,compareNewSystemReadback} from '../src/new-system-core.mjs';
import {NewSystemAdapter} from '../src/new-system-adapter.mjs';
import {inspectReviewedBatch} from '../src/review-preflight.mjs';
const mark=(type,start,end,text)=>({type,start,end,text});
const block=(text,marks)=>({type:'text',strictSpacing:true,text,emphasis:{schemaVersion:1,indexUnit:'unicode-code-points',marks}});
let browserPromise;
after(async()=>{if(browserPromise)await(await browserPromise.catch(()=>null))?.close();});
async function editor(t){
  browserPromise??=chromium.launch({channel:'msedge',headless:true});
  const context=await(await browserPromise).newContext();t.after(()=>context.close());
  await context.route('**/*',route=>route.abort());
  const page=await context.newPage();
  await page.setContent('<!doctype html><meta charset="utf-8"><div id="editor" contenteditable="true" style="font:24px sans-serif;min-height:80px;width:400px"></div>');
  return page;
}
test('font marks render independently with underline, supplementary characters and exact spaces',()=>{
  const b=block('A 𠮷 title B',[mark('italic',2,9,'𠮷 title'),mark('bold',4,9,'title'),mark('underline',4,9,'title')]);
  assert.equal(assertNativeEmphasis(b).length,3);
  assert.equal(renderNativeEmphasis(b),'A&nbsp;<i>𠮷&nbsp;</i><b><i><u>title</u></i></b>&nbsp;B');
  assert.throws(()=>assertNativeEmphasis(block('abc',[mark('italic',0,2,'ab'),mark('italic',1,3,'bc')])),/交叠/u);
  assert.throws(()=>assertNativeEmphasis(block('abc',[mark('bold',0,2,'bc')])));
});
test('real editing input and adapter read computed italic/bold ranges without blur/save',async t=>{
  const page=await editor(t),text='A 同同𠮷 B',b=block(text,[mark('italic',2,5,'同同𠮷'),mark('bold',3,5,'同𠮷'),mark('underline',4,5,'𠮷')]);
  await page.locator('#editor').evaluate(e=>{window.blurs=0;e.addEventListener('blur',()=>window.blurs++);});
  const html=renderEditorHtml({blocks:[b]});
  await insertReviewedEditorHtml(page,'#editor',html);
  await assertEditorNativeEmphasis(page,'#editor',html);
  const actual=await(new NewSystemAdapter({page,inputMode:'browser-command'}))._editorRead('#editor');
  assert.equal(nativeEmphasisSignature(actual.paragraphs[0].nativeEmphasis.text,actual.paragraphs[0].nativeEmphasis.marks),nativeEmphasisSignature(text,b.emphasis.marks));
  assert.equal(await page.evaluate(()=>window.blurs),0);
  const styles=await page.locator('#editor').evaluate(e=>[...e.querySelectorAll('i,b')].map(n=>({style:getComputedStyle(n).fontStyle,weight:getComputedStyle(n).fontWeight})));
  assert.ok(styles.some(s=>s.style==='italic'));assert.ok(styles.some(s=>Number(s.weight)>=700));
});
test('matching text with lost, moved, widened or extra fonts rejects before save',async t=>{
  const page=await editor(t),want='<p>A<i>同</i>同<b>𠮷</b>B</p>';
  for(const html of ['<p>A同同<b>𠮷</b>B</p>','<p>A同<i>同</i><b>𠮷</b>B</p>','<p>A<i>同同</i><b>𠮷</b>B</p>','<p>A<i>同</i>同𠮷B</p>','<p><i>A同</i>同<b>𠮷</b>B</p>','<p>A<i>同</i>同<i>𠮷</i>B</p>']){
    await page.locator('#editor').evaluate((e,html)=>e.innerHTML=html,html);
    assert.equal(await page.locator('#editor').textContent(),'A同同𠮷B');
    await assert.rejects(assertEditorNativeEmphasis(page,'#editor',want),/回读/u);
  }
});
test('real sanitizer removing font tags is detected despite unchanged text',async t=>{
  const page=await editor(t);
  await page.locator('#editor').evaluate(e=>e.addEventListener('input',()=>{for(const n of e.querySelectorAll('i,b'))n.replaceWith(...n.childNodes);}));
  await assert.rejects(insertReviewedEditorHtml(page,'#editor','<p>A<i>same</i><b>same</b>B</p>'),/回读/u);
  assert.equal(await page.locator('#editor').textContent(),'AsamesameB');
});
test('computed inherited font resets and unknown oblique style are distinguished',async t=>{
  const page=await editor(t);
  await page.locator('#editor').evaluate(e=>e.innerHTML='<p><i><b>A<span style="font-style:normal;font-weight:400">B</span>C</b></i><span style="font-style:oblique">D</span></p>');
  const actual=(await page.locator('#editor').evaluate(readEditorNativeEmphasis))[0];
  assert.ok(actual.marks.some(m=>m.type==='italic'&&m.text==='A'));
  assert.ok(!actual.marks.some(m=>m.text==='B'));
  assert.ok(actual.marks.some(m=>m.type==='unsupported-italic'&&m.text==='D'));
  assert.throws(()=>nativeEmphasisSignature(actual.text,actual.marks));
});
test('reviewed unknown or relative font styles cannot disappear into plain text',async t=>{
  const page=await editor(t);
  await page.locator('#editor').evaluate(e=>e.innerHTML='<p>X</p>');
  for(const html of ['<p><span style="font-style:oblique">X</span></p>',
    '<p><span style="font-weight:bolder">X</span></p>',
    '<p><span style="font-weight:lighter">X</span></p>']) {
    await assert.rejects(assertEditorNativeEmphasis(page,'#editor',html),/格式|font/u);
  }
});
test('reviewed inherit and unset preserve ancestor fonts while normal resets them',async t=>{
  const page=await editor(t);
  for(const value of ['inherit','unset']) {
    const html=`<p><i><b>A<span style="font-style:${value};font-weight:${value}">B</span>C<span style="font-style:normal;font-weight:400">D</span></b></i></p>`;
    await page.locator('#editor').evaluate((e,html)=>e.innerHTML=html,html);
    await assertEditorNativeEmphasis(page,'#editor',html);
  }
});
test('combined fonts retain exact ranges across scripts, dots and wavy underlines',async t=>{
  const page=await editor(t),text='A𠮷①B2 C';
  const b={type:'text',strictSpacing:true,runs:[{type:'text',text:'A𠮷'},{type:'sup',text:'①'},
    {type:'text',text:'B'},{type:'sub',text:'2'},{type:'text',text:' C'}],
    emphasis:{schemaVersion:1,indexUnit:'unicode-code-points',marks:[mark('italic',1,5,'𠮷①B2'),
      mark('bold',2,4,'①B'),mark('emphasis-dot',1,2,'𠮷'),mark('underline-wavy',1,5,'𠮷①B2')]}};
  const html=renderEditorHtml({blocks:[b]});
  await insertReviewedEditorHtml(page,'#editor',html);
  const actual=await(new NewSystemAdapter({page,inputMode:'browser-command'}))._editorRead('#editor');
  assert.equal(nativeEmphasisSignature(actual.paragraphs[0].nativeEmphasis.text,actual.paragraphs[0].nativeEmphasis.marks),nativeEmphasisSignature(text,b.emphasis.marks));
  assert.deepEqual(actual.paragraphs[0].nativeScripts.marks.map(m=>[m.type,m.start,m.end,m.text]),[['sup',2,3,'①'],['sub',4,5,'2']]);
  await page.locator('#editor').evaluate(e=>{for(const node of e.querySelectorAll('i,b')){
    const span=document.createElement('span');span.style[node.tagName==='I'?'fontStyle':'fontWeight']=node.tagName==='I'?'italic':'700';
    span.append(...node.childNodes);node.replaceWith(span);
  }});
  await assertEditorNativeEmphasis(page,'#editor',html);
});
test('valid font ranges pass preflight without granting pending review approval',()=>{
  const b=block('AB',[mark('italic',0,2,'AB'),mark('bold',1,2,'B')]);
  const task={id:'synthetic-font-task',target:{chapterLabel:'C',sectionLabel:'S',record:1},
    source:{pages:[1],answerPages:[2]},stem:{blocks:[b]},answer:{blocks:[{type:'text',text:'x'}]},
    answerRequirement:{kind:'question',evidence:'synthetic requirement'},answerStatus:'provided',
    review:{status:'pending',issues:[],checks:{sourceText:false,answerMatch:false,wholeQuestion:false,format:false}}};
  const manifest={schemaVersion:1,kind:'new-system-batch',bookId:1,source:'fixture',tasks:[task],
    coverage:{pages:[{page:1,candidates:[{id:'synthetic-font-candidate',type:'question',decision:'include',taskIds:[task.id]}]}]}};
  const pending=inspectReviewedBatch(manifest);
  assert.equal(pending.valid,true,pending.errors.join('; '));assert.equal(pending.readyForExecution,false);
  assert.equal(task.review.status,'pending');assert.ok(Object.values(task.review.checks).every(value=>value===false));
  task.review={status:'approved',issues:[],checks:{sourceText:true,answerMatch:true,wholeQuestion:true,format:true}};
  assert.equal(inspectReviewedBatch(manifest).readyForExecution,true);
  b.emphasis.marks[0].end=1;
  assert.equal(inspectReviewedBatch(manifest).readyForExecution,false);
});
test('persisted readback compares exact font positions as well as text',()=>{
  const text='同同',b=block(text,[mark('italic',0,1,'同'),mark('bold',1,2,'同')]);
  const task={id:'font-fixture',target:{chapterLabel:'C',sectionLabel:'S',record:1},source:{pages:[1],answerPages:[2]},stem:{blocks:[b]},answer:{blocks:[{type:'text',text:'x'}]},review:{status:'approved',issues:[]}};
  const paragraph=(text,marks)=>({text,imageCount:0,align:'left',direction:'ltr',nativeEmphasis:{text,marks}});
  const readback={status:'found',bookId:1,recordId:1,target:{...task.target},source:{pages:[1],answerPages:[2]},stem:{text,html:'<p><i>同</i><b>同</b></p>',images:[],paragraphs:[paragraph(text,[mark('italic',0,1,'同'),mark('bold',1,2,'同')])]},answer:{text:'x',html:'<p>x</p>',images:[],paragraphs:[paragraph('x',[])]}};
  assert.equal(compareNewSystemReadback(task,readback,{bookId:1}).ok,true);
  for(const marks of [[],[mark('italic',1,2,'同'),mark('bold',0,1,'同')],[mark('italic',0,2,'同同'),mark('bold',1,2,'同')]]){
    const bad=structuredClone(readback);bad.stem.paragraphs[0].nativeEmphasis.marks=marks;
    assert.equal(compareNewSystemReadback(task,bad,{bookId:1}).ok,false);
  }
});
