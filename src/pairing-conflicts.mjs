import { readFileSync, realpathSync, statSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { resolveAssetPath } from './core.mjs';
import { normalizeOcrText, preparePairedBatch, validatePairedBatch, pairingKey } from './paired-batch.mjs';
import { rasterDimensions } from './draft-batch.mjs';
import { sha256 } from './preparation-files.mjs';

const clone = structuredClone;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const hashString = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const inside = (root, file) => { const rel = path.relative(root, file); return rel === '' || !(rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)); };
const diagnostic = (code, message, extra = {}) => ({ code, message, ...extra, blocking: true, referenceOnly: true });

// Missing local images remain visible as diagnostics. Existing ancestors must
// still be inside this job, including when a junction targets a missing file.
function localBytes(baseDir, filename, { missing = false } = {}) {
  const root = realpathSync(baseDir), file = resolveAssetPath(filename, root);
  if (file === root) throw new Error('来源路径不能指向作业目录');
  let current = file;
  while (true) {
    try { lstatSync(current); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; current = path.dirname(current); }
  }
  if (!inside(root, realpathSync(current))) throw new Error('来源软链接/junction 越出同 job');
  try {
    const real = realpathSync(file);
    if (!inside(root, real) || !statSync(real).isFile()) throw new Error('来源路径越出同 job 或不是文件');
    return readFileSync(real);
  } catch (error) { if (missing && error.code === 'ENOENT') return null; throw error; }
}

function boundInput(baseDir, reference, value, label) {
  if (!object(reference) || typeof reference.path !== 'string' || path.basename(reference.path) !== reference.path
      || ['.', '..'].includes(reference.path) || !hashString(reference.sha256)) throw new Error(`${label} 必须是同 job 根目录的 {path,sha256} 引用`);
  const bytes = localBytes(baseDir, reference.path);
  if (sha256(bytes) !== reference.sha256) throw new Error(`${label} SHA256 不一致`);
  if (!isDeepStrictEqual(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, '')), value)) throw new Error(`${label} 对象与原文件内容不一致`);
  return clone(reference);
}

function preparedRecord(record) {
  const result = clone(record); result.cleanText = normalizeOcrText(record.rawOcr);
  result.blocks = record.blocks === undefined ? (result.cleanText.trim() ? [{ type: 'text', text: result.cleanText }] : [])
    : record.blocks.map(block => block.type === 'text' ? { ...clone(block), text: normalizeOcrText(block.text) }
      : block.type === 'image' ? { ...clone(block), align: 'center' } : clone(block));
  return result;
}

function indexedSources(index, bookId, baseDir) {
  if (!object(index) || index.schemaVersion !== 1 || index.bookId !== bookId || !Array.isArray(index.pages)) throw new Error('index 版本/bookId/pages 不一致');
  const byPage = new Map(), byFile = new Map(), cache = new Map();
  for (const entry of index.pages) {
    if (!object(entry) || !positive(entry.systemPage) || byPage.has(entry.systemPage) || typeof entry.file !== 'string'
        || byFile.has(entry.file) || !hashString(entry.sha256) || !positive(entry.width) || !positive(entry.height)) throw new Error('index 页码/路径/SHA256/尺寸无效或重复');
    resolveAssetPath(entry.file, baseDir); byPage.set(entry.systemPage, entry); byFile.set(entry.file, entry);
  }
  const image = filename => {
    if (cache.has(filename)) return cache.get(filename);
    const entry = byFile.get(filename), bytes = localBytes(baseDir, filename, { missing: true });
    if (bytes === null) {
      const result = { path: filename, page: entry?.systemPage ?? null, sha256: null, indexSha256: entry?.sha256 ?? null,
        verified: false, available: false, diagnostics: [diagnostic('source_image_missing', '声明原图在同 job 中不存在', { path: filename })] };
      cache.set(filename, result); return result;
    }
    const actual = rasterDimensions(bytes), actualHash = sha256(bytes), ext = path.extname(filename).toLowerCase();
    if ((actual.mimeType === 'image/png' ? ext !== '.png' : !['.jpg', '.jpeg'].includes(ext))) throw new Error(`原图 ${filename} MIME 与扩展名不一致`);
    if (entry && (actualHash !== entry.sha256 || actual.width !== entry.width || actual.height !== entry.height
        || entry.bytes !== undefined && entry.bytes !== bytes.length || entry.mimeType !== undefined && entry.mimeType !== actual.mimeType)) throw new Error(`原图 ${filename} SHA256/实际尺寸/字节/MIME 与 index 不一致`);
    const result = { path: filename, page: entry?.systemPage ?? null, sha256: actualHash, indexSha256: entry?.sha256 ?? null,
      ...actual, bytes: bytes.length, verified: Boolean(entry), available: true,
      diagnostics: entry ? [] : [diagnostic('source_image_not_indexed', '声明原图未列入 index，实际哈希仅供定位', { path: filename })] };
    cache.set(filename, result); return result;
  };
  const record = source => {
    const diagnostics = [], images = (source.images ?? []).map(filename => {
      const result = image(filename);
      if (result.page !== null && !source.pages.includes(result.page)) throw new Error('来源原图与声明来源页不一致');
      diagnostics.push(...result.diagnostics); return result;
    });
    for (const page of source.pages) if (!byPage.has(page)) diagnostics.push(diagnostic('source_page_not_indexed', '声明来源页未列入 index，不能认定答案页已查验', { page }));
    const regions = (source.regions ?? []).map(region => {
      const entry = byPage.get(region.page);
      if (entry && entry.file !== region.image) throw new Error('来源区域 page/image 与 index 原图路径不一致');
      const original = image(region.image), box = region.bbox;
      if (original.page !== null && original.page !== region.page) throw new Error('来源区域 page/image 不一致');
      if (original.available && (!Array.isArray(box) || box.length !== 4 || box.some(value => !Number.isSafeInteger(value) || value < 0)
          || box[2] <= box[0] || box[3] <= box[1] || box[2] > original.width || box[3] > original.height)) throw new Error('来源区域 bbox 须为有效原像素范围，不能越出实际原图');
      if (region.sha256 !== undefined && (!hashString(region.sha256)
          || (original.sha256 ?? original.indexSha256) !== null && region.sha256 !== (original.sha256 ?? original.indexSha256))) throw new Error('来源区域声明 SHA256 与原图不一致');
      return { ...clone(region), declaredSha256: region.sha256 ?? null, sha256: original.sha256, indexSha256: original.indexSha256,
        verified: original.verified && Boolean(entry), available: original.available };
    });
    if (!images.length) diagnostics.push(diagnostic('source_images_missing', '记录没有声明原图，不能证明题目或答案边界'));
    if (!regions.length) diagnostics.push(diagnostic('source_regions_missing', '记录没有声明原像素区域，不能证明题目或答案边界'));
    for (const page of source.pages) if (!regions.some(region => region.page === page)) diagnostics.push(diagnostic('source_page_unlocated', '声明来源页没有对应区域', { page }));
    return { pages: clone(source.pages), images: clone(images), regions, diagnostics };
  };
  return { record, cache };
}

/** Read-only localization; full IDs and raw text are never shortened or matched heuristically. */
export function buildPairingConflictsReport(paired, records, index, baseDir, provenance) {
  const root = realpathSync(baseDir);
  const inputs = Object.fromEntries([['paired', paired], ['records', records], ['index', index]]
    .map(([name, value]) => [name, boundInput(root, provenance?.[name], value, name)]));
  if (paired.preparation?.kind !== 'deterministic-local-pairing' || paired.preparation?.input?.path !== inputs.records.path
      || paired.preparation?.input?.sha256 !== inputs.records.sha256) throw new Error('paired.preparation.input 必须精确绑定同 job records 的路径与原始 SHA256');
  const validation = validatePairedBatch(paired, { baseDir: root, checkFiles: false });
  if (!validation.valid) throw new Error(`paired 输入无效：${validation.errors.join('; ')}`);
  const recomputed = preparePairedBatch(records); // Frozen records retain every original candidate and blocker.
  if (records.bookId !== paired.bookId) throw new Error('records 与 paired bookId 不一致');
  const questions = new Map(records.questions.map(record => [record.id, record])), answers = new Map(records.answers.map(record => [record.id, record]));
  if (questions.size !== paired.tasks.length || paired.tasks.some(task => !questions.has(task.id))) throw new Error('paired 必须保留 records 全部题干身份，不能漏题或换 ID');
  for (const task of paired.tasks) {
    if (!isDeepStrictEqual(task.stem, preparedRecord(questions.get(task.id)))) throw new Error(`${task.id} 题干记录与 records 身份/全文/来源不一致`);
    if (task.answer && (!answers.has(task.answer.id) || !isDeepStrictEqual(task.answer, preparedRecord(answers.get(task.answer.id))))) throw new Error(`${task.id} 答案记录与 records 身份/全文/来源不一致`);
  }
  if (paired.unmatchedAnswerIds.some(id => !answers.has(id))) throw new Error('unmatchedAnswerIds 引用了未知 records 答案');
  const recomputedTasks = new Map(recomputed.tasks.map(task => [task.id, task]));
  const indexed = indexedSources(index, paired.bookId, root), answerUse = new Map(), questionUse = new Map();
  for (const task of paired.tasks) {
    if (task.answer) answerUse.set(task.answer.id, [...(answerUse.get(task.answer.id) ?? []), task.id]);
    const key = pairingKey(task.stem); if (key !== null) questionUse.set(key, [...(questionUse.get(key) ?? []), task.id]);
  }
  const conflicts = [];
  for (const task of paired.tasks) {
    const original = recomputedTasks.get(task.id), reasons = new Set([...task.pairing.issues, ...task.review.issues,
      ...original.pairing.issues, ...original.review.issues]);
    if (!isDeepStrictEqual(task.pairing, original.pairing)) reasons.add('pairing_metadata_changed');
    if (!isDeepStrictEqual(task.review.issues, original.review.issues)) reasons.add('review_issues_changed');
    if ((task.answer?.id ?? null) !== (original.answer?.id ?? null)) reasons.add('answer_selection_changed');
    if (task.pairing.method === 'none') reasons.add('pairing_unresolved');
    if (!task.answer) reasons.add('answer_missing');
    if (task.pairing.candidateIds.length !== 1) reasons.add('answer_candidate_not_unique');
    if (task.review.status === 'review_required') reasons.add('review_required');
    const relatedQuestionIds = questionUse.get(pairingKey(task.stem)) ?? [];
    if (relatedQuestionIds.length > 1 && task.pairing.method !== 'explicit') reasons.add('duplicate_question_key');
    const sharedAnswerTaskIds = task.answer ? answerUse.get(task.answer.id) : [];
    if (sharedAnswerTaskIds.length > 1) reasons.add('answer_reused');
    if (task.answer && (String(task.stem.chapter) !== String(task.answer.chapter) || String(task.stem.unit ?? '') !== String(task.answer.unit ?? ''))) reasons.add('declared_answer_scope_mismatch');
    if (!reasons.size) continue;
    const question = { record: clone(task.stem), sourceEvidence: indexed.record(task.stem.source) };
    const candidateIds = [...task.pairing.candidateIds], computedCandidateIds = [...original.pairing.candidateIds],
      answerIds = [...new Set([...candidateIds, ...computedCandidateIds, ...(task.answer ? [task.answer.id] : [])])];
    const candidates = answerIds.map(id => {
      const original = answers.get(id);
      if (!original) return { candidateId: id, declaredCandidate: candidateIds.includes(id), computedCandidate: computedCandidateIds.includes(id), selectedInInput: false, found: false,
        referenceOnly: true, record: null, sourceEvidence: null, diagnostics: [diagnostic('candidate_record_missing', '候选 ID 在字节绑定 records 中不存在；报告不会猜测或替换答案', { candidateId: id })] };
      const record = preparedRecord(original), probe = preparePairedBatch({ schemaVersion: 1, bookId: paired.bookId,
        questions: [questions.get(task.id)], answers: [original], pairings: [{ questionId: task.id, answerId: id }] });
      const diagnostics = probe.tasks[0].pairing.issues.filter(issue => issue.startsWith('answer_'))
        .map(issue => diagnostic(issue, '候选答案仍需按原图核对，不能据此解除问题', { candidateId: id }));
      return { candidateId: id, declaredCandidate: candidateIds.includes(id), computedCandidate: computedCandidateIds.includes(id), selectedInInput: task.answer?.id === id,
        found: true, referenceOnly: true, record, sourceEvidence: indexed.record(record.source), diagnostics };
    });
    conflicts.push({ taskId: task.id, blocking: true, referenceOnly: true, reasons: [...reasons],
      originalPairing: clone(task.pairing), originalReview: clone(task.review), recomputedPairing: clone(original.pairing),
      recomputedReview: clone(original.review), selectedAnswerId: task.answer?.id ?? null,
      candidateIds: clone(candidateIds), computedCandidateIds, relatedQuestionIds: [...relatedQuestionIds], sharedAnswerTaskIds: [...sharedAnswerTaskIds], question, answers: candidates });
  }
  return { schemaVersion: 1, kind: 'pairing-conflicts-report', bookId: paired.bookId,
    referenceOnly: true, readyForExecution: false, automaticallyApproved: false,
    platformWritePerformed: false, sourceSemanticsVerifiedByTool: false, inputs,
    summary: { totalTasks: paired.tasks.length, conflictTasks: conflicts.length,
      candidateAnswers: conflicts.reduce((count, conflict) => count + conflict.answers.length, 0), sourceImagesRead: [...indexed.cache.values()].filter(image => image.available).length,
      sourceImagesUnavailable: [...indexed.cache.values()].filter(image => !image.available).length,
      unmatchedAnswers: paired.unmatchedAnswerIds.length },
    unmatchedAnswerIds: clone(paired.unmatchedAnswerIds), recomputedUnmatchedAnswerIds: clone(recomputed.unmatchedAnswerIds), warnings: clone(paired.warnings ?? []),
    validation: { paired: validation }, conflicts };
}
