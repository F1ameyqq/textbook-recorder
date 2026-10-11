import test from 'node:test';
import assert from 'node:assert/strict';
import { NewSystemAdapter } from '../src/new-system-adapter.mjs';

const bookUrl='https://easylearn.baidu.com/edu-shop-web/#/content-manager/teaching-content?textbookID=100001&textbookType=main';
const target={chapterLabel:'第十四章 内能的利用',sectionLabel:'第3节 热机的效率',record:1,expectedRecordId:1001};
const task={target,source:{pages:[29],answerPages:[244]}};
const record={seqIndex:1,shitiID:1001,nodeID:900320,question:'<p>原题干</p>',answer:'<p>原答案</p>',mainPicNum:29,answerPicNum:244,haveAnswer:true};

// Pure page fixture: reload and an unselected page hide editors. Only selecting
// the exact section can reveal them. Calling editor wait prematurely fails.
function reloadFixture({showEditorsOnSelection=true,initialSelected=false}={}) {
  const events=[],listeners=new Map();
  let selected=initialSelected,editorsVisible=initialSelected,url=bookUrl,responseWait;
  const request={url:()=> 'https://easylearn.baidu.com/edushop/textbook/detail/shitilist?textbookID=100001&nodeID=900320'};
  const response={request:()=>request,url:request.url,ok:()=>true,json:async()=>({errno:0,errmsg:'success',data:[record]})};
  const chapter={
    first(){return this;},count:async()=>1,
    waitFor:async()=>{events.push('chapter-visible');},
    evaluateAll:async()=>{events.push('chapter-visible');return {count:1,visible:true};},
    locator:selector=>{assert.equal(selector,'xpath=..');return chapterNode;},
    click:async()=>{events.push('expand-chapter');},
  };
  const section={
    first(){return this;},count:async()=>1,
    waitFor:async()=>{events.push('section-visible');},
    evaluateAll:async()=>{events.push('section-visible');return {count:1,visible:true};},
    click:async()=>{
      if(selected){events.push('reclick-selected-section-with-no-request');return;}
      events.push('select-section'); selected=true; editorsVisible=showEditorsOnSelection;
      for(const listener of listeners.get('request')??[]) listener(request);
      assert.ok(listeners.get('response')?.length,'directory must install a response observer before clicking');
      for(const listener of listeners.get('response')??[])listener(response);
    },
  };
  const chapterNode={evaluate:async()=>true,locator:selector=>{assert.equal(selector,'.el-tree-node__content');return {filter:({hasText})=>{assert.ok(hasText.test(target.sectionLabel));return section;}};}};
  const page={
    context:()=>({}),isClosed:()=>false,url:()=>url,
    bringToFront:async()=>{},
    on:(event,listener)=>{if(!listeners.has(event))listeners.set(event,[]);listeners.get(event).push(listener);},
    off:(event,listener)=>listeners.set(event,(listeners.get(event)??[]).filter(value=>value!==listener)),
    reload:async()=>{events.push('reload');selected=false;editorsVisible=false;},
    locator:selector=>{
      if(selector==='.el-tree-node__content')return {filter:({hasText})=>{assert.ok(hasText.test(target.chapterLabel));return chapter;}};
      assert.ok(['#contentedit .w-e-text','#answeredit .w-e-text'].includes(selector));
      return {evaluateAll:async()=>{events.push('editor-wait:'+selector);if(!editorsVisible)throw new Error('Editor is hidden until a section is selected');return {count:1,visible:true};},waitFor:async({state})=>{assert.equal(state,'visible');events.push('editor-wait:'+selector);if(!editorsVisible)throw new Error('Editor is hidden until a section is selected');}};
    },
    evaluate:async()=>selected?{chapterLabel:target.chapterLabel,sectionLabel:target.sectionLabel}:{chapterLabel:'',sectionLabel:''},
    waitForResponse:predicate=>new Promise(resolve=>{responseWait={predicate,resolve};}),
  };
  const adapter=new NewSystemAdapter({page,inputMode:'browser-command'});adapter.bookId=100001;
  // This double tests directory request/scope ordering. Native pointer safety
  // is independently exercised with real Edge in checked-pointer-click.test.
  adapter._click=async locator=>{await adapter.guard({waitForEditors:false});await locator.click();};
  adapter._stableList=async records=>{assert.ok(selected);assert.deepEqual(records.map(item=>item.seqIndex),[1]);events.push('list-stable');};
  adapter._selectRecord=async found=>{assert.ok(selected&&editorsVisible);assert.equal(found.shitiID,1001);events.push('select-record');};
  adapter._editorRead=async selector=>{assert.ok(editorsVisible);return {html:selector.startsWith('#contentedit')?record.question:record.answer,images:[]};};
  return {adapter,events,changeBook:()=>{url=bookUrl.replace('100001','146005');}};
}

test('fresh read from an unselected page reloads then selects the target directory before waiting for editors',async()=>{
  const {adapter,events}=reloadFixture();
  const result=await adapter.read(task,{refresh:true});
  assert.equal(result.status,'found');assert.equal(result.recordId,1001);assert.equal(result.count,1);
  assert.equal(result.bookId,100001);assert.equal(result.stem.html,record.question);assert.equal(result.answer.html,record.answer);
  assert.equal(events[0],'reload');
  const selectedAt=events.indexOf('select-section');
  assert.ok(selectedAt>events.indexOf('chapter-visible'));
  assert.ok(events.findIndex(event=>event.startsWith('editor-wait:'))>selectedAt);
  assert.ok(events.indexOf('select-record')>events.findIndex(event=>event.startsWith('editor-wait:')));
});

test('default write guard and editing preflight still reject hidden editors without changing directory',async()=>{
  const {adapter,events}=reloadFixture();
  await assert.rejects(adapter.guard(),/hidden/);
  await assert.rejects(adapter._clipboardPreflight('<p>reviewed content</p>'),/hidden/);
  assert.equal(events.includes('select-section'),false);
  await assert.rejects(adapter.guard({waitForEditors:'false'}),/布尔值/);
});

test('URL-only refresh guard rejects a different book before reload or any directory action',async()=>{
  const {adapter,events,changeBook}=reloadFixture();changeBook();
  await assert.rejects(adapter.read(task,{refresh:true}),/书 ID/);
  assert.deepEqual(events,[]);
});

test('directory selection still requires visible editors before readback succeeds',async()=>{
  const {adapter,events}=reloadFixture({showEditorsOnSelection:false});
  await assert.rejects(adapter.read(task,{refresh:true}),/hidden/);
  assert.ok(events.includes('select-section'));
  assert.equal(events.includes('select-record'),false);
});

test('an already selected section with no authoritative cache reloads before requesting LIST',async()=>{
  const {adapter,events}=reloadFixture({initialSelected:true});
  const result=await adapter.read(task);
  assert.equal(result.recordId,1001);
  assert.equal(events[0],'reload');
  assert.equal(events.includes('reclick-selected-section-with-no-request'),false);
  assert.equal(events.filter(event=>event==='select-section').length,1);
});
