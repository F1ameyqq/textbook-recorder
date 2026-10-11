import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { resolveAssetPath } from './core.mjs';
import { assertNativeEmphasis } from './native-emphasis.mjs';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isId = value => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const identifier = value => (typeof value === 'string' && value.trim().length > 0) || positiveInteger(value);
const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const reviewStatuses = new Set(['pending', 'approved', 'review_required']);
const pairingMethods = new Set(['explicit', 'chapter_number', 'none']);
const UNKNOWN_ANSWERS = new Set(['未知', '待补充', '无答案', '暂无答案', '未识别', '[未识别]', '答案略', '略', '见解析', '?', '？']);
const UNKNOWN_GROUPS = new Set(['unknown', 'unrecognized', 'pending', '未知', '不明', '待确认', '未识别', '未标注']);

/**
 * Local intermediate schema v1; no browser, OCR service or model calls.
 * Input: {schemaVersion:1, bookId, questions:[Record], answers:[Record],
 *         pairings?:[{questionId, answerId}]}.
 * Record: {id, chapter, unit?:string|number, group?:string|number,
 *          section?:string|number, questionNumber:string|number|null,
 *          rawOcr:string, blocks?:Block[], unknown?:boolean,
 *          source:{pages:number[], images?:string[], regions?:Region[]}}.
 * Block: {type:'text',text} | {type:'latex',latex,display?:boolean} |
 *        {type:'image',path,align?:'center'}. Missing align means center; preparation
 *        persists explicit align:'center' for both stem and answer image blocks.
 * Region: {page:number,image:string,bbox:[left,top,right,bottom]}; unmodified original pixels.
 * Output: {schemaVersion:1, kind:'paired-batch', bookId, tasks:[{
 *   id, stem:PreparedRecord, answer:PreparedRecord|null,
 *   pairing:{method,candidateIds,issues}, review:{status,issues}
 * }], unmatchedAnswerIds, warnings}.
 * PreparedRecord preserves rawOcr and original source separately from cleanText/blocks.
 * group/section identify the printed column heading (e.g. 典题/基础达标/能力提升),
 * not the chapter or unit. Numeric-only numbers without a group never auto-pair.
 * Full declared labels such as 【典题1】 may identify their own group; digits are
 * never promoted to those labels. Explicit ID mappings can resolve missing groups.
 * Every prepared pair still needs review; this module never grants approval.
 */

/** Whitespace-only cleanup. Digits, punctuation, Unicode and formulas are never corrected. */
export function normalizeOcrText(text) {
  if (typeof text !== 'string') throw new TypeError('OCR 文本必须是字符串');
  return text.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n')
    .split('\n').map(line => line.replace(/[ \t]+$/gu, '')).join('\n')
    .replace(/^\n+|\n+$/gu, '');
}

function scopePart(value) { return value === undefined || value === null ? null : String(value).trim(); }

function groupPart(record) {
  const group = scopePart(record.group);
  const section = scopePart(record.section);
  if (group !== null && section !== null && group !== section) return null;
  // This is a declared complete label, not OCR inference or guessed numeric context.
  const fullLabel = typeof record.questionNumber === 'string'
    ? record.questionNumber.trim().match(/^【(典题|例题|典例|例)\s*[0-9０-９一二三四五六七八九十]+】$/u)
    : null;
  const declared = group ?? section;
  if (declared !== null) {
    if (UNKNOWN_GROUPS.has(declared.toLowerCase())) return null;
    if (fullLabel && declared !== fullLabel[1]) return null;
    return declared;
  }
  return fullLabel?.[1] ?? null;
}

/** Exact declared chapter/unit/group/number only; never infer numbers from OCR. */
export function pairingKey(record) {
  if (!isObject(record) || !identifier(record.chapter) || !identifier(record.questionNumber)) return null;
  const group = groupPart(record);
  if (group === null) return null;
  return JSON.stringify([scopePart(record.chapter), scopePart(record.unit), group, scopePart(record.questionNumber)]);
}

function checkImage(filename, label, baseDir, checkFiles, errors) {
  let resolved;
  try { resolved = resolveAssetPath(filename, baseDir); }
  catch (error) { errors.push(`${label}: ${error.message}`); return; }
  if (!imageExtensions.has(path.extname(filename).toLowerCase())) {
    errors.push(`${label}: 原图格式仅支持 png/jpg/jpeg/webp`);
    return;
  }
  if (!checkFiles) return;
  try {
    if (!statSync(resolved).isFile()) throw new Error('不是文件');
    accessSync(resolved, constants.R_OK);
    const relative = path.relative(realpathSync(baseDir), realpathSync(resolved));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      errors.push(`${label}: 原图软链接越界`);
    }
  } catch { errors.push(`${label}: 原图不存在或不可读取`); }
}

function checkSource(source, label, options, errors) {
  if (!isObject(source)) { errors.push(`${label}: 必须保留来源对象`); return; }
  if (!Array.isArray(source.pages) || source.pages.length === 0 || source.pages.some(page => !positiveInteger(page))) errors.push(`${label}.pages: 必须是非空正整数数组`);
  if (source.images !== undefined) {
    if (!Array.isArray(source.images)) errors.push(`${label}.images: 必须是数组`);
    else source.images.forEach((filename, index) => checkImage(filename, `${label}.images[${index}]`, options.baseDir, options.checkFiles, errors));
  }
  if (source.regions !== undefined) {
    if (!Array.isArray(source.regions)) errors.push(`${label}.regions: 必须是数组`);
    else for (const [index, region] of source.regions.entries()) {
      const location = `${label}.regions[${index}]`;
      if (!isObject(region)) { errors.push(`${location}: 必须是对象`); continue; }
      if (!positiveInteger(region.page) || !Array.isArray(source.pages) || !source.pages.includes(region.page)) errors.push(`${location}.page: 必须属于来源页`);
      checkImage(region.image, `${location}.image`, options.baseDir, options.checkFiles, errors);
      if (!Array.isArray(source.images) || !source.images.includes(region.image)) errors.push(`${location}.image: 必须属于来源原图列表`);
      const box = region.bbox;
      if (!Array.isArray(box) || box.length !== 4 || box.some(value => !Number.isFinite(value) || value < 0) || box[2] <= box[0] || box[3] <= box[1]) errors.push(`${location}.bbox: 必须是有效的 [left,top,right,bottom]`);
    }
  }
}

function checkBlocks(blocks, label, options, errors) {
  if (!Array.isArray(blocks)) { errors.push(`${label}: 必须是数组`); return; }
  for (const [index, block] of blocks.entries()) {
    const location = `${label}[${index}]`;
    if (!isObject(block)) { errors.push(`${location}: 内容块必须是对象`); continue; }
    if (block.type === 'text') {
      if (typeof block.text !== 'string' || !block.text.trim()) errors.push(`${location}.text: 文本不能为空`);
    } else if (block.type === 'latex') {
      if (typeof block.latex !== 'string' || !block.latex.trim()) errors.push(`${location}.latex: 公式不能为空`);
      if (block.display !== undefined && typeof block.display !== 'boolean') errors.push(`${location}.display: 必须是布尔值`);
    } else if (block.type === 'image') {
      checkImage(block.path, `${location}.path`, options.baseDir, options.checkFiles, errors);
      if (block.align !== undefined && block.align !== 'center') errors.push(`${location}.align: 图片必须居中，只允许 center`);
    }
    else errors.push(`${location}.type: 必须是 text、latex 或 image`);
  }
}

function checkRecord(record, label, options, errors, prepared) {
  if (!isObject(record)) { errors.push(`${label}: 必须是对象`); return; }
  if (!isId(record.id)) errors.push(`${label}.id: 只允许字母、数字、下划线、短横线`);
  if (!identifier(record.chapter)) errors.push(`${label}.chapter: 必须明确章节`);
  if (record.unit !== undefined && record.unit !== null && !identifier(record.unit)) errors.push(`${label}.unit: 单元标识无效`);
  for (const key of ['group', 'section']) if (record[key] !== undefined && record[key] !== null && !identifier(record[key])) errors.push(`${label}.${key}: 栏目标识无效`);
  if (record.group !== undefined && record.group !== null && record.section !== undefined && record.section !== null && scopePart(record.group) !== scopePart(record.section)) errors.push(`${label}: group 与 section 栏目标识不一致`);
  if (record.questionNumber !== null && !identifier(record.questionNumber)) errors.push(`${label}.questionNumber: 必须是题号或 null`);
  if (typeof record.rawOcr !== 'string') errors.push(`${label}.rawOcr: 必须保留原始 OCR 字符串`);
  if (record.unknown !== undefined && typeof record.unknown !== 'boolean') errors.push(`${label}.unknown: 必须是布尔值`);
  checkSource(record.source, `${label}.source`, options, errors);
  if (record.blocks !== undefined || prepared) checkBlocks(record.blocks, `${label}.blocks`, options, errors);
  if (prepared) {
    if (typeof record.cleanText !== 'string' || (typeof record.rawOcr === 'string' && record.cleanText !== normalizeOcrText(record.rawOcr))) errors.push(`${label}.cleanText: 必须由原始 OCR 进行保守空白清洗`);
  }
}

function contentPresent(record) {
  return Array.isArray(record?.blocks) && record.blocks.some(block => block?.type === 'image' ||
    (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) ||
    (block?.type === 'latex' && typeof block.latex === 'string' && block.latex.trim()));
}

function unknownAnswer(record) {
  if (!record || record.unknown === true || !contentPresent(record)) return true;
  if (record.blocks.some(block => block?.type !== 'text')) return false;
  const text = record.blocks.map(block => block.text).join('\n').trim();
  return UNKNOWN_ANSWERS.has(text);
}

function prepareRecord(record) {
  const copied = structuredClone(record);
  copied.cleanText = normalizeOcrText(record.rawOcr);
  copied.blocks = record.blocks === undefined
    ? (copied.cleanText.trim() ? [{ type: 'text', text: copied.cleanText }] : [])
    : record.blocks.map(block => {
      if (block.type === 'text') {
        const text=normalizeOcrText(block.text);
        if(block.emphasis?.schemaVersion===1) {
          assertNativeEmphasis(block);
          if(text!==block.text)throw new Error('带格式范围的正文不能清洗改字或偏移，须基于最终文字重新标注');
        }
        return { ...structuredClone(block), text };
      }
      if (block.type === 'image') return { ...structuredClone(block), align: 'center' };
      return structuredClone(block);
    });
  return copied;
}

const addIssue = (issues, issue) => { if (!issues.includes(issue)) issues.push(issue); };

function provenanceIssues(record, side) {
  const issues = [];
  if (!Array.isArray(record.source.images) || !record.source.images.length) issues.push(`${side}_source_images_missing`);
  if (!Array.isArray(record.source.regions) || !record.source.regions.length) issues.push(`${side}_source_locations_missing`);
  else if (Array.isArray(record.source.pages) && record.source.pages.some(page => !record.source.regions.some(region => region?.page === page))) issues.push(`${side}_source_pages_unlocated`);
  return issues;
}

/** Build conservative candidates, never fabricate answers or approve a pair. */
export function preparePairedBatch(input) {
  const errors = [];
  const options = { baseDir: process.cwd(), checkFiles: false };
  if (!isObject(input) || input.schemaVersion !== 1 || !positiveInteger(input.bookId)) throw new Error('输入必须包含 schemaVersion:1 和正整数 bookId');
  if (!Array.isArray(input.questions) || !Array.isArray(input.answers)) throw new Error('输入 questions 和 answers 必须是数组');
  const questions = new Map();
  const answers = new Map();
  for (const [kind, records, collection] of [['questions', input.questions, questions], ['answers', input.answers, answers]]) {
    for (const [index, record] of records.entries()) {
      checkRecord(record, `${kind}[${index}]`, options, errors, false);
      if (!isObject(record)) continue;
      if (collection.has(record.id)) errors.push(`${kind}: id 重复 ${record.id}`);
      else collection.set(record.id, record);
    }
  }
  const explicit = new Map();
  if (input.pairings !== undefined && !Array.isArray(input.pairings)) errors.push('pairings 必须是数组');
  else for (const [index, pair] of (input.pairings ?? []).entries()) {
    if (!isObject(pair) || !questions.has(pair.questionId) || !answers.has(pair.answerId)) errors.push(`pairings[${index}]: 必须引用已有题干和答案 ID`);
    else if (explicit.has(pair.questionId)) errors.push(`pairings[${index}]: 同一题干重复指定答案`);
    else explicit.set(pair.questionId, pair.answerId);
  }
  if (errors.length) throw new Error(`题干答案输入无效: ${errors.join('; ')}`);
  const questionsByKey = new Map();
  const answersByKey = new Map();
  for (const [records, index] of [[input.questions, questionsByKey], [input.answers, answersByKey]]) {
    for (const record of records) {
      const key = pairingKey(record);
      if (key === null) continue;
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(record.id);
    }
  }
  const tasks = input.questions.map(question => {
    const stem = prepareRecord(question);
    const key = pairingKey(question);
    const candidates = key === null ? [] : answersByKey.get(key) ?? [];
    let answer = null;
    let method = 'none';
    let candidateIds = [...candidates];
    const issues = [...provenanceIssues(stem, 'stem')];
    if (!contentPresent(stem)) addIssue(issues, 'stem_content_missing');
    if (explicit.has(question.id)) {
      const answerId = explicit.get(question.id);
      answer = prepareRecord(answers.get(answerId));
      method = 'explicit';
      candidateIds = [answerId];
    } else if (!identifier(question.questionNumber)) addIssue(issues, 'question_number_unknown');
    else if (key === null) addIssue(issues, 'question_group_unknown');
    else if ((questionsByKey.get(key)?.length ?? 0) > 1) addIssue(issues, 'duplicate_question_key');
    else if (candidates.length > 1) addIssue(issues, 'multiple_answer_candidates');
    else if (candidates.length === 1) {
      answer = prepareRecord(answers.get(candidates[0]));
      method = 'chapter_number';
    }
    if (!answer) addIssue(issues, 'answer_missing');
    else {
      provenanceIssues(answer, 'answer').forEach(issue => addIssue(issues, issue));
      if (unknownAnswer(answer)) addIssue(issues, 'answer_unknown');
    }
    return { id: question.id, stem, answer, pairing: { method, candidateIds, issues: [...issues] }, review: { status: issues.length ? 'review_required' : 'pending', issues: [...issues] } };
  });
  const answerUse = new Map();
  for (const entry of tasks) {
    if (!entry.answer) continue;
    if (!answerUse.has(entry.answer.id)) answerUse.set(entry.answer.id, []);
    answerUse.get(entry.answer.id).push(entry);
  }
  for (const entries of answerUse.values()) if (entries.length > 1) {
    for (const entry of entries) {
      addIssue(entry.pairing.issues, 'answer_reused');
      addIssue(entry.review.issues, 'answer_reused');
      entry.review.status = 'review_required';
    }
  }
  const warnings = [];
  for (const entry of tasks) {
    if (entry.stem.source.pages.length > 1) warnings.push(`${entry.id}: 题干跨页，须核对各页内容及顺序`);
    if (entry.answer?.source.pages.length > 1) warnings.push(`${entry.id}: 答案跨页，须核对各页内容及顺序`);
  }
  return {
    schemaVersion: 1, kind: 'paired-batch', bookId: input.bookId, tasks,
    unmatchedAnswerIds: input.answers.filter(answer => !answerUse.has(answer.id)).map(answer => answer.id),
    warnings,
  };
}

/** Validate paired intermediate batch locally. Default checks original image files. */
export function validatePairedBatch(batch, baseDirOrOptions = process.cwd()) {
  const options = typeof baseDirOrOptions === 'string'
    ? { baseDir: baseDirOrOptions, checkFiles: true }
    : { baseDir: process.cwd(), checkFiles: true, ...baseDirOrOptions };
  const errors = [];
  const warnings = [];
  if (!isObject(batch)) return { valid: false, errors: ['题单必须是对象'], warnings };
  if (batch.schemaVersion !== 1 || batch.kind !== 'paired-batch') errors.push('schemaVersion 必须是 1，kind 必须是 paired-batch');
  if (!positiveInteger(batch.bookId)) errors.push('bookId 必须是正整数');
  if (!Array.isArray(batch.tasks)) return { valid: false, errors: [...errors, 'tasks 必须是数组'], warnings };
  const ids = new Set();
  const answerUse = new Map();
  const questionKeys = new Map();
  for (const [index, task] of batch.tasks.entries()) {
    const label = `tasks[${index}]`;
    if (!isObject(task)) { errors.push(`${label}: 必须是对象`); continue; }
    if (!isId(task.id) || ids.has(task.id)) errors.push(`${label}.id: 不合法或重复`);
    ids.add(task.id);
    checkRecord(task.stem, `${label}.stem`, options, errors, true);
    if (isObject(task.stem)) {
      const key = pairingKey(task.stem);
      if (key !== null) {
        if (!questionKeys.has(key)) questionKeys.set(key, []);
        questionKeys.get(key).push(task);
      }
    }
    if (task.stem?.id !== task.id) errors.push(`${label}: task.id 必须与 stem.id 一致`);
    if (task.answer !== null) {
      checkRecord(task.answer, `${label}.answer`, options, errors, true);
      if (isObject(task.answer)) {
        if (!answerUse.has(task.answer.id)) answerUse.set(task.answer.id, []);
        answerUse.get(task.answer.id).push(task);
      }
    }
    if (!isObject(task.pairing) || !pairingMethods.has(task.pairing.method) || !Array.isArray(task.pairing.candidateIds) || task.pairing.candidateIds.some(candidate => !isId(candidate)) || !Array.isArray(task.pairing.issues) || task.pairing.issues.some(issue => typeof issue !== 'string' || !issue)) errors.push(`${label}.pairing: 配对方法、候选和问题列表无效`);
    if (!isObject(task.review) || !reviewStatuses.has(task.review.status) || !Array.isArray(task.review.issues) || task.review.issues.some(issue => typeof issue !== 'string' || !issue)) errors.push(`${label}.review: 审校状态或问题列表无效`);
    const requiredIssues = [];
    if (!task.answer) requiredIssues.push('answer_missing');
    else {
      if (unknownAnswer(task.answer)) requiredIssues.push('answer_unknown');
      if (task.answer.source) requiredIssues.push(...provenanceIssues(task.answer, 'answer'));
      if (!Array.isArray(task.pairing?.candidateIds) || !task.pairing.candidateIds.includes(task.answer.id)) requiredIssues.push('answer_not_selected_candidate');
    }
    if (!contentPresent(task.stem)) requiredIssues.push('stem_content_missing');
    if (task.stem?.source) requiredIssues.push(...provenanceIssues(task.stem, 'stem'));
    if (task.pairing?.candidateIds?.length !== 1) requiredIssues.push('answer_candidate_not_unique');
    if (task.pairing?.method === 'none') requiredIssues.push('pairing_unresolved');
    if (task.pairing?.method === 'chapter_number' && task.answer && (pairingKey(task.stem) === null || pairingKey(task.stem) !== pairingKey(task.answer))) requiredIssues.push('chapter_number_mismatch');
    if (requiredIssues.length && task.review?.status !== 'review_required') errors.push(`${label}: ${requiredIssues.join(', ')}，必须标记 review_required，不能批准`);
    if (task.review?.status === 'approved' && (task.review.issues?.length || task.pairing?.issues?.length)) errors.push(`${label}: 仍有未解决问题，不能批准`);
    if (task.stem?.source?.pages?.length > 1 || task.answer?.source?.pages?.length > 1) warnings.push(`${task.id}: 存在跨页来源，需要检查完整性与顺序`);
  }
  for (const entries of questionKeys.values()) if (entries.length > 1) {
    for (const entry of entries) if (entry.pairing?.method === 'chapter_number' && entry.review?.status !== 'review_required') errors.push(`${entry.id}: 重复章节题号不能自动配对，必须标记 review_required 或明确指定配对 ID`);
  }
  for (const [answerId, entries] of answerUse) if (entries.length > 1 && entries.some(entry => entry.review?.status !== 'review_required')) errors.push(`答案 ${answerId} 被重复配对，必须标记 review_required`);
  if (!Array.isArray(batch.unmatchedAnswerIds) || batch.unmatchedAnswerIds.some(id => !isId(id))) errors.push('unmatchedAnswerIds 必须是 ID 数组');
  return { valid: errors.length === 0, errors, warnings };
}

export function summarizePairedBatch(batch) {
  return {
    bookId: batch.bookId, total: batch.tasks.length,
    paired: batch.tasks.filter(task => task.answer !== null).length,
    pending: batch.tasks.filter(task => task.review.status === 'pending').length,
    approved: batch.tasks.filter(task => task.review.status === 'approved').length,
    reviewRequired: batch.tasks.filter(task => task.review.status === 'review_required').length,
    unmatchedAnswers: batch.unmatchedAnswerIds.length,
  };
}
