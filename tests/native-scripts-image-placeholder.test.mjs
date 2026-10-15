import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {chromium} from 'playwright';
import {compareNewSystemReadback,renderEditorHtml} from '../src/new-system-core.mjs';
import {readEditorNativeScripts} from '../src/native-scripts.mjs';
import {ANALYSIS_SEPARATOR} from '../src/analysis-separator.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR9cAAAAASUVORK5CYII=','base64');
const mark=(type,start,end,text)=>({type,start,end,text});
function fixture(t) {
  const baseDir=mkdtempSync(path.join(os.tmpdir(),'recorder-native-placeholder-'));
  t.after(()=>{assert.equal(path.dirname(baseDir),os.tmpdir());assert.ok(path.basename(baseDir).startsWith('recorder-native-placeholder-'));rmSync(baseDir,{recursive:true,force:true});});
  writeFileSync(path.join(baseDir,'figure.png'),png);
  const task={id:'synthetic-image-placeholder',target:{chapterLabel:'Synthetic chapter',sectionLabel:'Synthetic section',record:1},source:{pages:[1],answerPages:[2]},
    stem:{blocks:[{type:'text',text:'题干'},{type:'image',path:'figure.png',align:'center'},{type:'text',text:'结尾'}]},
    answer:{blocks:[{type:'text',text:'答案'},{type:'analysis-separator'},{type:'text',text:'解析'}]},review:{status:'approved',issues:[]}};
  const paragraph=(text,imageCount=0,align='left')=>({text,imageCount,align,direction:'ltr',nativeScripts:{text,marks:[]}});
  const readback={status:'found',bookId:100001,recordId:1001,target:{...task.target},source:structuredClone(task.source),
    stem:{text:'题干\n结尾',html:renderEditorHtml(task.stem,baseDir).replace(/(<img\b[^>]*>)(<\/p>)/u,'$1<br>$2'),images:[{sha256:createHash('sha256').update(png).digest('hex'),complete:true,width:1,height:1,align:'center'}],paragraphs:[paragraph('题干'),paragraph('',1,'center'),paragraph('结尾')]},
    answer:{text:'答案\n解析',html:`<p>答案</p><p><img style="display: block; width: 500px" src="${ANALYSIS_SEPARATOR.src}"><br></p><p>解析</p>`,images:[{...ANALYSIS_SEPARATOR,complete:true,align:'left'}],paragraphs:[paragraph('答案'),paragraph('',1),paragraph('解析')]}};
  readback.stem.paragraphs[1].nativeScripts.text='\n';
  readback.answer.paragraphs[1].nativeScripts.text='\n';
  return {baseDir,task,readback};
}
const compare=f=>compareNewSystemReadback(f.task,f.readback,{baseDir:f.baseDir,bookId:100001});

test('real read-only DOM metadata for image plus BR and analysis-separator plus BR compares without changing DOM',async t=>{
  const f=fixture(t),browser=await chromium.launch({channel:'msedge',headless:true});
  t.after(()=>browser.close());
  const page=await browser.newPage();await page.route('**/*',route=>route.abort());
  await page.setContent('<!doctype html><meta charset="utf-8"><div id="stem"></div><div id="answer"></div>');
  for(const side of ['stem','answer']) {
    const editor=page.locator(`#${side}`);await editor.evaluate((element,html)=>element.innerHTML=html,f.readback[side].html);
    const before=await editor.innerHTML(),metadata=await editor.evaluate(readEditorNativeScripts);
    assert.deepEqual(metadata[1],{text:'\n',marks:[]},`${side} must reproduce the platform BR placeholder via the real reader`);
    f.readback[side].paragraphs.forEach((paragraph,index)=>paragraph.nativeScripts=metadata[index]);
    assert.equal(await editor.innerHTML(),before);
  }
  assert.deepEqual(compare(f),{ok:true,errors:[]});
});

test('only empty or LF-only metadata can stand for a non-text image paragraph',async t=>{
  for(const text of ['','\n','\n\n'])await t.test(JSON.stringify(text),()=>{
    const f=fixture(t);f.readback.stem.paragraphs[1].nativeScripts.text=text;f.readback.answer.paragraphs[1].nativeScripts.text=text;
    assert.equal(compare(f).ok,true);
  });
  for(const text of ['字',' ','\u00a0','\r','\n字'])await t.test(`reject ${JSON.stringify(text)}`,()=>{
    const f=fixture(t);f.readback.answer.paragraphs[1].nativeScripts.text=text;
    const result=compare(f);assert.equal(result.ok,false);assert.match(result.errors.join(';'),/上下标/u);
  });
});

test('script marks and malformed metadata remain forbidden on image placeholders',async t=>{
  for(const metadata of [{text:'\n',marks:[mark('sup',0,1,'\n')]},{text:'\n',marks:[mark('sub',0,1,'\n')]},{text:'\n',marks:null},{text:'\n',marks:[mark('other',0,1,'\n')]},{text:'\n',marks:[mark('sup',0,2,'\n')]},{text:1,marks:[]}])await t.test(JSON.stringify(metadata),()=>{
    const f=fixture(t);f.readback.answer.paragraphs[1].nativeScripts=metadata;
    const result=compare(f);assert.equal(result.ok,false);assert.match(result.errors.join(';'),/上下标/u);
  });
});

test('text and combined emphasis/script paragraphs retain exact script metadata text',async t=>{
  for(const combined of [false,true])await t.test(combined?'combined':'plain',()=>{
    const f=fixture(t);
    if(combined){
      f.task.stem.blocks[0]={type:'text',runs:[{type:'text',text:'题'},{type:'sup',text:'干'}],emphasis:{schemaVersion:1,indexUnit:'unicode-code-points',marks:[mark('underline',0,2,'题干')]}};
      f.readback.stem.html=f.readback.stem.html.replace('题干','<u>题</u><sup><u>干</u></sup>');
      f.readback.stem.paragraphs[0].nativeEmphasis={text:'题干',marks:[mark('underline',0,2,'题干')]};
      f.readback.stem.paragraphs[0].nativeScripts.marks=[mark('sup',1,2,'干')];
    }
    assert.equal(compare(f).ok,true);
    f.readback.stem.paragraphs[0].nativeScripts.text+='\n';
    const result=compare(f);assert.equal(result.ok,false);assert.match(result.errors.join(';'),/上下标/u);
  });
});

test('placeholder normalization keeps image identity, count, dimensions and paragraph positions strict',async t=>{
  const changes={
    asset:r=>{r.stem.images[0].sha256='wrong';},
    count:r=>{r.stem.images.push({...r.stem.images[0]});},
    imageParagraph:r=>{r.stem.paragraphs[1].imageCount=2;},
    movedParagraph:r=>{[r.stem.paragraphs[1],r.stem.paragraphs[2]]=[r.stem.paragraphs[2],r.stem.paragraphs[1]];},
    separatorAsset:r=>{r.answer.images[0].src='https://example.invalid/wrong.png';},
    separatorDimensions:r=>{r.answer.images[0].width=1;},
    missingSeparator:r=>{r.answer.images=[];},
    addedScriptTag:r=>{r.answer.html=r.answer.html.replace('<br>','<sup><br></sup>');},
  };
  for(const [name,change] of Object.entries(changes))await t.test(name,()=>{
    const f=fixture(t);change(f.readback);assert.equal(compare(f).ok,false);
  });
});
