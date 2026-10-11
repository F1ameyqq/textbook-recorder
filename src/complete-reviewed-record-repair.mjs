import fs from 'node:fs/promises';
import {isDeepStrictEqual} from 'node:util';
import {renderEditorHtml,compareNewSystemReadback,verifyNewSystemSave} from './new-system-core.mjs';
import {validateRecordRepairSnapshot} from './reviewed-record-repair-snapshot.mjs';
const assert=(v,m)=>{if(!v)throw Error(m);};
const savePath='/edushop/textbook/myproducecommit/editshiti';

/** One explicitly approved existing-ID completion, never an append or a replay
 * of the failed native request. Only the originally frozen empty record is
 * eligible. The fixed request carries the reviewed final content and sources. */
export async function completeReviewedRecordRepair(adapter,task,{snapshot,pending,pendingPath,checkpoint,rejectedParameterProof}){
  validateRecordRepairSnapshot(snapshot,task,adapter.bookId);
  assert(pending?.status==='pending'&&pending.phase==='correction'&&isDeepStrictEqual(pending.task,task)
    &&isDeepStrictEqual(pending.priorRecords,snapshot.records),'补全不属于原待核对修订或完整冻结目录');
  assert(snapshot.records.length===task.target.record,'当前补全仅支持已绑定目录末题');
  assert(!adapter._busy,'原写入仍在执行');
  const current=await adapter.read(task,{refresh:true});
  const compared=compareNewSystemReadback(task,current,{baseDir:adapter.baseDir,bookId:adapter.bookId});
  const protectedRows=rows=>rows.map(r=>r.seqIndex===task.target.record?{...r,question:null,answer:null,mainPicNum:null,answerPicNum:null,haveAnswer:null}:r);
  assert(adapter._nodeID===snapshot.nodeID&&current.recordId===task.target.expectedRecordId
    &&isDeepStrictEqual(protectedRows(adapter._directoryRecords),protectedRows(snapshot.records)),
    '补全前目录、原ID或其他题内容发生变化');
  const evidencePath=pendingPath+'.completion.contract-v2.json';
  let receipt,readback=current;
  if(!compared.ok){
    assert(isDeepStrictEqual(adapter._directoryRecords,snapshot.records),'当前记录不是完整已授权空白基线，停止补全');
    try{
      await fs.access(pendingPath+'.completion.json');
      assert(rejectedParameterProof?.verified===true&&rejectedParameterProof.errno===300001,
        '原补全结果未知，没有绑定的明确参数错误回执，禁止新请求');
    }catch(error){if(error.code!=='ENOENT')throw error;}
    const basicResponse=await adapter.page.request.get(adapter.origin+'/edushop/textbook/detail/basicinfo',{params:{textbookID:adapter.bookId},timeout:adapter.timeout});
    const basic=await basicResponse.json();
    assert(basicResponse.ok()&&basic.errno===0&&basic.data?.uploadID,'当前书籍原图来源信息无效');
    const pagesResponse=await adapter.page.request.get(adapter.origin+'/edushop/textbook/file/progress',{params:{uploadID:basic.data.uploadID},timeout:adapter.timeout});
    const pagesReply=await pagesResponse.json(),pages=pagesReply.data?.data;
    assert(pagesResponse.ok()&&pagesReply.errno===0&&Array.isArray(pages),'原图页列表无效');
    const mainPicURL=pages[task.source.pages[0]-1]?.pageURL,answerPicURL=pages[task.source.answerPages[0]-1]?.pageURL;
    for(const urlText of [mainPicURL,answerPicURL]){const url=new URL(urlText);assert(url.protocol==='https:'&&url.hostname.endsWith('.bcebos.com'),'原图地址必须来自当前书籍官方原图列表');}
    const body={textbookID:adapter.bookId,nodeID:snapshot.nodeID,seqIndex:task.target.record,
      shitiID:task.target.expectedRecordId,mainPicNum:task.source.pages[0],answerPicNum:task.source.answerPages[0],
      mainPicURL,answerPicURL,
      question:renderEditorHtml(task.stem,adapter.baseDir),answer:renderEditorHtml(task.answer,adapter.baseDir)};
    // Exclusive durable intent prohibits a second completion request after an
    // unknown response. A subsequent call may only confirm an already final row.
    await fs.writeFile(evidencePath,JSON.stringify({schemaVersion:1,kind:'reviewed-existing-id-final-completion',
      status:'pending',bookId:adapter.bookId,taskId:task.id,authorization:snapshot.authorization,
      priorRecords:snapshot.records,body,createdAt:new Date().toISOString()},null,2)+'\n',{flag:'wx'});
    await checkpoint({phase:'completion-write-intent',recordId:body.shitiID,evidencePath});
    await adapter.guard({waitForEditors:false});
    adapter._busy=true;adapter._uncertain=true;
    try{
      const response=await adapter.page.request.post(adapter.origin+savePath,{data:body,timeout:adapter.timeout});
      const reply=await response.json();
      receipt={bookId:adapter.bookId,seqIndex:task.target.record,shitiID:task.target.expectedRecordId,
        mainPicNum:task.source.pages[0],answerPicNum:task.source.answerPages[0],
        request:{bookId:body.textbookID,seqIndex:body.seqIndex,shitiID:body.shitiID,mainPicNum:body.mainPicNum,answerPicNum:body.answerPicNum},
        response:{status:response.status(),body:reply}};
      await checkpoint({phase:'completion-save-response',receipt});
      const checked=verifyNewSystemSave(task,receipt,{bookId:adapter.bookId,existingRecordId:task.target.expectedRecordId});
      assert(checked.ok,'补全保存业务回执失败: '+checked.errors.join('; '));
    }finally{adapter._busy=false;}
    readback=await adapter.read(task,{refresh:true});
  }
  const finalComparison=compareNewSystemReadback(task,readback,{baseDir:adapter.baseDir,bookId:adapter.bookId});
  assert(finalComparison.ok&&readback.haveAnswer===true&&readback.count===snapshot.records.length
    &&isDeepStrictEqual(protectedRows(adapter._directoryRecords),protectedRows(snapshot.records)),
    '补全后的答案、来源、原生格式或其他题刷新核对失败: '+finalComparison.errors.join('; '));
  const proof={outcome:'saved',writeUnlocked:true,bookId:adapter.bookId,taskId:task.id,recordId:readback.recordId,
    nodeID:snapshot.nodeID,priorRecordIds:snapshot.records.slice(0,-1).map(r=>r.shitiID),
    priorRecordsUnchanged:true,targetRecordUnique:true,fullContentCompared:true,evidencePath};
  await checkpoint({phase:'completion-fresh-readback',readback,comparison:finalComparison,recovery:proof});
  // Keep the original failed intent intact; this separate proof records the
  // successful final completion. Session/state unlock follows its core checks.
  await fs.writeFile(evidencePath,JSON.stringify({schemaVersion:1,kind:'reviewed-existing-id-final-completion',
    status:'verified',bookId:adapter.bookId,taskId:task.id,authorization:snapshot.authorization,
    originalPendingPath:pendingPath,receipt:receipt??null,readback,comparison:finalComparison,recovery:proof,
    verifiedAt:new Date().toISOString()},null,2)+'\n');
  adapter._pendingWrite=null;adapter._uncertain=false;
  return {...readback,receipt,recovery:proof};
}
