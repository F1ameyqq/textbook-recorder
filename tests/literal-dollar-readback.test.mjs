import test from 'node:test';
import assert from 'node:assert/strict';
import {expectedEditor,renderEditorHtml,compareNewSystemReadback} from '../src/new-system-core.mjs';

function fixture(){
  const task={id:'synthetic-currency',target:{chapterLabel:'C',sectionLabel:'S',record:1},
    source:{pages:[1],answerPages:[2]},stem:{blocks:[{type:'text',text:'Prices $2 and $1.5; family $5.',strictSpacing:true}]},
    answer:{blocks:[{type:'text',text:'A'}]},review:{status:'approved',issues:[]}};
  const editor=side=>({...expectedEditor(task[side]),html:renderEditorHtml(task[side]),formulas:[]});
  return {task,readback:{status:'found',bookId:1,recordId:1,target:{...task.target},source:task.source,stem:editor('stem'),answer:editor('answer')}};
}

test('ordinary manifests reject additional native formulas even when ordinary text is unchanged',()=>{
  for(const side of ['stem','answer'])for(const evidence of ['list','math-tex','class','unquoted-class','encoded-class','quoted-angle','quoted-fake-class','reader-count']){
    const {task,readback}=fixture();
    assert.equal(compareNewSystemReadback(task,readback,{bookId:1}).ok,true);
    if(evidence==='list')readback[side].formulas=[{latex:'unwanted'}];
    else if(evidence==='reader-count')readback[side].literalDollarSafety={count:side==='stem'?3:0,unsafeCount:0,formulaCount:1};
    else readback[side].html+=evidence==='math-tex'?'<math-tex>$unwanted$</math-tex>':
      evidence==='class'?'<span class="formula-node" data-latex="unwanted"></span>':
      evidence==='unquoted-class'?'<span class=formula-node data-latex=unwanted></span>':
      evidence==='quoted-angle'?'<span title=">" class="formula-node"></span>':
      evidence==='quoted-fake-class'?`<span title=' class="ordinary"' class="formula-node"></span>`:
      '<span class="formula&#x2d;node" data-latex="unwanted"></span>';
    const result=compareNewSystemReadback(task,readback,{bookId:1});
    assert.equal(result.ok,false,`${side}: ${evidence}`);
    assert.match(result.errors.join('; '),/公式/u);
  }
});

test('quoted attribute values cannot masquerade as formula classes',()=>{
  const {task,readback}=fixture();
  readback.stem.html+=`<span title=' class="formula-node"' class="ordinary"></span>`;
  readback.stem.literalDollarSafety={count:3,unsafeCount:0,formulaCount:0};
  assert.equal(compareNewSystemReadback(task,readback,{bookId:1}).ok,true);
});

test('literal-dollar readback rejects unsafe parent pairing and missing dollars',()=>{
  for(const evidence of [{count:3,unsafeCount:3},{count:2,unsafeCount:0},{count:3,unsafeCount:-1}]){
    const {task,readback}=fixture();readback.stem.literalDollarSafety=evidence;
    const result=compareNewSystemReadback(task,readback,{bookId:1});
    assert.equal(result.ok,false);assert.match(result.errors.join('; '),/\$|货币/u);
  }
  const {task,readback}=fixture();readback.stem.literalDollarSafety={count:3,unsafeCount:0};
  assert.equal(compareNewSystemReadback(task,readback,{bookId:1}).ok,true);
});
