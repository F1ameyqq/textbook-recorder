import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { pasteReviewedEditorHtml } from '../src/browser-editor-paste.mjs';

async function fixture(t, initial = '') {
  const browser = await chromium.launch({channel:'msedge',headless:true});
  t.after(()=>browser.close());
  const context = await browser.newContext({serviceWorkers:'block',viewport:{width:1000,height:700}});
  let requests=0,fronts=0;
  await context.route('**/*',route=>{requests++;return route.abort();});
  const page=await context.newPage();
  await page.setContent('<div id="editor" contenteditable="true" style="width:600px;min-height:120px;border:1px solid">'+initial+'</div>');
  page.bringToFront=async()=>{fronts++;throw new Error('Background paste must not bring a window to front');};
  await page.evaluate(()=>{
    window.fixtureCalls={commands:0,clipboard:0,inputs:0};
    const native=document.execCommand.bind(document);
    document.execCommand=(...args)=>{window.fixtureCalls.commands++;return native(...args);};
    Object.defineProperty(navigator,'clipboard',{configurable:true,get(){window.fixtureCalls.clipboard++;throw new Error('Background paste must not access clipboard');}});
    document.querySelector('#editor').addEventListener('input',()=>window.fixtureCalls.inputs++);
  });
  return {page,guard:async()=>assert.equal(page.url(),'about:blank'),stats:async()=>({fronts,requests,...await page.evaluate(()=>window.fixtureCalls)})};
}

test('formula-free background paste keeps exact authored spaces, scripts and native underline without clipboard',async t=>{
  const f=await fixture(t);
  const html='<p style="text-align:left;direction:ltr;white-space:pre-wrap" dir="ltr" align="left">&nbsp;&nbsp;甲&nbsp;&nbsp;乙<sub>2</sub><u>丙</u></p>';
  const result=await pasteReviewedEditorHtml(f.page,'#editor',html,{focusMode:'background',guard:f.guard,timeoutMs:3000});
  assert.equal(result.command,'insertHTML');assert.equal(result.formulaPasteCount,0);assert.deepEqual(result.clipboardFormats,[]);
  const actual=await f.page.locator('#editor').evaluate(element=>({text:element.textContent,scripts:[...element.querySelectorAll('sub')].map(node=>node.textContent),underline:element.querySelector('u')?.textContent}));
  assert.deepEqual(actual,{text:'\u00a0\u00a0甲\u00a0\u00a0乙2丙',scripts:['2'],underline:'丙'});
  const calls=await f.stats();assert.equal(calls.commands,1);assert.ok(calls.inputs>0);assert.equal(calls.clipboard,0);assert.equal(calls.fronts,0);assert.equal(calls.requests,0);
});

test('background formula-only native paste rejects before replacement, input, clipboard or activation',async t=>{
  const f=await fixture(t,'<p>existing reviewed content</p>');
  const before=await f.page.locator('#editor').innerHTML();
  await assert.rejects(pasteReviewedEditorHtml(f.page,'#editor','<p>formula <math-tex>$x$</math-tex></p>',{replace:true,focusMode:'background',guard:f.guard}),/原生剪贴板/u);
  assert.equal(await f.page.locator('#editor').innerHTML(),before);
  assert.deepEqual(await f.stats(),{fronts:0,requests:0,commands:0,clipboard:0,inputs:0});
});

test('paste mode validation rejects before any page capability or content access',async()=>{
  const page={locator(){throw new Error('Invalid mode touched the page');}};
  for(const options of [{focusMode:'hidden'},{windowMode:'hidden'},{focusMode:'foreground',windowMode:'minimized'}])await assert.rejects(pasteReviewedEditorHtml(page,'#editor','<p>reviewed</p>',options),/focusMode|windowMode|minimized/u);
});
