import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { deflateSync } from 'node:zlib';
import { pairBatch } from '../scripts/pair-batch.mjs';
import { reportPairingConflicts } from '../scripts/report-pairing-conflicts.mjs';
import { createMapping } from '../scripts/create-mapping-template.mjs';
import { prepareDraft } from '../scripts/prepare-draft.mjs';
import { reviewMaterials } from '../scripts/create-review-materials.mjs';
import { sha256 } from '../src/preparation-files.mjs';

function png(color) {
  const crc = bytes => { let sum = 0xffffffff; for (const byte of bytes) { sum ^= byte; for (let i = 0; i < 8; i++) sum = sum & 1 ? 0xedb88320 ^ sum >>> 1 : sum >>> 1; } return (sum ^ 0xffffffff) >>> 0; };
  const chunk = (name, data) => { const body = Buffer.concat([Buffer.from(name), data]), length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(body)); return Buffer.concat([length, body, checksum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(2); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(14, color); pixels[0] = 0; pixels[7] = 0;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

test('local assistance keeps complete cross-page sources and unresolved pairs throughout the preparation flow', async t => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'recorder-assistance-'));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const baseDir = path.join(project, 'data', 'jobs', 'synthetic');
  await fs.mkdir(path.join(baseDir, 'images'), { recursive: true });
  const pages = [];
  for (let page = 1; page <= 3; page++) {
    const bytes = png(40 * page), file = `images/page-${page}.png`;
    await fs.writeFile(path.join(baseDir, file), bytes);
    pages.push({ systemPage: page, file, sha256: sha256(bytes), width: 2, height: 2, mimeType: 'image/png', bytes: bytes.length });
  }
  const record = (id, number, text, chosen) => ({ id, chapter: '合成章', unit: '合成节', group: '基础', questionNumber: number,
    rawOcr: '', blocks: [{ type: 'text', text }], source: { pages: chosen, images: chosen.map(page => pages[page - 1].file),
      regions: chosen.map(page => ({ page, image: pages[page - 1].file, bbox: [0, 0, 2, 2] })) } });
  const records = { schemaVersion: 1, bookId: 900001,
    questions: [record('q1', 1, '1. 哪一项是甲？', [1]), record('activity', 2, '2. 活动：先分析甲，再回答乙是什么？', [1, 2]), record('q3', 3, '3. 缺少哪一项？', [2])],
    answers: [record('a1', 1, '甲', [3]), record('a1-other', 1, '另一个候选', [3]), record('a2', 2, '乙', [3])],
    pairings: [{ questionId: 'activity', answerId: 'a2' }] };
  const input = { 'records.json': records, 'index.json': { schemaVersion: 1, bookId: 900001, pages },
    'plan.json': { schemaVersion: 1, kind: 'local-workflow-plan', bookId: 900001, source: 'fixture', scope: { pages: [1, 2, 3], sections: [{ chapterLabel: '合成章', sectionLabel: '合成节', startRecord: 7, recordLimit: 3 }] } },
    'order.json': { schemaVersion: 1, kind: 'confirmed-question-order', bookId: 900001, confirmed: true, sections: [{ chapterLabel: '合成章', sectionLabel: '合成节', questionIds: ['q1', 'activity', 'q3'] }] } };
  const originals = new Map();
  for (const [name, value] of Object.entries(input)) {
    const bytes = Buffer.from(JSON.stringify(value)); await fs.writeFile(path.join(baseDir, name), bytes); originals.set(name, bytes);
  }
  const args = name => `data/jobs/synthetic/${name}`;
  const context = { project, cwd: project };
  await pairBatch([`--input=${args('records.json')}`, `--output=${args('paired.json')}`], context);
  originals.set('paired.json', await fs.readFile(path.join(baseDir, 'paired.json')));
  const conflict = await reportPairingConflicts([`--input=${args('paired.json')}`, `--records=${args('records.json')}`, `--index=${args('index.json')}`, `--output=${args('conflicts.json')}`], context);
  const conflictReport = JSON.parse(await fs.readFile(conflict.outputPath, 'utf8'));
  assert.deepEqual(conflictReport.conflicts.map(row => row.taskId), ['q1', 'q3']);
  assert.deepEqual(conflictReport.conflicts[0].answers.map(row => row.candidateId), ['a1', 'a1-other']);
  assert.equal(conflictReport.readyForExecution, false);

  const generated = await createMapping([`--input=${args('paired.json')}`, `--plan=${args('plan.json')}`, `--order=${args('order.json')}`, `--index=${args('index.json')}`, `--output=${args('mapping.template.json')}`], context);
  const mapping = JSON.parse(await fs.readFile(generated.outputPath, 'utf8'));
  assert.deepEqual(mapping.placements.map(item => item.target.record), [7, 8, 9]);
  assert.deepEqual(mapping.sourceReferences[1].stem.pages, [1, 2]);
  assert.equal(generated.readyForExecution, false);
  await assert.rejects(prepareDraft([`--input=${args('paired.json')}`, `--mapping=${args('mapping.template.json')}`, `--output=${args('unfinished.json')}`], context), /作答要求/);

  // Only synthetic test input is filled here; no review or approval is inferred.
  mapping.placements.forEach((item, i) => { item.answerRequirement = { kind: 'question', evidence: records.questions[i].blocks[0].text }; item.answerStatus = 'provided'; });
  mapping.coverage.pages.forEach(item => { item.candidates = item.page === 3
    ? [{ id: 'answers-only', type: 'non-question', decision: 'exclude', taskIds: [], reason: '仅参考答案，无独立作答要求' }]
    : (item.page === 1 ? ['q1', 'activity'] : ['activity', 'q3']).map(id => ({ id: `${id}-page${item.page}`, type: id === 'activity' ? 'whole-activity' : 'question', decision: 'include', taskIds: [id] })); });
  await fs.writeFile(path.join(baseDir, 'mapping.filled.json'), JSON.stringify(mapping));
  const draft = await prepareDraft([`--input=${args('paired.json')}`, `--mapping=${args('mapping.filled.json')}`, `--output=${args('draft.json')}`], context);
  const manifest = JSON.parse(await fs.readFile(draft.outputPath, 'utf8'));
  assert.equal(draft.readyForExecution, false);
  assert.ok(manifest.tasks[0].review.issues.includes('multiple_answer_candidates'));
  assert.ok(manifest.tasks[2].review.issues.includes('answer_missing'));
  assert.ok(manifest.tasks.every(task => task.review.status === 'pending' && Object.values(task.review.checks).every(value => value === false)));
  originals.set('draft.json', await fs.readFile(path.join(baseDir, 'draft.json')));

  const materialArgs = [`--manifest=${args('draft.json')}`, '--tasks=activity', '--outputdir=data/review/synthetic-materials'];
  const result = await reviewMaterials(materialArgs, context);
  const materials = JSON.parse(await fs.readFile(result.reportPath, 'utf8'));
  assert.deepEqual(materials.selectedTaskIds, ['activity']);
  assert.equal(materials.tasks.length, 1);
  assert.equal(materials.regions.length, 3);
  assert.deepEqual(materials.sourceImages.map(image => image.sha256).sort(), pages.map(page => page.sha256).sort());
  assert.equal(result.readyForExecution, false);
  await assert.rejects(reviewMaterials(materialArgs, context), /已存在|EEXIST/);
  for (const [name, bytes] of originals) assert.deepEqual(await fs.readFile(path.join(baseDir, name)), bytes, `${name} must remain unchanged`);
});
