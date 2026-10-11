import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {NewSystemAdapter} from '../src/new-system-adapter.mjs';
import {ANALYSIS_SEPARATOR} from '../src/analysis-separator.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR9cAAAAASUVORK5CYII=','base64');

test('native menu inserts separator between reviewed answer and analysis without changing adjacent text',async t=>{
  let browser;
  try{browser=await chromium.launch({channel:'msedge',headless:true});}catch(error){t.skip('Edge unavailable for isolated UI fixture');return;}
  t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.route(ANALYSIS_SEPARATOR.src,route=>route.fulfill({contentType:'image/png',body:png}));
  await page.setContent('<div id="answeredit"><div class="w-e-menu">添加解析</div><div class="w-e-text" contenteditable="true"><p>old answer</p></div></div>');
  await page.evaluate(src=>{
    window.nativeAnalysisClicks=0;
    const menu=document.querySelector('.w-e-menu');
    menu.addEventListener('mousedown',event=>event.preventDefault());
    menu.addEventListener('click',()=>{window.nativeAnalysisClicks++;document.execCommand('insertHTML',false,`<p><br><img style="display: block; width: 500px" src="${src}"></p>`);});
  },ANALYSIS_SEPARATOR.src);
  const adapter=new NewSystemAdapter({page,source:'fixture',inputMode:'browser-command',timeout:5000});
  adapter.guard=async()=>assert.equal(page.url(),'about:blank');
  const answer={blocks:[{type:'text',text:'4. D'},{type:'text',text:'5. C'},{type:'analysis-separator'},{type:'text',text:'4. Explanation'},{type:'text',text:'D is correct.'},{type:'text',text:'5. Explanation'}]};
  const result=await adapter._pasteReviewedAnswer(answer,{replace:true});
  assert.equal(result.analysisButtonClicks,1);
  const actual=await page.evaluate(()=>({clicks:window.nativeAnalysisClicks,parts:[...document.querySelector('.w-e-text').children].filter(p=>p.textContent.trim()||p.querySelector('img')).map(p=>p.textContent.trim()||p.querySelector('img').src)}));
  assert.equal(actual.clicks,1);
  assert.deepEqual(actual.parts,['4. D','5. C',ANALYSIS_SEPARATOR.src,'4. Explanation','D is correct.','5. Explanation']);
});
