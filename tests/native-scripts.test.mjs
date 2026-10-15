import test from 'node:test';
import assert from 'node:assert/strict';
import {expectedNativeScripts,nativeScriptsSignature} from '../src/native-scripts.mjs';
import {validateNewSystemManifest,renderEditorHtml,expectedEditor,compareNewSystemReadback} from '../src/new-system-core.mjs';

const mark=(type,start,end,text)=>({type,start,end,text});
const spec=marks=>({schemaVersion:1,indexUnit:'unicode-code-points',marks});
const combined=()=>({type:'text',runs:[{type:'text',text:'甲同'},{type:'sup',text:'同'},{type:'text',text:'𠮷乙'}],emphasis:spec([mark('underline',0,4,'甲同同𠮷')])});

test('native script expectations use final Unicode code-point offsets without changing blocks',()=>{
  const block={type:'text',runs:[{type:'text',text:'𠮷同'},{type:'sup',text:'同'},{type:'text',text:'甲'},{type:'sub',text:'②'}]},before=structuredClone(block);
  assert.deepEqual(expectedNativeScripts(block),{text:'𠮷同同甲②',marks:[mark('sup',2,3,'同'),mark('sub',4,5,'②')]});
  assert.deepEqual(block,before);
  assert.deepEqual(expectedNativeScripts({type:'sup',text:'𠮷\r\n①'}),{text:'𠮷\n①',marks:[mark('sup',0,3,'𠮷\n①')]});
  assert.deepEqual(expectedNativeScripts({type:'text',parts:['甲','乙']}),{text:'甲'+'\u00a0'.repeat(8)+'乙',marks:[]});
  assert.deepEqual(expectedNativeScripts({type:'image',path:'not-read.png'}),{text:'',marks:[]});
});

test('script signatures accept equivalent split nodes but reject position, type and duplicate changes',()=>{
  assert.equal(nativeScriptsSignature('同同',[mark('sup',0,2,'同同')]),nativeScriptsSignature('同同',[mark('sup',0,1,'同'),mark('sup',1,2,'同')]));
  assert.notEqual(nativeScriptsSignature('同同',[mark('sup',0,1,'同')]),nativeScriptsSignature('同同',[mark('sup',1,2,'同')]));
  assert.notEqual(nativeScriptsSignature('同',[mark('sup',0,1,'同')]),nativeScriptsSignature('同',[mark('sub',0,1,'同')]));
  assert.equal(nativeScriptsSignature('甲 乙',[mark('sub',0,2,'甲 ')]),nativeScriptsSignature('甲\u00a0乙',[mark('sub',0,2,'甲\u00a0')]));
  for(const marks of [[mark('sup',0,1,'乙')],[mark('script',0,1,'甲')],[mark('sup',-1,1,'甲')],[mark('sup',0,2,'甲')],[mark('sup',0,1,'甲'),mark('sup',0,1,'甲')]])assert.throws(()=>nativeScriptsSignature('甲',marks));
  assert.throws(()=>expectedNativeScripts({type:'text',text:'甲',runs:[{type:'sup',text:'甲'}]}));
  assert.throws(()=>expectedNativeScripts({type:'text',runs:[{type:'sup',text:'\ud800'}]}));
});

function fixture(){
  const block=combined(),text='甲同同𠮷乙',task={id:'synthetic-combined',target:{chapterLabel:'Synthetic chapter',sectionLabel:'Synthetic section',record:1},source:{pages:[1],answerPages:[2]},stem:{blocks:[block]},answer:{blocks:[{type:'text',text:'答案'}]},review:{status:'approved',issues:[]}};
  // Independent actual metadata and HTML. Neither expectedEditor nor the
  // renderer manufactures the readback being accepted under this test.
  const readback={status:'found',bookId:100001,recordId:1001,target:{...task.target},source:structuredClone(task.source),stem:{text,html:'<p><u>甲同</u><sup><u>同</u></sup><u>𠮷</u>乙</p>',images:[],paragraphs:[{text,imageCount:0,align:'left',direction:'ltr',nativeEmphasis:{text,marks:[mark('underline',0,4,'甲同同𠮷')]},nativeScripts:{text,marks:[mark('sup',2,3,'同')]}}]},answer:{text:'答案',html:'<p>答案</p>',images:[],paragraphs:[{text:'答案',imageCount:0,align:'left',direction:'ltr'}]}};
  return {task,readback};
}

test('one natural paragraph renders overlapping underline and sup once and exposes expected locations',()=>{
  const {task,readback}=fixture();
  assert.equal(validateNewSystemManifest({schemaVersion:1,kind:'new-system-batch',bookId:100001,source:'fixture',tasks:[task]}).valid,true);
  const html=renderEditorHtml(task.stem);
  assert.equal((html.match(/<sup>/gu)??[]).length,1);
  assert.match(html,/<sup><u>同<\/u><\/sup>/u);
  assert.deepEqual(expectedEditor(task.stem).paragraphs[0].nativeScripts,{text:'甲同同𠮷乙',marks:[mark('sup',2,3,'同')]});
  assert.equal(compareNewSystemReadback(task,readback,{bookId:100001}).ok,true);
});

test('combined readback rejects missing, moved, widened, extra and malformed script metadata',async t=>{
  const changes={missing:p=>{delete p.nativeScripts;},stripped:p=>{p.nativeScripts.marks=[];},moved:p=>{p.nativeScripts.marks=[mark('sup',1,2,'同')];},widened:p=>{p.nativeScripts.marks=[mark('sup',1,3,'同同')];},extra:p=>{p.nativeScripts.marks.push(mark('sub',4,5,'乙'));},kind:p=>{p.nativeScripts.marks[0].type='sub';},invalid:p=>{p.nativeScripts.marks[0].text='乙';},wrongParagraph:p=>{p.nativeScripts.text='甲同同𠮷乙!';}};
  for(const [name,change]of Object.entries(changes))await t.test(name,()=>{const {task,readback}=fixture();change(readback.stem.paragraphs[0]);const result=compareNewSystemReadback(task,readback);assert.equal(result.ok,false);assert.match(result.errors.join(';'),/上下标/u);});
});

test('old script-array checks remain mandatory even with perfect new positional metadata',()=>{
  const {task,readback}=fixture();readback.stem.html=readback.stem.html.replace(/<sup>|<\/sup>/gu,'');
  const result=compareNewSystemReadback(task,readback);assert.equal(result.ok,false);assert.match(result.errors.join(';'),/上下标标签/u);
});

test('legacy script readbacks remain compatible, but any available positions are strict',()=>{
  const {task,readback}=fixture();delete task.stem.blocks[0].emphasis;delete readback.stem.paragraphs[0].nativeEmphasis;delete readback.stem.paragraphs[0].nativeScripts;
  assert.equal(compareNewSystemReadback(task,readback).ok,true);
  readback.stem.paragraphs[0].nativeScripts={text:'甲同同𠮷乙',marks:[mark('sup',1,2,'同')]};
  assert.equal(compareNewSystemReadback(task,readback).ok,false);
  const plain=fixture();plain.task.stem.blocks=[{type:'text',text:'甲同同𠮷乙'}];delete plain.readback.stem.paragraphs[0].nativeEmphasis;plain.readback.stem.html='<p>甲同同𠮷乙</p>';
  assert.equal(compareNewSystemReadback(plain.task,plain.readback).ok,false,'Unrequested script metadata rejects plain text');
});
