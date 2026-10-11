import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {readEditorNativeEmphasis,assertEditorNativeEmphasis,nativeEmphasisSignature} from '../src/native-emphasis.mjs';
import {insertReviewedEditorHtml} from '../src/browser-editor-command.mjs';
import {renderEditorHtml} from '../src/new-system-core.mjs';

let browserPromise;
after(async()=>{if(browserPromise)await (await browserPromise.catch(()=>null))?.close();});

async function ownedEditor(t){
  // A fresh owned, headless Edge context. No user or production profile and no
  // connection to the textbook platform; network requests are explicitly denied.
  browserPromise??=chromium.launch({channel:'msedge',headless:true});
  const browser=await browserPromise;
  const context=await browser.newContext();t.after(()=>context.close());
  await context.route('**/*',route=>route.abort());
  const page=await context.newPage();
  await page.setContent('<!doctype html><meta charset="utf-8"><div id="editor" contenteditable="true" style="font:24px sans-serif"></div>');
  return page;
}

async function insert(page,html){
  await page.locator('#editor').click();
  return page.locator('#editor').evaluate((editor,html)=>{
    const range=document.createRange();range.selectNodeContents(editor);
    const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
    if(document.activeElement!==editor)throw new Error('Owned editor lacks focus');
    const succeeded=document.execCommand('insertHTML',false,html);
    if(!succeeded)throw new Error('Owned browser declined insertHTML');
    return {succeeded,html:editor.innerHTML};
  },html);
}

const dotStyle='text-emphasis-style:dot;text-emphasis-position:under right;-webkit-text-emphasis-style:dot;-webkit-text-emphasis-position:under right';

test('native reader recognizes real execCommand underline and under-dot styling with Unicode offsets', async t=>{
  const page=await ownedEditor(t);
  const html=`<p>甲<span style="${dotStyle}">同</span>同<u>𠮷</u>乙</p>`;
  const inserted=await insert(page,html);assert.equal(inserted.succeeded,true);
  const actual=await page.locator('#editor').evaluate(readEditorNativeEmphasis);
  assert.equal(actual.length,1);assert.equal(actual[0].text,'甲同同𠮷乙');
  assert.deepEqual(actual[0].marks,[{type:'emphasis-dot',start:1,end:2,text:'同'},{type:'underline',start:3,end:4,text:'𠮷'}]);
  await assert.doesNotReject(assertEditorNativeEmphasis(page,'#editor',html));
});

test('native reader preserves overlap, inherited underline, explicit BR and separate paragraphs', async t=>{
  const page=await ownedEditor(t);
  const html=`<p><u>甲<span style="${dotStyle}">𠮷</span></u><br>乙</p><p>尾<span style="${dotStyle}">字</span></p>`;
  await insert(page,html);
  const actual=await page.locator('#editor').evaluate(readEditorNativeEmphasis);
  assert.equal(actual.length,2);
  assert.equal(actual[0].text,'甲𠮷\n乙');assert.equal(actual[1].text,'尾字');
  const expectedFirst=[{type:'underline',start:0,end:2,text:'甲𠮷'},{type:'emphasis-dot',start:1,end:2,text:'𠮷'}];
  assert.equal(nativeEmphasisSignature(actual[0].text,actual[0].marks),nativeEmphasisSignature('甲𠮷\n乙',expectedFirst));
  assert.deepEqual(actual[1].marks,[{type:'emphasis-dot',start:1,end:2,text:'字'}]);
  await assert.doesNotReject(assertEditorNativeEmphasis(page,'#editor',html));
});

test('native reader respects an explicit inherited-emphasis opt-out while retaining propagated underline', async t=>{
  const page=await ownedEditor(t);
  const html=`<p style="${dotStyle}"><u>甲<span style="text-emphasis-style:none;-webkit-text-emphasis-style:none">乙</span>丙</u></p>`;
  await insert(page,html);
  const actual=await page.locator('#editor').evaluate(readEditorNativeEmphasis);
  assert.equal(actual[0].text,'甲乙丙');
  const expected=[{type:'underline',start:0,end:3,text:'甲乙丙'},{type:'emphasis-dot',start:0,end:1,text:'甲'},{type:'emphasis-dot',start:2,end:3,text:'丙'}];
  assert.equal(nativeEmphasisSignature(actual[0].text,actual[0].marks),nativeEmphasisSignature('甲乙丙',expected));
  await assert.doesNotReject(assertEditorNativeEmphasis(page,'#editor',html));
});

test('inline-style sanitizer triggered by a real editor input event rejects a lost dot despite matching text', async t=>{
  const page=await ownedEditor(t);
  await page.locator('#editor').evaluate(editor=>{
    window.observedEditorInputs=[];
    editor.addEventListener('input',event=>{
      window.observedEditorInputs.push({type:event.type,inputType:event.inputType});
      for(const node of editor.querySelectorAll('span[style]'))node.removeAttribute('style');
    });
  });
  const html=`<p>同<span style="${dotStyle}">同</span></p>`;
  await insert(page,html);
  const actual=await page.locator('#editor').evaluate(readEditorNativeEmphasis);
  assert.equal(actual[0].text,'同同');assert.deepEqual(actual[0].marks,[]);
  assert.ok((await page.evaluate(()=>window.observedEditorInputs)).length>0,'execCommand must trigger the editor input listener');
  await assert.rejects(assertEditorNativeEmphasis(page,'#editor',html),/加点|下划线/u);
});

test('semantic underline loss also rejects when an editor input handler unwraps u without altering text', async t=>{
  const page=await ownedEditor(t);
  await page.locator('#editor').evaluate(editor=>editor.addEventListener('input',()=>{
    for(const node of editor.querySelectorAll('u'))node.replaceWith(...node.childNodes);
  }));
  const html='<p>甲<u>𠮷</u>乙</p>';
  await insert(page,html);
  const actual=await page.locator('#editor').evaluate(readEditorNativeEmphasis);
  assert.equal(actual[0].text,'甲𠮷乙');assert.deepEqual(actual[0].marks,[]);
  await assert.rejects(assertEditorNativeEmphasis(page,'#editor',html),/加点|下划线/u);
});

test('browser pre-save check rejects moved, enlarged and unexpected marks on unchanged text', async t=>{
  const page=await ownedEditor(t);
  const expected=`<p><span style="${dotStyle}">同</span>同甲</p>`;
  for(const changed of [
    `<p>同<span style="${dotStyle}">同</span>甲</p>`,
    `<p><span style="${dotStyle}">同同</span>甲</p>`,
    `<p><span style="${dotStyle}">同</span>同<u>甲</u></p>`,
  ]){
    await insert(page,changed);
    assert.equal(await page.locator('#editor').textContent(),'同同甲');
    await assert.rejects(assertEditorNativeEmphasis(page,'#editor',expected),/加点|下划线/u);
  }
});

test('browser pre-save check rejects unsupported emphasis shape or placement rather than treating it as an under-dot', async t=>{
  const page=await ownedEditor(t);
  const expected=`<p><span style="${dotStyle}">甲</span>乙</p>`;
  for(const changed of [
    '<p><span style="text-emphasis-style:circle;text-emphasis-position:under right">甲</span>乙</p>',
    '<p><span style="text-emphasis-style:dot;text-emphasis-position:over right">甲</span>乙</p>',
  ]){
    await insert(page,changed);
    const native=await page.locator('#editor').evaluate(readEditorNativeEmphasis);
    assert.equal(native[0].marks[0].type,'unsupported-emphasis');
    await assert.rejects(assertEditorNativeEmphasis(page,'#editor',expected),/加点|下划线/u);
  }
});

test('available book 146965 first-ten v3 draft retains all 135 marks through the real owned browser command', async t=>{
  const job=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../data/jobs/book-146965-full-20261009');
  const filename=path.join(job,'batch.first10.draft.v3.json');
  let batch;
  try{batch=JSON.parse(await fs.readFile(filename,'utf8'));}
  catch(error){if(error.code==='ENOENT'){t.skip('Local first-ten source fixture is absent from this checkout');return;}throw error;}
  assert.equal(batch.bookId,146965);assert.equal(batch.tasks.length,10);
  const page=await ownedEditor(t);
  let checkedMarks=0;
  for(const task of batch.tasks)for(const side of ['stem','answer']){
    // Rendered input is compared against the original manifest's text and
    // independently authored code-point ranges, never against parsed renderer
    // output. This detects whitespace loss and incorrect format range slicing.
    await insertReviewedEditorHtml(page,'#editor',renderEditorHtml(task[side],job),{replace:true,timeoutMs:2500});
    const actual=await page.locator('#editor').evaluate(readEditorNativeEmphasis);
    assert.equal(actual.length,task[side].blocks.length,`${task.id} ${side} paragraph count`);
    for(const [index,authored] of task[side].blocks.entries()){
      if(authored.type==='image'||authored.type==='analysis-separator'){
        assert.deepEqual(actual[index].marks,[]);
        assert.equal(actual[index].text.trim(),'');
        continue;
      }
      const text=authored.type==='image'||authored.type==='analysis-separator'?'':authored.parts?authored.parts.join('\u00a0'.repeat(8)):authored.runs?authored.runs.map(run=>run.text).join(''):authored.text;
      const marks=authored.emphasis?.marks??[];
      assert.equal(nativeEmphasisSignature(actual[index].text,actual[index].marks),nativeEmphasisSignature(text,marks),`${task.id} ${side} paragraph ${index+1}: final text and marked ranges changed`);
      checkedMarks+=marks.length;
    }
  }
  assert.equal(checkedMarks,135);
});
