import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validatePairedBatch } from './paired-batch.mjs';
import { inspectReviewedBatch } from './review-preflight.mjs';
import { assertNativeEmphasis } from './native-emphasis.mjs';
import { validateRecordRepairSnapshot } from './reviewed-record-repair-snapshot.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const positive = value => Number.isSafeInteger(value) && value > 0;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const hashString = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const inside = (root, file) => { const rel = path.relative(root, file); return rel === '' || !(rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const requirementOkay = value => object(value) && ['question', 'fill-in'].includes(value.kind)
  && nonempty(value.evidence) && !/^(原书未提供参考答案|无答案|未提供参考答案)[。！!]?$/u.test(value.evidence.trim());
const agentChecked = value => object(value) && value.checkedAgainstOriginal === true && nonempty(value.evidence);
const clone = value => structuredClone(value);

function localBytes(baseDir, filename) {
  if (!nonempty(filename) || path.isAbsolute(filename) || filename.includes('\0')) throw new Error('来源路径须为作业根内相对路径');
  const root = realpathSync(baseDir), file = path.resolve(root, filename);
  if (!inside(root, file) || file === root) throw new Error('来源路径越出作业根');
  const real = realpathSync(file);
  if (!inside(root, real) || !statSync(real).isFile()) throw new Error('来源软链接越界或不是文件');
  return readFileSync(real);
}

function referencedJson(baseDir, reference, label) {
  if (!object(reference) || !hashString(reference.sha256)) throw new Error(`${label} 必须是 {path,sha256} 字节绑定`);
  const bytes = localBytes(baseDir, reference.path);
  if (hash(bytes) !== reference.sha256) throw new Error(`${label} SHA256 不一致`);
  return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, ''));
}

function correctionBaseline(mapping, baseDir) {
  if (mapping.correction === undefined) return null;
  const correction = mapping.correction;
  if (!object(correction) || correction.schemaVersion !== 1 || !nonempty(correction.beforeManifest)
      || !hashString(correction.beforeSha256)
      || Object.keys(correction).some(key => !['schemaVersion', 'beforeManifest', 'beforeSha256', 'beforeSnapshot'].includes(key))) {
    throw new Error('correction 必须是 schemaVersion:1 的 beforeManifest/beforeSha256 绑定');
  }
  const before = referencedJson(baseDir, { path: correction.beforeManifest, sha256: correction.beforeSha256 }, 'correction.beforeManifest');
  if (!object(before) || before.schemaVersion !== 1 || before.kind !== 'new-system-batch'
      || before.bookId !== mapping.bookId || before.source !== mapping.source || !Array.isArray(before.tasks)
      || before.tasks.length !== mapping.placements.length) throw new Error('correction 基线须为同书同来源、完整对应任务的既有题单');
  const byId = new Map(), recordIds = new Set();
  for (const task of before.tasks) {
    if (!object(task) || !nonempty(task.id) || byId.has(task.id) || !object(task.target)
        || !positive(task.target.expectedRecordId) || recordIds.has(task.target.expectedRecordId) || task.review?.status !== 'approved'
        || !['sourceText', 'answerMatch', 'wholeQuestion', 'format'].every(key => task.review?.checks?.[key] === true)) {
      throw new Error('correction 基线任务须唯一、已审校，且有明确的正整数 expectedRecordId');
    }
    byId.set(task.id, task);
    recordIds.add(task.target.expectedRecordId);
  }
  if(correction.beforeSnapshot!==undefined){
    if(before.tasks.length!==1)throw new Error('空答案/归零来源修复快照仅允许单题');
    const snapshot=referencedJson(baseDir,correction.beforeSnapshot,'correction.beforeSnapshot');
    validateRecordRepairSnapshot(snapshot,before.tasks[0],mapping.bookId);
  }
  return byId;
}

/** Read actual raster headers; reported index dimensions alone are not trusted. */
export function rasterDimensions(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString('ascii', 12, 16) === 'IHDR') {
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (positive(width) && positive(height)) return { width, height, mimeType: 'image/png' };
  }
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset < bytes.length) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 217 || marker === 218) break;
      if (marker === 0 || marker === 216 || marker >= 208 && marker <= 215 || marker === 1) continue;
      if (offset + 2 > bytes.length) break;
      const size = bytes.readUInt16BE(offset);
      if (size < 2 || offset + size > bytes.length) break;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && size >= 8) {
        const height = bytes.readUInt16BE(offset + 3), width = bytes.readUInt16BE(offset + 5);
        if (positive(width) && positive(height)) return { width, height, mimeType: 'image/jpeg' };
      }
      offset += size;
    }
  }
  throw new Error('来源只支持有有效尺寸的 PNG/JPEG 原图');
}

function boundedBox(box, image, label) {
  if (!Array.isArray(box) || box.length !== 4 || box.some(value => !Number.isSafeInteger(value) || value < 0)
      || box[2] <= box[0] || box[3] <= box[1] || box[2] > image.width || box[3] > image.height) throw new Error(`${label} 坐标须为原像素有效范围 [left,top,right,bottom]`);
}

function sourceIndex(mapping, baseDir) {
  const index = referencedJson(baseDir, mapping.index, 'index');
  if (index.schemaVersion !== 1 || index.bookId !== mapping.bookId || !Array.isArray(index.pages) || !index.pages.length) throw new Error('原图 index 的版本/bookId/pages 不一致');
  const byPage = new Map(), byFile = new Map(), loaded = new Map();
  for (const item of index.pages) {
    if (!object(item) || !positive(item.systemPage) || byPage.has(item.systemPage) || !nonempty(item.file) || byFile.has(item.file)
        || !hashString(item.sha256) || !positive(item.width) || !positive(item.height)) throw new Error('index 页码/路径/SHA/尺寸无效或重复');
    byPage.set(item.systemPage, item); byFile.set(item.file, item);
  }
  const imageFor = (page, filename) => {
    const entry = byPage.get(page);
    if (!entry || entry.file !== filename) throw new Error('来源页与 index 原图路径不一致');
    if (!loaded.has(filename)) {
      const bytes = localBytes(baseDir, filename), actual = rasterDimensions(bytes);
      const ext = path.extname(filename).toLowerCase();
      if (hash(bytes) !== entry.sha256 || actual.width !== entry.width || actual.height !== entry.height
          || entry.bytes !== undefined && entry.bytes !== bytes.length || entry.mimeType !== undefined && entry.mimeType !== actual.mimeType
          || (actual.mimeType === 'image/png' ? ext !== '.png' : !['.jpg','.jpeg'].includes(ext))) throw new Error('原图 SHA/实际尺寸/字节/MIME/扩展名与 index 不一致');
      loaded.set(filename, entry);
    }
    return entry;
  };
  return { byPage, byFile, imageFor, loaded };
}

function verifyRecordSources(record, indexed, label) {
  if (!record) return;
  for (const filename of record.source.images ?? []) {
    const item = indexed.byFile.get(filename);
    if (!item || !record.source.pages.includes(item.systemPage)) throw new Error(`${label} 原图未在来源页 index 中`);
    indexed.imageFor(item.systemPage, filename);
  }
  for (const [position, region] of (record.source.regions ?? []).entries()) {
    const image = indexed.imageFor(region.page, region.image);
    boundedBox(region.bbox, image, `${label}.regions[${position}]`);
  }
  for (const page of record.source.pages) if (!indexed.byPage.has(page)) throw new Error(`${label} 来源页不在 index`);
}

function cropMap(mapping, baseDir, indexed) {
  if (mapping.cropEvidence === undefined) return null;
  const evidence = referencedJson(baseDir, mapping.cropEvidence, 'cropEvidence');
  if (evidence.kind !== 'source-crops' || evidence.bookId !== mapping.bookId || evidence.indexSha256 !== mapping.index.sha256 || !Array.isArray(evidence.crops)) throw new Error('cropEvidence 必须绑定同书同 index 的 source-crops');
  const byFile = new Map(), ids = new Set();
  for (const crop of evidence.crops) {
    if (!object(crop) || !nonempty(crop.id) || ids.has(crop.id) || !nonempty(crop.file) || byFile.has(crop.file)
        || !['diagram','table'].includes(crop.purpose) || !hashString(crop.sha256)) throw new Error('裁图 id/file/purpose/SHA 无效或重复');
    const original = indexed.imageFor(crop.page, crop.image);
    boundedBox(crop.bbox, original, '裁图 bbox');
    if (crop.sourceSha256 !== original.sha256) throw new Error('裁图原图 SHA 与 index 不一致');
    const bytes = localBytes(baseDir, crop.file), actual = rasterDimensions(bytes);
    if (hash(bytes) !== crop.sha256 || actual.width !== crop.bbox[2] - crop.bbox[0] || actual.height !== crop.bbox[3] - crop.bbox[1]
        || actual.mimeType !== 'image/png' || path.extname(crop.file).toLowerCase() !== '.png') throw new Error('裁图输出 SHA/PNG/尺寸与 cropEvidence 不一致');
    ids.add(crop.id); byFile.set(crop.file, crop);
  }
  return byFile;
}

function imageBlock(block, record, indexed, crops) {
  if (!['diagram','table'].includes(block.purpose)) throw new Error('图片 purpose 只能是 diagram/table；禁止 whole-question');
  let source = block.source;
  const original = indexed.byFile.get(block.path);
  if (original) {
    indexed.imageFor(original.systemPage, original.file);
    source ??= { page: original.systemPage, image: original.file, bbox: [0,0,original.width,original.height], sha256: original.sha256 };
    if (source.page !== original.systemPage || source.image !== original.file || source.sha256 !== original.sha256
        || !same(source.bbox, [0,0,original.width,original.height])) throw new Error('直接原图 image.source 须精确为完整原图');
  } else {
    const crop = crops?.get(block.path);
    if (!crop) throw new Error('裁图必须提供 cropEvidence 字节绑定；不能只信 image.source 声明');
    if (!object(source) || source.page !== crop.page || source.image !== crop.image || source.sha256 !== crop.sourceSha256
        || !same(source.bbox, crop.bbox) || crop.purpose !== block.purpose) throw new Error('image.source/purpose 与实际裁图证据不一致');
  }
  if (!record?.source.pages.includes(source.page) || !record.source.images.includes(source.image)) throw new Error('内容图片须属于本题原图来源');
  if (!record.source.regions.some(region => region.page === source.page && region.image === source.image
      && source.bbox[0] >= region.bbox[0] && source.bbox[1] >= region.bbox[1] && source.bbox[2] <= region.bbox[2] && source.bbox[3] <= region.bbox[3])) {
    throw new Error('内容图片 bbox 须落在本题已声明的原图区域内');
  }
  return { ...clone(block), align: 'center', source: clone(source) };
}

function convertBlocks(blocks, record, indexed, crops) {
  if (!Array.isArray(blocks) || !blocks.length) return [];
  return blocks.map(block => {
    if (!object(block)) throw new Error('内容块必须是对象');
    if (block.emphasis?.schemaVersion===1) assertNativeEmphasis(block);
    if (block.type === 'image') return imageBlock(block, record, indexed, crops);
    // Unsupported formulas stay explicit and blocked; never replace them with
    // a guessed exponent, linear formula or whole-question screenshot.
    if (block.type === 'latex') return { ...clone(block), type: 'formula' };
    return clone(block);
  });
}

function missingPolicyAllowed(paired, placement, mapping, indexed) {
  const policy = mapping.missingReferencePolicy, pages = placement.searchedAnswerPages;
  return paired.answer === null && paired.pairing.issues.includes('answer_missing')
    && requirementOkay(placement.answerRequirement) && placement.answerStatus === 'not-provided' && agentChecked(placement.agentReview)
    && object(policy) && policy.authorized === true && policy.source === 'direct-user-rule' && nonempty(policy.userQuote)
    && nonempty(policy.evidenceReference) && policy.label === '原书未提供参考答案'
    && Array.isArray(pages) && pages.length > 0 && pages.every(positive) && new Set(pages).size === pages.length
    && pages.every(page => indexed.byPage.has(page));
}

/** Deterministic local draft conversion. Human declarations never grant approval. */
export function prepareDraftBatch(paired, mapping, baseDir, provenance = {}) {
  const pairReport = validatePairedBatch(paired, baseDir);
  if (!pairReport.valid) throw new Error(`paired 输入无效：${pairReport.errors.join('; ')}`);
  if (!object(mapping) || mapping.schemaVersion !== 1 || mapping.kind !== 'new-system-draft-mapping'
      || mapping.bookId !== paired.bookId || !['fixture','production'].includes(mapping.source)
      || !Array.isArray(mapping.placements)) throw new Error('mapping 必须明确版本/kind/bookId/source/placements');
  const beforeById = correctionBaseline(mapping, baseDir);
  const indexed = sourceIndex(mapping, baseDir), crops = cropMap(mapping, baseDir, indexed), placements = new Map();
  const ids = new Set(paired.tasks.map(task => task.id));
  for (const placement of mapping.placements) {
    if (!object(placement) || !ids.has(placement.questionId) || placements.has(placement.questionId)) throw new Error('placement 必须唯一引用已有 questionId');
    if (!object(placement.target) || !nonempty(placement.target.chapterLabel) || !nonempty(placement.target.sectionLabel) || !positive(placement.target.record)
        || (beforeById ? !positive(placement.target.expectedRecordId) : placement.target.expectedRecordId !== undefined)) {
      throw new Error('新草稿 placement.target 必须有 chapterLabel/sectionLabel/正整数 record；既有 ID 仅接受已冻结 correction 基线中的正整数');
    }
    if (beforeById && (!beforeById.has(placement.questionId) || !same(beforeById.get(placement.questionId).target, placement.target))) {
      throw new Error('correction placement 的 task ID/target 与冻结基线不一致');
    }
    if (!requirementOkay(placement.answerRequirement) || !['provided','not-provided'].includes(placement.answerStatus)) throw new Error('placement 必须声明具体作答要求和 answerStatus；缺答备注不是题目依据');
    if (placement.replacementBlocks !== undefined && (!object(placement.replacementBlocks) || !agentChecked(placement.agentReview)
        || Object.keys(placement.replacementBlocks).some(side => !['stem','answer'].includes(side)
          || !Array.isArray(placement.replacementBlocks[side]) || !placement.replacementBlocks[side].length))) throw new Error('replacementBlocks 须附 agentReview 逐图核对声明，且仅非空 stem/answer 数组；声明不是自动验证');
    if (placement.searchedAnswerPages !== undefined) {
      if (!Array.isArray(placement.searchedAnswerPages) || !placement.searchedAnswerPages.length
          || placement.searchedAnswerPages.some(page => !positive(page)) || new Set(placement.searchedAnswerPages).size !== placement.searchedAnswerPages.length) throw new Error('searchedAnswerPages 须为已查验的不重复正整数页码');
      for (const page of placement.searchedAnswerPages) {
        const original = indexed.byPage.get(page);
        if (!original) throw new Error('searchedAnswerPages 必须位于实际 index 内');
        indexed.imageFor(page, original.file);
      }
    }
    placements.set(placement.questionId, placement);
  }
  if (placements.size !== paired.tasks.length) throw new Error('placement 必须覆盖全部 paired tasks，不能静默丢题');
  const tasks = paired.tasks.map(entry => {
    const placement = placements.get(entry.id);
    verifyRecordSources(entry.stem, indexed, entry.id + '.stem'); verifyRecordSources(entry.answer, indexed, entry.id + '.answer');
    const issues = [...new Set([...entry.pairing.issues, ...entry.review.issues])];
    if (entry.answer && (String(entry.stem.chapter) !== String(entry.answer.chapter) || String(entry.stem.unit ?? '') !== String(entry.answer.unit ?? ''))) issues.push('declared_answer_scope_mismatch');
    const missingAllowed = missingPolicyAllowed(entry, placement, mapping, indexed), notes = [];
    let answerPages = entry.answer?.source.pages ?? [], answerBlocks;
    if (entry.answer) {
      if (placement.answerStatus !== 'provided') issues.push('answer_status_mismatch');
      answerBlocks = convertBlocks(placement.replacementBlocks?.answer ?? entry.answer.blocks, entry.answer, indexed, crops);
    } else if (missingAllowed) {
      const position = issues.indexOf('answer_missing'); if (position >= 0) issues.splice(position, 1);
      answerPages = clone(placement.searchedAnswerPages);
      for (const page of answerPages) { const original = indexed.byPage.get(page); indexed.imageFor(page, original.file); }
      answerBlocks = [{ type: 'text', text: '原书未提供参考答案' }];
      notes.push({ kind: 'user-authorized-missing-reference', originalIssue: 'answer_missing', policy: clone(mapping.missingReferencePolicy), searchedAnswerPages: answerPages, agentReview: clone(placement.agentReview) });
    } else {
      // Preserve the unresolved absence as an issue, not a fictional answer.
      answerPages = Array.isArray(placement.searchedAnswerPages) ? clone(placement.searchedAnswerPages) : [];
      answerBlocks = [{ type: 'text', text: '待核对参考答案' }];
      if (placement.replacementBlocks?.answer !== undefined) issues.push('unpaired_answer_replacement_forbidden');
    }
    const stemBlocks = convertBlocks(placement.replacementBlocks?.stem ?? entry.stem.blocks, entry.stem, indexed, crops);
    if (beforeById && !same(beforeById.get(entry.id)?.source, { pages: entry.stem.source.pages, answerPages })) {
      throw new Error('correction task 的 source 与冻结基线不一致');
    }
    for (const side of [stemBlocks, answerBlocks]) if (side.some(block => !['text','image','sup','sub','analysis-separator'].includes(block.type))) issues.push('unsupported_native_format');
    return { id: entry.id, target: clone(placement.target), source: { pages: clone(entry.stem.source.pages), answerPages },
      stem: { blocks: stemBlocks }, answer: { blocks: answerBlocks }, answerRequirement: clone(placement.answerRequirement), answerStatus: placement.answerStatus,
      review: { status: 'pending', issues: [...new Set(issues)], checks: { sourceText: false, answerMatch: false, wholeQuestion: false, format: false } },
      preparation: { originalPairing: clone(entry.pairing), originalReview: clone(entry.review), records: { stem: clone(entry.stem), answer: clone(entry.answer) },
        ...(placement.agentReview ? { agentReview: clone(placement.agentReview), sourceVerifiedByTool: false } : {}), notes } };
  });
  // Coverage original images use the same indexed bytes as record provenance.
  for (const item of mapping.coverage?.pages ?? []) {
    const original = indexed.byPage.get(item.page);
    if (!original || item.imagePath !== original.file) throw new Error('coverage 每页必须绑定 index 的对应 imagePath 原图');
    indexed.imageFor(item.page, item.imagePath);
  }
  const manifest = { schemaVersion: 1, kind: 'new-system-batch', bookId: mapping.bookId, source: mapping.source, tasks,
    ...(beforeById ? { correction: clone(mapping.correction) } : {}),
    coverage: clone(mapping.coverage), preparation: { kind: 'local-paired-draft', ...clone(provenance), index: clone(mapping.index),
      ...(mapping.cropEvidence ? { cropEvidence: clone(mapping.cropEvidence) } : {}), unmatchedAnswerIds: clone(paired.unmatchedAnswerIds),
      unmatchedAnswers: clone(paired.preparation?.unmatchedAnswers ?? []),
      pairedWarnings: clone(paired.warnings ?? []), automaticallyApproved: false, sourceSemanticsVerifiedByTool: false } };
  const report = inspectReviewedBatch(manifest, baseDir);
  return { manifest, report, summary: { tasks: tasks.length, pending: tasks.length, issues: tasks.reduce((sum, task) => sum + task.review.issues.length, 0),
    sourceImagesVerified: indexed.loaded.size, knownMissingReferences: tasks.filter(task => task.preparation.notes.length).length,
    valid: report.valid, readyForExecution: false } };
}
