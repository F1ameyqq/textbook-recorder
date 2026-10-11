import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { preparePairedBatch } from '../src/paired-batch.mjs';
import { prepareDraftBatch } from '../src/draft-batch.mjs';
import { createReviewDecisionsTemplate } from '../src/review-decisions-template.mjs';
import { createDemoDiagram } from '../src/demo-batch.mjs';
import { sha256 } from '../src/preparation-files.mjs';

async function fixture(t) {
  const job = await fs.mkdtemp(path.join(os.tmpdir(), 'recorder-correction-draft-'));
  t.after(() => fs.rm(job, { recursive: true, force: true }));
  const write = async (name, value) => {
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
    await fs.writeFile(path.join(job, name), bytes);
    return { path: name, sha256: sha256(bytes) };
  };
  const raster = createDemoDiagram();
  const pages = [1, 2].map(systemPage => ({ systemPage, file: `page-${systemPage}.png`,
    sha256: sha256(raster), width: 240, height: 100 }));
  for (const page of pages) await fs.writeFile(path.join(job, page.file), raster);
  const index = await write('index.json', { schemaVersion: 1, bookId: 900001, pages });
  const record = (id, page, text) => ({ id, chapter: '合成章', unit: '合成节', group: '基础', questionNumber: 1,
    rawOcr: '', source: { pages: [page], images: [pages[page - 1].file],
      regions: [{ page, image: pages[page - 1].file, bbox: [10, 5, 200, 90] }] }, blocks: [{ type: 'text', text }] });
  const paired = preparePairedBatch({ schemaVersion: 1, bookId: 900001,
    questions: [record('q', 1, '1. 写出字音（    ）')], answers: [record('a', 2, '1. 示例')] });
  const pairedRef = await write('paired.json', paired);
  const mapping = { schemaVersion: 1, kind: 'new-system-draft-mapping', bookId: 900001, source: 'fixture', index,
    placements: [{ questionId: 'q', target: { chapterLabel: '合成章', sectionLabel: '合成节', record: 1 },
      answerRequirement: { kind: 'fill-in', evidence: '写出字音' }, answerStatus: 'provided' }],
    coverage: { pages: [{ page: 1, imagePath: pages[0].file,
      candidates: [{ id: 'page1-q', type: 'question', decision: 'include', taskIds: ['q'] }] }] } };
  const before = prepareDraftBatch(paired, mapping, job).manifest;
  before.tasks[0].target.expectedRecordId = 487;
  before.tasks[0].review = { status: 'approved', issues: [],
    checks: { sourceText: true, answerMatch: true, wholeQuestion: true, format: true } };
  const beforeRef = await write('before.json', before);
  const correction = structuredClone(mapping);
  correction.correction = { schemaVersion: 1, beforeManifest: beforeRef.path, beforeSha256: beforeRef.sha256 };
  correction.placements[0].target.expectedRecordId = 487;
  correction.placements[0].replacementBlocks = { stem: [{ type: 'text', text: '1. 写出字音（        ）', strictSpacing: true }] };
  correction.placements[0].agentReview = { checkedAgainstOriginal: true, evidence: '合成图中原题/答案区域核对；本次仅空格排版修订。' };
  return { job, paired, pairedRef, mapping, before, correction, write };
}

test('frozen correction regenerates complete pending provenance and a blank hash-bound decisions template', async t => {
  const f = await fixture(t), beforeBytes = await fs.readFile(path.join(f.job, 'before.json'));
  const mapping = await f.write('mapping.json', f.correction);
  const draft = prepareDraftBatch(f.paired, f.correction, f.job, { paired: f.pairedRef, mapping }).manifest;
  assert.deepEqual(draft.correction, f.correction.correction);
  assert.equal(draft.tasks[0].target.expectedRecordId, 487);
  assert.equal(draft.tasks[0].review.status, 'pending');
  assert.ok(Object.values(draft.tasks[0].review.checks).every(value => value === false));
  assert.equal(draft.reviewEvidence, undefined);
  const draftRef = await f.write('draft.json', draft);
  const result = createReviewDecisionsTemplate(draft, draftRef.sha256, f.job);
  assert.equal(result.report.valid, true);
  assert.equal(result.decisions.coverageChecked, false);
  assert.equal(result.decisions.tasks[0].evidence, '');
  assert.ok(Object.values(result.decisions.tasks[0].checks).every(value => value === false));
  assert.deepEqual(await fs.readFile(path.join(f.job, 'before.json')), beforeBytes);
  const changed = structuredClone(draft); changed.correction.beforeSha256 = '0'.repeat(64);
  assert.throws(() => createReviewDecisionsTemplate(changed, draftRef.sha256, f.job), /冻结|不一致/);
});

test('ordinary append mapping still cannot declare an existing ID and corrections require positive IDs', async t => {
  const f = await fixture(t), ordinary = structuredClone(f.mapping);
  ordinary.placements[0].target.expectedRecordId = 487;
  assert.throws(() => prepareDraftBatch(f.paired, ordinary, f.job), /既有 ID/);
  for (const value of [undefined, 0, -1, '487', 1.5]) {
    const mapping = structuredClone(f.correction);
    mapping.placements[0].target.expectedRecordId = value;
    assert.throws(() => prepareDraftBatch(f.paired, mapping, f.job), /正整数|既有 ID/);
  }
});

test('correction metadata requires an exact schema and same-job byte-bound baseline', async t => {
  const f = await fixture(t);
  for (const change of [value => { value.schemaVersion = 2; }, value => { value.extra = true; },
    value => { value.beforeSha256 = 'invalid'; }, value => { value.beforeManifest = '../before.json'; },
    value => { value.beforeManifest = path.join(f.job, 'before.json'); }]) {
    const mapping = structuredClone(f.correction); change(mapping.correction);
    assert.throws(() => prepareDraftBatch(f.paired, mapping, f.job), /correction|路径|作业根/);
  }
  await fs.appendFile(path.join(f.job, 'before.json'), ' ');
  assert.throws(() => prepareDraftBatch(f.paired, f.correction, f.job), /correction.*SHA256/);
});

test('changed baseline book, source, task ID, target, source pages or review cannot establish correction identity', async t => {
  const f = await fixture(t);
  for (const change of [before => { before.bookId++; }, before => { before.source = 'production'; },
    before => { before.tasks[0].id = 'other'; }, before => { before.tasks[0].target.record++; },
    before => { before.tasks[0].target.expectedRecordId++; }, before => { before.tasks[0].source.pages = [2]; },
    before => { before.tasks[0].review.status = 'pending'; }, before => { before.tasks[0].review.checks.format = false; }]) {
    const before = structuredClone(f.before); change(before);
    const reference = await f.write('before.json', before), mapping = structuredClone(f.correction);
    mapping.correction.beforeSha256 = reference.sha256;
    assert.throws(() => prepareDraftBatch(f.paired, mapping, f.job), /correction/);
  }
});

test('changed paired source also rejects even when the correction target still matches', async t => {
  const f = await fixture(t), paired = structuredClone(f.paired);
  paired.tasks[0].stem.source = structuredClone(paired.tasks[0].answer.source);
  assert.throws(() => prepareDraftBatch(paired, f.correction, f.job), /correction task.*source/);
});

test('single-record repair binds the complete observed snapshot by SHA256 and original ID', async t => {
  const f = await fixture(t);
  const snapshot = { schemaVersion: 1, kind: 'reviewed-empty-answer-source-repair-baseline',
    bookId: 900001, target: f.before.tasks[0].target, nodeID: 28,
    authorization: { source: 'direct-user', userQuote: '补回答案和来源页，并修正缩进' },
    records: [{ seqIndex: 1, shitiID: 487, nodeID: 28, question: '<p>原题</p>',
      answer: '', haveAnswer: false, mainPicNum: 0, answerPicNum: 0 }] };
  f.correction.correction.beforeSnapshot = await f.write('snapshot.json', snapshot);
  const draft = prepareDraftBatch(f.paired, f.correction, f.job).manifest;
  assert.deepEqual(draft.correction.beforeSnapshot, f.correction.correction.beforeSnapshot);
  await fs.appendFile(path.join(f.job, 'snapshot.json'), ' ');
  assert.throws(() => prepareDraftBatch(f.paired, f.correction, f.job), /SHA256/);
  snapshot.records[0].shitiID++;
  f.correction.correction.beforeSnapshot = await f.write('snapshot.json', snapshot);
  assert.throws(() => prepareDraftBatch(f.paired, f.correction, f.job), /原ID/);
});
