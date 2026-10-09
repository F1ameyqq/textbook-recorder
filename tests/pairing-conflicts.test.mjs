import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { preparePairedBatch } from '../src/paired-batch.mjs';
import { sha256 } from '../src/preparation-files.mjs';
import { buildPairingConflictsReport } from '../src/pairing-conflicts.mjs';
import { reportPairingConflicts } from '../scripts/report-pairing-conflicts.mjs';

const copy = structuredClone;
function png(width, height) {
  const crc = bytes => { let sum = 0xffffffff; for (const byte of bytes) { sum ^= byte; for (let i = 0; i < 8; i++) sum = sum & 1 ? 0xedb88320 ^ sum >>> 1 : sum >>> 1; } return (sum ^ 0xffffffff) >>> 0; };
  const chunk = (name, data) => { const body = Buffer.concat([Buffer.from(name), data]), length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(body)); return Buffer.concat([length, body, checksum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc(height * (1 + width * 3), 255))), chunk('IEND', Buffer.alloc(0))]);
}

async function fixture(t) {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'recorder-pairing-conflicts-'));
  t.after(async () => { assert.equal(path.dirname(project), path.resolve(os.tmpdir())); assert.ok(path.basename(project).startsWith('recorder-pairing-conflicts-')); await fs.rm(project, { recursive: true, force: true }); });
  const baseDir = path.join(project, 'data', 'jobs', 'synthetic'); await fs.mkdir(path.join(baseDir, 'images'), { recursive: true });
  const bytes = png(2, 2), pages = [];
  for (let page = 1; page <= 5; page++) {
    const file = `images/page-${page}.png`; if (page < 5) await fs.writeFile(path.join(baseDir, file), bytes);
    pages.push({ systemPage: page, file, sha256: sha256(bytes), width: 2, height: 2, bytes: bytes.length, mimeType: 'image/png' });
  }
  const source = chosen => ({ pages: chosen, images: chosen.map(page => pages[page - 1].file), regions: chosen.map(page => ({ page, image: pages[page - 1].file, bbox: [0,0,2,2] })) });
  const record = (id, number, rawOcr, chosen) => ({ id, chapter: '同名章', unit: '同名节', group: '基础', questionNumber: number, rawOcr, source: source(chosen) });
  const records = { schemaVersion: 1, bookId: 900003, questions: [
    record('question-ambiguous-full-id-001', 1, '1. 第一段完整问题。\n第二段含 R₁、10³ 和条件 x > 0。\n请分别说明两部分。', [1,2]),
    record('question-missing-full-id-002', 2, '2. 没有对应答案的完整问题。', [1]),
    record('question-resolved-003', 3, '3. 已有唯一答案。', [1])
  ], answers: [
    record('answer-same-number-full-id-left', 1, '1. 同名候选：左答案完整第一行。\n第二行不能截断。', [3]),
    record('answer-same-number-full-id-right', 1, '1. 同名候选：右答案第3页。\n续接第4页完整答案。', [3,4]),
    record('answer-resolved-003', 3, '唯一已配答案；其原图不应在冲突报告中读取。', [5])
  ] };
  records.questions[0].blocks = [{ type: 'text', text: records.questions[0].rawOcr }, { type: 'latex', latex: '\\frac{1}{2}', display: true }];
  const f = { project, baseDir, records, index: { schemaVersion: 1, bookId: records.bookId, pages }, source, record, bytes };
  f.paired = preparePairedBatch(records); await save(f); return f;
}

async function save(f) {
  const recordBytes = Buffer.from(JSON.stringify(f.records)), indexBytes = Buffer.from(JSON.stringify(f.index));
  f.paired.preparation = { kind: 'deterministic-local-pairing', input: { path: 'records.json', sha256: sha256(recordBytes) }, automaticallyApproved: false,
    unmatchedAnswers: f.records.answers.filter(record => f.paired.unmatchedAnswerIds.includes(record.id)) };
  const pairedBytes = Buffer.from(JSON.stringify(f.paired));
  for (const [file, bytes] of [['records.json', recordBytes], ['index.json', indexBytes], ['paired.json', pairedBytes]]) await fs.writeFile(path.join(f.baseDir, file), bytes);
  f.provenance = { paired: { path: 'paired.json', sha256: sha256(pairedBytes) }, records: { path: 'records.json', sha256: sha256(recordBytes) }, index: { path: 'index.json', sha256: sha256(indexBytes) } };
}
const args = (output = 'conflicts.json') => ['--input=data/jobs/synthetic/paired.json', '--records=data/jobs/synthetic/records.json', '--index=data/jobs/synthetic/index.json', `--output=data/jobs/synthetic/${output}`];
const run = (f, output) => reportPairingConflicts(args(output), { project: f.project, cwd: f.project });

test('ambiguous and missing pairs expose complete records, full IDs, all candidate regions and hashes without changing blockers', async t => {
  const f = await fixture(t), before = await Promise.all(['records.json','index.json','paired.json'].map(file => fs.readFile(path.join(f.baseDir, file))));
  const result = await run(f), report = JSON.parse(await fs.readFile(result.outputPath, 'utf8'));
  assert.equal(result.reportCreated, true); assert.equal(result.referenceOnly, true); assert.equal(result.readyForExecution, false);
  assert.equal(result.platformWritePerformed, false); assert.equal(result.sourceSemanticsVerifiedByTool, false);
  assert.equal(report.platformWritePerformed, false); assert.equal(report.sourceSemanticsVerifiedByTool, false);
  assert.equal(report.automaticallyApproved, false); assert.equal(report.summary.conflictTasks, 2); assert.equal(report.summary.sourceImagesRead, 4);
  const conflict = report.conflicts[0]; assert.equal(conflict.taskId, f.records.questions[0].id); assert.equal(conflict.blocking, true);
  assert.deepEqual(conflict.originalPairing, f.paired.tasks[0].pairing); assert.deepEqual(conflict.originalReview, f.paired.tasks[0].review);
  assert.equal(conflict.selectedAnswerId, null); assert.deepEqual(conflict.candidateIds, f.records.answers.slice(0,2).map(answer => answer.id));
  assert.equal(conflict.question.record.rawOcr, f.records.questions[0].rawOcr); assert.deepEqual(conflict.question.record.blocks, f.paired.tasks[0].stem.blocks);
  assert.deepEqual(conflict.answers.map(answer => answer.record.rawOcr), f.records.answers.slice(0,2).map(answer => answer.rawOcr));
  assert.deepEqual(conflict.answers[1].sourceEvidence.regions.map(region => region.page), [3,4]);
  for (const side of [conflict.question, ...conflict.answers]) for (const region of side.sourceEvidence.regions) {
    assert.deepEqual(region.bbox, [0,0,2,2]); assert.equal(region.sha256, sha256(f.bytes)); assert.equal(region.indexSha256, sha256(f.bytes)); assert.equal(region.verified, true);
  }
  assert.deepEqual(report.inputs, f.provenance); assert.equal(report.conflicts[1].answers.length, 0); assert.ok(report.conflicts[1].reasons.includes('answer_missing'));
  assert.deepEqual(await Promise.all(['records.json','index.json','paired.json'].map(file => fs.readFile(path.join(f.baseDir, file)))), before);
  await assert.rejects(fs.access(path.join(f.baseDir, 'images/page-5.png')), /ENOENT/); // Unrelated accepted pair remains unread.
});

test('unknown candidate IDs remain explicit missing records and unknown answers never become replacements', async t => {
  const f = await fixture(t); f.records.answers[0].rawOcr = '未知'; f.records.answers[0].unknown = true; f.paired = preparePairedBatch(f.records);
  f.paired.tasks[0].pairing.candidateIds.push('unknown-candidate-full-id'); await save(f);
  const report = buildPairingConflictsReport(f.paired, f.records, f.index, f.baseDir, f.provenance), conflict = report.conflicts[0];
  const unknown = conflict.answers.find(answer => !answer.found); assert.equal(unknown.candidateId, 'unknown-candidate-full-id'); assert.equal(unknown.record, null);
  assert.equal(unknown.diagnostics[0].code, 'candidate_record_missing'); assert.equal(conflict.answers[0].record.rawOcr, '未知'); assert.ok(conflict.answers[0].diagnostics.some(item => item.code === 'answer_unknown'));
  assert.equal(conflict.originalReview.status, 'review_required'); assert.equal(conflict.selectedAnswerId, null); assert.equal(report.readyForExecution, false);
});

test('missing indexed answer pages or local images are diagnostic and never claim original verification', async t => {
  const f = await fixture(t); f.records.answers[1].source.regions[0].sha256 = sha256(f.bytes); f.paired = preparePairedBatch(f.records);
  f.index.pages = f.index.pages.filter(page => page.systemPage !== 4); await fs.unlink(path.join(f.baseDir, 'images/page-3.png')); await save(f);
  const report = buildPairingConflictsReport(f.paired, f.records, f.index, f.baseDir, f.provenance), evidence = report.conflicts[0].answers[1].sourceEvidence;
  assert.ok(evidence.diagnostics.some(item => item.code === 'source_page_not_indexed' && item.page === 4));
  assert.equal(evidence.regions[0].sha256, null); assert.equal(evidence.regions[0].declaredSha256, sha256(f.bytes)); assert.equal(evidence.regions[0].available, false); assert.equal(evidence.regions[0].verified, false);
  assert.equal(evidence.regions[1].sha256, sha256(f.bytes)); assert.equal(evidence.regions[1].indexSha256, null); assert.equal(evidence.regions[1].verified, false);
  assert.equal(report.conflicts[0].blocking, true); assert.deepEqual(report.conflicts[0].originalPairing, f.paired.tasks[0].pairing);
});

test('reused answers and duplicate question keys retain separate question identities and original issues', async t => {
  const f = await fixture(t); f.records.questions[1].questionNumber = 1; f.records.pairings = f.records.questions.slice(0,2).map(question => ({ questionId: question.id, answerId: f.records.answers[0].id }));
  f.paired = preparePairedBatch(f.records); await save(f); const report = buildPairingConflictsReport(f.paired, f.records, f.index, f.baseDir, f.provenance);
  assert.equal(report.conflicts.length, 2); for (const conflict of report.conflicts) {
    assert.ok(conflict.originalPairing.issues.includes('answer_reused')); assert.deepEqual(conflict.sharedAnswerTaskIds, f.records.questions.slice(0,2).map(question => question.id));
    assert.deepEqual(conflict.relatedQuestionIds, f.records.questions.slice(0,2).map(question => question.id)); assert.equal(conflict.answers[0].selectedInInput, true); assert.equal(conflict.referenceOnly, true);
  }
  delete f.records.pairings; f.paired = preparePairedBatch(f.records); await save(f);
  const duplicates = buildPairingConflictsReport(f.paired, f.records, f.index, f.baseDir, f.provenance); assert.ok(duplicates.conflicts.every(conflict => conflict.reasons.includes('duplicate_question_key')));
});

test('changed raw records binding, record identity, original hashes and source geometry fail before output', async t => {
  for (const mode of ['binding', 'identity', 'hash', 'dimensions', 'page-image', 'bbox', 'region-hash']) await t.test(mode, async child => {
    const f = await fixture(child);
    if (mode === 'binding') f.paired.preparation.input.sha256 = '0'.repeat(64);
    if (mode === 'identity') f.paired.tasks[0].stem.rawOcr = f.paired.tasks[0].stem.cleanText = '替换全文';
    if (mode === 'hash') f.index.pages[2].sha256 = '0'.repeat(64);
    if (mode === 'dimensions') f.index.pages[2].width = 3;
    if (mode === 'page-image') { f.records.answers[1].source.regions[1].image = f.index.pages[2].file; f.paired = preparePairedBatch(f.records); }
    if (mode === 'bbox') { f.records.answers[1].source.regions[1].bbox = [0,0,3,2]; f.paired = preparePairedBatch(f.records); }
    if (mode === 'region-hash') { f.records.answers[1].source.regions[1].sha256 = '0'.repeat(64); f.paired = preparePairedBatch(f.records); }
    if (mode === 'binding') { const bytes = Buffer.from(JSON.stringify(f.paired)); await fs.writeFile(path.join(f.baseDir, 'paired.json'), bytes); }
    else await save(f);
    await assert.rejects(run(f), /SHA256|身份|实际尺寸|原图路径|bbox/); await assert.rejects(fs.access(path.join(f.baseDir, 'conflicts.json')), /ENOENT/);
  });
});

test('a changed input file cannot be rebound by passing stale objects to the report API', async t => {
  const f = await fixture(t); await fs.appendFile(path.join(f.baseDir, 'records.json'), '\n');
  assert.throws(() => buildPairingConflictsReport(f.paired, f.records, f.index, f.baseDir, f.provenance), /records SHA256/);
  await assert.rejects(run(f), /paired.preparation.input/);
});

test('all CLI files share one job, outputs cannot overwrite inputs or existing reports, and flags are strict', async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.project, 'data/jobs/other')); await fs.writeFile(path.join(f.project, 'data/jobs/other/index.json'), JSON.stringify(f.index));
  await assert.rejects(reportPairingConflicts(args().map(value => value.startsWith('--index=') ? '--index=data/jobs/other/index.json' : value), { project: f.project, cwd: f.project }), /同一/);
  await assert.rejects(run(f, '../other/conflicts.json'), /同一/);
  await assert.rejects(run(f, 'paired.json'), /EEXIST/); const result = await run(f), bytes = await fs.readFile(result.outputPath);
  await assert.rejects(run(f), /EEXIST/); assert.deepEqual(await fs.readFile(result.outputPath), bytes);
  await assert.rejects(reportPairingConflicts([...args(), '--input=extra.json'], { project: f.project, cwd: f.project }), /重复/);
  await assert.rejects(reportPairingConflicts([...args(), '--execute=true'], { project: f.project, cwd: f.project }), /未知/);
  await assert.rejects(reportPairingConflicts(args().filter(value => !value.startsWith('--records=')), { project: f.project, cwd: f.project }), /必须明确提供/);
  assert.match((await reportPairingConflicts(['--help'])).help, /--records=.*--index=/);
});

test('lexical and actual image junction escapes are rejected without reading external originals', async t => {
  const f = await fixture(t); f.records.answers[0].source.images = ['../outside.png']; f.paired = copy(f.paired); f.paired.preparation.input.sha256 = sha256(Buffer.from(JSON.stringify(f.records)));
  await save(f); await assert.rejects(run(f), /越界|无效/);
  const restored = await fixture(t), outside = await fs.mkdtemp(path.join(os.tmpdir(), 'recorder-pairing-outside-')); t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'page.png'), restored.bytes); const link = path.join(restored.baseDir, 'foreign');
  try { await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) { t.skip('Windows 无权创建实际 junction'); return; } throw error; }
  restored.index.pages[2].file = 'foreign/page.png'; for (const answer of restored.records.answers.slice(0,2)) {
    answer.source.images[0] = 'foreign/page.png'; answer.source.regions[0].image = 'foreign/page.png';
  }
  restored.paired = preparePairedBatch(restored.records); await save(restored); await assert.rejects(run(restored), /越出同 job/);
  await assert.rejects(fs.access(path.join(restored.baseDir, 'conflicts.json')), /ENOENT/);
});

test('explicit scope conflicts are reported without selecting a new answer or altering pending state', async t => {
  const f = await fixture(t); f.records.answers[0].chapter = '另章'; f.records.pairings = [{ questionId: f.records.questions[0].id, answerId: f.records.answers[0].id }];
  f.paired = preparePairedBatch(f.records); await save(f); const report = buildPairingConflictsReport(f.paired, f.records, f.index, f.baseDir, f.provenance), conflict = report.conflicts[0];
  assert.equal(conflict.originalReview.status, 'pending'); assert.deepEqual(conflict.originalReview.issues, []); assert.ok(conflict.reasons.includes('declared_answer_scope_mismatch'));
  assert.equal(conflict.selectedAnswerId, f.records.answers[0].id); assert.equal(conflict.answers.length, 1); assert.equal(report.readyForExecution, false); assert.deepEqual(f.paired.tasks[0].review, conflict.originalReview);
});

test('edited candidate lists and cleared issues cannot hide the frozen records conflict or its other answers', async t => {
  const f = await fixture(t), task = f.paired.tasks[0];
  task.answer = copy(f.paired.preparation.unmatchedAnswers[0]); task.answer.cleanText = task.answer.rawOcr; task.answer.blocks = [{ type: 'text', text: task.answer.rawOcr }];
  task.pairing = { method: 'chapter_number', candidateIds: [task.answer.id], issues: [] }; task.review = { status: 'approved', issues: [] }; await save(f);
  const report = buildPairingConflictsReport(f.paired, f.records, f.index, f.baseDir, f.provenance), conflict = report.conflicts[0];
  assert.equal(conflict.originalReview.status, 'approved'); assert.deepEqual(conflict.originalReview.issues, []);
  assert.ok(conflict.reasons.includes('multiple_answer_candidates')); assert.ok(conflict.reasons.includes('pairing_metadata_changed')); assert.ok(conflict.reasons.includes('review_issues_changed'));
  assert.deepEqual(conflict.recomputedPairing.candidateIds, f.records.answers.slice(0,2).map(answer => answer.id)); assert.equal(conflict.recomputedReview.status, 'review_required');
  assert.equal(conflict.answers.length, 2); const hidden = conflict.answers.find(answer => !answer.declaredCandidate);
  assert.equal(hidden.computedCandidate, true); assert.equal(hidden.record.rawOcr, f.records.answers[1].rawOcr); assert.equal(conflict.blocking, true); assert.equal(report.readyForExecution, false);
});

test('clearing answer_unknown and approving an unknown selected answer is refused without creating a report', async t => {
  const f = await fixture(t); f.records.answers[0].rawOcr = '未知'; f.records.pairings = [{ questionId: f.records.questions[0].id, answerId: f.records.answers[0].id }];
  f.paired = preparePairedBatch(f.records); const task = f.paired.tasks[0]; assert.ok(task.pairing.issues.includes('answer_unknown'));
  task.pairing.issues = []; task.review = { status: 'approved', issues: [] }; await save(f);
  await assert.rejects(run(f), /answer_unknown.*review_required/); await assert.rejects(fs.access(path.join(f.baseDir, 'conflicts.json')), /ENOENT/);
});
