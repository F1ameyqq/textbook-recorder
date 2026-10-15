import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {prepareReviewedLiteralDollarHtml,readEditorLiteralDollarSafety} from '../src/literal-dollar.mjs';
import {insertReviewedEditorHtml} from '../src/browser-editor-command.mjs';
import {renderEditorHtml,compareNewSystemReadback} from '../src/new-system-core.mjs';
import {NewSystemAdapter} from '../src/new-system-adapter.mjs';
import {checkedPointerClick} from '../src/checked-pointer-click.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
let browserPromise;
after(async()=>{if(browserPromise)await(await browserPromise.catch(()=>null))?.close();});
async function fixture(t){
  browserPromise??=chromium.launch({channel:'msedge',headless:true});
  const context=await(await browserPromise).newContext();t.after(()=>context.close());
  await context.route('**/*',route=>route.abort());
  const page=await context.newPage();
  await page.setContent('<!doctype html><meta charset="utf-8"><div id="editor" contenteditable="true" style="font:24px sans-serif;width:700px;min-height:140px"></div>');
  await page.evaluate(()=>{
    window.events={paste:0,clipboard:0,blur:0,inputs:[]};
    const editor=document.querySelector('#editor');
    editor.addEventListener('paste',()=>events.paste++);editor.addEventListener('blur',()=>events.blur++);
    editor.addEventListener('input',event=>events.inputs.push({trusted:event.isTrusted,type:event.inputType}));
    Object.defineProperty(navigator,'clipboard',{configurable:true,get(){events.clipboard++;throw new Error('Clipboard forbidden');}});
  });
  return page;
}

test('literal-dollar preparation is inert, idempotent and preserves characters and true formula subtrees',async t=>{
  const page=await fixture(t);
  const html='<p title="$unchanged">  Adults pay &#36;2 each; <b><i>$1.5</i></b>; family $5. <math-tex>$x+1$</math-tex><span class="formula-node" data-latex="y">$y$</span></p>';
  const prepared=await page.evaluate(prepareReviewedLiteralDollarHtml,html);
  assert.equal(prepared.count,3);assert.deepEqual(await page.evaluate(prepareReviewedLiteralDollarHtml,prepared.html),prepared);
  const result=await page.evaluate(({html,prepared})=>{
    const original=document.createElement('div'),actual=document.createElement('div');original.innerHTML=html;actual.innerHTML=prepared.html;
    return {sameText:original.textContent===actual.textContent,formulas:[...original.querySelectorAll('math-tex,.formula-node')].map(n=>n.outerHTML),
      after:[...actual.querySelectorAll('math-tex,.formula-node')].map(n=>n.outerHTML),title:actual.firstChild.title,
      spans:[...actual.querySelectorAll('span')].filter(n=>n.textContent==='$').map(n=>[n.style.whiteSpace,n.childNodes.length]),live:document.querySelector('#editor').innerHTML};
  },{html,prepared});
  assert.equal(result.sameText,true);assert.deepEqual(result.formulas,result.after);assert.equal(result.title,'$unchanged');
  assert.deepEqual(result.spans,[['pre',1],['pre',1],['pre',1]]);assert.equal(result.live,'');
  assert.deepEqual(await page.evaluate(()=>events),{paste:0,clipboard:0,blur:0,inputs:[]});
});

test('native insertHTML preserves currency isolation, eight spaces and overlapping fonts/scripts',async t=>{
  const page=await fixture(t);
  const runs=[{type:'text',text:'  Pay $2        '},{type:'sup',text:'①'},{type:'text',text:' $1.5  or $5; '},{type:'sub',text:'2'},{type:'text',text:' 𠮷 '}];
  const text=runs.map(r=>r.text).join(''),chars=Array.from(text),start=chars.join('').indexOf('$1.5');
  const block={type:'text',strictSpacing:true,runs,emphasis:{schemaVersion:1,indexUnit:'unicode-code-points',marks:[
    {type:'italic',start:2,end:chars.length-1,text:chars.slice(2,-1).join('')},
    {type:'bold',start,end:start+4,text:'$1.5'},
    {type:'underline-wavy',start,end:start+4,text:'$1.5'}]}};
  const result=await insertReviewedEditorHtml(page,'#editor',renderEditorHtml({blocks:[block]}));
  assert.equal(result.protectedLiteralDollarCount,3);assert.equal(result.command,'insertHTML');
  const read=await(new NewSystemAdapter({page,inputMode:'browser-command'}))._editorRead('#editor');
  assert.equal(read.literalDollarSafety.count,3);assert.equal(read.literalDollarSafety.unsafeCount,0);assert.equal(read.literalDollarSafety.isolatedCount,3);
  assert.equal(read.literalDollarSafety.text.replace(/\u00a0/gu,' '),text);assert.deepEqual(read.formulas,[]);
  assert.ok(read.paragraphs[0].nativeEmphasis.marks.some(m=>m.type==='bold'&&m.text==='$'));
  assert.equal(read.paragraphs[0].nativeScripts.marks.length,2);
  const events=await page.evaluate(()=>window.events);assert.equal(events.paste,0);assert.equal(events.clipboard,0);assert.equal(events.blur,0);
  assert.ok(events.inputs.length>0);assert.ok(events.inputs.every(e=>e.trusted));
});

test('input fixture with paired dollar delimiters reproduces the old failure and accepts protected text',async t=>{
  const page=await fixture(t),html='<p>Adults pay $2 each; children $1.5; family $5.</p>';
  // Model the external automatic delimiter conversion, not the protection code.
  await page.locator('#editor').evaluate(editor=>editor.addEventListener('input',()=>{
    for(const paragraph of editor.querySelectorAll('p')){
      const nodes=[...paragraph.childNodes].filter(n=>n.nodeType===3);
      if(/\$[^$]+\$/u.test(nodes.map(n=>n.data).join(''))){
        const math=document.createElement('math-tex');math.textContent='$misparsed$';nodes[0].replaceWith(math);
      }
    }
  }));
  await page.locator('#editor').click();await page.evaluate(html=>document.execCommand('insertHTML',false,html),html);
  assert.equal(await page.locator('#editor math-tex').count(),1);
  await page.locator('#editor').evaluate(e=>e.replaceChildren());
  await insertReviewedEditorHtml(page,'#editor',html);
  assert.equal(await page.locator('#editor math-tex').count(),0);assert.equal(await page.locator('#editor').textContent(),'Adults pay $2 each; children $1.5; family $5.');
});

test('stripped isolation rejects before blur without repairing the live editor or retrying',async t=>{
  const page=await fixture(t);
  await page.locator('#editor').evaluate(e=>e.addEventListener('input',()=>{
    for(const n of e.querySelectorAll('span'))n.replaceWith(...n.childNodes);
  }));
  await assert.rejects(insertReviewedEditorHtml(page,'#editor','<p>Prices $2 and $5.</p>'),/\$.*隔离/u);
  assert.equal(await page.locator('#editor').textContent(),'Prices $2 and $5.');assert.equal(await page.locator('#editor span').count(),0);
  const events=await page.evaluate(()=>window.events);assert.equal(events.inputs.length,1);assert.equal(events.paste,0);assert.equal(events.clipboard,0);assert.equal(events.blur,0);
});

test('input-time formula conversion still rejects and retains its diagnostic nodes',async t=>{
  const page=await fixture(t);
  await page.locator('#editor').evaluate(e=>e.addEventListener('input',()=>{
    const formula=document.createElement('math-tex');formula.textContent='$unwanted$';e.firstChild.append(formula);
  }));
  await assert.rejects(insertReviewedEditorHtml(page,'#editor','<p>Prices $2 and $5.</p>',{timeoutMs:5000}),/额外公式/u);
  assert.equal(await page.locator('#editor math-tex').count(),1);
  assert.equal((await page.evaluate(()=>window.events)).blur,0);
});

test('real reader rejects extra persisted math hidden from ordinary text while accepting intact currency',async t=>{
  const page=await fixture(t),task={id:'synthetic-currency',target:{chapterLabel:'C',sectionLabel:'S',record:1},source:{pages:[1],answerPages:[2]},
    stem:{blocks:[{type:'text',text:'Prices $2 and $5.',strictSpacing:true}]},answer:{blocks:[{type:'text',text:'A'}]}};
  const adapter=new NewSystemAdapter({page,inputMode:'browser-command'});
  const readback={status:'found',bookId:1,recordId:1,target:task.target,source:task.source};
  await insertReviewedEditorHtml(page,'#editor',renderEditorHtml(task.answer));readback.answer=await adapter._editorRead('#editor');
  await insertReviewedEditorHtml(page,'#editor',renderEditorHtml(task.stem),{replace:true});readback.stem=await adapter._editorRead('#editor');
  assert.equal(compareNewSystemReadback(task,readback,{bookId:1}).ok,true);
  await page.locator('#editor').evaluate(e=>{const formula=document.createElement('math-tex');formula.textContent='$unwanted$';e.firstChild.append(formula);});
  readback.stem=await adapter._editorRead('#editor');assert.equal(readback.stem.formulas.length,1);
  const result=compareNewSystemReadback(task,readback,{bookId:1});assert.equal(result.ok,false);assert.match(result.errors.join('; '),/未审原生公式/u);
});

test('dollar safety groups direct siblings but preserves legacy one-dollar paragraphs',async t=>{
  const page=await fixture(t);
  for(const [html,count,unsafe]of [['<p>$2<!-- split --> and $5</p>',2,2],['<p>$2</p><p>$5</p>',2,0],['<p><span>$</span>2 and <span>$</span>5</p>',2,0]]){
    await page.locator('#editor').evaluate((e,html)=>e.innerHTML=html,html);
    const read=await page.locator('#editor').evaluate(readEditorLiteralDollarSafety);assert.equal(read.count,count);assert.equal(read.unsafeCount,unsafe);
  }
});

test('late currency isolation loss blocks the actual append save step and preserves its unknown lock',async t=>{
  const page=await fixture(t),dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'recorder-dollar-save-'));
  t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  await page.evaluate(()=>{
    const answer=document.querySelector('#editor');answer.id='answer';answer.className='w-e-text';
    const answerParent=document.createElement('div');answerParent.id='answeredit';answer.replaceWith(answerParent);answerParent.append(answer);
    const stemParent=document.createElement('div');stemParent.id='contentedit';
    const stem=document.createElement('div');stem.className='w-e-text';stem.contentEditable='true';stem.style.cssText='font:24px sans-serif;width:700px;min-height:140px';stemParent.append(stem);document.body.prepend(stemParent);
    const source=document.createElement('input');source.className='el-input__inner';document.body.append(source);
    window.saveInputEvents={mousedown:0,click:0,blur:0};
    source.addEventListener('mousedown',()=>saveInputEvents.mousedown++);source.addEventListener('click',()=>saveInputEvents.click++);
    stem.addEventListener('blur',()=>saveInputEvents.blur++);
  });
  const adapter=new NewSystemAdapter({page,dataDir,baseDir:dataDir,source:'fixture',inputMode:'browser-command',focusMode:'background',windowMode:'normal',timeout:5000});adapter.bookId=1;
  page.bringToFront=async()=>{throw new Error('Fixture forbids foreground activation');};
  adapter.guard=async()=>assert.equal(page.url(),'about:blank');
  adapter.directory=async()=>{adapter._directoryRecords=[];adapter._nodeID=1;};
  adapter._navigateSources=async()=>[1,2];adapter._clipboardPreflight=async()=>{};
  let plusClicks=0;
  adapter._click=async(locator,options={})=>{if(!plusClicks){plusClicks++;return;}return NewSystemAdapter.prototype._click.call(adapter,locator,options);};
  adapter._paste=async(selector,html,options)=>{
    const result=await NewSystemAdapter.prototype._paste.call(adapter,selector,html,options);
    if(selector.startsWith('#contentedit'))await page.locator('#answeredit .w-e-text').evaluate(e=>{for(const n of e.querySelectorAll('span'))n.replaceWith(...n.childNodes);});
    return result;
  };
  const task={id:'synthetic-dollar-save',target:{chapterLabel:'C',sectionLabel:'S',record:1},source:{pages:[1],answerPages:[2]},
    stem:{blocks:[{type:'text',text:'Question'}]},answer:{blocks:[{type:'text',text:'Adults $2; children $1.5; family $5.',strictSpacing:true}]},review:{status:'approved',issues:[]}};
  await assert.rejects(adapter.append(task),error=>error.phase==='save-business-receipt'&&/隔离/u.test(error.message));
  assert.equal(plusClicks,1);assert.deepEqual(await page.evaluate(()=>saveInputEvents),{mousedown:0,click:0,blur:0});
  assert.equal(adapter._uncertain,true);assert.equal(adapter.pendingWrite.status,'pending');
  assert.equal(adapter.pendingWrite.observedSaveRequests,0);assert.equal(adapter.pendingWrite.receipt,null);
  assert.equal((await page.locator('#answeredit .w-e-text').textContent()).replace(/\u00a0/gu,' '),'Adults $2; children $1.5; family $5.');
  await assert.rejects(adapter.append(task),/拒绝再次写入/u);
});

test('foreground and background normal native pointers assert before one trusted click',async t=>{
  for(const focusMode of ['foreground','background']){
  const page=await fixture(t);
  if(focusMode==='background')page.bringToFront=async()=>{throw new Error('Fixture forbids foreground activation');};
  await page.evaluate(()=>{
    const button=document.createElement('button');button.id='save';button.textContent='Save';document.body.append(button);
    window.pointerEvents=[];
    for(const name of ['mousedown','click'])button.addEventListener(name,e=>pointerEvents.push([name,e.isTrusted]));
  });
  const clicked=await checkedPointerClick(page,page.locator('#save'),{focusMode,windowMode:'normal',timeout:5000,guard:async()=>assert.equal(page.url(),'about:blank'),beforeInput:async()=>{
    assert.deepEqual(await page.evaluate(()=>pointerEvents),[]);
    await page.evaluate(()=>pointerEvents.push(['asserted',true]));
  }});
  assert.equal(clicked.activationMethod,'page.mouse.click');assert.equal(clicked.nativeClick.trusted,true);
  assert.deepEqual(await page.evaluate(()=>pointerEvents),[['asserted',true],['mousedown',true],['click',true]]);
  assert.deepEqual(await page.evaluate(()=>Object.keys(window).filter(k=>k.startsWith('__recorderPointer_'))),[]);
  }
});

test('normal native pointer assertion failure sends no input and retains editor focus',async t=>{
  const page=await fixture(t);
  await page.evaluate(()=>{
    const button=document.createElement('button');button.id='save';button.textContent='Save';document.body.append(button);
    window.pointerEvents=[];for(const name of ['mousedown','click'])button.addEventListener(name,()=>pointerEvents.push(name));
  });
  await page.locator('#editor').focus();
  await assert.rejects(checkedPointerClick(page,page.locator('#save'),{timeout:5000,guard:async()=>{},beforeInput:async()=>{throw new Error('Unreviewed currency');}}),/Unreviewed currency/u);
  assert.deepEqual(await page.evaluate(()=>pointerEvents),[]);assert.equal(await page.evaluate(()=>document.activeElement.id),'editor');
  assert.equal((await page.evaluate(()=>events)).blur,0);
  assert.deepEqual(await page.evaluate(()=>Object.keys(window).filter(k=>k.startsWith('__recorderPointer_'))),[]);
});

test('normal pointer rechecks obstruction after the assertion without sending input',async t=>{
  const page=await fixture(t);
  await page.evaluate(()=>{
    const button=document.createElement('button');button.id='save';button.textContent='Save';document.body.append(button);
    window.pointerInputs=0;document.addEventListener('mousedown',()=>pointerInputs++);
  });
  await assert.rejects(checkedPointerClick(page,page.locator('#save'),{timeout:5000,guard:async()=>{},beforeInput:async()=>{
    // Model an unrelated layout change during the read-only assertion.
    await page.evaluate(()=>{const cover=document.createElement('div');cover.style.cssText='position:fixed;inset:0;z-index:10000';document.body.append(cover);});
  }}),/covered/u);
  assert.equal(await page.evaluate(()=>pointerInputs),0);
  assert.deepEqual(await page.evaluate(()=>Object.keys(window).filter(k=>k.startsWith('__recorderPointer_'))),[]);
});

test('pointer assertion type validation preserves minimized-only editor-focus restrictions',async t=>{
  const page=await fixture(t),locator=page.locator('#editor');
  for(const beforeInput of [null,true,'assertion',{}])await assert.rejects(checkedPointerClick(page,locator,{guard:async()=>{},beforeInput}),/must be a function/u);
  for(const focusMode of ['foreground','background'])await assert.rejects(checkedPointerClick(page,locator,{guard:async()=>{},focusMode,windowMode:'normal',preserveEditorFocus:true,beforeInput:async()=>{}}),/restricted to minimized/u);
  assert.deepEqual(await page.evaluate(()=>Object.keys(window).filter(k=>k.startsWith('__recorderPointer_'))),[]);
});

test('ordinary currency input rejects invisible added characters despite matching normalized readback',async t=>{
  const page=await fixture(t);
  await page.locator('#editor').evaluate(e=>e.addEventListener('input',()=>e.firstChild.append(document.createTextNode('\u200b')),{once:true}));
  await assert.rejects(insertReviewedEditorHtml(page,'#editor','<p>Prices $2 and $5.</p>'),/原字符/u);
  assert.equal(await page.locator('#editor').textContent(),'Prices $2 and $5.\u200b');
  assert.equal((await page.evaluate(()=>window.events)).blur,0);
});
