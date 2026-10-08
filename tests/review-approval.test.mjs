import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { preparePairedBatch } from '../src/paired-batch.mjs';
import { prepareDraftBatch } from '../src/draft-batch.mjs';
import { createDemoDiagram } from '../src/demo-batch.mjs';
import { sha256 } from '../src/preparation-files.mjs';
import { approveDraft } from '../scripts/approve-reviewed-draft.mjs';

async function fixture(t, { answer = '蓝色', unknown = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'recorder-approval-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const job = path.join(root, 'data', 'jobs', 'synthetic'); await fs.mkdir(path.join(job, 'images'), { recursive: true });
  const bytes = createDemoDiagram(); await fs.writeFile(path.join(job, 'images', 'page.png'), bytes);
  const write = async (name, value) => { const data = Buffer.from(JSON.stringify(value, null, 2) + '\n'); await fs.writeFile(path.join(job, name), data); return { path: name, sha256: sha256(data) }; };
  const index = await write('index.json', { schemaVersion: 1, bookId: 900001,
    pages: [{ systemPage: 1, file: 'images/page.png', sha256: sha256(bytes), width: 240, height: 100 }] });
  const source = { pages: [1], images: ['images/page.png'], regions: [{ page: 1, image: 'images/page.png', bbox: [0, 0, 240, 100] }] };
  const record = (id, text) => ({ id, chapter: '合成章', unit: '合成节', group: '基础', questionNumber: 1, rawOcr: text, source });
  const pairedValue = preparePairedBatch({ schemaVersion: 1, bookId: 900001,
    questions: [record('q', '1. 左边是什么颜色？')], answers: [{ ...record('a', unknown ? '未知' : answer) }] });
  const paired = await write('paired.json', pairedValue);
  const mappingValue = { schemaVersion: 1, kind: 'new-system-draft-mapping', bookId: 900001, source: 'fixture', index,
    placements: [{ questionId: 'q', target: { chapterLabel: '合成章', sectionLabel: '合成节', record: 1 },
      answerRequirement: { kind: 'question', evidence: '请作答图左边的颜色' }, answerStatus: 'provided' }],
    coverage: { pages: [{ page: 1, imagePath: 'images/page.png', candidates: [{ id: 'candidate-q', type: 'question', decision: 'include', taskIds: ['q'] }] }] } };
  const mapping = await write('mapping.json', mappingValue);
  const draft = prepareDraftBatch(pairedValue, mappingValue, job, { paired, mapping }).manifest;
  const manifest = await write('draft.json', draft);
  const decisions = { schemaVersion: 1, manifestSha256: manifest.sha256, coverageChecked: true,
    tasks: [{ taskId: 'q', checks: { sourceText: true, answerMatch: true, wholeQuestion: true, format: true }, evidence: '合成第1页左右色块已核对，正文与配答逐项核对' }] };
  await write('decisions.json', decisions);
  const approve = () => approveDraft(['--manifest=data/jobs/synthetic/draft.json', '--decisions=data/jobs/synthetic/decisions.json', '--output=data/jobs/synthetic/approved.json'], root);
  return { root, job, draft, decisions, write, approve };
}

test('byte-bound actual review grants approval only and leaves draft untouched', async t => {
  const f = await fixture(t), before = await fs.readFile(path.join(f.job, 'draft.json'));
  const result = await f.approve(); assert.equal(result.readyForExecution, true); assert.equal(result.platformWritePerformed, false);
  const approved = JSON.parse(await fs.readFile(result.manifestPath, 'utf8'));
  assert.equal(approved.tasks[0].review.status, 'approved'); assert.deepEqual(approved.tasks[0].review.issues, []);
  assert.equal(approved.reviewEvidence.draftSha256, f.decisions.manifestSha256);
  assert.deepEqual(await fs.readFile(path.join(f.job, 'draft.json')), before);
  await assert.rejects(f.approve(), /EEXIST/);
});

test('hash mismatch and missing/duplicate decisions cannot write approved artifact', async t => {
  const f = await fixture(t); f.decisions.manifestSha256 = 'a'.repeat(64); await f.write('decisions.json', f.decisions);
  await assert.rejects(f.approve(), /SHA256/);
  f.decisions.manifestSha256 = sha256(await fs.readFile(path.join(f.job, 'draft.json')));
  const valid = structuredClone(f.decisions.tasks); f.decisions.tasks = []; await f.write('decisions.json', f.decisions);
  await assert.rejects(f.approve(), /缺题/);
  f.decisions.tasks = [...valid, ...valid]; await f.write('decisions.json', f.decisions);
  await assert.rejects(f.approve(), /唯一/);
  assert.equal(await fs.access(path.join(f.job, 'approved.json')).then(() => true, () => false), false);
});

test('changed original bytes or mapping invalidates previous review', async t => {
  const f = await fixture(t); await fs.appendFile(path.join(f.job, 'images', 'page.png'), 'changed');
  await assert.rejects(f.approve(), /原图 SHA/);
  await fs.writeFile(path.join(f.job, 'images', 'page.png'), createDemoDiagram());
  await fs.appendFile(path.join(f.job, 'mapping.json'), ' ');
  await assert.rejects(f.approve(), /准备证据 SHA256/);
});

test('editing draft alone or clearing existing issues cannot bypass regeneration', async t => {
  const f = await fixture(t, { unknown: true });
  f.draft.tasks[0].review.issues = []; f.draft.tasks[0].answer.blocks[0].text = '蓝色';
  const ref = await f.write('draft.json', f.draft); f.decisions.manifestSha256 = ref.sha256; await f.write('decisions.json', f.decisions);
  await assert.rejects(f.approve(), /冻结/);
});

test('true checks do not approve unresolved pairing or stacked fractions', async t => {
  const f = await fixture(t, { unknown: true }); await assert.rejects(f.approve(), /尚有问题/);
  const g = await fixture(t, { answer: 'Q/W' });
  g.decisions.tasks[0].specialReview = { sourceLayout: 'stacked', fractionLayoutConfirmed: true };
  await g.write('decisions.json', g.decisions); await assert.rejects(g.approve(), /上下排分式/);
  assert.equal(await fs.access(path.join(g.job, 'approved.json')).then(() => true, () => false), false);
});
