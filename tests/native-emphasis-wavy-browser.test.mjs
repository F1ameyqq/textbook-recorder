import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {readEditorNativeEmphasis,assertEditorNativeEmphasis,nativeEmphasisSignature} from '../src/native-emphasis.mjs';
import {assertEditorNativeScripts} from '../src/native-scripts.mjs';
import {insertReviewedEditorHtml} from '../src/browser-editor-command.mjs';
import {renderEditorHtml} from '../src/new-system-core.mjs';
import {NewSystemAdapter} from '../src/new-system-adapter.mjs';

let browserPromise;
after(async()=>{if(browserPromise)await(await browserPromise.catch(()=>null))?.close();});
async function ownedEditor(t,width=400){
  browserPromise??=chromium.launch({channel:'msedge',headless:true});
  const context=await(await browserPromise).newContext();t.after(()=>context.close());
  await context.route('**/*',route=>route.abort());
  const page=await context.newPage();await page.setContent(`<!doctype html><meta charset="utf-8"><div id="editor" contenteditable="true" style="font:24px sans-serif;min-height:60px;width:${width}px"></div>`);
  return page;
}
const mark=(type,start,end,text)=>({type,start,end,text});
const wavy=text=>`<u style="text-decoration-style:wavy">${text}</u>`;

test('real computed wavy decoration remains continuous across visual wrapping without creating paragraphs',async t=>{
  const page=await ownedEditor(t,100),text='甲同同𠮷乙丙丁戊己庚辛壬癸尾',html=`<p>${wavy(text)}</p>`;
  await insertReviewedEditorHtml(page,'#editor',html);
  const style=await page.locator('#editor u').evaluate(element=>({line:getComputedStyle(element).textDecorationLine,style:getComputedStyle(element).textDecorationStyle,rows:new Set([...element.getClientRects()].map(rect=>Math.round(rect.y))).size}));
  assert.equal(style.line,'underline');assert.equal(style.style,'wavy');assert.ok(style.rows>1,'Actual browser layout must wrap the single wavy run');
  const before=await page.locator('#editor').innerHTML(),actual=await page.locator('#editor').evaluate(readEditorNativeEmphasis);
  assert.equal(actual.length,1);assert.equal(actual[0].text,text);
  assert.equal(nativeEmphasisSignature(text,actual[0].marks),nativeEmphasisSignature(text,[mark('underline-wavy',0,Array.from(text).length,text)]));
  await assertEditorNativeEmphasis(page,'#editor',html);assert.equal(await page.locator('#editor').innerHTML(),before);
});

test('real input preserves wavy and dot ranges within one script-bearing paragraph before blur/save',async t=>{
  const page=await ownedEditor(t),text='甲𠮷①乙丙',block={type:'text',runs:[{type:'text',text:'甲𠮷'},{type:'sup',text:'①'},{type:'text',text:'乙丙'}],emphasis:{schemaVersion:1,indexUnit:'unicode-code-points',marks:[mark('underline-wavy',1,4,'𠮷①乙'),mark('emphasis-dot',2,3,'①')]}};
  await page.locator('#editor').evaluate(editor=>{window.blurs=0;window.saves=0;editor.addEventListener('blur',()=>{window.blurs++;window.saves++;});});
  const html=renderEditorHtml({blocks:[block]});assert.equal((await insertReviewedEditorHtml(page,'#editor',html)).succeeded,true);
  await assertEditorNativeScripts(page,'#editor',html);await assertEditorNativeEmphasis(page,'#editor',html);
  const adapter=new NewSystemAdapter({page,inputMode:'browser-command'}),readback=await adapter._editorRead('#editor');
  assert.equal(nativeEmphasisSignature(text,readback.paragraphs[0].nativeEmphasis.marks),nativeEmphasisSignature(text,block.emphasis.marks));
  assert.equal(readback.paragraphs.length,1);assert.equal(await page.locator('#editor sup').count(),1);
  assert.deepEqual(await page.evaluate(()=>({blurs:window.blurs,saves:window.saves})),{blurs:0,saves:0});
});

test('solid, missing, unknown or unsupported computed decorations cannot substitute for wavy',async t=>{
  const page=await ownedEditor(t),expected=`<p>甲${wavy('𠮷')}乙</p>`;
  for(const html of ['<p>甲<u>𠮷</u>乙</p>','<p>甲𠮷乙</p>','<p>甲<u style="text-decoration-style:not-a-style">𠮷</u>乙</p>','<p>甲<u style="text-decoration-style:dotted">𠮷</u>乙</p>','<p>甲<u style="text-decoration-style:double">𠮷</u>乙</p>','<p>甲<u style="text-decoration-line:none;text-decoration-style:wavy">𠮷</u>乙</p>']){
    await page.locator('#editor').evaluate((editor,html)=>editor.innerHTML=html,html);const before=await page.locator('#editor').innerHTML();
    assert.equal(await page.locator('#editor').textContent(),'甲𠮷乙');await assert.rejects(assertEditorNativeEmphasis(page,'#editor',expected),/格式|加点|下划线/u);
    assert.equal(await page.locator('#editor').innerHTML(),before);
  }
  await page.locator('#editor').evaluate(editor=>editor.innerHTML='<p>甲<u style="text-decoration-style:dashed">𠮷</u>乙</p>');
  assert.equal((await page.locator('#editor').evaluate(readEditorNativeEmphasis))[0].marks[0].type,'unsupported-underline');
  await assert.rejects(assertEditorNativeEmphasis(page,'#editor','<p>甲<u>𠮷</u>乙</p>'),/格式|加点|下划线/u);
});

test('unchanged repeated text still rejects moved, widened, extra or conflicting wavy ranges',async t=>{
  const page=await ownedEditor(t),expected=`<p>甲同${wavy('同')}乙</p>`;
  for(const html of [`<p>甲${wavy('同')}同乙</p>`,`<p>甲${wavy('同同')}乙</p>`,`<p>甲同${wavy('同')}${wavy('乙')}</p>`,`<p>甲同<u>${wavy('同')}</u>乙</p>`]){
    await page.locator('#editor').evaluate((editor,html)=>editor.innerHTML=html,html);assert.equal(await page.locator('#editor').textContent(),'甲同同乙');
    await assert.rejects(assertEditorNativeEmphasis(page,'#editor',expected),/格式|加点|下划线/u);
  }
});

test('actual input sanitizer stripping wavy style stops before blur/save even when underline and text remain',async t=>{
  const page=await ownedEditor(t);
  await page.locator('#editor').evaluate(editor=>{
    window.inputs=0;window.blurs=0;window.saves=0;
    editor.addEventListener('blur',()=>{window.blurs++;window.saves++;});
    editor.addEventListener('input',()=>{window.inputs++;for(const element of editor.querySelectorAll('u'))element.removeAttribute('style');});
  });
  await assert.rejects(insertReviewedEditorHtml(page,'#editor',`<p>甲同${wavy('同')}乙</p>`),/格式|加点|下划线/u);
  assert.equal(await page.locator('#editor').textContent(),'甲同同乙');assert.equal(await page.locator('#editor u').count(),1);
  const events=await page.evaluate(()=>({inputs:window.inputs,blurs:window.blurs,saves:window.saves}));assert.ok(events.inputs>0);assert.equal(events.blurs,0);assert.equal(events.saves,0);
});
