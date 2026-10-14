import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {readEditorNativeScripts, assertEditorNativeScripts, nativeScriptsSignature} from '../src/native-scripts.mjs';
import {assertEditorNativeEmphasis} from '../src/native-emphasis.mjs';
import {insertReviewedEditorHtml} from '../src/browser-editor-command.mjs';
import {renderEditorHtml} from '../src/new-system-core.mjs';

const normalizer = '#editor sup,#editor sub{font-size:75%;line-height:0;position:relative;vertical-align:baseline;transform:none}#editor sup{top:-.5em;bottom:auto}#editor sub{top:auto;bottom:-.25em}';
let browserPromise;
after(async () => { if (browserPromise) await (await browserPromise.catch(() => null))?.close(); });
async function ownedEditor(t, extraCss = '') {
  browserPromise ??= chromium.launch({channel:'msedge',headless:true});
  const context = await (await browserPromise).newContext();
  t.after(() => context.close());
  await context.route('**/*',route => route.abort());
  const page = await context.newPage();
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>${normalizer}${extraCss}</style><div id="editor" contenteditable="true" style="font:24px sans-serif;min-height:60px"></div>`);
  return page;
}
const mark = (type,start,end,text) => ({type,start,end,text});
const mixedBlock = {
  type:'text',
  runs:[{type:'text',text:'甲𠮷'},{type:'sup',text:'①②'},{type:'text',text:'乙'},{type:'sub',text:'③'}],
  emphasis:{schemaVersion:1,indexUnit:'unicode-code-points',marks:[mark('underline',1,3,'𠮷①'),mark('emphasis-dot',3,4,'②')]},
};

test('real normalizer CSS retains native sup/sub positions with underline and dots inside sup', async t => {
  const page = await ownedEditor(t), html = renderEditorHtml({blocks:[mixedBlock]});
  await page.locator('#editor').evaluate((editor,html) => editor.innerHTML = html,html);
  const computed = await page.locator('#editor').evaluate(editor => [...editor.querySelectorAll('sup,sub')].map(element => {
    const style = getComputedStyle(element);
    return {tag:element.tagName,align:style.verticalAlign,position:style.position,fontSize:style.fontSize,lineHeight:style.lineHeight,top:style.top,bottom:style.bottom};
  }));
  assert.deepEqual(computed,[
    {tag:'SUP',align:'baseline',position:'relative',fontSize:'18px',lineHeight:'0px',top:'-9px',bottom:'9px'},
    {tag:'SUB',align:'baseline',position:'relative',fontSize:'18px',lineHeight:'0px',top:'4.5px',bottom:'-4.5px'},
  ],'Positive evidence must come from actual computed browser CSS');
  const before = await page.locator('#editor').innerHTML();
  const actual = await page.locator('#editor').evaluate(readEditorNativeScripts);
  assert.equal(nativeScriptsSignature(actual[0].text,actual[0].marks),nativeScriptsSignature('甲𠮷①②乙③',[mark('sup',2,4,'①②'),mark('sub',5,6,'③')]));
  await assertEditorNativeScripts(page,'#editor',html);
  await assertEditorNativeEmphasis(page,'#editor',html);
  assert.equal(await page.locator('#editor').innerHTML(),before,'Style validation must never repair live DOM');
  assert.equal(await page.locator('#editor sup').count(),1);
  assert.equal(await page.locator('#editor sub').count(),1);
});

test('browser command accepts real normalized scripts and their combined emphasis before blur/save', async t => {
  const page = await ownedEditor(t), html = renderEditorHtml({blocks:[mixedBlock]});
  await page.locator('#editor').evaluate(editor => {
    window.blurs = 0; window.saves = 0;
    editor.addEventListener('blur',() => {window.blurs++;window.saves++;});
  });
  const result = await insertReviewedEditorHtml(page,'#editor',html);
  assert.equal(result.succeeded,true);
  await assertEditorNativeScripts(page,'#editor',html);
  await assertEditorNativeEmphasis(page,'#editor',html);
  assert.deepEqual(await page.evaluate(() => ({blurs:window.blurs,saves:window.saves})),{blurs:0,saves:0});
});

const invalidStyles = [
  ['sup zero displacement','#editor sup{top:0}'],
  ['sub zero displacement','#editor sub{bottom:0}'],
  ['sup reverse displacement','#editor sup{top:.5em}'],
  ['sub reverse displacement','#editor sub{bottom:.25em}'],
  ['sup excessive displacement','#editor sup{top:-2em}'],
  ['sub excessive displacement','#editor sub{bottom:-2em}'],
  ['absolute positioning','#editor sup{position:absolute}'],
  ['additional transform','#editor sup{transform:translateY(-1px)}'],
  ['unreduced font size','#editor sup{font-size:100%}'],
  ['sup both top and bottom','#editor sup{bottom:-.25em}'],
  ['sub both top and bottom','#editor sub{top:-.5em}'],
  ['nonzero line height','#editor sup{line-height:normal}'],
  ['static positioning','#editor sup{position:static}'],
];
for (const [name,css] of invalidStyles) {
  test(`normalizer guard rejects ${name} without changing editor text or DOM`, async t => {
    const page = await ownedEditor(t,css), html = '<p>甲<sup>②</sup>乙<sub>③</sub></p>';
    await page.locator('#editor').evaluate((editor,html) => editor.innerHTML = html,html);
    const before = await page.locator('#editor').innerHTML();
    await assert.rejects(assertEditorNativeScripts(page,'#editor',html),/上下标|纵向/u);
    assert.equal(await page.locator('#editor').textContent(),'甲②乙③');
    assert.equal(await page.locator('#editor').innerHTML(),before);
  });
}

test('normalizer guard rejects duplicate script nesting and CSS-only pseudo-script', async t => {
  const page = await ownedEditor(t,'#editor .pseudo{font-size:75%;line-height:0;position:relative;vertical-align:baseline;top:-.5em}');
  await page.locator('#editor').evaluate(editor => editor.innerHTML = '<p>甲<sup><sup>②</sup></sup></p>');
  await assert.rejects(assertEditorNativeScripts(page,'#editor','<p>甲<sup>②</sup></p>'),/上下标|嵌套/u);
  await page.locator('#editor').evaluate(editor => editor.innerHTML = '<p>甲<span class="pseudo">②</span></p>');
  await assert.rejects(assertEditorNativeScripts(page,'#editor','<p>甲<sup>②</sup></p>'),/上下标/u);
});

test('normalizer preserves exact ranges and rejects shifted or widened script markup', async t => {
  const page = await ownedEditor(t), expected = '<p>甲同<sup>同</sup>乙<sub>③</sub></p>';
  for (const actual of ['<p>甲<sup>同</sup>同乙<sub>③</sub></p>','<p>甲<sup>同同</sup>乙<sub>③</sub></p>','<p>甲同<sub>同</sub>乙<sub>③</sub></p>']) {
    await page.locator('#editor').evaluate((editor,html) => editor.innerHTML = html,actual);
    assert.equal(await page.locator('#editor').textContent(),'甲同同乙③');
    await assert.rejects(assertEditorNativeScripts(page,'#editor',expected),/上下标/u);
  }
});

test('real input stripping normalized script formatting stops before any blur/save', async t => {
  const page = await ownedEditor(t);
  await page.locator('#editor').evaluate(editor => {
    window.inputs = 0; window.blurs = 0; window.saves = 0;
    editor.addEventListener('blur',() => {window.blurs++;window.saves++;});
    editor.addEventListener('input',() => {
      window.inputs++;
      for (const element of editor.querySelectorAll('sup,sub')) element.replaceWith(...element.childNodes);
    });
  });
  await assert.rejects(insertReviewedEditorHtml(page,'#editor','<p>甲同<sup>同</sup>乙<sub>③</sub></p>'),/上下标/u);
  assert.equal(await page.locator('#editor').textContent(),'甲同同乙③');
  const events = await page.evaluate(() => ({inputs:window.inputs,blurs:window.blurs,saves:window.saves}));
  assert.ok(events.inputs > 0,'Failure must occur after a genuine editor input event');
  assert.equal(events.blurs,0); assert.equal(events.saves,0);
});
