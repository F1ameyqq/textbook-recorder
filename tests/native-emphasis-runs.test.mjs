import test from 'node:test';
import assert from 'node:assert/strict';
import {assertNativeEmphasis,nativeEmphasisText,renderNativeEmphasis,nativeEmphasisSignature} from '../src/native-emphasis.mjs';

const mark=(type,start,end,text)=>({type,start,end,text});
const spec=marks=>({schemaVersion:1,indexUnit:'unicode-code-points',marks});
const run=(type,text)=>({type,text});
const block=(runs,marks)=>({type:'text',runs,emphasis:spec(marks)});
const dot=text=>`<span style="text-emphasis-style:dot;text-emphasis-position:under right;-webkit-text-emphasis-style:dot;-webkit-text-emphasis-position:under right">${text}</span>`;

test('run emphasis offsets count the entire final paragraph, indentation and script characters in Unicode code points',()=>{
  const value=block([run('text','  甲𠮷'),run('sup','①'),run('text','乙'),run('sub','₂'),run('text','尾')],
    [mark('underline',3,7,'𠮷①乙₂'),mark('emphasis-dot',4,5,'①')]);
  const original=structuredClone(value);
  assert.equal(nativeEmphasisText(value),'  甲𠮷①乙₂尾');
  assert.deepEqual(assertNativeEmphasis(value),value.emphasis.marks);
  assert.equal(renderNativeEmphasis(value),`  甲<u>𠮷</u><sup>${dot('<u>①</u>')}</sup><u>乙</u><sub><u>₂</u></sub>尾`);
  assert.deepEqual(value,original);
});

test('one paragraph retains four separate superscript annotations and crossing underline/dot ranges',()=>{
  const value=block([run('text','   甲'),run('sup','①'),run('text','乙'),run('sup','②'),run('text','丙'),run('sup','③'),run('text','丁'),run('sup','④'),run('text','尾')],
    [mark('underline',3,11,'甲①乙②丙③丁④'),mark('emphasis-dot',4,7,'①乙②')]);
  const html=renderNativeEmphasis(value);
  assert.equal(html,`   <u>甲</u><sup>${dot('<u>①</u>')}</sup>${dot('<u>乙</u>')}<sup>${dot('<u>②</u>')}</sup><u>丙</u><sup><u>③</u></sup><u>丁</u><sup><u>④</u></sup>尾`);
  assert.deepEqual([...html.matchAll(/<sup>(.*?)<\/sup>/gu)].map(match=>match[1].replace(/<[^>]+>/gu,'')),['①','②','③','④']);
  assert.doesNotMatch(html,/<\/?p\b/u);
});

test('mark boundaries within a multi-character sup/sub keep a single outer script per run',()=>{
  const value=block([run('text','前'),run('sup','①②③'),run('sub','xy'),run('text','后')],
    [mark('underline',2,5,'②③x'),mark('emphasis-dot',3,4,'③')]);
  const html=renderNativeEmphasis(value);
  assert.equal(html,`前<sup>①<u>②</u>${dot('<u>③</u>')}</sup><sub><u>x</u>y</sub>后`);
  assert.equal((html.match(/<sup>/gu)??[]).length,1);
  assert.equal((html.match(/<sub>/gu)??[]).length,1);
});

test('strict spacing, LF, Unicode and HTML escaping remain exact inside runs and marks',()=>{
  const value={...block([run('text','  甲\n<&'),run('sup','①'),run('text','  乙')],
    [mark('underline',4,7,'<&①')]),strictSpacing:true};
  assert.equal(nativeEmphasisText(value),'  甲\n<&①  乙');
  assert.equal(renderNativeEmphasis(value),'&nbsp;&nbsp;甲<br><u>&lt;&amp;</u><sup><u>①</u></sup>&nbsp;&nbsp;乙');
  assert.doesNotMatch(renderNativeEmphasis(value),/<&/u);
});

test('adjacent run text and split same-kind mark fragments preserve the per-character emphasis signature',()=>{
  const text='甲①乙₂尾';
  const full=[mark('underline',0,4,'甲①乙₂')];
  const split=[mark('underline',0,1,'甲'),mark('underline',1,2,'①'),mark('underline',2,3,'乙'),mark('underline',3,4,'₂')];
  assert.equal(nativeEmphasisSignature(text,full),nativeEmphasisSignature(text,split));
  const value=block([run('text','甲'),run('sup','①'),run('text','乙'),run('sub','₂'),run('text','尾')],full);
  assert.equal(renderNativeEmphasis(value),'<u>甲</u><sup><u>①</u></sup><u>乙</u><sub><u>₂</u></sub>尾');
});

test('malformed runs and mutually exclusive representations reject before rendering',async t=>{
  const valid=()=>block([run('text','甲'),run('sup','①'),run('text','乙')],[mark('underline',0,3,'甲①乙')]);
  const cases={
    'text together with runs':b=>{b.text='甲①乙';},
    'parts together with runs':b=>{b.parts=['甲','乙'];},
    'nontext paragraph':b=>{b.type='sup';},
    'runs is not array':b=>{b.runs={type:'text',text:'甲'};},
    'empty runs':b=>{b.runs=[];},
    'nonobject run':b=>{b.runs[0]='甲';},
    'array run':b=>{b.runs[0]=['text','甲'];},
    'unknown run type':b=>{b.runs[1].type='image';},
    'unknown run field':b=>{b.runs[1].emphasis='underline';},
    'missing run type':b=>{delete b.runs[1].type;},
    'missing run text':b=>{delete b.runs[1].text;},
    'empty run text':b=>{b.runs[1].text='';},
    'whitespace-only run':b=>{b.runs[1].text='  ';},
    'unpaired high surrogate':b=>{b.runs[1].text='\ud800';},
    'unpaired low surrogate':b=>{b.runs[1].text='\udc00';},
    'CR in run':b=>{b.runs[1].text='①\r';},
    'CRLF in run':b=>{b.runs[1].text='①\r\n';},
  };
  for(const [name,change]of Object.entries(cases))await t.test(name,()=>{
    const value=valid();change(value);
    assert.throws(()=>nativeEmphasisText(value));assert.throws(()=>assertNativeEmphasis(value));assert.throws(()=>renderNativeEmphasis(value));
  });
});

test('a run boundary cannot split a grapheme even when every run is independently well-formed Unicode',async t=>{
  for(const [name,runs]of [
    ['combining mark',[run('text','e'),run('sup','\u0301甲')]],
    ['emoji ZWJ',[run('text','👩'),run('sup','‍💻甲')]],
    ['regional indicators',[run('text','🇨'),run('sub','🇳甲')]],
    ['variation selector',[run('text','字'),run('sup','\u{E0100}甲')]],
  ])await t.test(name,()=>{
    const value={type:'text',runs};
    assert.throws(()=>nativeEmphasisText(value),/grapheme|完整字符/u);
    assert.throws(()=>assertNativeEmphasis(value),/grapheme|完整字符/u);
    assert.throws(()=>renderNativeEmphasis(value),/grapheme|完整字符/u);
  });
  const value=block([run('text','e\u0301'),run('sup','👩‍💻'),run('sub','🇨🇳'),run('text','字\u{E0100}')],
    [mark('underline',2,5,'👩‍💻')]);
  assert.equal(nativeEmphasisText(value),'e\u0301👩‍💻🇨🇳字\u{E0100}');
  assert.equal(renderNativeEmphasis(value),'e\u0301<sup><u>👩‍💻</u></sup><sub>🇨🇳</sub>字\u{E0100}');
});

test('run declarations keep stale ranges, same-kind overlaps, blank ranges and cross-LF marks rejected',async t=>{
  const cases=[
    ['script omitted from final marked text',[run('text','甲'),run('sup','①'),run('text','乙')],[mark('underline',0,2,'甲乙')]],
    ['UTF-16 range',[run('text','𠮷'),run('sup','①')],[mark('underline',0,2,'𠮷')]],
    ['same-kind overlap',[run('text','甲'),run('sup','①'),run('text','乙')],[mark('underline',0,2,'甲①'),mark('underline',1,3,'①乙')]],
    ['blank marked text',[run('text','甲 乙'),run('sup','①')],[mark('underline',1,2,' ')]],
    ['cross LF',[run('text','甲\n'),run('sup','①')],[mark('underline',0,3,'甲\n①')]],
    ['split grapheme',[run('text','e\u0301'),run('sup','①')],[mark('emphasis-dot',0,1,'e')]],
  ];
  for(const [name,runs,marks]of cases)await t.test(name,()=>{
    const value=block(runs,marks);assert.throws(()=>assertNativeEmphasis(value));assert.throws(()=>renderNativeEmphasis(value));
  });
});

test('plain text rendering and no-emphasis behavior remain unchanged while valid plain runs retain scripts',()=>{
  const value={type:'text',text:'甲𠮷乙&<>\n末',emphasis:spec([mark('emphasis-dot',0,2,'甲𠮷'),mark('underline',1,3,'𠮷乙')])};
  assert.equal(nativeEmphasisText(value),value.text);
  assert.equal(renderNativeEmphasis(value),`${dot('甲')}${dot('<u>𠮷</u>')}<u>乙</u>&amp;&lt;&gt;<br>末`);
  assert.deepEqual(assertNativeEmphasis({type:'text',text:'普通文本'}),[]);
  const unmarked={type:'text',runs:[run('text','前'),run('sup','①'),run('sub','xy'),run('text','后')]};
  assert.deepEqual(assertNativeEmphasis(unmarked),[]);
  assert.equal(renderNativeEmphasis(unmarked),'前<sup>①</sup><sub>xy</sub>后');
});
