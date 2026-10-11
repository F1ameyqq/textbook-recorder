import test from 'node:test';
import assert from 'node:assert/strict';
import {assertNativeEmphasis, renderNativeEmphasis, nativeEmphasisSignature} from '../src/native-emphasis.mjs';
import {validateNewSystemManifest, renderEditorHtml, compareNewSystemReadback} from '../src/new-system-core.mjs';

const mark = (type, start, end, text) => ({type, start, end, text});
const spec = marks => ({schemaVersion:1, indexUnit:'unicode-code-points', marks});
const block = (text, marks) => ({type:'text', text, emphasis:spec(marks)});

test('emphasis contract uses final Unicode code-point offsets and returns a sorted independent copy', () => {
  const value = block('甲𠮷乙', [mark('underline',2,3,'乙'),mark('emphasis-dot',1,2,'𠮷')]);
  const before = structuredClone(value);
  assert.deepEqual(assertNativeEmphasis(value), [mark('emphasis-dot',1,2,'𠮷'),mark('underline',2,3,'乙')]);
  assert.deepEqual(value,before);
  const checked = assertNativeEmphasis(value); checked[0].text='changed';
  assert.deepEqual(value,before);
  assert.deepEqual(assertNativeEmphasis({type:'text',text:'普通文本'}),[]);
});

test('same-kind overlaps and duplicates reject while independent dot and underline ranges may overlap', () => {
  const overlap=block('甲乙丙',[mark('underline',0,2,'甲乙'),mark('underline',1,3,'乙丙')]);
  assert.throws(()=>assertNativeEmphasis(overlap),/交叠/u);
  assert.throws(()=>assertNativeEmphasis(block('甲',[mark('emphasis-dot',0,1,'甲'),mark('emphasis-dot',0,1,'甲')])),/重复|交叠/u);
  assert.equal(assertNativeEmphasis(block('甲乙丙',[mark('emphasis-dot',0,2,'甲乙'),mark('underline',1,3,'乙丙')])).length,2);
});

test('malformed or stale native-format declarations reject explicitly', async t => {
  const valid=()=>block('甲乙',[mark('emphasis-dot',0,1,'甲')]);
  const cases={
    'old source-only marker': b=>{b.emphasis={type:'dot',text:'甲'};},
    'wrong version': b=>{b.emphasis.schemaVersion=2;},
    'UTF-16 offsets': b=>{b.emphasis.indexUnit='utf16';},
    'unknown spec field': b=>{b.emphasis.confirmed=true;},
    'empty marks': b=>{b.emphasis.marks=[];},
    'unknown kind': b=>{b.emphasis.marks[0].type='overline';},
    'unknown mark field': b=>{b.emphasis.marks[0].style='color:red';},
    'noninteger start': b=>{b.emphasis.marks[0].start=0.5;},
    'negative start': b=>{b.emphasis.marks[0].start=-1;},
    'zero-length range': b=>{b.emphasis.marks[0].end=0;},
    'range past text': b=>{b.emphasis.marks[0].end=3;},
    'stale marked text': b=>{b.emphasis.marks[0].text='乙';},
    'mixed runs': b=>{b.runs=[{type:'text',text:'甲乙'}];},
    'mixed parts': b=>{b.parts=['甲','乙'];},
    'nontext block': b=>{b.type='sup';},
    'unpaired surrogate': b=>{b.text='甲\ud800';},
    'CR text': b=>{b.text='甲\r乙';},
  };
  for(const [name,mutate] of Object.entries(cases))await t.test(name,()=>{
    const value=valid(); mutate(value); assert.throws(()=>assertNativeEmphasis(value));
    assert.throws(()=>renderNativeEmphasis(value));
  });
});

test('ranges cannot cross a line break, contain only spaces or split a grapheme', () => {
  assert.throws(()=>assertNativeEmphasis(block('甲\n乙',[mark('underline',0,3,'甲\n乙')])));
  assert.throws(()=>assertNativeEmphasis(block('甲 乙',[mark('underline',1,2,' ')])));
  assert.throws(()=>assertNativeEmphasis(block('e\u0301甲',[mark('emphasis-dot',0,1,'e')])));
  assert.doesNotThrow(()=>assertNativeEmphasis(block('e\u0301甲',[mark('emphasis-dot',0,2,'e\u0301')])));
  const emoji='👩‍💻';
  assert.throws(()=>assertNativeEmphasis(block(emoji+'甲',[mark('underline',0,1,'👩')])));
  assert.doesNotThrow(()=>assertNativeEmphasis(block(emoji+'甲',[mark('underline',0,3,emoji)])));
});

test('renderer escapes text, retains line breaks and nests independently overlapping marks', () => {
  const value=block('甲𠮷乙&<>\n末',[
    mark('emphasis-dot',0,2,'甲𠮷'),mark('underline',1,3,'𠮷乙'),
  ]);
  const style='text-emphasis-style:dot;text-emphasis-position:under right;-webkit-text-emphasis-style:dot;-webkit-text-emphasis-position:under right';
  const expected=`<span style="${style}">甲</span><span style="${style}"><u>𠮷</u></span><u>乙</u>&amp;&lt;&gt;<br>末`;
  assert.equal(renderNativeEmphasis(value),expected);
  assert.equal(renderEditorHtml({blocks:[value]}),`<p style="text-align:left;direction:ltr" dir="ltr" align="left">${expected}</p>`);
  assert.doesNotMatch(renderNativeEmphasis(block('<script>',[mark('underline',0,8,'<script>')])),/<script>/u);
});

test('strict spacing survives rendering inside and around emphasis without moving code-point ranges', () => {
  const value = { ...block('   甲 𠮷        乙', [mark('underline', 3, 6, '甲 𠮷'), mark('emphasis-dot', 5, 6, '𠮷')]), strictSpacing: true };
  const original = structuredClone(value);
  const style = 'text-emphasis-style:dot;text-emphasis-position:under right;-webkit-text-emphasis-style:dot;-webkit-text-emphasis-position:under right';
  const html = '&nbsp;'.repeat(3) + `<u>甲&nbsp;</u><span style="${style}"><u>𠮷</u></span>` + '&nbsp;'.repeat(8) + '乙';
  assert.equal(renderNativeEmphasis(value), html);
  assert.deepEqual(value, original);
  assert.deepEqual(assertNativeEmphasis(value), original.emphasis.marks);
  assert.equal(nativeEmphasisSignature(value.text, value.emphasis.marks), nativeEmphasisSignature(value.text.replace(/ /gu, '\u00a0'), [mark('underline', 3, 6, '甲\u00a0𠮷'), mark('emphasis-dot', 5, 6, '𠮷')]));
  const ordinary = { ...value, strictSpacing: false };
  assert.match(renderNativeEmphasis(ordinary), /^ {3}<u>甲 <\/u>/u);
});

test('canonical signatures recognize equivalent split DOM ranges and retain repeated-character locations', () => {
  const full=[mark('underline',0,2,'同同')];
  const split=[mark('underline',0,1,'同'),mark('underline',1,2,'同')];
  assert.equal(nativeEmphasisSignature('同同',full),nativeEmphasisSignature('同同',split));
  assert.notEqual(nativeEmphasisSignature('同同',[mark('emphasis-dot',0,1,'同')]),nativeEmphasisSignature('同同',[mark('emphasis-dot',1,2,'同')]));
  assert.notEqual(nativeEmphasisSignature('甲',[mark('underline',0,1,'甲')]),nativeEmphasisSignature('甲',[mark('emphasis-dot',0,1,'甲')]));
  assert.throws(()=>nativeEmphasisSignature('甲',[mark('underline',0,1,'乙')]));
  assert.equal(nativeEmphasisSignature('甲 乙',[]),nativeEmphasisSignature('甲\u00a0乙',[]));
});

function comparisonFixture(){
  const text='甲同同𠮷乙';
  const marks=[mark('emphasis-dot',1,2,'同'),mark('underline',3,4,'𠮷')];
  const task={id:'synthetic-native-emphasis',target:{chapterLabel:'Synthetic topic',sectionLabel:'Synthetic training',record:1},source:{pages:[1],answerPages:[2]},stem:{blocks:[block(text,marks)]},answer:{blocks:[{type:'text',text:'答案'}]},review:{status:'approved',issues:[]}};
  // Independent persisted metadata and HTML fixture: never use expectedEditor
  // or the renderer to manufacture the actual readback under test.
  const readback={status:'found',bookId:100001,recordId:1001,target:{...task.target},source:{pages:[1],answerPages:[2]},stem:{text,html:'<p>甲<span style="text-emphasis-style:dot;text-emphasis-position:under right">同</span>同<u>𠮷</u>乙</p>',images:[],paragraphs:[{text,imageCount:0,align:'left',direction:'ltr',nativeEmphasis:{text,marks:[mark('emphasis-dot',1,2,'同'),mark('underline',3,4,'𠮷')]}}]},answer:{text:'答案',html:'<p>答案</p>',images:[],paragraphs:[{text:'答案',imageCount:0,align:'left',direction:'ltr',nativeEmphasis:{text:'答案',marks:[]}}]}};
  return {task,readback};
}

test('manifest supports explicit emphasis while rejecting silently ignored ad-hoc formatting fields', () => {
  const {task}=comparisonFixture();
  const manifest={schemaVersion:1,kind:'new-system-batch',bookId:100001,source:'fixture',tasks:[task]};
  assert.equal(validateNewSystemManifest(manifest).valid,true);
  task.stem.blocks=[{type:'text',runs:[{type:'text',text:'目标',underline:true}]}];
  assert.equal(validateNewSystemManifest(manifest).valid,false);
  task.stem.blocks=[{type:'text',text:'目标',underline:true}];
  assert.equal(validateNewSystemManifest(manifest).valid,false);
  assert.throws(()=>renderEditorHtml(task.stem));
});

test('readback verifies exact marked locations and rejects lost, moved, widened, added or malformed native marks', async t => {
  const good=comparisonFixture();
  assert.equal(compareNewSystemReadback(good.task,good.readback,{bookId:100001}).ok,true);
  const cases={
    'metadata absent': n=>undefined,
    'all marks stripped': n=>({...n,marks:[]}),
    'dot stripped': n=>({...n,marks:n.marks.filter(m=>m.type!=='emphasis-dot')}),
    'underline stripped': n=>({...n,marks:n.marks.filter(m=>m.type!=='underline')}),
    'dot moved to identical neighboring character': n=>({...n,marks:[mark('emphasis-dot',2,3,'同'),n.marks[1]]}),
    'dot widened': n=>({...n,marks:[mark('emphasis-dot',1,3,'同同'),n.marks[1]]}),
    'underline widened': n=>({...n,marks:[n.marks[0],mark('underline',3,5,'𠮷乙')]}),
    'unexpected underline': n=>({...n,marks:[...n.marks,mark('underline',0,1,'甲')]}),
    'kind changed': n=>({...n,marks:[mark('underline',1,2,'同'),n.marks[1]]}),
    'invalid native offset text': n=>({...n,marks:[mark('emphasis-dot',0,1,'同'),n.marks[1]]}),
    'unsupported emphasis': n=>({...n,marks:[mark('unsupported-emphasis',1,2,'同'),n.marks[1]]}),
  };
  for(const [name,mutate] of Object.entries(cases))await t.test(name,()=>{
    const {task,readback}=comparisonFixture();
    readback.stem.paragraphs[0].nativeEmphasis=mutate(readback.stem.paragraphs[0].nativeEmphasis);
    const result=compareNewSystemReadback(task,readback,{bookId:100001});
    assert.equal(result.ok,false); assert.match(result.errors.join(';'),/加点|下划线/u);
  });
});

test('unrequested native marks on a plain-text task reject even when all text matches', () => {
  const {task,readback}=comparisonFixture();
  delete task.stem.blocks[0].emphasis;
  const result=compareNewSystemReadback(task,readback);
  assert.equal(result.ok,false); assert.match(result.errors.join(';'),/加点|下划线/u);
});
