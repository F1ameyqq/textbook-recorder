import {isDeepStrictEqual} from 'node:util';

const positive=value=>Number.isSafeInteger(value)&&value>0;
const nonempty=value=>typeof value==='string'&&value.trim().length>0;
const assert=(value,message)=>{if(!value)throw new Error(message);};

/** An explicitly approved, single-record repair for an empty answer and lost
 * source pages. This is an observed server baseline, never an execution task. */
export function validateRecordRepairSnapshot(snapshot,task,bookId){
  assert(snapshot?.schemaVersion===1&&snapshot.kind==='reviewed-empty-answer-source-repair-baseline'
    &&snapshot.bookId===bookId&&isDeepStrictEqual(snapshot.target,task.target)
    &&positive(snapshot.nodeID)&&Array.isArray(snapshot.records)&&snapshot.records.length>0
    &&snapshot.authorization?.source==='direct-user'&&nonempty(snapshot.authorization.userQuote),
    '修复快照缺少同书、同目标或明确用户授权声明');
  const ids=new Set();
  for(const [i,row] of snapshot.records.entries()){
    assert(row.seqIndex===i+1&&positive(row.shitiID)&&!ids.has(row.shitiID)&&row.nodeID===snapshot.nodeID
      &&typeof row.question==='string'&&typeof row.answer==='string'&&typeof row.haveAnswer==='boolean',
      '修复快照目录身份或完整内容无效');
    ids.add(row.shitiID);
  }
  const record=snapshot.records.find(r=>r.seqIndex===task.target.record);
  assert(record?.shitiID===task.target.expectedRecordId&&nonempty(record.question)
    &&record.answer===''&&record.haveAnswer===false&&record.mainPicNum===0&&record.answerPicNum===0,
    '修复快照仅允许明确原ID、答案空白且两来源归零的既有题');
  assert(task.answerStatus==='provided'&&positive(task.source.pages[0])&&positive(task.source.answerPages[0]),
    '修复最终题单须含已核对官方答案及正整数来源');
  return record;
}
