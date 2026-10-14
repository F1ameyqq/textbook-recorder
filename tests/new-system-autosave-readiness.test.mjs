import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {readAppendAutosaveSnapshot,waitForAppendAutosaveReady} from '../src/append-autosave-readiness.mjs';
import {checkedPointerClick} from '../src/checked-pointer-click.mjs';
import {requireRecorderDocumentReady} from '../src/browser-document-state.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const html={stem:'<p>完整合成题干</p>',answer:'<p>完整合成答案</p>'};

// The real public UI sets its dirty flag/model in delayed onchange, whereas
// editorBlur only saves a dirty, nonempty model. This fixture executes that
// event order without a browser, framework mutation or platform request.
function delayedApplication(){
  const state={bookId:101,nodeID:501,index:1,mainPicNum:3,answerPicNum:9,question:'',answer:'',focus:false};
  const events=[],saves=[];
  const onChange=()=>{state.question=html.stem;state.answer=html.answer;state.focus=true;events.push('model-change');};
  const save=()=>{if(!state.question){events.push('save-empty-return');return;}saves.push({question:state.question,answer:state.answer});events.push('save');};
  const blur=()=>{events.push('blur');if(state.focus){save();state.focus=false;}};
  return {state,events,saves,onChange,save,blur};
}

test('DOM completion before delayed application onchange reproduces zero autosaves from an early blur',async()=>{
  const f=delayedApplication();f.events.push('dom-ready');f.blur();
  assert.equal(f.saves.length,0);await delay(5);f.onChange();
  assert.equal(f.state.question,html.stem);assert.equal(f.state.focus,true);assert.equal(f.saves.length,0);
  assert.deepEqual(f.events,['dom-ready','blur','model-change']);
});

test('focusing the save button can double-submit a fresh draft; no-focus activation submits once',()=>{
  const unsafe=delayedApplication();unsafe.onChange();unsafe.blur();unsafe.save();assert.equal(unsafe.saves.length,2);
  const safe=delayedApplication();safe.onChange();safe.save();assert.equal(safe.saves.length,1);
  assert.equal(safe.events.includes('blur'),false);
});

// A small inert DOM parser is sufficient for these authored HTML cases. It is
// used only by the real browser callback; no readiness result is mocked.
function parsedElement(tagName='DIV'){
  const node={nodeType:1,tagName:tagName.toUpperCase(),childNodes:[],attributes:[],style:{},getAttribute(name){return this.attributes.find(a=>a.name===name)?.value??null;}};
  Object.defineProperty(node,'children',{get(){return this.childNodes.filter(child=>child.nodeType===1);}});
  Object.defineProperty(node,'textContent',{get(){return this.childNodes.map(child=>child.textContent??child.nodeValue).join('');}});
  Object.defineProperty(node,'innerHTML',{set(source){
    this.childNodes=[];const stack=[this];
    for(const token of source.match(/<[^>]+>|[^<]+/gu)??[]){
      if(token.startsWith('</')){stack.pop();continue;}
      if(token.startsWith('<')){
        const [,tag,raw]=/^<([a-z][\w-]*)([\s\S]*?)\/?\s*>$/iu.exec(token)??[];
        if(!tag)throw new Error('Unsupported fixture markup');
        const child=parsedElement(tag);
        for(const match of raw.matchAll(/([\w-]+)\s*=\s*["']([^"']*)["']/gu)){
          const name=match[1],value=match[2];child.attributes.push({name,value});
          if(name==='style')for(const item of value.split(';')){const at=item.indexOf(':');if(at>0){const key=item.slice(0,at).trim().replace(/-([a-z])/gu,(_,c)=>c.toUpperCase());child.style[key]=item.slice(at+1).trim();}}
        }
        stack.at(-1).childNodes.push(child);if(!['br','img','input'].includes(tag.toLowerCase()))stack.push(child);
      }else stack.at(-1).childNodes.push({nodeType:3,nodeValue:token.replaceAll('&nbsp;','\u00a0').replaceAll('&amp;','&'),get textContent(){return this.nodeValue;}});
    }
    if(stack.length!==1)throw new Error('Unclosed fixture markup');
  }});return node;
}

function browserFixture(){
  const app=delayedApplication(),trace=[],listeners=new Map();let document;
  class HTMLElement {
    constructor(id,tagName='DIV',innerHTML=''){Object.assign(this,{id,tagName,innerHTML,isConnected:true,style:{},children:[],attributes:[]});}
    get textContent(){return this.innerHTML.replace(/<[^>]*>/gu,'');}
    get innerText(){return this.textContent;}
    get isContentEditable(){return this===stem||this===answer;}
    contains(node){return node===this||this.children.includes(node);}
    getBoundingClientRect(){return {x:20,y:20,width:500,height:80};}
    scrollIntoView(){trace.push('scroll');}
    focus(){trace.push('focus:'+this.id);if(document.activeElement===stem||document.activeElement===answer)app.blur();document.activeElement=this;}
    click(){trace.push('click:'+this.id);const event={target:this,isTrusted:false,clientX:270,clientY:60};for(const fn of listeners.get('click')??[])fn(event);if(this===button)app.save();}
    dispatchEvent(){throw new Error('Fabricated events forbidden');}
    querySelector(selector){return this.querySelectorAll(selector)[0]??null;}
    querySelectorAll(selector){if(selector.includes('.w-e-text'))return this===stemRef.$el?[stem]:this===answerRef.$el?[answer]:[];return [];}
    getAttribute(name){return name==='id'?this.id:null;}
    matches(selector){return selector==='button.top-btn'&&this===button;}
    closest(selector){return selector==='#contentedit'&&(this===stem||this===contentWrapper)?contentWrapper:selector==='#answeredit'&&(this===answer||this===answerWrapper)?answerWrapper:null;}
  }
  const stem=new HTMLElement('stem','DIV',html.stem),answer=new HTMLElement('answer','DIV',html.answer),button=new HTMLElement('save','BUTTON','保存');
  const contentWrapper=new HTMLElement('contentedit'),answerWrapper=new HTMLElement('answeredit'),root=new HTMLElement('app');
  contentWrapper.children=[stem];answerWrapper.children=[answer];root.children=[contentWrapper,answerWrapper,button];
  const input=[Object.assign(new HTMLElement('source-question','INPUT'),{value:'3'}),Object.assign(new HTMLElement('source-answer','INPUT'),{value:'9'})];
  const model={textbookID:101,currentDirectoryNode:{data:{id:501}},checkedShitiInfo:{index:1,nodeID:501,question:'',answer:'',text:'新增',questionStr:'新增'},docContentPicCurrent:2,docAnswerPicCurrent:8,lastSeqIndex:1,shitiList:[{shitiID:101,seqIndex:1,nodeID:501},{nodeID:501,text:'新增',questionStr:'新增'}]};
  const stemRef={_uid:2,$el:contentWrapper,editor:{$textElem:{elems:[stem]},isFocus:true}},answerRef={_uid:3,$el:answerWrapper,editor:{$textElem:{elems:[answer]},isFocus:false}};
  const component={_uid:1,$el:root,$refs:{contentedit:stemRef,answeredit:answerRef},$children:[stemRef,answerRef],$parent:null};
  for(const key of Object.keys(model))Object.defineProperty(component,key,{get:()=>model[key],set:()=>{throw new Error('Framework mutation forbidden: '+key);}});
  Object.defineProperty(component,'focus',{get:()=>app.state.focus,set:()=>{throw new Error('Framework dirty mutation forbidden');}});
  stemRef.$parent=component;answerRef.$parent=component;contentWrapper.__vue__=stemRef;answerWrapper.__vue__=answerRef;root.__vue__=component;
  stem.parentElement=contentWrapper;answer.parentElement=answerWrapper;button.parentElement=root;contentWrapper.parentElement=root;answerWrapper.parentElement=root;
  const modelChange=()=>{app.onChange();model.checkedShitiInfo.question=html.stem;model.checkedShitiInfo.answer=html.answer;trace.push('model-ready');};
  document={activeElement:stem,visibilityState:'hidden',readyState:'complete',prerendering:false,documentElement:root,body:root,hasFocus:()=>false,
    querySelector:selector=>selector==='#app'?root:selector.includes('contentedit')?selector.includes('.w-e-text')?stem:contentWrapper:selector.includes('answeredit')?selector.includes('.w-e-text')?answer:answerWrapper:selector.includes('.top-btn')||selector.includes('button')?button:null,
    querySelectorAll:selector=>selector.includes('input.el-input__inner')?input:selector==='*'?[root,contentWrapper,stem,answerWrapper,answer,button,...input]:selector.includes('contentedit')&&selector.includes('.w-e-text')?[stem]:selector.includes('answeredit')&&selector.includes('.w-e-text')?[answer]:selector.includes('.w-e-text')?[stem,answer]:selector.includes('.top-btn')||selector.includes('button')?[button]:[],
    createElement:tag=>parsedElement(tag),
    addEventListener:(name,fn)=>{const list=listeners.get(name)??[];list.push(fn);listeners.set(name,list);},removeEventListener:(name,fn)=>listeners.set(name,(listeners.get(name)??[]).filter(other=>other!==fn))};
  const location={href:'https://easylearn.baidu.com/edu-shop-web/#/content-manager/teaching-content?textbookID=101'},performance={timeOrigin:1000000};
  const globals={document,location,performance,HTMLElement,innerWidth:1200,innerHeight:900,getComputedStyle:()=>({display:'block',visibility:'visible',borderLeftWidth:'0',borderTopWidth:'0'})};globals.window=globals;document.elementFromPoint=()=>button;
  const run=(fn,arg,element)=>vm.runInNewContext(element?'('+fn.toString()+')(__element,__arg)':'('+fn.toString()+')(__arg)',{...globals,__arg:arg,__element:element});
  const browser=new EventEmitter();browser.isConnected=()=>true;browser.__textbookRecorderWindowBridge={manage:async()=>({tabId:1,windowId:3,windowState:'minimized'})};
  const context=new EventEmitter();context.browser=()=>browser;context.newCDPSession=async()=>{throw new Error('Target.attachToBrowserTarget: Not allowed');};
  const page=new EventEmitter();page.context=()=>context;page.isClosed=()=>false;page.url=()=>location.href;page.evaluate=async(fn,arg)=>run(fn,arg);page.bringToFront=async()=>{throw new Error('Foreground activation forbidden');};
  const locator=element=>({page:()=>page,count:async()=>1,isVisible:async()=>true,isEnabled:async()=>true,evaluate:async(fn,arg)=>run(fn,arg,element),filter:()=>locator(element)});
  page.locator=selector=>locator(selector.includes('contentedit')?stem:selector.includes('answeredit')?answer:button);
  page.waitForFunction=async(fn,arg,{timeout=1000}={})=>{const started=Date.now();while(!run(fn,arg)){if(Date.now()-started>=timeout)throw new Error('fixture wait timeout');await delay(2);}};
  const guard=async()=>{trace.push('guard');};
  return {app,trace,page,browser,model,component,stemRef,answerRef,stem,answer,button,input,document,location,performance,modelChange,guard,run};
}

const task={id:'q-synthetic-2',target:{record:2},source:{pages:[3],answerPages:[9]}};
const expected={bookId:101,nodeID:501,record:2,mainPicNum:3,answerPicNum:9,stemHtml:html.stem,answerHtml:html.answer,priorRecordIds:[101]};
const snapshot=f=>f.run(readAppendAutosaveSnapshot,expected);
function adapterFor(f){return {page:f.page,bookId:101,_nodeID:501,focusMode:'background',windowMode:'minimized',_pendingWrite:{priorRecords:[{shitiID:101}],observedSaveRequests:0,receipt:null},guard:f.guard,
  _requireDocumentFocus:()=>requireRecorderDocumentReady(f.page,{focusMode:'background',windowMode:'minimized',guard:f.guard})};}
function readiness(f,{onSleep=()=>{},timeoutMs=40,...options}={}){
  let clock=0;
  return waitForAppendAutosaveReady(adapterFor(f),task,{stemHtml:html.stem,answerHtml:html.answer,timeoutMs,pollMs:10,now:()=>clock,sleep:async ms=>{clock+=ms;await onSleep(clock);},...options});
}

test('real snapshot identifies DOM-ready but dirty/model-not-ready state without mutating app or focus',()=>{
  const f=browserFixture(),result=snapshot(f);
  assert.equal(result.ready,false);assert.equal(result.fatal.length,0);
  assert.equal(result.differences.length,3);assert.equal(f.app.state.focus,false);
  assert.equal(f.document.activeElement,f.stem);assert.deepEqual(f.trace,[]);assert.equal(f.app.saves.length,0);
});

test('polling waits for delayed onchange before exactly one no-focus Save activation',async()=>{
  const f=browserFixture();
  const proof=await readiness(f,{onSleep:()=>f.modelChange()});
  assert.equal(proof.kind,'new-system-append-model-ready');assert.equal(proof.attempts,2);
  assert.equal(f.app.saves.length,0);assert.equal(f.document.activeElement,f.stem);
  const click=await checkedPointerClick(f.page,f.page.locator('button.top-btn'),{guard:f.guard,focusMode:'background',windowMode:'minimized',preserveEditorFocus:true,timeout:3000});
  assert.equal(f.app.saves.length,1);assert.equal(f.app.events.includes('blur'),false);
  assert.equal(f.trace.filter(item=>item.startsWith('focus:')).length,0);
  assert.equal(f.trace.filter(item=>item==='click:save').length,1);assert.equal(click.editorFocus.preserved,true);
  assert.equal(click.editorFocus.blurEvents.length,0);assert.equal(f.document.activeElement,f.stem);
  assert.equal(click.activationMethod,'HTMLElement.click/preserve-editor-focus');
});

for(const [name,mutate] of [
  ['book',f=>f.model.textbookID=102],['directory',f=>f.model.currentDirectoryNode.data.id=502],
  ['draft node',f=>f.model.checkedShitiInfo.nodeID=502],['draft index',f=>f.model.checkedShitiInfo.index=2],
  ['missing draft index',f=>delete f.model.checkedShitiInfo.index],['saved id',f=>f.model.checkedShitiInfo.shitiID=999],
  ['saved sequence',f=>f.model.checkedShitiInfo.seqIndex=2],['source question',f=>f.model.docContentPicCurrent=3],
  ['source answer',f=>f.model.docAnswerPicCurrent=9],['not-new draft',f=>f.model.checkedShitiInfo.text='旧题'],
  ['prior ids',f=>f.model.shitiList[0].shitiID=999],['saved final row',f=>f.model.shitiList[1].shitiID=999],
  ['prior sequence',f=>f.model.shitiList[0].seqIndex=2],
  ['extra row',f=>f.model.shitiList.push({})],['crossed editor refs',f=>f.answerRef.editor.$textElem.elems=[f.stem]],
  ['ambiguous vm',f=>f.component.$children.push({...f.component,_uid:99,$children:[]})],
  ['editor focus',f=>f.document.activeElement=f.answer],['missing vm identity',f=>delete f.component._uid],
])test('model readiness rejects '+name+' and sends no Save',async()=>{
  const f=browserFixture();f.modelChange();mutate(f);
  await assert.rejects(readiness(f),/binding failed/u);assert.equal(f.app.saves.length,0);
  assert.equal(f.trace.some(item=>item.startsWith('click:')||item.startsWith('focus:')),false);
});

test('edited DOM or model full text stays blocked until the deadline',async()=>{
  for(const side of ['DOM','model']){
    const f=browserFixture();f.modelChange();if(side==='DOM')f.stem.innerHTML='<p>另一道完整题</p>';else f.model.checkedShitiInfo.answer='<p>另一完整答案</p>';
    const error=await readiness(f).then(()=>null,error=>error);assert.match(error.message,/deadline/u);
    assert.equal(error.appendModelReadiness.lastSnapshot.ready,false);assert.equal(f.app.saves.length,0);
  }
});

test('dirty=false with full DOM/model never proves save readiness',async()=>{
  const f=browserFixture();f.modelChange();f.app.state.focus=false;
  await assert.rejects(readiness(f),/deadline/u);assert.equal(f.app.saves.length,0);
});

test('polling rejects a changed app instance even when the next model is ready',async()=>{
  const f=browserFixture();await assert.rejects(readiness(f,{onSleep:()=>{f.component._uid++;f.modelChange();}}),/instance changed/u);assert.equal(f.app.saves.length,0);
});

test('polling rejects a reload or changed window before accepting delayed readiness',async()=>{
  for(const change of [f=>f.performance.timeOrigin++,f=>f.browser.__textbookRecorderWindowBridge.manage=async()=>({tabId:1,windowId:4,windowState:'minimized'})]){
    const f=browserFixture();await assert.rejects(readiness(f,{onSleep:()=>{change(f);f.modelChange();}}),/document changed|window changed/u);assert.equal(f.app.saves.length,0);
  }
});

test('scope guard failure prevents readiness and no Save is attempted',async()=>{
  const f=browserFixture();const adapter=adapterFor(f);adapter.guard=async()=>{throw new Error('book guard refused');};
  await assert.rejects(waitForAppendAutosaveReady(adapter,task,{stemHtml:html.stem,answerHtml:html.answer,timeoutMs:100}),/book guard refused/u);assert.equal(f.app.saves.length,0);
});

test('readiness has a real bounded timeout for a hung page snapshot',async()=>{
  const f=browserFixture();f.page.evaluate=()=>new Promise(()=>{});
  const started=Date.now();await assert.rejects(waitForAppendAutosaveReady(adapterFor(f),task,{stemHtml:html.stem,answerHtml:html.answer,timeoutMs:25}),/deadline/u);
  assert.ok(Date.now()-started<1000);assert.equal(f.app.saves.length,0);
});

test('wrong input mode, invalid polling bound or missing authored field cannot qualify',async()=>{
  const f=browserFixture();for(const mutate of [adapter=>adapter.focusMode='foreground',adapter=>adapter.windowMode='normal']){
    const adapter=adapterFor(f);mutate(adapter);await assert.rejects(waitForAppendAutosaveReady(adapter,task,{stemHtml:html.stem,answerHtml:html.answer}),/restricted/u);
  }
  for(const options of [{pollMs:0},{timeoutMs:60001},{stemHtml:''}])await assert.rejects(readiness(f,options),/Invalid/u);
});

test('actual focused button path demonstrates two submits while preserve-editor-focus path uses one',async()=>{
  const f=browserFixture();f.modelChange();
  const click=await checkedPointerClick(f.page,f.page.locator('button.top-btn'),{guard:f.guard,focusMode:'background',windowMode:'minimized',timeout:3000});
  assert.equal(f.app.saves.length,2);assert.equal(f.app.events.filter(item=>item==='blur').length,1);
  assert.equal(click.activationMethod,'HTMLElement.focus/click');
});

test('no-focus activation refuses a non-Save button or lost owned editor focus before click',async()=>{
  for(const change of [f=>f.button.innerHTML='别的操作',f=>f.document.activeElement=f.answer]){
    const f=browserFixture();f.modelChange();change(f);
    await assert.rejects(checkedPointerClick(f.page,f.page.locator('button.top-btn'),{guard:f.guard,focusMode:'background',windowMode:'minimized',preserveEditorFocus:true,timeout:3000}),/real Save button|active owned/u);
    assert.equal(f.app.saves.length,0);assert.equal(f.trace.some(item=>item.startsWith('click:')||item.startsWith('focus:')),false);
  }
});

test('a prior Save request, receipt or changed pending intent during polling prohibits the UI trigger',async()=>{
  for(const change of [adapter=>adapter._pendingWrite.observedSaveRequests++,adapter=>adapter._pendingWrite.receipt={shitiID:999},adapter=>adapter._pendingWrite={...adapter._pendingWrite}]){
    const f=browserFixture(),adapter=adapterFor(f);let clock=0;
    await assert.rejects(waitForAppendAutosaveReady(adapter,task,{stemHtml:html.stem,answerHtml:html.answer,timeoutMs:40,pollMs:10,now:()=>clock,sleep:async ms=>{clock+=ms;change(adapter);f.modelChange();}}),/earlier save|changed intention/u);
    assert.equal(f.app.saves.length,0);assert.equal(f.trace.some(item=>item.startsWith('click:')),false);
  }
});

test('readiness compares authored emphasis, script, image identity and paragraph layout',()=>{
  for(const [reviewed,changed] of [
    ['<p><strong>重</strong>点</p>','<p>重点</p>'],
    ['<p>x<sub>2</sub></p>','<p>x<sup>2</sup></p>'],
    ['<p><span style="text-emphasis-style:dot;text-emphasis-position:under">字</span></p>','<p>字</p>'],
    ['<p><img src="fixture-a.png" data-source="a"></p>','<p><img src="fixture-b.png" data-source="a"></p>'],
    ['<p style="text-align:center">文字</p>','<p style="text-align:left">文字</p>'],
  ]){
    const f=browserFixture();f.modelChange();f.stem.innerHTML=changed;f.model.checkedShitiInfo.question=changed;
    const state=f.run(readAppendAutosaveSnapshot,{...expected,stemHtml:reviewed});
    assert.equal(state.ready,false);assert.ok(state.differences.includes('stem DOM does not match every reviewed field'));assert.equal(f.app.saves.length,0);
  }
});

test('non-authored highlight/span and left/start layout differences do not block identical authored content',()=>{
  const f=browserFixture();f.modelChange();f.stem.innerHTML='<p style="text-align:start"><span style="background-color:yellow">完整合成题干</span></p>';
  f.model.checkedShitiInfo.question='<p style="text-align:left">完整合成题干</p>';
  assert.equal(snapshot(f).ready,true);assert.equal(f.app.saves.length,0);
});

test('readiness preserves distinct wavy and solid underline when the application model catches up',()=>{
  const reviewed='<p>甲<u style="text-decoration-style:wavy">乙<sup>①</sup>丙</u><u>丁</u><span style="text-emphasis-style:dot;text-emphasis-position:under">戊</span>。</p>';
  const f=browserFixture();f.modelChange();f.stem.innerHTML=reviewed;f.model.checkedShitiInfo.question=reviewed;
  const state=f.run(readAppendAutosaveSnapshot,{...expected,stemHtml:reviewed});
  assert.equal(state.ready,true);assert.equal(state.fatal.length,0);assert.equal(f.app.saves.length,0);
});

test('readiness rejects a wavy-to-solid loss in either the DOM or application model',()=>{
  const wave='<p><u style="text-decoration-style:wavy">甲乙丙</u>。</p>',solid='<p><u>甲乙丙</u>。</p>';
  for(const [reviewed,dom,model] of [[wave,solid,solid],[wave,wave,solid],[solid,wave,wave],[solid,solid,wave]]){
    const f=browserFixture();f.modelChange();f.stem.innerHTML=dom;f.model.checkedShitiInfo.question=model;
    const state=f.run(readAppendAutosaveSnapshot,{...expected,stemHtml:reviewed});
    assert.equal(state.ready,false);assert.ok(state.differences.length>0);assert.equal(f.app.saves.length,0);
  }
});

test('readiness rejects unknown or conflicting authored underline styles before Save',()=>{
  for(const changed of ['<p><u style="text-decoration-style:dotted">甲</u></p>','<p><u style="text-decoration-style:wavy"><u>甲</u></u></p>']){
    const f=browserFixture();f.modelChange();f.stem.innerHTML=changed;f.model.checkedShitiInfo.question=changed;
    const state=f.run(readAppendAutosaveSnapshot,{...expected,stemHtml:changed});
    assert.equal(state.ready,false);assert.equal(state.fatal.length,1);assert.match(state.fatal[0],/underline style/);assert.equal(f.app.saves.length,0);
  }
});

test('no-focus trigger propagates the final pre-Save rejection without activating the button',async()=>{
  const f=browserFixture();f.modelChange();let assertions=0;
  await assert.rejects(checkedPointerClick(f.page,f.page.locator('button.top-btn'),{guard:f.guard,focusMode:'background',windowMode:'minimized',preserveEditorFocus:true,timeout:3000,beforeInput:async()=>{assertions++;f.stem.innerHTML='<p>外部变化</p>';throw new Error('full draft recheck refused');}}),/full draft recheck refused/u);
  assert.equal(assertions,1);assert.equal(f.app.saves.length,0);assert.equal(f.trace.some(item=>item.startsWith('click:')||item.startsWith('focus:')),false);
});

test('if a Save handler changes editor focus the helper stops after that one click without retrying',async()=>{
  const f=browserFixture();f.modelChange();const originalSave=f.app.save;
  f.app.save=()=>{originalSave();f.document.activeElement=f.answer;};
  await assert.rejects(checkedPointerClick(f.page,f.page.locator('button.top-btn'),{guard:f.guard,focusMode:'background',windowMode:'minimized',preserveEditorFocus:true,timeout:3000}),/changed owned editor focus/u);
  assert.equal(f.app.saves.length,1);assert.equal(f.trace.filter(item=>item==='click:save').length,1);assert.equal(f.trace.some(item=>item.startsWith('focus:')),false);
});
