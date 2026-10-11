import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {NativeAnalysisCorrectionAdapter} from './native-analysis-correction-adapter.mjs';
import {renderEditorHtml,compareNewSystemReadback,verifyNewSystemSave} from './new-system-core.mjs';
import {validateRecordRepairSnapshot} from './reviewed-record-repair-snapshot.mjs';

const SAVE_PATH='/edushop/textbook/myproducecommit/editshiti';
const assert=(value,message)=>{if(!value)throw new Error(message);};
const digest=value=>createHash('sha256').update(value).digest('hex');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function requestBody(request){try{return request.postDataJSON();}catch{return Object.fromEntries(new URLSearchParams(request.postData()));}}

// Parse detached HTML only. LF, NBSP, paragraph boundaries and spaces stay exact.
async function sameHtml(page,actual,expected){
  if(typeof actual!=='string'||typeof expected!=='string')return false;
  return page.evaluate(({actual,expected})=>{
    const signature=html=>{
      const root=document.createElement('div');root.innerHTML=html;
      if(root.querySelector('script,iframe,object,embed')||[...root.querySelectorAll('*')].some(n=>[...n.attributes].some(a=>/^on/i.test(a.name))))throw new Error('未审可执行内容');
      return [...root.children].filter(n=>n.textContent.trim()||n.querySelector('img')).map(n=>{
        if(n.tagName!=='P')throw new Error('修订必须保持段落结构');
        const clone=n.cloneNode(true);for(const br of clone.querySelectorAll('br'))br.replaceWith('\n');
        return {text:clone.textContent.replace(/\u00a0/g,' ').replace(/\r\n?/g,'\n'),images:[...n.querySelectorAll('img')].map(i=>i.getAttribute('src')),scripts:[...n.querySelectorAll('sup,sub')].map(i=>[i.tagName,i.textContent])};
      });
    };
    return JSON.stringify(signature(actual))===JSON.stringify(signature(expected));
  },{actual,expected});
}

/** Existing record replacement; preserves the IDs, source, directory and neighbours. */
export class ReviewedRecordCorrectionAdapter extends NativeAnalysisCorrectionAdapter {
  async replaceRecord(task,{expectedBefore,repairSnapshot,checkpoint=async()=>{}}={}){
    assert(!this._busy&&!this._uncertain&&!this._pendingWrite,'上次保存尚未核对，拒绝修订');
    const id=task.target.expectedRecordId;
    assert(Number.isSafeInteger(id)&&id>0&&isDeepStrictEqual(task.target,expectedBefore?.target)&&isDeepStrictEqual(task.source,expectedBefore?.source)&&task.id===expectedBefore?.id&&task.review.status==='approved'&&expectedBefore.review.status==='approved','修订需已审前后题单、相同原ID/目录/来源');
    if(repairSnapshot!==undefined)validateRecordRepairSnapshot(repairSnapshot,task,this.bookId);
    this._busy=true;
    let edited=false,phase='baseline',fatal=null,queue=Promise.resolve(),lastActivity=Date.now(),refreshing=false;
    const rows=[],byRequest=new Map();let baseline,nodeID,count,cursor,stemHtml,answerHtml,rank=0,sourceRank=0;
    const enqueue=operation=>{queue=queue.then(operation).catch(error=>{fatal??=error;});};
    const drain=async()=>{for(;;){const p=queue;await p;if(p===queue)break;}if(fatal)throw fatal;};
    const onRequest=request=>{
      let url;try{url=new URL(request.url());}catch{return;}
      if(request.method()!=='POST'||url.origin!==this.origin||url.pathname!==SAVE_PATH||(this._requests.get(request)??0)<=cursor)return;
      lastActivity=Date.now();const row={index:rows.length+1,phase,status:'pending',at:new Date().toISOString()};rows.push(row);byRequest.set(request,row);
      enqueue(async()=>{
        assert(!refreshing&&rows.length<=6,'修订刷新期间保存或超过绑定保存上限');
        const body=requestBody(request);assert(body&&typeof body==='object','保存正文无效');
        for(const [key,wanted] of [['textbookID',this.bookId],['nodeID',nodeID],['seqIndex',task.target.record],['shitiID',id]])assert(Number(body[key])===wanted,'保存身份或来源改变: '+key);
        const mainPicNum=Number(body.mainPicNum),answerPicNum=Number(body.answerPicNum);
        if(repairSnapshot){
          const sourceStates=[[0,0],[task.source.pages[0],0],[task.source.pages[0],task.source.answerPages[0]]];
          const nextSourceRank=sourceStates.findIndex(pair=>pair[0]===mainPicNum&&pair[1]===answerPicNum);
          assert(nextSourceRank>=sourceRank&&(phase==='restore-sources'||nextSourceRank===2),'修复来源不是已审归零、正文恢复或最终态');
          sourceRank=nextSourceRank;row.sourceState=sourceRank;
        }else for(const [key,wanted] of [['mainPicNum',task.source.pages[0]],['answerPicNum',task.source.answerPages[0]]])assert(Number(body[key])===wanted,'保存身份或来源改变: '+key);
        let state;
        if(await sameHtml(this.page,body.question,stemHtml)&&await sameHtml(this.page,body.answer,answerHtml))state=2;
        else if(await sameHtml(this.page,body.question,stemHtml)&&await sameHtml(this.page,body.answer,baseline.answer.html))state=1;
        else if(await sameHtml(this.page,body.question,baseline.stem.html)&&await sameHtml(this.page,body.answer,baseline.answer.html))state=0;
        else throw new Error('保存内容不是已审原态、题干修订态或最终态');
        assert(state>=rank,'保存发生状态回退');
        assert(!rows.slice(0,-1).some(r=>r.state!==undefined&&r.state!==state&&r.status!=='responded'),'不同修订态保存不得并发');
        rank=state;row.state=state;row.questionSha256=digest(body.question);row.answerSha256=digest(body.answer);row.status='awaiting-response';
        row.request={bookId:this.bookId,seqIndex:task.target.record,shitiID:id,mainPicNum,answerPicNum};
        await checkpoint({phase:'save-request',observation:structuredClone(row)});
      });
    };
    const onResponse=response=>{const row=byRequest.get(response.request());if(!row)return;lastActivity=Date.now();enqueue(async()=>{
      assert(row.status==='awaiting-response','保存响应缺少合法请求');const body=await response.json();
      row.receipt={...row.request,request:row.request,response:{status:response.status(),body:{errno:body?.errno,errmsg:body?.errmsg,data:{seqIndex:Number(body?.data?.seqIndex),shitiID:Number(body?.data?.shitiID),haveAnswer:body?.data?.haveAnswer}}}};
      const receiptTask=repairSnapshot&&row.state<2?{...task,source:{pages:[row.request.mainPicNum],answerPages:[row.request.answerPicNum]}}:task;
      const verification=verifyNewSystemSave(receiptTask,row.receipt,{bookId:this.bookId,existingRecordId:id});
      const errors=repairSnapshot&&row.state<2&&body?.data?.haveAnswer===false?verification.errors.filter(e=>e!=='保存响应未确认答案'):verification.errors;
      assert(!errors.length,'修订保存业务回执不符: '+errors.join('; '));row.status='responded';row.responseAt=new Date().toISOString();await checkpoint({phase:'save-response',observation:structuredClone(row)});
    });};
    const onFailed=request=>{if(byRequest.has(request))fatal??=new Error('修订保存请求传输失败');};
    const settle=async(required)=>{const deadline=Date.now()+this.timeout;for(;;){await drain();if(rows.length&&rows.every(r=>r.status==='responded')&&rank>=required&&Date.now()-lastActivity>=500)return;if(Date.now()>=deadline)throw new Error('修订保存回执未确认，禁止重试');await pause(40);}};
    try{
      baseline=await this.read(expectedBefore,{refresh:true});
      if(repairSnapshot)assert(baseline.status==='found'&&baseline.bookId===this.bookId&&baseline.recordId===id&&this._nodeID===repairSnapshot.nodeID&&isDeepStrictEqual(this._directoryRecords,repairSnapshot.records),'当前完整目录不同于已审修复快照');
      else {const match=compareNewSystemReadback(expectedBefore,baseline,{baseDir:this.baseDir,bookId:this.bookId});assert(match.ok,'当前记录不同于修订基线: '+match.errors.join('; '));}
      const priorRecords=structuredClone(this._directoryRecords);nodeID=this._nodeID;count=priorRecords.length;
      assert(priorRecords.filter(r=>r.seqIndex===task.target.record&&r.shitiID===id).length===1,'原题身份不唯一');
      stemHtml=renderEditorHtml(task.stem,this.baseDir);answerHtml=renderEditorHtml(task.answer,this.baseDir);cursor=this._sequence;
      this.page.on('request',onRequest);this.page.on('response',onResponse);this.page.on('requestfailed',onFailed);
      await checkpoint({phase:'write-intent',bookId:this.bookId,recordId:id,mutation:repairSnapshot?'reviewed-empty-answer-source-repair':'reviewed-existing-record',priorRecords,baseline,maxSaveRequests:6,allowedStates:['before','corrected-stem','final'],...(repairSnapshot?{repairSnapshot}:{} )});
      this._pendingWrite={status:'pending',task:structuredClone(task),phase:'correction',before:structuredClone(expectedBefore),priorRecords};await this._persistPendingWrite();
      edited=true;this._uncertain=true;
      if(repairSnapshot){
        phase='restore-sources';await this._navigateSources(task);await drain();
        const deadline=Date.now()+this.timeout;
        while(rows.some(r=>r.status!=='responded')||Date.now()-lastActivity<500){assert(Date.now()<deadline,'来源恢复保存未确认');await pause(40);await drain();}
      }
      phase='correct-stem';await this._paste('#contentedit .w-e-text',stemHtml,{replace:true});await drain();await this._click(this.page.locator('input.el-input__inner').nth(0));await settle(1);
      phase='correct-answer';await this._paste('#answeredit .w-e-text',answerHtml,{replace:true});await drain();await this._click(this.page.locator('input.el-input__inner').nth(0));await settle(2);
      assert(rows.at(-1)?.state===2,'最后保存不是最终修订态');
      phase='fresh-readback';refreshing=true;const readback=await this.read(task,{refresh:true});await drain();const comparison=compareNewSystemReadback(task,readback,{baseDir:this.baseDir,bookId:this.bookId});assert(comparison.ok&&readback.count===count,'修订刷新核对失败: '+comparison.errors.join('; '));
      if(repairSnapshot)assert(readback.mainPicNum===task.source.pages[0]&&readback.answerPicNum===task.source.answerPages[0]&&readback.haveAnswer===true,'修复后来源或答案标记不符');
      const protectedRecords=records=>records.map(r=>r.seqIndex===task.target.record?{...r,question:null,answer:null,...(repairSnapshot?{mainPicNum:null,answerPicNum:null,haveAnswer:null}:{})}:r);
      assert(isDeepStrictEqual(protectedRecords(priorRecords),protectedRecords(this._directoryRecords)),'修订改变了其他题目或题号/来源/身份');
      await checkpoint({phase:'readback',readback,comparison,saveRequests:rows.length,preservedRecords:count,observations:rows});
      this._pendingWrite.status='verified';this._pendingWrite.receipt=rows.at(-1).receipt;await this._persistPendingWrite();this._pendingWrite=null;this._uncertain=false;
      return {receipt:rows.at(-1).receipt,readback,comparison,saveRequests:rows.length,preservedRecords:count,plusClicks:0};
    }catch(error){if(edited)this._uncertain=true;throw new Error('['+phase+'] '+error.message,{cause:error});}
    finally{this.page.off('request',onRequest);this.page.off('response',onResponse);this.page.off('requestfailed',onFailed);this._busy=false;}
  }
}
