import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {installPersistentBridge,readRecorderWindowPreparationSnapshot} from '../src/persistent-recorder-bridge.mjs';

const bookId=101;
const bookUrl='https://easylearn.baidu.com/edu-shop-web/#/content-manager/teaching-content?textbookID=101&textbookType=main';
const receipt={tabId:10,windowId:40,windowState:'normal',bookTabActive:true,helperTabActive:false,windowFocused:false,created:true,documentTimeOrigin:1000};
function dom(){
  const editor=()=>({textContent:'',innerText:'',querySelectorAll:()=>[{tagName:'P'},{tagName:'BR'}]});
  const stem=editor(),answer=editor(),component={textbookID:bookId,focus:false,$children:[],$refs:{
    contentedit:{editor:{$textElem:{elems:[stem]}}},answeredit:{editor:{$textElem:{elems:[answer]}}}}};
  const root={$children:[component]};
  const document={querySelectorAll:selector=>selector.startsWith('#contentedit')?[stem]:[answer],querySelector:selector=>selector==='#app'?{__vue__:root}:null,
    createElement:()=>{let html='';return {set innerHTML(value){html=value;},get textContent(){return html.replace(/<[^>]*>/gu,'');},querySelectorAll(){return [...html.matchAll(/<([a-z]+)([^>]*)>/giu)].map(match=>({tagName:match[1].toUpperCase(),attributes:match[2].replace(/\/$/u,'').trim()?[{}]:[]}));}};}};
  return {stem,answer,component,root,document,read(){return vm.runInNewContext(`(${readRecorderWindowPreparationSnapshot.toString()})(bookId)`,{document,bookId});}};
}
test('normal-window blank proof reads the exact editor owner without invoking app methods',()=>{
  const f=dom();f.component.saveQuestion=()=>assert.fail('No app save method may run');
  assert.equal(f.read().confirmedEmpty,true);
  assert.equal(f.component.focus,false);assert.equal(f.stem.textContent,'');
});
function initialEmpty(f){Object.assign(f.component,{focus:true,currentDirectoryNode:{},shitiList:[],selectedQuestionID:-1,lastSeqIndex:0,checkedShitiInfo:{question:'<p><br></p>',answer:'<p><br></p>'}});return f;}
test('initial empty onchange flag is accepted only with the untouched unselected model',()=>{
  const f=initialEmpty(dom()),before=structuredClone({focus:f.component.focus,model:f.component.checkedShitiInfo});
  const proof=f.read();assert.equal(proof.confirmedEmpty,true);assert.equal(proof.initialEmptyModel,true);assert.equal(proof.reason,'initial-empty-model');
  assert.deepEqual({focus:f.component.focus,model:f.component.checkedShitiInfo},before);
});
for(const [name,change] of [
  ['selected directory',f=>f.component.currentDirectoryNode={data:{id:501}}],
  ['selected index zero',f=>f.component.checkedShitiInfo.index=0],['saved record identity',f=>f.component.checkedShitiInfo.shitiID=12],
  ['sequence identity',f=>f.component.checkedShitiInfo.seqIndex=1],['source field',f=>f.component.checkedShitiInfo.mainPicNum=1],
  ['record list',f=>f.component.shitiList=[{shitiID:12}]],['selected record',f=>f.component.selectedQuestionID=0],
  ['prior sequence',f=>f.component.lastSeqIndex=1],['model text',f=>f.component.checkedShitiInfo.question='<p>unsaved</p>'],
  ['empty HTML attributes',f=>f.component.checkedShitiInfo.answer='<p style="color:red"><br></p>'],
  ['image-only model',f=>f.component.checkedShitiInfo.answer='<p><img></p>'],['unknown model field',f=>f.component.checkedShitiInfo.other=''],
  ['nonempty live editor',f=>f.stem.textContent='unsaved'],
])test('initial focus flag exception refuses '+name,()=>{
  const f=initialEmpty(dom());change(f);const proof=f.read();assert.equal(proof.confirmedEmpty,false);
  assert.equal(JSON.stringify(proof).includes('unsaved'),false);assert.equal(JSON.stringify(proof).includes('color:red'),false);
});
for(const [name,change] of [
  ['stem input',f=>f.stem.textContent='unsaved'],['answer input',f=>f.answer.innerText='unsaved'],
  ['image/formula content',f=>f.stem.querySelectorAll=()=>[{tagName:'IMG'}]],
  ['dirty model',f=>f.component.focus=true],['wrong book',f=>f.component.textbookID=102],
  ['wrong editor owner',f=>f.component.$refs.answeredit.editor.$textElem.elems=[{}]],
  ['duplicate editor',f=>f.document.querySelectorAll=()=>[f.stem,f.answer]],
  ['duplicate app owner',f=>f.root.$children.push({...f.component})],
  ['missing app owner',f=>f.root.$children=[]],
])test('window preparation preserves '+name,()=>{const f=dom();change(f);assert.equal(f.read().confirmedEmpty,false);});

async function fixture(t,{windowBridgePresent=true}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'recorder-normal-window-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const events=[];let options;
  const trap=label=>()=>{events.push(label);assert.fail('Normal background must not call '+label);};
  const browser=windowBridgePresent?{__textbookRecorderWindowBridge:{prepareNormalWindow:trap('prepareNormalWindow'),manage:trap('windowMutation')}}:{};
  const page={url:()=>bookUrl,context:()=>({browser:()=>browser}),bringToFront:trap('bringToFront'),evaluate:trap('draftPreparationRead')};
  const bridge=await installPersistentBridge({page,config:{root,bookId,focusMode:'background',windowMode:'normal'},adapterFactory:value=>{
    options=value;events.push('adapter');return {connect:async()=>events.push('connect'),read:async()=>events.push('readonly-directory'),_directoryRecords:[]};
  }});
  bridge.start({id:'normal-probe',action:'probe',args:{chapterLabel:'Synthetic chapter',sectionLabel:'Synthetic section'}});
  for(let n=0;n<1000&&!bridge.status().job.terminal;n++)await new Promise(resolve=>setTimeout(resolve,2));
  const status=bridge.status();assert.equal(status.job.terminal,true);
  return {root,events,status,options};
}
for(const windowBridgePresent of [true,false])test('normal background probe needs no window preparation or activation; bridge present='+windowBridgePresent,async t=>{
  const f=await fixture(t,{windowBridgePresent});assert.equal(f.status.job.error,undefined);
  assert.deepEqual(f.events,['adapter','connect','readonly-directory']);
  assert.equal(f.options.focusMode,'background');assert.equal(f.options.windowMode,'normal');assert.equal(f.options.inputMode,'browser-command');
  assert.equal(f.status.normalWindowPreparation,undefined);assert.equal(f.status.job.normalWindowPreparation,undefined);
  assert.equal(f.status.job.result.writePerformed,false);
  const saved=JSON.parse(await fs.readFile(path.join(f.root,'data/persistent-executor/jobs/normal-probe/job-result.json'),'utf8'));
  assert.equal(saved.normalWindowPreparation,undefined);assert.equal(saved.result.writePerformed,false);
});
