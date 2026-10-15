import test from 'node:test';
import assert from 'node:assert/strict';
import {assertNativeEmphasis,renderNativeEmphasis,nativeEmphasisSignature} from '../src/native-emphasis.mjs';
import {validateNewSystemManifest,renderEditorHtml,compareNewSystemReadback} from '../src/new-system-core.mjs';

const mark=(type,start,end,text)=>({type,start,end,text});
const spec=marks=>({schemaVersion:1,indexUnit:'unicode-code-points',marks});
const block=()=>({type:'text',runs:[{type:'text',text:'甲𠮷'},{type:'sup',text:'①'},{type:'text',text:'乙丙'}],emphasis:spec([mark('underline-wavy',1,4,'𠮷①乙'),mark('emphasis-dot',2,3,'①')])});

test('underline-wavy is a distinct strict type with full Unicode positions across runs',()=>{
  const value=block(),before=structuredClone(value);
  assert.deepEqual(assertNativeEmphasis(value),value.emphasis.marks);
  const html=renderNativeEmphasis(value);
  assert.equal(html,'甲<u style="text-decoration-style:wavy">𠮷</u><sup><span style="text-emphasis-style:dot;text-emphasis-position:under right;-webkit-text-emphasis-style:dot;-webkit-text-emphasis-position:under right"><u style="text-decoration-style:wavy">①</u></span></sup><u style="text-decoration-style:wavy">乙</u>丙');
  assert.equal((html.match(/<sup>/gu)??[]).length,1);assert.doesNotMatch(html,/<\/?p\b/u);
  assert.deepEqual(value,before);
  assert.notEqual(nativeEmphasisSignature('𠮷',[mark('underline-wavy',0,1,'𠮷')]),nativeEmphasisSignature('𠮷',[mark('underline',0,1,'𠮷')]));
  assert.equal(nativeEmphasisSignature('𠮷①乙',[mark('underline-wavy',0,3,'𠮷①乙')]),nativeEmphasisSignature('𠮷①乙',[mark('underline-wavy',0,1,'𠮷'),mark('underline-wavy',1,3,'①乙')]));
});

test('wavy ranges reject unknown styles, stale offsets and conflicting underline declarations',async t=>{
  const cases={
    alias:b=>{b.emphasis.marks[0].type='wavy';},
    unknownField:b=>{b.emphasis.marks[0].style='wavy';},
    staleText:b=>{b.emphasis.marks[0].text='𠮷乙';},
    utf16Offset:b=>{b.emphasis.marks[0].start=2;},
    outOfRange:b=>{b.emphasis.marks[0].end=99;},
    duplicate:b=>{b.emphasis.marks.push({...b.emphasis.marks[0]});},
    solidOverlap:b=>{b.emphasis.marks.push(mark('underline',0,2,'甲𠮷'));},
    crossLF:b=>{b.runs=[{type:'text',text:'甲\n'},{type:'sup',text:'①'},{type:'text',text:'乙丙'}];b.emphasis.marks=[mark('underline-wavy',0,3,'甲\n①')];},
  };
  for(const [name,change] of Object.entries(cases))await t.test(name,()=>{const value=block();change(value);assert.throws(()=>assertNativeEmphasis(value));assert.throws(()=>renderNativeEmphasis(value));});
  assert.throws(()=>nativeEmphasisSignature('甲',[mark('unknown-decoration',0,1,'甲')]));
  assert.throws(()=>nativeEmphasisSignature('甲',[mark('underline-wavy',0,1,'甲'),mark('underline',0,1,'甲')]));
  assert.throws(()=>nativeEmphasisSignature('甲',[mark('underline-wavy',0,1,'甲'),mark('underline-wavy',0,1,'甲')]));
  assert.doesNotThrow(()=>assertNativeEmphasis({type:'text',text:'甲乙',emphasis:spec([mark('underline',0,1,'甲'),mark('underline-wavy',1,2,'乙')])}));
});

test('strict spacing and existing validation/render/readback integration retain wavy identity',()=>{
  const value={...block(),strictSpacing:true};value.runs[0].text='  甲𠮷';value.emphasis.marks=[mark('underline-wavy',3,6,'𠮷①乙'),mark('emphasis-dot',4,5,'①')];
  assert.match(renderNativeEmphasis(value),/^&nbsp;&nbsp;甲<u style="text-decoration-style:wavy">𠮷/u);
  const task={id:'synthetic-wavy',target:{chapterLabel:'Synthetic chapter',sectionLabel:'Synthetic section',record:1},source:{pages:[1],answerPages:[2]},stem:{blocks:[block()]},answer:{blocks:[{type:'text',text:'答案'}]},review:{status:'approved',issues:[]}};
  assert.equal(validateNewSystemManifest({schemaVersion:1,kind:'new-system-batch',bookId:100001,source:'fixture',tasks:[task]}).valid,true);
  const text='甲𠮷①乙丙',readback={status:'found',bookId:100001,recordId:1001,target:{...task.target},source:structuredClone(task.source),stem:{text,html:renderEditorHtml(task.stem),images:[],paragraphs:[{text,imageCount:0,align:'left',direction:'ltr',nativeEmphasis:{text,marks:structuredClone(task.stem.blocks[0].emphasis.marks)},nativeScripts:{text,marks:[mark('sup',2,3,'①')]}}]},answer:{text:'答案',html:'<p>答案</p>',images:[],paragraphs:[{text:'答案',imageCount:0,align:'left',direction:'ltr'}]}};
  assert.equal(compareNewSystemReadback(task,readback).ok,true);
  readback.stem.paragraphs[0].nativeEmphasis.marks[0].type='underline';
  assert.equal(compareNewSystemReadback(task,readback).ok,false,'Solid cannot be accepted as the authored wavy range');
});
