import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { validatePairedBatch } from './paired-batch.mjs';
import { validateWorkflowPlan } from './workflow-job.mjs';
import { rasterDimensions } from './draft-batch.mjs';
import { sha256 } from './preparation-files.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const positive = value => Number.isSafeInteger(value) && value > 0;
const hashString = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const copy = value => structuredClone(value);
const sectionKey = value => JSON.stringify([value.chapterLabel, value.sectionLabel]);
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative === '' || !(relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative));
};
const checks = () => ({ sourceText: false, answerMatch: false, wholeQuestion: false, format: false });

function localBytes(baseDir, filename) {
  if (!nonempty(filename) || path.isAbsolute(filename) || filename.includes('\0')) throw new Error('来源路径须为作业根内相对路径');
  const root = realpathSync(baseDir), file = path.resolve(root, filename);
  if (!inside(root, file) || file === root) throw new Error('来源路径越出作业根');
  const real = realpathSync(file);
  if (!inside(root, real) || !statSync(real).isFile()) throw new Error('来源软链接越界或不是文件');
  return readFileSync(real);
}

function jsonReference(baseDir, reference, label) {
  if (!object(reference) || !nonempty(reference.path) || path.basename(reference.path) !== reference.path || !hashString(reference.sha256)) {
    throw new Error(`${label} 必须绑定同一作业根 JSON 的 {path,sha256}`);
  }
  const real = realpathSync(path.join(baseDir, reference.path));
  if (path.dirname(real) !== realpathSync(baseDir)) throw new Error(`${label} JSON 软链接越出作业根`);
  const bytes = localBytes(baseDir, reference.path);
  if (sha256(bytes) !== reference.sha256) throw new Error(`${label} SHA256 与实际字节不一致`);
  return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, ''));
}

function confirmedOrder(order, paired, plan) {
  if (!object(order) || order.schemaVersion !== 1 || order.kind !== 'confirmed-question-order' || order.bookId !== plan.bookId
      || order.confirmed !== true || !Array.isArray(order.sections) || !order.sections.length
      || Object.keys(order).some(key => !['schemaVersion', 'kind', 'bookId', 'confirmed', 'sections'].includes(key))) {
    throw new Error('order 须为同书 confirmed-question-order，并由实际确认题序者明确声明 confirmed:true');
  }
  if (!plan.scope.sections?.length) throw new Error('mapping 必须使用 plan.scope.sections 的明确目录和 startRecord');
  const planned = new Map(plan.scope.sections.map(section => [sectionKey(section), section]));
  const usedSections = new Set(), ids = new Set(), placements = [];
  for (const section of order.sections) {
    if (!object(section) || Object.keys(section).some(key => !['chapterLabel', 'sectionLabel', 'questionIds'].includes(key))
        || !nonempty(section.chapterLabel) || !nonempty(section.sectionLabel) || !Array.isArray(section.questionIds) || !section.questionIds.length) {
      throw new Error('order.sections 须明确 chapterLabel/sectionLabel 和非空 questionIds；不推断题序');
    }
    const key = sectionKey(section), scope = planned.get(key);
    if (!scope || usedSections.has(key)) throw new Error('order 目录须唯一且完全属于 plan.scope.sections');
    usedSections.add(key);
    if (scope.recordLimit !== undefined && section.questionIds.length > scope.recordLimit) throw new Error('已确认题序数量越出 plan.recordLimit');
    for (const [offset, questionId] of section.questionIds.entries()) {
      if (typeof questionId !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(questionId) || ids.has(questionId)) throw new Error('order.questionIds 须为不重复的明确任务 ID');
      ids.add(questionId);
      const record = scope.startRecord + offset;
      if (!positive(record)) throw new Error('记录号越出安全整数范围');
      placements.push({ questionId, target: { chapterLabel: section.chapterLabel, sectionLabel: section.sectionLabel, record } });
    }
  }
  if (usedSections.size !== planned.size) throw new Error('order 必须覆盖全部计划目录');
  if (placements.length !== paired.tasks.length || placements.some((placement, index) => placement.questionId !== paired.tasks[index]?.id)) {
    throw new Error('已确认题序必须逐项匹配全部 paired.tasks 顺序；请按明确题序重排 records 并重新配对，不能静默重排或推断');
  }
  return placements;
}

function completeBaseline(baseline, plan) {
  if (!object(baseline) || baseline.bookId !== plan.bookId) throw new Error('production 必须提供同书完整本地 baseline');
  const scopes = baseline.kind === 'local-section-baselines' ? baseline.scopes : [baseline];
  const bySection = new Map();
  if (!Array.isArray(scopes) || !scopes.length) throw new Error('baseline 需要完整单节快照或 local-section-baselines.scopes');
  for (const scope of scopes) {
    if (!object(scope) || scope.bookId !== plan.bookId || !nonempty(scope.chapterLabel) || !nonempty(scope.sectionLabel)
        || !positive(scope.nodeID) || !Number.isFinite(Date.parse(scope.serverSnapshotAt)) || !Array.isArray(scope.records)
        || bySection.has(sectionKey(scope)) || scope.records.some((record, index) => !object(record) || record.seqIndex !== index + 1
          || !positive(record.shitiID) || record.nodeID !== scope.nodeID)
        || new Set(scope.records.map(record => record.shitiID)).size !== scope.records.length) {
      throw new Error('baseline 须有完整、连续、目录绑定的 records；probe 数量不能代替');
    }
    bySection.set(sectionKey(scope), scope);
  }
  for (const scope of plan.scope.sections) {
    if (bySection.get(sectionKey(scope))?.records.length !== scope.startRecord - 1) {
      throw new Error('本地历史基线与计划 startRecord 不一致；停止重核，不能静默平移');
    }
  }
}

function originalIndex(index, bookId, baseDir) {
  if (!object(index) || index.schemaVersion !== 1 || index.bookId !== bookId || !Array.isArray(index.pages) || !index.pages.length) throw new Error('index 须有同书 schemaVersion:1 和原图 pages');
  const byPage = new Map(), byFile = new Map(), loaded = new Map();
  for (const entry of index.pages) {
    if (!object(entry) || !positive(entry.systemPage) || byPage.has(entry.systemPage) || !nonempty(entry.file) || byFile.has(entry.file)
        || !hashString(entry.sha256) || !positive(entry.width) || !positive(entry.height)) throw new Error('index 页码/路径/SHA/尺寸无效或重复');
    byPage.set(entry.systemPage, entry); byFile.set(entry.file, entry);
  }
  const imageFor = (page, image) => {
    const entry = byPage.get(page);
    if (!entry || entry.file !== image) throw new Error('来源页与 index 原图路径不一致');
    if (!loaded.has(image)) {
      const bytes = localBytes(baseDir, image), actual = rasterDimensions(bytes), extension = path.extname(image).toLowerCase();
      if (sha256(bytes) !== entry.sha256 || actual.width !== entry.width || actual.height !== entry.height
          || entry.bytes !== undefined && entry.bytes !== bytes.length || entry.mimeType !== undefined && entry.mimeType !== actual.mimeType
          || (actual.mimeType === 'image/png' ? extension !== '.png' : !['.jpg', '.jpeg'].includes(extension))) throw new Error('原图 SHA/实际尺寸/字节/MIME/扩展名与 index 不一致');
      loaded.set(image, entry);
    }
    return entry;
  };
  return { byPage, byFile, loaded, imageFor };
}

function boundedBox(bbox, image) {
  if (!Array.isArray(bbox) || bbox.length !== 4 || bbox.some(value => !Number.isSafeInteger(value) || value < 0)
      || bbox[2] <= bbox[0] || bbox[3] <= bbox[1] || bbox[2] > image.width || bbox[3] > image.height) throw new Error('来源 bbox 须为原像素有效范围 [left,top,right,bottom]');
}

function recordReference(record, indexed, allowedPages) {
  if (record === null) return null;
  const source = record.source;
  for (const page of source.pages) {
    if (!indexed.byPage.has(page) || allowedPages && !allowedPages.has(page)) throw new Error('题干/答案来源页越出 index 或 plan.scope.pages');
  }
  const images = (source.images ?? []).map(filename => {
    const entry = indexed.byFile.get(filename);
    if (!entry || !source.pages.includes(entry.systemPage)) throw new Error('题干/答案原图不属于声明来源页');
    indexed.imageFor(entry.systemPage, filename);
    return { page: entry.systemPage, image: filename, sha256: entry.sha256, width: entry.width, height: entry.height, referenceOnly: true };
  });
  const regions = (source.regions ?? []).map(region => {
    const entry = indexed.imageFor(region.page, region.image); boundedBox(region.bbox, entry);
    return { ...copy(region), sha256: entry.sha256, referenceOnly: true };
  });
  return { recordId: record.id, chapter: record.chapter, ...(record.unit !== undefined ? { unit: record.unit } : {}),
    ...(record.group !== undefined ? { group: record.group } : {}), ...(record.section !== undefined ? { section: record.section } : {}),
    questionNumber: record.questionNumber, pages: copy(source.pages), images, regions, referenceOnly: true };
}

function validateCrops(crops, references, indexed, bookId, baseDir) {
  if (crops.kind !== 'source-crops' || crops.bookId !== bookId || crops.indexSha256 !== references.index.sha256 || !Array.isArray(crops.crops)) throw new Error('crops 须绑定同书同 index 的 source-crops');
  const ids = new Set(), files = new Set();
  for (const crop of crops.crops) {
    if (!object(crop) || !nonempty(crop.id) || ids.has(crop.id) || !nonempty(crop.file) || files.has(crop.file)
        || !['diagram', 'table'].includes(crop.purpose) || !hashString(crop.sha256)) throw new Error('裁图 id/file/purpose/SHA 无效或重复');
    const original = indexed.imageFor(crop.page, crop.image); boundedBox(crop.bbox, original);
    if (crop.sourceSha256 !== original.sha256) throw new Error('裁图原图 SHA 与 index 不一致');
    const bytes = localBytes(baseDir, crop.file), actual = rasterDimensions(bytes);
    if (sha256(bytes) !== crop.sha256 || actual.width !== crop.bbox[2] - crop.bbox[0] || actual.height !== crop.bbox[3] - crop.bbox[1]
        || actual.mimeType !== 'image/png' || path.extname(crop.file).toLowerCase() !== '.png') throw new Error('裁图输出 SHA/PNG/尺寸与证据不一致');
    ids.add(crop.id); files.add(crop.file);
  }
}

/** Build only mechanical local references and numbering; no browser or semantic review. */
export function createMappingTemplate(references, baseDir) {
  if (!object(references) || Object.keys(references).some(key => !['paired', 'plan', 'order', 'index', 'baseline', 'cropEvidence'].includes(key))) throw new Error('mapping 输入引用无效');
  const paired = jsonReference(baseDir, references.paired, 'paired');
  const plan = validateWorkflowPlan(jsonReference(baseDir, references.plan, 'plan'));
  const order = jsonReference(baseDir, references.order, 'order');
  const index = jsonReference(baseDir, references.index, 'index');
  const pairReport = validatePairedBatch(paired, baseDir);
  if (!pairReport.valid || paired.bookId !== plan.bookId || !paired.tasks.length) throw new Error(`paired 须为同书非空有效题单：${pairReport.errors.join('; ')}`);
  const placements = confirmedOrder(order, paired, plan);
  if (plan.source === 'production') completeBaseline(jsonReference(baseDir, references.baseline, 'baseline'), plan);
  else if (references.baseline !== undefined) throw new Error('fixture 使用计划显式 startRecord，不接受 baseline 改写起点');
  const indexed = originalIndex(index, plan.bookId, baseDir), allowedPages = plan.scope.pages ? new Set(plan.scope.pages) : null;
  if (references.cropEvidence !== undefined) validateCrops(jsonReference(baseDir, references.cropEvidence, 'cropEvidence'), references, indexed, plan.bookId, baseDir);
  const sourceReferences = paired.tasks.map((task, position) => ({ questionId: task.id,
    pairedTask: { ...copy(references.paired), jsonPointer: `/tasks/${position}`, referenceOnly: true },
    stem: recordReference(task.stem, indexed, allowedPages), answer: recordReference(task.answer, indexed, allowedPages),
    pairing: copy(task.pairing), issues: [...new Set([...task.pairing.issues, ...task.review.issues])], referenceOnly: true }));
  const sourcePages = [...new Set(sourceReferences.flatMap(item => [...item.stem.pages, ...(item.answer?.pages ?? [])]))];
  const pages = (plan.scope.pages ?? sourcePages).map(page => {
    const entry = indexed.byPage.get(page);
    if (!entry) throw new Error('计划来源页不在 index');
    indexed.imageFor(page, entry.file);
    return { page, imagePath: entry.file, sha256: entry.sha256, candidates: [], referenceOnly: true, coverageChecked: false, evidence: '' };
  });
  const requiredFields = [];
  for (const [position, placement] of placements.entries()) {
    const task = paired.tasks[position];
    placement.answerRequirement = { kind: null, evidence: '' };
    placement.answerStatus = task.answer === null ? null : 'provided';
    placement.agentReview = { checkedAgainstOriginal: false, evidence: '' };
    placement.review = { status: 'pending', checks: checks(), evidence: '', issues: copy(sourceReferences[position].issues) };
    requiredFields.push(`placements[${position}].answerRequirement.kind`, `placements[${position}].answerRequirement.evidence`);
    if (placement.answerStatus === null) requiredFields.push(`placements[${position}].answerStatus`);
  }
  pages.forEach((_, position) => requiredFields.push(`coverage.pages[${position}].candidates`, `coverage.pages[${position}].coverageChecked`, `coverage.pages[${position}].evidence`));
  return { schemaVersion: 1, kind: 'new-system-draft-mapping', bookId: plan.bookId, source: plan.source,
    index: copy(references.index), ...(references.cropEvidence ? { cropEvidence: copy(references.cropEvidence) } : {}),
    placements, coverage: { pages, referenceOnly: true, coverageChecked: false, evidence: '' }, sourceReferences, requiredFields,
    preparation: { kind: 'local-mapping-template', references: copy(references), automaticallyApproved: false, platformWritePerformed: false,
      sourceSemanticsVerifiedByTool: false, questionOrderInferredByTool: false, coverageInferredByTool: false,
      warnings: copy(paired.warnings ?? []), unmatchedAnswerIds: copy(paired.unmatchedAnswerIds),
      limitations: ['confirmed:true 仅声明题序已确认，不代表原图、答案、边界或覆盖审校', '补全具体作答要求和逐页候选前 draft 拒绝为预期；审校问题与审批须另行处理'] } };
}
