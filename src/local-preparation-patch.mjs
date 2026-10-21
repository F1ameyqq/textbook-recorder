import { isDeepStrictEqual } from 'node:util';
import { sha256 } from './preparation-files.mjs';
import { assertNativeEmphasis } from './native-emphasis.mjs';
import { expectedNativeScripts } from './native-scripts.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]+$/u.test(value);
const text = value => typeof value === 'string' && Boolean(value.trim()) && value.isWellFormed() && !/\r/u.test(value);
const checks = () => ({ sourceText: false, answerMatch: false, wholeQuestion: false, format: false });

function fields(value, allowed, required, label) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))
      || required.some(key => !Object.hasOwn(value, key))) throw new Error(`${label}: 未知、缺失或非法字段`);
}

/** The old blocks value is hashed as compact JSON; an absent blocks field is null. */
export function preparationBlocksSha256(blocks) {
  if (blocks !== undefined && !Array.isArray(blocks)) throw new Error('blocks 必须是数组或未设置');
  return sha256(Buffer.from(JSON.stringify(blocks ?? null), 'utf8'));
}

function validateBlocks(blocks, side, mapping) {
  if (!Array.isArray(blocks) || !blocks.length) throw new Error('替换 blocks 必须为非空数组');
  let separator = -1;
  for (const [index, block] of blocks.entries()) {
    if (!object(block)) throw new Error('block 必须为对象');
    if (block.type === 'text') {
      fields(block, ['type', 'text', 'runs', 'parts', 'strictSpacing', 'emphasis', 'align'], ['type'], 'text block');
      if (block.strictSpacing !== undefined && typeof block.strictSpacing !== 'boolean') throw new Error('strictSpacing 必须为布尔值');
      if (block.align !== undefined && !['left', 'start'].includes(block.align)) throw new Error('文字必须左对齐');
      if (block.parts !== undefined) {
        if (side !== 'answer' || block.text !== undefined || block.runs !== undefined || block.emphasis !== undefined
            || !Array.isArray(block.parts) || block.parts.length < 2
            || block.parts.some(part => !text(part) || part !== part.trim() || /[\n\t]/u.test(part))) throw new Error('parts 仅允许明确答案，不能混合文字或格式范围');
      } else if (block.runs === undefined && !text(block.text)) throw new Error('text 必须是非空完整 Unicode 文字，换行使用 LF');
      assertNativeEmphasis(block);
      expectedNativeScripts(block);
    } else if (['sup', 'sub'].includes(block.type)) {
      fields(block, ['type', 'text'], ['type', 'text'], '上下标 block');
      if (!text(block.text)) throw new Error('上下标文字无效');
      expectedNativeScripts(block);
    } else if (block.type === 'image') {
      // Whole replacements first require the complete image object and index to
      // equal the old value. Keep all existing crop/redraw/source metadata; its
      // actual pixel provenance remains the original draft validator's job.
      continue;
    } else if (block.type === 'latex' && !mapping) {
      fields(block, ['type', 'latex', 'display'], ['type', 'latex'], 'latex block');
      if (!text(block.latex) || block.display !== undefined && typeof block.display !== 'boolean') throw new Error('latex block 无效；仍须后续专项审校');
    } else if (block.type === 'analysis-separator') {
      fields(block, ['type'], ['type'], 'analysis-separator block');
      if (side !== 'answer' || separator !== -1 || index === 0 || index === blocks.length - 1) throw new Error('解析分隔线只允许位于答案内容之间一次');
      separator = index;
    } else throw new Error('替换 blocks 含不支持的类型');
  }
}

function unchangedImages(before, after) {
  const images = blocks => (blocks ?? []).flatMap((block, index) => block?.type === 'image' ? [{ index, block }] : []);
  if (!Array.isArray(after) || !isDeepStrictEqual(images(before), images(after))) {
    throw new Error('本轮补丁不允许新增、删除、移动或修改图片及其来源；原图片块须在原位置完整保留');
  }
}

function uniqueRecords(records, label, key) {
  if (!Array.isArray(records)) throw new Error(`${label} 必须为数组`);
  const result = new Map();
  for (const record of records) {
    if (!object(record) || !id(record[key]) || result.has(record[key])) throw new Error(`${label} 的 ID 无效或重复`);
    result.set(record[key], record);
  }
  return result;
}

function pendingReview(entry) {
  if (entry.review !== undefined) {
    entry.review = { status: 'pending', checks: checks(), evidence: '',
      issues: Array.isArray(entry.review?.issues) ? entry.review.issues.filter(issue => typeof issue === 'string' && issue.trim()) : [] };
  }
  if (entry.agentReview !== undefined) entry.agentReview = { checkedAgainstOriginal: false, evidence: '' };
  delete entry.reviewEvidence;
  delete entry.specialReview;
}

function invalidateReview(value, mapping) {
  pendingReview(value);
  if (mapping) {
    for (const placement of value.placements) {
      pendingReview(placement);
      // replacementBlocks require a fresh actual image review before draft generation.
      if (placement.replacementBlocks !== undefined) placement.agentReview = { checkedAgainstOriginal: false, evidence: '' };
    }
    if (object(value.coverage)) {
      value.coverage.coverageChecked = false; value.coverage.evidence = '';
      for (const page of value.coverage.pages ?? []) if (object(page)) { page.coverageChecked = false; page.evidence = ''; }
    }
    if (object(value.preparation)) {
      value.preparation.automaticallyApproved = false;
      value.preparation.sourceSemanticsVerifiedByTool = false;
      value.preparation.platformWritePerformed = false;
    }
  } else for (const collection of ['questions', 'answers']) for (const record of value[collection]) pendingReview(record);
}

/** Local source edit only: it does not infer ranges, review content, pair answers or authorize execution. */
export function patchPreparationSource(source, sourceSha256, patch) {
  fields(patch, ['schemaVersion', 'kind', 'sourceSha256', 'operations'], ['schemaVersion', 'kind', 'sourceSha256', 'operations'], 'patch');
  if (patch.schemaVersion !== 1 || patch.kind !== 'local-preparation-patch' || !hash(sourceSha256)
      || patch.sourceSha256 !== sourceSha256) throw new Error('patch 必须绑定输入原始字节 SHA256');
  if (!object(source) || source.schemaVersion !== 1 || !Number.isSafeInteger(source.bookId) || source.bookId < 1) throw new Error('输入必须为明确 bookId 的 records 或 mapping');
  const mapping = source.kind === 'new-system-draft-mapping';
  if (!mapping && source.kind !== undefined) throw new Error('只允许 records 或 new-system-draft-mapping，不接受题单、批准或进度');
  for (const key of ['tasks', 'status', 'readyForExecution', 'platformExecutionAllowed', 'platformAcceptanceVerified', 'pending', 'manifestHash']) {
    if (Object.hasOwn(source, key)) throw new Error('输入含执行或题单状态，不能作为局部准备材料');
  }
  const value = structuredClone(source), collections = mapping
    ? { placements: uniqueRecords(value.placements, 'placements', 'questionId') }
    : { questions: uniqueRecords(value.questions, 'questions', 'id'), answers: uniqueRecords(value.answers, 'answers', 'id') };
  if (!Array.isArray(patch.operations) || !patch.operations.length) throw new Error('operations 必须为非空数组');
  const seen = new Map(), affectedIds = [], affectedTargets = [], targetKeys = new Set();
  for (const operation of patch.operations) {
    const selector = mapping ? ['questionId', 'side'] : ['collection', 'recordId'];
    const operationFields = operation?.op === 'replace-text' ? ['blockIndex', 'expectedText', 'text'] : ['expectedBlocksSha256', 'blocks'];
    fields(operation, ['op', ...selector, ...operationFields], ['op', ...selector, ...operationFields], 'operation');
    if (!['replace-text', 'replace-blocks'].includes(operation.op)) throw new Error('operation 仅允许 replace-text/replace-blocks');
    const recordId = mapping ? operation.questionId : operation.recordId;
    if (!id(recordId)) throw new Error('必须明确已有记录 ID');
    if (mapping ? !['stem', 'answer'].includes(operation.side) : !['questions', 'answers'].includes(operation.collection)) throw new Error('局部补丁选择器无效');
    const side = mapping ? operation.side : operation.collection === 'answers' ? 'answer' : 'stem';
    const record = collections[mapping ? 'placements' : operation.collection].get(recordId);
    if (!record) throw new Error('补丁引用的记录不存在');
    if (mapping && record.replacementBlocks !== undefined && !object(record.replacementBlocks)) throw new Error('replacementBlocks 必须为对象');
    const oldBlocks = mapping ? record.replacementBlocks?.[side] : record.blocks;
    const key = JSON.stringify(mapping ? [recordId, side] : [operation.collection, recordId]);
    const used = seen.get(key) ?? new Set();
    const slot = operation.op === 'replace-blocks' ? 'all' : operation.blockIndex;
    if (used.has('all') || used.has(slot) || slot === 'all' && used.size) throw new Error('同一 blocks 的补丁重叠或重复');
    used.add(slot); seen.set(key, used);
    let blocks;
    if (operation.op === 'replace-text') {
      if (!Number.isSafeInteger(operation.blockIndex) || operation.blockIndex < 0 || !Array.isArray(oldBlocks)
          || !object(oldBlocks[operation.blockIndex])) throw new Error('blockIndex 必须指向已有 block');
      const block = oldBlocks[operation.blockIndex];
      if (block.type !== 'text' || block.emphasis !== undefined || block.runs !== undefined || block.parts !== undefined) throw new Error('已有 emphasis/runs/parts 或非普通 text：须显式替换完整 blocks 并重新核对格式');
      if (typeof operation.expectedText !== 'string' || block.text !== operation.expectedText) throw new Error('expectedText 与原值不一致');
      if (!text(operation.text) || operation.text === block.text) throw new Error('新文字无效或没有变化');
      const newBlock = { ...structuredClone(block), text: operation.text };
      validateBlocks([newBlock], side, mapping);
      blocks = structuredClone(oldBlocks); blocks[operation.blockIndex] = newBlock;
    } else {
      if (!hash(operation.expectedBlocksSha256) || operation.expectedBlocksSha256 !== preparationBlocksSha256(oldBlocks)) throw new Error('expectedBlocksSha256 与原 blocks 不一致');
      if (isDeepStrictEqual(oldBlocks, operation.blocks)) throw new Error('替换 blocks 没有变化');
      blocks = structuredClone(operation.blocks);
      unchangedImages(oldBlocks, blocks);
      validateBlocks(blocks, side, mapping);
    }
    if (mapping) { record.replacementBlocks ??= {}; record.replacementBlocks[side] = blocks; }
    else record.blocks = blocks;
    if (!affectedIds.includes(recordId)) affectedIds.push(recordId);
    if (!targetKeys.has(key)) {
      targetKeys.add(key);
      affectedTargets.push(mapping ? { questionId: recordId, side } : { collection: operation.collection, recordId });
    }
  }
  invalidateReview(value, mapping);
  return { value, affectedIds, affectedTargets, requiresReview: true, platformWritePerformed: false };
}
