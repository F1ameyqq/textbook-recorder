import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { activateRecorderPage, readRecorderWindowState } from '../src/browser-focus.mjs';
import { requireRecorderDocumentReady } from '../src/browser-document-state.mjs';
import { manageRecorderWindow } from '../src/recorder-window-state.mjs';
import { insertReviewedEditorHtml } from '../src/browser-editor-command.mjs';
import { checkedPointerClick } from '../src/checked-pointer-click.mjs';
import { NewSystemAdapter } from '../src/new-system-adapter.mjs';
import { ANALYSIS_SEPARATOR } from '../src/analysis-separator.mjs';

test('real minimized Windows Edge supports confined editor input without foreground activation', {timeout:60000}, async t=>{
  const executablePath=['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
  if(process.platform!=='win32'||!executablePath){t.skip('Requires installed Windows Edge');return;}
  const browser=await chromium.launch({executablePath,headless:false,args:['--start-minimized','--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run','--disable-default-apps','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost','--proxy-server=http://127.0.0.1:9']});
  try{
    const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1100,height:800}});
    await context.route('**/*',route=>route.abort('blockedbyclient'));
    const page=await context.newPage();
    await page.setContent('<title>isolated recorder minimized test</title><style>body{margin:40px}.editor{padding:12px;border:2px solid;width:700px;min-height:100px;margin-bottom:30px}#directory{width:700px}#directory span{display:block;line-height:30px}</style><div id="target" class="editor" contenteditable="true"></div><div id="answeredit"><div id="answer" class="editor w-e-text" contenteditable="true"></div></div><div id="directory"><span>section label</span></div>');
    await page.route(ANALYSIS_SEPARATOR.src,route=>route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR9cAAAAASUVORK5CYII=','base64')}));
    await page.evaluate(()=>{window.fixtureSectionClicks=0;document.querySelector('#directory span').addEventListener('click',()=>window.fixtureSectionClicks++);});
    page.bringToFront=async()=>{throw new Error('Foreground activation forbidden in minimized test');};
    const guard=async()=>{assert.equal(page.url(),'about:blank');assert.equal(await page.locator('#target').count(),1);assert.equal(await page.locator('#answer').count(),1);};
    await activateRecorderPage(page,'background',{windowMode:'minimized',guard});
    // Disable Playwright's default focus emulation for this disposable fixture.
    // The production code never enables emulation or overrides DOM properties.
    const session=await context.newCDPSession(page);
    await session.send('Emulation.setFocusEmulationEnabled',{enabled:false});await session.detach();
    await manageRecorderWindow(page,'minimize',guard);
    const actual=await requireRecorderDocumentReady(page,{focusMode:'background',windowMode:'minimized',guard});
    assert.equal(actual.minimized,true);assert.ok(['visible','hidden'].includes(actual.visibilityState));
    assert.equal((await manageRecorderWindow(page,'read',guard)).windowState,'minimized');
    const options={focusMode:'background',windowMode:'minimized',guard,timeoutMs:8000};
    const clicked=await checkedPointerClick(page,page.locator('#directory'),{...options,timeout:8000});
    assert.equal(clicked.nativeClick.trusted,false);assert.equal(clicked.activationMethod,'HTMLElement.focus/click');
    assert.equal(await page.evaluate(()=>window.fixtureSectionClicks),1,'the actual hit-tested child handler must run');
    const first=await insertReviewedEditorHtml(page,'#answer','<p>答案</p>',options);
    const second=await insertReviewedEditorHtml(page,'#target','<p>　　正文&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;第二组</p>',options);
    assert.ok(first.inputEvents.some(event=>event.isTrusted&&event.type==='input'));
    assert.ok(second.inputEvents.some(event=>event.isTrusted&&event.type==='input'));
    assert.equal(await page.locator('#answer').innerText(),'答案');
    assert.equal(await page.locator('#target').textContent(),'　　正文'+ '\u00a0'.repeat(8)+'第二组');
    const adapter=new NewSystemAdapter({page,source:'fixture',inputMode:'browser-command',focusMode:'background',windowMode:'minimized',timeout:8000});
    adapter.guard=guard;
    const answer={blocks:[{type:'text',text:'5. D',strictSpacing:true},{type:'analysis-separator'},{type:'text',text:'A. 解析',strictSpacing:true},{type:'text',text:'B. 解析',strictSpacing:true}]};
    const analysis=await adapter._pasteReviewedAnswer(answer,{replace:true});
    assert.equal(analysis.analysisButtonClicks,0);
    assert.equal(analysis.analysisInputMethod,'browser-command-reviewed-native-image');
    assert.equal(await page.locator('#answeredit img').getAttribute('src'),ANALYSIS_SEPARATOR.src);
    assert.deepEqual(await page.locator('#answer > p').allTextContents(),['5.\u00a0D','','A.\u00a0解析','B.\u00a0解析']);
    assert.equal((await readRecorderWindowState(page,guard)).windowState,'minimized');
    const before=await page.locator('#target').innerHTML();
    await page.evaluate(()=>{const overlay=document.createElement('div');overlay.style.cssText='position:fixed;inset:0;z-index:9999;background:white';document.body.append(overlay);});
    await assert.rejects(insertReviewedEditorHtml(page,'#target','<p>must not replace</p>',{...options,replace:true}),/covered/);
    assert.equal(await page.locator('#target').innerHTML(),before);
    assert.equal((await readRecorderWindowState(page,guard)).windowState,'minimized');
    t.diagnostic(JSON.stringify({visibilityState:actual.visibilityState,hasFocus:actual.hasFocus,windowState:'minimized',trustedInputs:2,coveredInputRejected:true,platformSave:false}));
  }finally{await browser.close();}
});
