import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {NewSystemAdapter} from './new-system-adapter.mjs';
import {renderEditorHtml,compareNewSystemReadback,verifyNewSystemSave} from './new-system-core.mjs';
import {ANALYSIS_SEPARATOR} from './analysis-separator.mjs';

const SAVE_PATH='/edushop/textbook/myproducecommit/editshiti';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const sha=value=>createHash('sha256').update(value).digest('hex');
const positive=value=>Number.isSafeInteger(Number(value))&&Number(value)>0;
const assert=(condition,message)=>{if(!condition)throw new Error(message);};
function parseRequest(request){let body;try{body=request.postDataJSON();}catch{}if(!body||typeof body!=='object'||Array.isArray(body)){const text=request.postData();try{body=JSON.parse(text);}catch{body=Object.fromEntries(new URLSearchParams(text));}}assert(body&&typeof body==='object'&&!Array.isArray(body),'保存请求正文无效');return body;}
const identity=body=>({bookId:Number(body.textbookID),seqIndex:Number(body.seqIndex),shitiID:Number(body.shitiID),mainPicNum:Number(body.mainPicNum),answerPicNum:Number(body.answerPicNum)});

/** Detached parsing only: validates actual native request HTML, never edits DOM. */
async function sameHtml(page,actual,expected,{strictSpacing=false}={}) {
  if(typeof actual!=='string'||!actual.trim())return false;
  return page.evaluate(({actual,expected,strictSpacing,nativeSeparatorSrc})=>{
    const text=value=>strictSpacing?value.replace(/\u00a0/gu,' ').replace(/[\r\n\t]/gu,'').trim():value.replace(/[\s\u200b]+/gu,'');
    const signature=html=>{
      const root=document.createElement('div');root.innerHTML=html;
      if(root.querySelector('script,iframe,object,embed,canvas,video,audio,svg')||[...root.querySelectorAll('*')].some(node=>[...node.attributes].some(attribute=>/^on/iu.test(attribute.name))))throw new Error('保存正文含未审可执行或复杂元素');
      const paragraphs=[...root.children].filter(node=>node.textContent.replace(/[\s\u200b]+/gu,'')||node.querySelector('img'));
      return paragraphs.map(node=>{
        if(node.tagName!=='P')throw new Error('保存正文必须保持独立段落');
        const align=node.style.textAlign||node.getAttribute('align')||'left';
        const direction=node.style.direction||node.getAttribute('dir')||'ltr';
        const scripts=[...node.querySelectorAll('sup,sub')].map(child=>[child.tagName,text(child.textContent)]);
        const images=[...node.querySelectorAll('img')].map(image=>{
          const src=image.getAttribute('src'),width=image.style.width||null;
          // The native menu uses 100%; the platform's save serializer uses
          // 500px. This read-only comparison accepts those two representations
          // of the fixed marker. Fresh core readback still requires saved 500px.
          return {src,display:image.style.display||null,width:src===nativeSeparatorSrc&&['100%','500px'].includes(width)?'native-marker-width':width};
        });
        return {text:text(node.textContent),align:['left','start'].includes(align)?'left':align,direction,scripts,images};
      });
    };
    return JSON.stringify(signature(actual))===JSON.stringify(signature(expected));
  },{actual,expected,strictSpacing,nativeSeparatorSrc:ANALYSIS_SEPARATOR.src});
}

function finalEditorMatches({selector,html}) {
  const actual=document.querySelector(selector),expected=document.createElement('div');expected.innerHTML=html;if(!actual)return false;
  const useful=element=>[...element.children].filter(child=>child.textContent.trim()||child.querySelector('img')),got=useful(actual),want=useful(expected),normalize=value=>value.replace(/[\s\u200b]+/gu,'');
  return got.length===want.length&&got.every((paragraph,i)=>{const images=[...paragraph.querySelectorAll('img')],wanted=[...want[i].querySelectorAll('img')];return normalize(paragraph.textContent)===normalize(want[i].textContent)&&images.length===wanted.length&&images.every((image,j)=>image.src===wanted[j].src&&image.complete&&image.naturalWidth>0&&image.naturalHeight>0);});
}

async function insertNativeMarker(adapter,answer,index) {
  const selector='#answeredit .w-e-text',editor=adapter.page.locator(selector);
  await editor.evaluate((element,index)=>{
    const paragraph=element.children[index];
    if(!paragraph||paragraph.tagName!=='P'||paragraph.textContent.trim()||paragraph.querySelector('img,svg,math-tex,.formula-node'))throw new Error('解析插入位置必须是已审空占位段落');
    element.focus();const range=document.createRange();range.selectNodeContents(paragraph);range.collapse(true);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
  },index);
  await adapter.page.keyboard.press('Shift');
  await editor.evaluate((element,index)=>{
    const selection=window.getSelection(),paragraph=element.children[index];
    if(document.activeElement!==element||!selection?.isCollapsed||selection.rangeCount!==1||!paragraph.contains(selection.anchorNode)||!paragraph.contains(selection.focusNode))throw new Error('原生解析按钮的光标位置不正确');
  },index);
  await adapter._click(adapter.page.locator('#answeredit .w-e-menu').filter({hasText:/^\s*添加解析\s*$/u}));
  await adapter.page.waitForFunction(finalEditorMatches,{selector,html:renderEditorHtml(answer,adapter.baseDir)},{timeout:adapter.timeout,polling:80});
  return {analysisButtonClicks:1};
}

/** Existing-answer correction with every native autosave response accounted for. */
export class NativeAnalysisCorrectionAdapter extends NewSystemAdapter {
  async _click(locator) {
    await this.guard({waitForEditors:false});
    await this._activate();
    // CDP activation can resolve before the reloaded tab's visibility event.
    // Wait on real browser state using timers; never spoof it or weaken the
    // inherited pointer checks if activation does not make the page visible.
    if(this.focusMode==='foreground')await this.page.waitForFunction(()=>document.visibilityState==='visible',null,{timeout:this.timeout,polling:80});
    return super._click(locator);
  }

  async replaceAnswer(task,{expectedBefore,checkpoint=async()=>{},markerOnly=false}={}) {
    if(this._busy||this._uncertain||this._pendingWrite?.status==='pending')throw new Error('上次写入未完成核对，拒绝修改');
    const expectedID=task?.target?.expectedRecordId;
    assert(positive(expectedID)&&JSON.stringify(task.target)===JSON.stringify(expectedBefore?.target)&&task.review?.status==='approved'&&expectedBefore?.review?.status==='approved'&&isDeepStrictEqual(task.stem,expectedBefore.stem)&&isDeepStrictEqual(task.source,expectedBefore.source),'答案修正必须绑定原题ID、已审前后内容及相同目录、题干、来源');
    const markers=task.answer?.blocks?.flatMap((block,index)=>block.type==='analysis-separator'?[index]:[])??[];
    assert(markers.length===1,'原生解析修正必须恰好有一个已审分隔标记');
    assert(typeof markerOnly==='boolean','markerOnly必须是明确布尔值');
    const projection={...structuredClone(task.answer),blocks:task.answer.blocks.filter(block=>block.type!=='analysis-separator').map(block=>structuredClone(block))};
    if(markerOnly)assert(isDeepStrictEqual(expectedBefore.answer,projection),'markerOnly前置答案必须严格等于已审最终答案去掉唯一marker的投影');
    const maxSaveRequests=markerOnly?2:3;
    this._busy=true;let edited=false,phase='existing-answer-readback',fatal=null,queue=Promise.resolve(),lastActivity=Date.now(),refreshStarted=false;
    const observed=[],byRequest=new Map(),saveCycleEvents=[];let listening=false;
    const captureFailure=error=>{fatal??=error;};
    const enqueue=operation=>{queue=queue.then(operation).catch(captureFailure);};
    const drain=async()=>{for(;;){const current=queue;await current;if(queue===current)break;}if(fatal)throw fatal;};
    const summary=row=>({index:row.index,phase:row.phase,at:row.at,request:row.request??null,answerState:row.answerState??null,responseAt:row.responseAt??null,status:row.status,receipt:row.receipt??null});
    const cycleEvent=async(kind,row,extra={})=>{const event={kind,at:new Date().toISOString(),observation:summary(row),saveRequests:observed.length,...extra};saveCycleEvents.push(structuredClone(event));await checkpoint({phase:'save-cycle-event',event});};
    let before,priorRecords,count,nodeID,html,intermediateHtml,cursor;
    const requestMatches=request=>{try{const url=new URL(request.url());return request.method()==='POST'&&url.origin===this.origin&&url.pathname===SAVE_PATH&&(this._requests.get(request)??0)>cursor;}catch{return false;}};
    const onRequest=request=>{
      if(!requestMatches(request))return;
      lastActivity=Date.now();const row={index:observed.length+1,phase,at:new Date().toISOString(),status:'pending'};observed.push(row);byRequest.set(request,row);
      enqueue(async()=>{
        const raw=parseRequest(request);row.request={...identity(raw),nodeID:Number(raw.nodeID),questionSha256:typeof raw.question==='string'?sha(raw.question):null,answerSha256:typeof raw.answer==='string'?sha(raw.answer):null,payloadSha256:sha(JSON.stringify(raw))};
        await cycleEvent('request-observed',row);
        assert(!refreshStarted,'刷新核对期间又出现保存请求，保留未知结果');
        assert(observed.length<=maxSaveRequests,'原生解析修正观察到超过绑定上限的自动保存');
        for(const [name,wanted] of [['bookId',this.bookId],['seqIndex',task.target.record],['shitiID',Number(expectedID)],['mainPicNum',task.source.pages[0]],['answerPicNum',task.source.answerPages[0]]])assert(positive(row.request[name])&&row.request[name]===wanted,'自动保存请求身份或来源不符: '+name);
        assert(Number(raw.nodeID)===nodeID&&positive(raw.nodeID),'自动保存请求目录不符');
        assert(typeof raw.question==='string'&&typeof raw.answer==='string','自动保存请求缺少question/answer全文');
        assert(await sameHtml(this.page,raw.question,renderEditorHtml(task.stem,this.baseDir),{strictSpacing:task.stem.blocks.some(block=>block.parts!==undefined)}),'自动保存改变了本题题干');
        const final=await sameHtml(this.page,raw.answer,html,{strictSpacing:task.answer.blocks.some(block=>block.parts!==undefined)});
        const intermediate=!final&&await sameHtml(this.page,raw.answer,intermediateHtml,{strictSpacing:task.answer.blocks.some(block=>block.parts!==undefined)});
        assert(final||intermediate,'自动保存答案不是已审最终态或唯一合法中间态');row.answerState=final?'final':'intermediate';
        if(row.answerState==='intermediate')assert(!observed.slice(0,row.index-1).some(other=>other.answerState==='final'),'最终答案之后不能保存中间态回退');
        assert(!observed.slice(0,row.index-1).some(other=>other.answerState&&other.answerState!==row.answerState&&other.status!=='responded'),'不同答案态的自动保存不得并发');
        row.status='awaiting-response';await cycleEvent('request-validated',row);
      });
    };
    const onResponse=response=>{
      const row=byRequest.get(response.request());if(!row)return;lastActivity=Date.now();row.responseAt=new Date().toISOString();
      enqueue(async()=>{
        assert(row.status==='awaiting-response'&&!row.receipt,'自动保存响应缺少已核对请求或重复');
        const body=await response.json();
        row.receipt={bookId:this.bookId,seqIndex:task.target.record,shitiID:Number(body?.data?.shitiID),mainPicNum:task.source.pages[0],answerPicNum:task.source.answerPages[0],request:identity(parseRequest(response.request())),response:{status:response.status(),body:{errno:body?.errno,errmsg:body?.errmsg,data:{seqIndex:Number(body?.data?.seqIndex),shitiID:Number(body?.data?.shitiID),haveAnswer:body?.data?.haveAnswer}}}};
        const verification=verifyNewSystemSave(task,row.receipt,{bookId:this.bookId,existingRecordId:Number(expectedID)});row.status=verification.ok?'responded':'invalid-response';
        await cycleEvent('response-observed',row,{verification});
        assert(verification.ok,'自动保存业务回执不符: '+verification.errors.join('; '));
      });
    };
    const onFailed=request=>{const row=byRequest.get(request);if(!row)return;lastActivity=Date.now();enqueue(async()=>{row.status='request-failed';await cycleEvent('request-failed',row);throw new Error('自动保存请求传输失败');});};
    const onClose=()=>captureFailure(new Error('自动保存核对期间页面关闭'));
    const onCrash=()=>captureFailure(new Error('自动保存核对期间页面崩溃'));
    const waitForAll=async(requiredState,{allowEmpty=false}={})=>{
      const deadline=Date.now()+this.timeout,quietMs=Math.min(500,Math.max(40,Math.floor(this.timeout/5)));
      for(;;){await drain();const all=(allowEmpty||observed.length>0)&&observed.every(row=>row.status==='responded'),stateMatches=requiredState===undefined||observed.at(-1)?.answerState===requiredState;if(all&&stateMatches&&Date.now()-lastActivity>=quietMs)return;if(Date.now()>=deadline)throw new Error('全部自动保存响应或'+(requiredState==='intermediate'?'已审中间态':'最终已审答案')+'回执未在限时内确认');await sleep(Math.min(40,Math.max(1,deadline-Date.now())));}
    };
    try {
      before=await this.read(expectedBefore,{refresh:true});const match=compareNewSystemReadback(expectedBefore,before,{baseDir:this.baseDir,bookId:this.bookId});assert(match.ok,'原记录与核对基线不符: '+match.errors.join('; '));
      priorRecords=structuredClone(this._directoryRecords);count=priorRecords.length;nodeID=this._nodeID;
      assert(positive(nodeID)&&priorRecords.filter(record=>record.seqIndex===task.target.record&&record.shitiID===Number(expectedID)).length===1,'原记录目录身份不唯一');
      html=renderEditorHtml(task.answer,this.baseDir);intermediateHtml=task.answer.blocks.map(block=>block.type==='analysis-separator'?'<p style="text-align:left;direction:ltr" dir="ltr" align="left"><br></p>':renderEditorHtml({blocks:[block]},this.baseDir)).join('');
      cursor=this._sequence;this.page.on('request',onRequest);this.page.on('response',onResponse);this.page.on('requestfailed',onFailed);this.page.on('close',onClose);this.page.on('crash',onCrash);listening=true;
      phase='answer-clipboard-preflight';await this._clipboardPreflight(html);await drain();assert(!observed.length,'预检时出现意外保存');
      await checkpoint({phase:'write-intent',bookId:this.bookId,recordId:Number(expectedID),record:task.target.record,mutation:'answer-only',markerOnly,priorRecords,allowedAnswerStates:['intermediate','final'],maxSaveRequests});await drain();assert(!observed.length,'编辑前出现意外保存');
      edited=true;this._uncertain=true;
      if(!markerOnly){
        phase='replace-reviewed-intermediate';await this._paste('#answeredit .w-e-text',intermediateHtml,{replace:true});await drain();
        phase='intermediate-answer-blur';await this._click(this.page.locator('input.el-input__inner').nth(0));
        phase='intermediate-business-receipts';await waitForAll('intermediate');
        const event={kind:'intermediate-stage-complete',at:new Date().toISOString(),saveRequests:observed.length};saveCycleEvents.push(structuredClone(event));await checkpoint({phase:'save-cycle-event',event});await drain();
      }
      phase='native-marker-insertion';const formatInput=await insertNativeMarker(this,task.answer,markers[0]);await drain();assert(formatInput.analysisButtonClicks===1,'必须真实点击一次原生添加解析');await checkpoint({phase:'answer-format-input',...formatInput,markerOnly});await drain();
      // A menu blur can issue another unchanged intermediate save. All such
      // responses must finish before an explicit final blur can dispatch final.
      phase='menu-save-cycle-settle';lastActivity=Date.now();await waitForAll(undefined,{allowEmpty:true});
      phase='pre-final-editor-confirmation';assert(await this.page.evaluate(finalEditorMatches,{selector:'#answeredit .w-e-text',html}),'中间响应后编辑器不再是已审解析最终态，禁止再保存或插入第二个marker');
      assert(observed.length<maxSaveRequests,'自动保存已达到绑定上限，禁止触发更多保存');
      phase='answer-final-blur';await this._click(this.page.locator('input.el-input__inner').nth(0));
      phase='all-save-business-receipts';await waitForAll('final');
      const final=observed.at(-1);assert(final.answerState==='final'&&final.status==='responded','最后自动保存不是已审最终态');
      await checkpoint({phase:'receipt',receipt:structuredClone(final.receipt),receipts:observed.map(row=>structuredClone(row.receipt)),saveCycleEvents:structuredClone(saveCycleEvents),observations:observed.map(summary),saveRequests:observed.length});await drain();
      phase='corrected-answer-reload';refreshStarted=true;const readback=await this.read(task,{refresh:true});await drain();
      const comparison=compareNewSystemReadback(task,readback,{baseDir:this.baseDir,bookId:this.bookId});
      assert(comparison.ok&&readback.count===count,'答案修正刷新核对失败: '+comparison.errors.join('; '));
      const withoutTargetAnswer=records=>records.map(record=>record.seqIndex===task.target.record?{...record,answer:null}:record);
      assert(isDeepStrictEqual(withoutTargetAnswer(priorRecords),withoutTargetAnswer(this._directoryRecords)),'答案修正改变了其他题目或本题题干、来源、身份');
      assert(observed.every(row=>row.status==='responded')&&observed.at(-1).answerState==='final','刷新之后仍有未确认的自动保存');
      await checkpoint({phase:'readback',readback,comparison,saveRequests:observed.length,preservedRecords:count});await drain();
      const receipt={...structuredClone(final.receipt),preservedRecords:count};this._uncertain=false;
      return {receipt,receipts:observed.map(row=>structuredClone(row.receipt)),saveCycleEvents:structuredClone(saveCycleEvents),observations:observed.map(summary),readback,comparison,saveRequests:observed.length,preservedRecords:count,plusClicks:0,markerOnly,...formatInput};
    }catch(error){if(edited||observed.length)this._uncertain=true;const wrapped=new Error(`[${phase}] ${error.message}`,{cause:error});wrapped.phase=phase;wrapped.observedSaveRequests=observed.length;wrapped.observations=observed.map(summary);wrapped.saveCycleEvents=structuredClone(saveCycleEvents);throw wrapped;}
    finally{if(listening){this.page.off('request',onRequest);this.page.off('response',onResponse);this.page.off('requestfailed',onFailed);this.page.off('close',onClose);this.page.off('crash',onCrash);}this._busy=false;}
  }
}
