import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {NativeAnalysisCorrectionAdapter} from '../src/native-analysis-correction-adapter.mjs';

function fixture({activate=true,guardRejects=false,covered=false,visibilityState='hidden',hasFocus=true,
  loseFocusOnPointerCheck=false,focusMode,windowMode}={}) {
  const events=[],protocol=[];
  let clicks=0,focused=hasFocus,windowState=windowMode??'normal',activationPending=false;
  const clickListeners=new Set();
  class HTMLElement {
    isConnected=true;
    contains(){return true;}
    focus(){}
    getBoundingClientRect(){return {x:10,y:10,width:100,height:20};}
    click(){clicks++;events.push('control-activation');for(const listener of clickListeners)listener({isTrusted:false,target:this,clientX:0,clientY:0});}
  }
  const element=new HTMLElement();
  const document={visibilityState,hasFocus:()=>focused,readyState:'complete',documentElement:{},body:{},
    elementFromPoint:()=>element,addEventListener:(name,listener)=>{assert.equal(name,'click');clickListeners.add(listener);},removeEventListener:(name,listener)=>clickListeners.delete(listener)};
  const environment=vm.createContext({document,window:{},location:{href:'https://example.test/book'},performance:{timeOrigin:100},__element:element,HTMLElement,getComputedStyle:()=>({display:'block',visibility:'visible'})});
  const evaluate=(fn,arg)=>vm.runInContext('('+fn.toString()+')',environment)(arg);
  const session={send:async(method,params={})=>{
    protocol.push({method,params});
    if(method==='Browser.getWindowForTarget')return {windowId:17,bounds:{windowState}};
    if(method==='Browser.getWindowBounds')return {bounds:{windowState}};
    if(method==='Browser.setWindowBounds'){
      assert.equal(params.windowId,17);
      assert.ok(['normal','minimized'].includes(params.bounds?.windowState));
      windowState=params.bounds.windowState;
      events.push(windowState==='normal'?'restore-window':'minimize-window');
      return {};
    }
    if(method==='Emulation.setFocusEmulationEnabled')return {};
    if(method==='Input.synthesizeTapGesture'){await page.mouse.click(params.x,params.y);return {};}
    throw new Error('Unexpected mock CDP method: '+method);
  },detach:async()=>{events.push('cdp-detach');}};
  const context={newCDPSession:async suppliedPage=>{assert.equal(suppliedPage,page);events.push('cdp-session');return session;}};
  const page={context:()=>context,on(){},isClosed:()=>false,evaluate:async(fn,arg)=>evaluate(fn,arg),
    mouse:{click:async(x,y)=>{clicks++;events.push('pointer-click');for(const listener of clickListeners)listener({isTrusted:true,target:element,clientX:x,clientY:y});}},
    bringToFront:async()=>{
      events.push('bringToFront');
      if(activate&&document.visibilityState==='hidden'&&!activationPending){
        activationPending=true;
        setTimeout(()=>{document.visibilityState='visible';events.push('became-visible');},20);
      }
    },
    waitForFunction:async(fn,arg,{timeout,polling})=>{
      events.push('visibility-wait');assert.equal(polling,80);const deadline=Date.now()+timeout;
      for(;;){
        if(evaluate(fn,arg)){events.push('visibility-confirmed');return;}
        if(Date.now()>=deadline)throw new Error('real visibility wait timed out');
        await new Promise(resolve=>setTimeout(resolve,5));
      }
    },
  };
  const locator={page:()=>page,count:async()=>1,isVisible:async()=>true,isEnabled:async()=>true,evaluate:async (fn,arg)=>{
    if(fn.toString().includes('addEventListener')||fn.toString().includes('Background activation')) {environment.__arg=arg;return vm.runInContext('('+fn.toString()+')(__element,__arg)',environment);}
    if(fn.toString().includes('scrollIntoView')){events.push('scroll');return;}
    events.push('pointer-check');
    const state={connected:true,rect:{x:10,y:10,width:100,height:20},point:{x:60,y:20},position:{x:50,y:10},visibleDocument:document.visibilityState==='visible',inViewport:true,hitTarget:!covered};
    if(loseFocusOnPointerCheck){focused=false;events.push('lost-document-focus');}
    return state;
  },click:async()=>{
    assert.equal(document.visibilityState,'visible');assert.equal(document.hasFocus(),true);
    clicks++;events.push('pointer-click');
  }};
  const adapter=new NativeAnalysisCorrectionAdapter({page,source:'fixture',inputMode:'browser-command',timeout:150,
    ...(focusMode===undefined?{}:{focusMode}),...(windowMode===undefined?{}:{windowMode})});
  adapter.guard=async()=>{events.push('guard');if(guardRejects)throw new Error('wrong guarded book');};
  return {adapter,locator,events,protocol,get clicks(){return clicks;},get windowState(){return windowState;}};
}

function assertNoBackgroundActivation(f) {
  assert.ok(!f.events.includes('bringToFront'),'background clicks must never activate the page');
  assert.ok(!f.events.includes('restore-window'),'background clicks must never restore the window');
  assert.ok(!f.events.includes('visibility-wait'),'background clicks must not wait for a foreground fallback');
}

test('a delayed real visibility confirmation is awaited before inherited pointer actionability checks',async()=>{
  const f=fixture();f.adapter.timeout=1000;const result=await f.adapter._click(f.locator);
  assert.equal(result.clicked,true);assert.equal(f.clicks,1);
  assert.ok(f.events.indexOf('became-visible')<f.events.indexOf('visibility-confirmed'));
  assert.ok(f.events.indexOf('visibility-confirmed')<f.events.indexOf('pointer-check'));
  assert.equal(f.events.filter(event=>event==='bringToFront').length,2,'base activation is preserved after the child wait');
});

test('activation that remains hidden fails without sending a pointer click',async()=>{
  const f=fixture({activate:false});await assert.rejects(f.adapter._click(f.locator),/visibility wait timed out/u);
  assert.equal(f.clicks,0);assert.ok(!f.events.includes('pointer-check'));
});

test('wrong book guard and obstructed target still fail closed after the focus correction',async t=>{
  for(const [name,options,pattern] of [['wrong-book',{guardRejects:true},/wrong guarded book/u],['covered-target',{covered:true},/covered/u]])await t.test(name,async()=>{
    const f=fixture(options);await assert.rejects(f.adapter._click(f.locator),pattern);assert.equal(f.clicks,0);
    if(name==='wrong-book')assert.ok(!f.events.includes('bringToFront'));
  });
});

test('background native correction binds its visible window regardless of OS document focus without activation or restore',async t=>{
  for(const windowMode of ['normal','minimized'])for(const hasFocus of [true,false])await t.test(`${windowMode}/document-focus-${hasFocus}`,async()=>{
    const f=fixture({focusMode:'background',windowMode,visibilityState:'visible',hasFocus});f.adapter.timeout=2000;
    const result=await f.adapter._click(f.locator);
    assert.equal(result.clicked,true);assert.equal(f.clicks,1);assert.equal(f.windowState,windowMode);
    assert.equal(result.documentCheck.windowId,17);assert.equal(result.documentCheck.hasFocus,hasFocus);
    assert.equal(result.documentCheck.minimized,windowMode==='minimized');
    assert.ok(f.protocol.some(call=>call.method==='Browser.getWindowForTarget'),'background click still needs the actual owned window');
    assertNoBackgroundActivation(f);
  });
});

test('background native correction refuses hidden, covered and wrong-book targets without a click or foreground fallback',async t=>{
  for(const [name,options,pattern] of [
    ['hidden',{visibilityState:'hidden'},/hidden|隐藏|不可见|visibility/iu],
    ['covered',{covered:true},/covered|遮挡/iu],
    ['wrong-book',{guardRejects:true},/wrong guarded book/u],
  ])await t.test(name,async()=>{
    const f=fixture({focusMode:'background',windowMode:'normal',visibilityState:'visible',...options});
    await assert.rejects(f.adapter._click(f.locator),pattern);
    assert.equal(f.clicks,0);assert.equal(f.windowState,'normal');assertNoBackgroundActivation(f);
  });
});

test('background native correction retains its window binding when OS document focus is lost during pointer sampling',async()=>{
  const f=fixture({focusMode:'background',windowMode:'normal',visibilityState:'visible',loseFocusOnPointerCheck:true});
  f.adapter.timeout=2000;
  const result=await f.adapter._click(f.locator);
  assert.equal(result.clicked,true);assert.equal(result.documentCheck.hasFocus,false);assert.equal(result.documentCheck.windowId,17);
  assert.ok(f.events.includes('lost-document-focus'));assert.equal(f.clicks,1);
  assert.equal(f.windowState,'normal');assertNoBackgroundActivation(f);
});

test('foreground editor preflight still rejects missing document focus before editor input',async()=>{
  const f=fixture({focusMode:'foreground',windowMode:'normal',visibilityState:'visible',hasFocus:false});
  await assert.rejects(f.adapter._requireDocumentFocus('editor input preflight'),/focus|焦点/iu);
  assert.equal(f.clicks,0);assert.ok(!f.events.includes('pointer-check'));
});

test('minimized correction uses verified window identity even when its document is hidden and unfocused',async()=>{
  const f=fixture({focusMode:'background',windowMode:'minimized',visibilityState:'hidden',hasFocus:false});f.adapter.timeout=1000;
  const result=await f.adapter._click(f.locator);assert.equal(result.nativeClick.trusted,false);assert.equal(result.activationMethod,'HTMLElement.focus/click');assert.equal(result.documentCheck.minimized,true);assert.equal(f.clicks,1);assertNoBackgroundActivation(f);
});
