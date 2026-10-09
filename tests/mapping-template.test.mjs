import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { deflateSync } from 'node:zlib';
import { preparePairedBatch } from '../src/paired-batch.mjs';
import { createMappingTemplate } from '../src/mapping-template.mjs';
import { prepareDraftBatch } from '../src/draft-batch.mjs';
import { sha256 } from '../src/preparation-files.mjs';
import { createMapping } from '../scripts/create-mapping-template.mjs';

function png(width, height) {
  const crc = bytes => { let sum = 0xffffffff; for (const byte of bytes) { sum ^= byte; for (let i = 0; i < 8; i++) sum = sum & 1 ? 0xedb88320 ^ sum >>> 1 : sum >>> 1; } return (sum ^ 0xffffffff) >>> 0; };
  const chunk = (name, data) => { const body = Buffer.concat([Buffer.from(name), data]), length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(body)); return Buffer.concat([length, body, checksum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc(height * (1 + width * 3), 255))), chunk('IEND', Buffer.alloc(0))]);
}

async function fixture(t) {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'recorder-mapping-test-'));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const baseDir = path.join(project, 'data', 'jobs', 'synthetic');
  await fs.mkdir(path.join(baseDir, 'images'), { recursive: true });
  const bytes = png(3, 2), pages = [];
  for (let page = 1; page <= 3; page++) {
    const file = `images/page-${page}.png`; await fs.writeFile(path.join(baseDir, file), bytes);
    pages.push({ systemPage: page, file, sha256: sha256(bytes), width: 3, height: 2, bytes: bytes.length, mimeType: 'image/png' });
  }
  const source = selected => ({ pages: selected, images: selected.map(page => pages[page - 1].file),
    regions: selected.map(page => ({ page, image: pages[page - 1].file, bbox: [0, 0, 3, 2] })) });
  const record = (id, number, text, selected) => ({ id, chapter: '合成章', unit: '合成节', group: '基础', questionNumber: number, rawOcr: text, source: source(selected) });
  const records = { schemaVersion: 1, bookId: 900101,
    questions: [record('q1', 1, '1. 分析两页合成材料并回答。', [1, 2]), record('q2', 2, '2. 填写合成结果。', [2])],
    answers: [record('a1', 1, '合成分析。', [3]), record('a2', 2, '合成结果。', [3])] };
  const paired = preparePairedBatch(records);
  const plan = { schemaVersion: 1, kind: 'local-workflow-plan', bookId: records.bookId, source: 'fixture',
    scope: { pages: [1, 2, 3], sections: [{ chapterLabel: '合成章', sectionLabel: '合成节', startRecord: 7, recordLimit: 2 }] } };
  const order = { schemaVersion: 1, kind: 'confirmed-question-order', bookId: records.bookId, confirmed: true,
    sections: [{ chapterLabel: '合成章', sectionLabel: '合成节', questionIds: ['q1', 'q2'] }] };
  const index = { schemaVersion: 1, bookId: records.bookId, pages };
  const references = {};
  const save = async (role, value, filename = `${role}.json`) => {
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
    await fs.writeFile(path.join(baseDir, filename), bytes);
    references[role] = { path: filename, sha256: sha256(bytes) };
    return references[role];
  };
  for (const [role, value] of Object.entries({ paired, plan, order, index })) await save(role, value);
  const baseline = (count = 6, chapterLabel = '合成章', sectionLabel = '合成节', nodeID = 401) => ({
    bookId: records.bookId, chapterLabel, sectionLabel, nodeID, serverSnapshotAt: '2026-10-09T00:00:00Z',
    records: Array.from({ length: count }, (_, index) => ({ seqIndex: index + 1, shitiID: 700 + index, nodeID })) });
  const argv = (output = 'mapping.template.json') => ['--input=data/jobs/synthetic/paired.json', '--plan=data/jobs/synthetic/plan.json',
    '--order=data/jobs/synthetic/order.json', '--index=data/jobs/synthetic/index.json', `--output=data/jobs/synthetic/${output}`];
  return { project, baseDir, records, paired, plan, order, index, references, save, baseline, argv };
}

test('CLI uses confirmed order and explicit fixture start, preserving real byte-bound pair identities without approval', async t => {
  const f = await fixture(t);
  f.paired.tasks[0].review.status = 'approved'; await f.save('paired', f.paired);
  const result = await createMapping(f.argv(), { project: f.project, cwd: f.project });
  const bytes = await fs.readFile(result.outputPath), mapping = JSON.parse(bytes);
  assert.equal(result.outputSha256, sha256(bytes)); assert.equal(result.approved, 0); assert.equal(result.readyForExecution, false);
  assert.equal(result.platformWritePerformed, false); assert.equal(mapping.preparation.platformWritePerformed, false);
  assert.equal(mapping.kind, 'new-system-draft-mapping'); assert.deepEqual(mapping.placements.map(item => [item.questionId, item.target.record]), [['q1', 7], ['q2', 8]]);
  assert.deepEqual(mapping.index, f.references.index); assert.equal(mapping.preparation.automaticallyApproved, false);
  assert.ok(mapping.placements.every(item => item.review.status === 'pending' && Object.values(item.review.checks).every(value => value === false)
    && item.agentReview.checkedAgainstOriginal === false && item.agentReview.evidence === '' && item.review.evidence === ''));
  assert.deepEqual(mapping.placements[0].answerRequirement, { kind: null, evidence: '' });
  const origin = mapping.sourceReferences[0];
  assert.equal(origin.referenceOnly, true); assert.equal(origin.stem.recordId, 'q1'); assert.equal(origin.answer.recordId, 'a1');
  assert.equal(origin.pairedTask.sha256, f.references.paired.sha256); assert.equal(origin.pairedTask.jsonPointer, '/tasks/0');
  assert.deepEqual(origin.stem.regions.map(region => region.bbox), [[0, 0, 3, 2], [0, 0, 3, 2]]);
  assert.ok([...origin.stem.images, ...origin.answer.images].every(image => image.sha256 === f.index.pages[0].sha256 && image.referenceOnly));
  assert.ok(mapping.coverage.pages.every(page => page.candidates.length === 0 && page.referenceOnly && page.coverageChecked === false && page.evidence === ''));
  assert.equal(mapping.preparation.questionOrderInferredByTool, false); assert.equal(mapping.preparation.coverageInferredByTool, false);
});

test('requiredFields explain the blocked skeleton; concrete completion runs the existing draft as pending', async t => {
  const f = await fixture(t), mapping = createMappingTemplate(f.references, f.baseDir);
  assert.ok(mapping.requiredFields.includes('placements[0].answerRequirement.evidence'));
  assert.ok(mapping.requiredFields.includes('coverage.pages[0].candidates'));
  assert.throws(() => prepareDraftBatch(f.paired, mapping, f.baseDir), /作答要求/);
  mapping.placements.forEach((placement, index) => { placement.answerRequirement = { kind: index ? 'fill-in' : 'question', evidence: f.records.questions[index].rawOcr }; });
  const uncovered = prepareDraftBatch(f.paired, mapping, f.baseDir);
  assert.equal(uncovered.report.valid, false); assert.ok(uncovered.report.errors.some(error => /candidates|候选映射/u.test(error)));
  mapping.coverage.pages[0].candidates = [{ id: 'q1-page1', type: 'question', decision: 'include', taskIds: ['q1'] }];
  mapping.coverage.pages[1].candidates = [{ id: 'q1-page2', type: 'question', decision: 'include', taskIds: ['q1'] }, { id: 'q2-page2', type: 'question', decision: 'include', taskIds: ['q2'] }];
  mapping.coverage.pages[2].candidates = [{ id: 'answer-page3', type: 'non-question', decision: 'exclude', taskIds: [], reason: '合成夹具的参考答案展示页，无正文作答要求' }];
  for (const page of mapping.coverage.pages) { page.coverageChecked = true; page.evidence = '合成夹具逐页确认'; }
  mapping.coverage.coverageChecked = true; mapping.coverage.evidence = '合成夹具逐页候选确认';
  const { manifest, report, summary } = prepareDraftBatch(f.paired, mapping, f.baseDir);
  assert.equal(report.valid, true); assert.equal(report.readyForExecution, false); assert.equal(summary.readyForExecution, false);
  assert.ok(manifest.tasks.every(task => task.review.status === 'pending' && Object.values(task.review.checks).every(value => value === false)));
  assert.deepEqual(manifest.tasks.map(task => task.target.record), [7, 8]);
});

test('unresolved missing answer and pairing issues survive; no absence policy or semantic requirement is manufactured', async t => {
  const f = await fixture(t); f.records.answers.pop(); f.paired = preparePairedBatch(f.records); await f.save('paired', f.paired);
  const mapping = createMappingTemplate(f.references, f.baseDir), placement = mapping.placements[1];
  assert.equal(placement.answerStatus, null); assert.equal(mapping.sourceReferences[1].answer, null);
  assert.ok(placement.review.issues.includes('answer_missing')); assert.ok(mapping.sourceReferences[1].pairing.issues.includes('answer_missing'));
  assert.ok(mapping.requiredFields.includes('placements[1].answerStatus')); assert.equal(mapping.missingReferencePolicy, undefined);
  mapping.placements.forEach(item => { item.answerRequirement = { kind: 'question', evidence: '合成问题要求回答' }; }); placement.answerStatus = 'not-provided';
  const result = prepareDraftBatch(f.paired, mapping, f.baseDir);
  assert.ok(result.manifest.tasks[1].review.issues.includes('answer_missing')); assert.equal(result.report.valid, false);
  assert.equal(result.manifest.tasks[1].answer.blocks[0].text, '待核对参考答案');
});

test('production requires full baseline and rejects conflict rather than shifting the declared start', async t => {
  const f = await fixture(t); f.plan.source = 'production'; await f.save('plan', f.plan);
  assert.throws(() => createMappingTemplate(f.references, f.baseDir), /baseline/);
  await f.save('baseline', f.baseline());
  const mapping = createMappingTemplate(f.references, f.baseDir);
  assert.equal(mapping.placements[0].target.record, 7); assert.deepEqual(mapping.preparation.references.baseline, f.references.baseline);
  const result = await createMapping([...f.argv(), '--baseline=data/jobs/synthetic/baseline.json'], { project: f.project, cwd: f.project });
  assert.equal(result.source, 'production'); assert.equal(result.readyForExecution, false);
  f.plan.scope.sections[0].startRecord = 9; await f.save('plan', f.plan);
  assert.throws(() => createMappingTemplate(f.references, f.baseDir), /startRecord.*不能静默平移/);
  assert.equal(f.plan.scope.sections[0].startRecord, 9);
});

test('multi-section production baselines are directory-bound with independent explicit starts', async t => {
  const f = await fixture(t); f.plan.source = 'production';
  f.plan.scope.sections[0].recordLimit = 1;
  f.plan.scope.sections.push({ chapterLabel: '合成章', sectionLabel: '第二节', startRecord: 2, recordLimit: 1 });
  f.order.sections[0].questionIds = ['q1']; f.order.sections.push({ chapterLabel: '合成章', sectionLabel: '第二节', questionIds: ['q2'] });
  await f.save('plan', f.plan); await f.save('order', f.order);
  await f.save('baseline', { kind: 'local-section-baselines', bookId: f.plan.bookId, scopes: [f.baseline(), f.baseline(1, '合成章', '第二节', 402)] });
  const mapping = createMappingTemplate(f.references, f.baseDir);
  assert.deepEqual(mapping.placements.map(item => [item.target.sectionLabel, item.target.record]), [['合成节', 7], ['第二节', 2]]);
  const broken = { kind: 'local-section-baselines', bookId: f.plan.bookId, scopes: [f.baseline()] }; await f.save('baseline', broken);
  assert.throws(() => createMappingTemplate(f.references, f.baseDir), /startRecord/);
});

test('count-only, gapped, duplicate, wrong-directory or untimed baselines fail closed', async t => {
  const f = await fixture(t); f.plan.source = 'production'; await f.save('plan', f.plan);
  const invalid = [
    { ...f.baseline(), records: undefined, recordCount: 6 },
    { ...f.baseline(), bookId: f.plan.bookId + 1 },
    { ...f.baseline(), sectionLabel: '其他节' },
    { ...f.baseline(), serverSnapshotAt: undefined },
    { ...f.baseline(), records: f.baseline().records.map((record, index) => ({ ...record, seqIndex: index === 2 ? 4 : record.seqIndex })) },
    { ...f.baseline(), records: f.baseline().records.map(record => ({ ...record, shitiID: 700 })) },
    { ...f.baseline(), records: f.baseline().records.map(record => ({ ...record, nodeID: 999 })) },
    { kind: 'local-section-baselines', bookId: f.plan.bookId, scopes: [f.baseline(), f.baseline()] },
  ];
  for (const baseline of invalid) { await f.save('baseline', baseline); assert.throws(() => createMappingTemplate(f.references, f.baseDir), /baseline|startRecord|基线/); }
});

test('fixture has no implicit start or baseline-based repositioning', async t => {
  const f = await fixture(t); delete f.plan.scope.sections[0].startRecord; await f.save('plan', f.plan);
  assert.throws(() => createMappingTemplate(f.references, f.baseDir), /startRecord/);
  f.plan.scope.sections[0].startRecord = 7; await f.save('plan', f.plan); await f.save('baseline', f.baseline(2));
  assert.throws(() => createMappingTemplate(f.references, f.baseDir), /fixture.*显式 startRecord/);
});

test('order must be explicitly confirmed, exact and complete; tools never infer or reorder tasks', async t => {
  const f = await fixture(t), invalid = [];
  for (const confirmed of [undefined, false, 'true']) invalid.push({ ...structuredClone(f.order), confirmed });
  const reversed = structuredClone(f.order); reversed.sections[0].questionIds.reverse(); invalid.push(reversed);
  const omitted = structuredClone(f.order); omitted.sections[0].questionIds.pop(); invalid.push(omitted);
  const duplicate = structuredClone(f.order); duplicate.sections[0].questionIds[1] = 'q1'; invalid.push(duplicate);
  const unknown = structuredClone(f.order); unknown.sections[0].questionIds[1] = 'inferred-q'; invalid.push(unknown);
  const other = structuredClone(f.order); other.sections[0].sectionLabel = '其他节'; invalid.push(other);
  invalid.push({ ...structuredClone(f.order), bookId: 999999 }, { ...structuredClone(f.order), automaticallyApproved: true });
  for (const order of invalid) { await f.save('order', order); assert.throws(() => createMappingTemplate(f.references, f.baseDir), /order|题序/); }
});

test('scope constrains answer pages, record limit and integer range as well as question pages', async t => {
  const f = await fixture(t); f.plan.scope.pages = [1, 2]; await f.save('plan', f.plan);
  assert.throws(() => createMappingTemplate(f.references, f.baseDir), /来源页越出/);
  f.plan.scope.pages = [1, 2, 3]; f.plan.scope.sections[0].recordLimit = 1; await f.save('plan', f.plan);
  assert.throws(() => createMappingTemplate(f.references, f.baseDir), /recordLimit/);
  f.plan.scope.sections[0].recordLimit = 2; f.plan.scope.sections[0].startRecord = Number.MAX_SAFE_INTEGER; await f.save('plan', f.plan);
  assert.throws(() => createMappingTemplate(f.references, f.baseDir), /安全整数/);
  delete f.plan.scope.sections; await f.save('plan', f.plan);
  assert.throws(() => createMappingTemplate(f.references, f.baseDir), /scope.sections/);
});

test('actual JSON hashes, raster bytes and original-pixel geometry are checked before output', async t => {
  const f = await fixture(t);
  for (const role of ['paired', 'plan', 'order', 'index']) {
    assert.throws(() => createMappingTemplate({ ...f.references, [role]: { ...f.references[role], sha256: 'a'.repeat(64) } }, f.baseDir), /SHA256/);
  }
  await fs.writeFile(path.join(f.baseDir, f.index.pages[0].file), png(4, 2));
  await assert.rejects(createMapping(f.argv(), { project: f.project, cwd: f.project }), /原图 SHA/);
  await assert.rejects(fs.access(path.join(f.baseDir, 'mapping.template.json')), /ENOENT/);
  await fs.writeFile(path.join(f.baseDir, f.index.pages[0].file), png(3, 2));
  f.paired.tasks[0].stem.source.regions[0].bbox = [0, 0, 4, 2]; await f.save('paired', f.paired);
  assert.throws(() => createMappingTemplate(f.references, f.baseDir), /bbox/);
  f.paired.tasks[0].stem.source.regions[0].bbox = [0, 0, 1.5, 2]; await f.save('paired', f.paired);
  assert.throws(() => createMappingTemplate(f.references, f.baseDir), /bbox/);
});

test('optional crop evidence retains actual hash but cannot supply approval or inferred replacement blocks', async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.baseDir, 'figures'));
  const bytes = png(1, 1); await fs.writeFile(path.join(f.baseDir, 'figures', 'diagram.png'), bytes);
  const crops = { kind: 'source-crops', bookId: f.plan.bookId, indexSha256: f.references.index.sha256,
    crops: [{ id: 'diagram', page: 1, image: f.index.pages[0].file, sourceSha256: f.index.pages[0].sha256, bbox: [0, 0, 1, 1], file: 'figures/diagram.png', sha256: sha256(bytes), purpose: 'diagram' }] };
  await f.save('cropEvidence', crops, 'source.json');
  const result = await createMapping([...f.argv(), '--crops=data/jobs/synthetic/source.json'], { project: f.project, cwd: f.project });
  const mapping = JSON.parse(await fs.readFile(result.outputPath, 'utf8'));
  assert.deepEqual(mapping.cropEvidence, f.references.cropEvidence); assert.ok(mapping.placements.every(item => item.replacementBlocks === undefined));
  crops.indexSha256 = 'a'.repeat(64); await f.save('cropEvidence', crops, 'source.json');
  assert.throws(() => createMappingTemplate(f.references, f.baseDir), /同 index/);
});

test('same-job guards reject cross-job JSON/output and overwrite without altering existing bytes', async t => {
  const f = await fixture(t), other = path.join(f.project, 'data', 'jobs', 'other'); await fs.mkdir(other);
  await fs.writeFile(path.join(other, 'order.json'), JSON.stringify(f.order));
  await assert.rejects(createMapping(f.argv().map(arg => arg.startsWith('--order=') ? '--order=data/jobs/other/order.json' : arg), { project: f.project, cwd: f.project }), /同一/);
  await assert.rejects(createMapping(f.argv().map(arg => arg.startsWith('--output=') ? '--output=data/jobs/other/mapping.json' : arg), { project: f.project, cwd: f.project }), /同一/);
  await assert.rejects(fs.access(path.join(other, 'mapping.json')), /ENOENT/);
  const first = await createMapping(f.argv(), { project: f.project, cwd: f.project }), original = await fs.readFile(first.outputPath);
  await assert.rejects(createMapping(f.argv(), { project: f.project, cwd: f.project }), /EEXIST/);
  assert.deepEqual(await fs.readFile(first.outputPath), original);
  await assert.rejects(createMapping(f.argv().map(arg => arg.startsWith('--output=') ? '--output=outside.json' : arg), { project: f.project, cwd: f.project }), /data\/jobs/);
});

test('actual junction image escape is rejected and no mapping is created', async t => {
  const f = await fixture(t), outside = await fs.mkdtemp(path.join(os.tmpdir(), 'recorder-mapping-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'page.png'), png(3, 2));
  try { await fs.symlink(outside, path.join(f.baseDir, 'foreign'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) { t.skip('Windows 无权创建实际 junction'); return; } throw error; }
  f.index.pages[0].file = 'foreign/page.png'; await f.save('index', f.index);
  const stem = f.paired.tasks[0].stem.source; stem.images[0] = 'foreign/page.png'; stem.regions[0].image = 'foreign/page.png'; await f.save('paired', f.paired);
  await assert.rejects(createMapping(f.argv(), { project: f.project, cwd: f.project }), /软链接越界|原图软链接越界/);
  await assert.rejects(fs.access(path.join(f.baseDir, 'mapping.template.json')), /ENOENT/);
});

test('section-only plans use declared local source pages without inventing candidates or question boundaries', async t => {
  const f = await fixture(t); delete f.plan.scope.pages; await f.save('plan', f.plan);
  const mapping = createMappingTemplate(f.references, f.baseDir);
  assert.deepEqual(mapping.coverage.pages.map(page => page.page), [1, 2, 3]);
  assert.ok(mapping.coverage.pages.every(page => page.candidates.length === 0));
  assert.deepEqual(mapping.placements.map(placement => placement.questionId), ['q1', 'q2']);
});

test('CLI help works without inputs and rejects unknown, duplicate or missing required flags', async t => {
  const f = await fixture(t); assert.match((await createMapping(['--help'])).help, /--order=.*--baseline=/);
  for (const argv of [['--input=x'], [...f.argv(), '--confirm=true'], [...f.argv(), '--order=again.json'], [...f.argv(), '--baseline=']]) {
    await assert.rejects(createMapping(argv, { project: f.project, cwd: f.project }), /必须明确|未知或重复|缺少路径/);
  }
});
