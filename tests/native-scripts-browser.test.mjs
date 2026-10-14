import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {readEditorNativeScripts,assertEditorNativeScripts,nativeScriptsSignature} from '../src/native-scripts.mjs';
import {insertReviewedEditorHtml} from '../src/browser-editor-command.mjs';
import {NewSystemAdapter} from '../src/new-system-adapter.mjs';
import {renderEditorHtml} from '../src/new-system-core.mjs';

let browserPromise;
after(async()=>{if(browserPromise)await(await browserPromise.catch(()=>null))?.close();});
async function ownedEditor(t){
  browserPromise??=chromium.launch({channel:'msedge',headless:true});
  const context=await(await browserPromise).newContext();t.after(()=>context.close());
  await context.route('**/*',route=>route.abort());
  const page=await context.newPage();await page.setContent('<!doctype html><meta charset="utf-8"><div id="editor" contenteditable="true" style="font:24px sans-serif;min-height:50px"></div>');
  return page;
}
const mark=(type,start,end,text)=>({type,start,end,text});

test('read-only real DOM reader retains Unicode script positions, BR and emphasis nesting',async t=>{
  const page=await ownedEditor(t),html='<p>𠮷同<sup><u>同</u></sup>甲<sub>②<br>③</sub></p><p>尾</p>';
  await page.locator('#editor').evaluate((editor,html)=>editor.innerHTML=html,html);
  const before=await page.locator('#editor').innerHTML(),actual=await page.locator('#editor').evaluate(readEditorNativeScripts);
  assert.equal(actual[0].text,'𠮷同同甲②\n③');
  assert.equal(nativeScriptsSignature(actual[0].text,actual[0].marks),nativeScriptsSignature('𠮷同同甲②\n③',[mark('sup',2,3,'同'),mark('sub',4,7,'②\n③')]));
  assert.deepEqual(actual[1],{text:'尾',marks:[]});
  await assertEditorNativeScripts(page,'#editor',html);
  assert.equal(await page.locator('#editor').innerHTML(),before,'Both actual and inert readers must leave live DOM unchanged');
});

test('browser-command inserts one paragraph with real underline and superscript before any blur',async t=>{
  const page=await ownedEditor(t),block={type:'text',runs:[{type:'text',text:'甲同'},{type:'sup',text:'同'},{type:'text',text:'𠮷乙'}],emphasis:{schemaVersion:1,indexUnit:'unicode-code-points',marks:[mark('underline',0,4,'甲同同𠮷')]}};
  await page.locator('#editor').evaluate(editor=>{window.blurCount=0;editor.addEventListener('blur',()=>window.blurCount++);});
  const result=await insertReviewedEditorHtml(page,'#editor',renderEditorHtml({blocks:[block]}));assert.equal(result.succeeded,true);
  const native=await page.locator('#editor').evaluate(readEditorNativeScripts);
  assert.equal(native.length,1);assert.equal(nativeScriptsSignature(native[0].text,native[0].marks),nativeScriptsSignature('甲同同𠮷乙',[mark('sup',2,3,'同')]));
  assert.equal(await page.locator('#editor sup').count(),1);assert.equal(await page.evaluate(()=>window.blurCount),0);
  const adapter=new NewSystemAdapter({page,inputMode:'browser-command'}),readback=await adapter._editorRead('#editor');
  assert.deepEqual(readback.paragraphs[0].nativeScripts,native[0]);assert.ok(readback.paragraphs[0].nativeEmphasis.marks.length);
});

test('unchanged text with shifted, widened, lost, extra or wrong-kind scripts is rejected',async t=>{
  const page=await ownedEditor(t),expected='<p>甲同<sup>同</sup>𠮷乙</p>';
  const changes=['<p>甲<sup>同</sup>同𠮷乙</p>','<p>甲<sup>同同</sup>𠮷乙</p>','<p>甲同同𠮷乙</p>','<p>甲同<sup>同</sup>𠮷<sub>乙</sub></p>','<p>甲同<sub>同</sub>𠮷乙</p>'];
  for(const html of changes){await page.locator('#editor').evaluate((editor,html)=>editor.innerHTML=html,html);assert.equal(await page.locator('#editor').textContent(),'甲同同𠮷乙');await assert.rejects(assertEditorNativeScripts(page,'#editor',expected),/上下标/u);}
});

test('real input sanitizer stripping superscript fails before blur or save despite matching text',async t=>{
  const page=await ownedEditor(t);
  await page.locator('#editor').evaluate(editor=>{window.inputs=0;window.blurs=0;window.saves=0;editor.addEventListener('blur',()=>{window.blurs++;window.saves++;});editor.addEventListener('input',()=>{window.inputs++;for(const node of editor.querySelectorAll('sup'))node.replaceWith(...node.childNodes);});});
  await assert.rejects(insertReviewedEditorHtml(page,'#editor','<p>甲同<sup>同</sup>乙</p>'),/上下标/u);
  assert.equal(await page.locator('#editor').textContent(),'甲同同乙');
  const events=await page.evaluate(()=>({inputs:window.inputs,blurs:window.blurs,saves:window.saves}));assert.ok(events.inputs>0);assert.equal(events.blurs,0);assert.equal(events.saves,0);
});

test('computed baseline reset, duplicate nesting and unexpected CSS superscript fail closed',async t=>{
  const page=await ownedEditor(t);
  await page.locator('#editor').evaluate(editor=>editor.innerHTML='<p>甲<sup style="vertical-align:baseline">②</sup></p>');
  await assert.rejects(assertEditorNativeScripts(page,'#editor','<p>甲<sup>②</sup></p>'),/纵向|上下标/u);
  await page.locator('#editor').evaluate(editor=>editor.innerHTML='<p>甲<sup><sup>②</sup></sup></p>');
  await assert.rejects(assertEditorNativeScripts(page,'#editor','<p>甲<sup>②</sup></p>'),/嵌套/u);
  await page.locator('#editor').evaluate(editor=>editor.innerHTML='<p>甲<span style="vertical-align:super">②</span></p>');
  await assert.rejects(assertEditorNativeScripts(page,'#editor','<p>甲②</p>'),/上下标/u);
});

test('moving a script to another paragraph cannot pass a global same-script list',async t=>{
  const page=await ownedEditor(t);await page.locator('#editor').evaluate(editor=>editor.innerHTML='<p>甲②</p><p>乙<sup>②</sup></p>');
  await assert.rejects(assertEditorNativeScripts(page,'#editor','<p>甲<sup>②</sup></p><p>乙②</p>'),/段落/u);
});
