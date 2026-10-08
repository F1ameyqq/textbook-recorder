import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createDemoDiagram, createDemoManifest } from '../src/demo-batch.mjs';
import { compareReviewedBatches, renderReviewDiff } from '../src/review-diff.mjs';
import { reviewDiff } from '../scripts/review-diff.mjs';

function manifest() {
  const value = createDemoManifest();
  value.preparation = { index: { path: 'index.json', sha256: 'a'.repeat(64) }, mapping: { path: 'mapping.json', sha256: 'b'.repeat(64) } };
  return value;
}

async function workspace(t) {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'recorder-diff-'));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const job = path.join(project, 'data', 'jobs', 'synthetic');
  await fs.mkdir(path.join(job, 'assets'), { recursive: true });
  await fs.writeFile(path.join(job, 'assets', 'demo-diagram.png'), createDemoDiagram());
  const before = manifest(), after = structuredClone(before);
  const write = async (name, value) => fs.writeFile(path.join(job, name), JSON.stringify(value));
  return { project, job, before, after, write };
}

test('diff locates answer/pairing changes and add/remove/order without mutating approval', () => {
  const before = manifest(), after = structuredClone(before), frozen = JSON.stringify(before);
  after.tasks[0].answer.blocks[0].text = 'B';
  after.tasks[0].preparation = { originalPairing: { method: 'explicit', candidateIds: ['other-answer'] } };
  after.tasks.splice(1, 1);
  after.tasks.push({ ...structuredClone(after.tasks[0]), id: 'added' });
  const report = compareReviewedBatches(before, after);
  const changed = report.tasks.find(task => task.taskId === 'demo-diagram');
  assert.ok(changed.changes.some(change => change.field === 'answer'));
  assert.ok(changed.changes.some(change => change.field === 'preparation.originalPairing'));
  assert.equal(report.summary.added, 1); assert.equal(report.summary.removed, 1);
  assert.ok(report.tasks.find(task => task.taskId === 'demo-whole-activity').changes.some(change => change.field === 'position'));
  assert.equal(report.automaticApproval, false); assert.equal(report.platformWritePerformed, false);
  assert.equal(JSON.stringify(before), frozen); assert.equal(after.tasks[0].review.status, 'approved');
});

test('changed cross-page coverage marks its whole task even when text is unchanged', () => {
  const before = manifest(), after = structuredClone(before);
  after.coverage.pages.push({ page: 3, imagePath: 'assets/demo-diagram.png', candidates: [
    { id: 'activity-continuation', type: 'whole-activity', decision: 'include', taskIds: ['demo-whole-activity'] },
  ] });
  const report = compareReviewedBatches(before, after);
  assert.equal(report.summary.changed, 0);
  assert.deepEqual(report.affectedTaskIds, ['demo-whole-activity']);
  assert.equal(report.coverageChanges[0].page, 3);
});

test('index/crop changes conservatively affect every task; whitespace does not reuse approval', () => {
  const before = manifest(), after = structuredClone(before);
  after.preparation.index.sha256 = 'c'.repeat(64);
  let report = compareReviewedBatches(before, after, { beforeSha256: 'a'.repeat(64), afterSha256: 'b'.repeat(64) });
  assert.equal(report.affectedTaskIds.length, before.tasks.length);
  assert.deepEqual(report.evidenceChanges, ['index']);
  report = compareReviewedBatches(before, before, { beforeSha256: 'a'.repeat(64), afterSha256: 'b'.repeat(64) });
  assert.equal(report.summary.changed, 0); assert.equal(report.draftBytesChanged, true);
  assert.equal(report.automaticApproval, false);
});

test('foreign books, fixture upgrade and ambiguous task identity cannot be compared', () => {
  const before = manifest(), after = structuredClone(before);
  after.bookId++; assert.throws(() => compareReviewedBatches(before, after), /同书/);
  after.bookId = before.bookId; after.source = 'production'; assert.throws(() => compareReviewedBatches(before, after), /fixture/);
  after.source = before.source; after.tasks.push(after.tasks[0]); assert.throws(() => compareReviewedBatches(before, after), /唯一/);
});

test('changed original-image review evidence cannot be hidden by mapping metadata', () => {
  const before = manifest(); before.tasks[0].preparation = { agentReview: { checkedAgainstOriginal: true, evidence: '合成来源第1页' } };
  const after = structuredClone(before);
  after.tasks[0].preparation.agentReview.evidence = '合成来源第2页';
  after.preparation.mapping.sha256 = 'c'.repeat(64);
  const report = compareReviewedBatches(before, after);
  assert.equal(report.summary.changed, 1);
  assert.ok(report.tasks[0].changes.some(change => change.field === 'preparation.agentReview'));
  assert.ok(report.affectedTaskIds.includes(before.tasks[0].id));
});

test('duplicate coverage pages cannot collapse into a false no-change result', () => {
  const before = manifest(); before.coverage.pages.push(structuredClone(before.coverage.pages[0]));
  const after = structuredClone(before); after.coverage.pages[0].candidates[0].taskIds = ['different'];
  assert.throws(() => compareReviewedBatches(before, after), /覆盖页须唯一/);
  const invalid = manifest(); invalid.coverage.pages[0].candidates[0].taskIds = [{ toString: 'invalid-id' }];
  assert.throws(() => compareReviewedBatches(manifest(), invalid), /明确 taskIds/);
});

test('Windows output directory casing remains a valid physical alias', { skip: process.platform !== 'win32' }, async t => {
  const f = await workspace(t);
  await f.write('before.json', f.before); await f.write('after.json', f.after);
  await fs.mkdir(path.join(f.project, 'data', 'Review'));
  const result = await reviewDiff(['--before=data/jobs/synthetic/before.json', '--after=data/jobs/synthetic/after.json',
    '--outputdir=data/review/case-alias'], { project: f.project, cwd: f.project });
  assert.match(result.reportPath, /case-alias/);
});

test('diff preview escapes metadata and invalid content while rendering verified local raster', async t => {
  const f = await workspace(t), attack = '<script src="https://evil.invalid/x"></script><img onerror="alert(1)">';
  f.after.tasks[0].id = attack;
  f.after.tasks[0].answer.blocks = [{ type: 'formula', latex: attack }];
  f.after.coverage.pages[0].candidates[0].reason = attack;
  const html = renderReviewDiff(f.before, f.after, compareReviewedBatches(f.before, f.after), f.job);
  assert.doesNotMatch(html, /<script\b|<[a-z][^>]*\son(?:error|click)=|<(?:img|iframe)[^>]+src=["']https?:/iu);
  assert.match(html, /&lt;script/); assert.match(html, /data:image\/png;base64/);
  assert.match(html, /default-src 'none'/); assert.match(html, /不继承或生成批准/);
});

test('CLI preserves both inputs, binds exact bytes and refuses report overwrite', async t => {
  const f = await workspace(t); f.after.tasks[0].answer.blocks[0].text = 'B';
  await f.write('before.json', f.before); await f.write('after.json', f.after);
  const beforeBytes = await fs.readFile(path.join(f.job, 'before.json'));
  const args = ['--before=data/jobs/synthetic/before.json', '--after=data/jobs/synthetic/after.json'];
  const options = { project: f.project, cwd: f.project };
  const result = await reviewDiff(args, options);
  assert.equal(result.changed, 1); assert.equal(result.automaticApproval, false);
  const report = JSON.parse(await fs.readFile(result.reportPath, 'utf8'));
  assert.equal(report.beforeSha256, result.beforeSha256); assert.equal(report.afterSha256, result.afterSha256);
  assert.equal(await fs.readFile(path.join(f.job, 'before.json'), 'utf8'), beforeBytes.toString('utf8'));
  assert.match(await fs.readFile(result.previewPath, 'utf8'), /上一版本/);
  await assert.rejects(reviewDiff(args, options), /输出已存在/);
});

test('CLI rejects unrelated jobs and output escapes before writing reports', async t => {
  const f = await workspace(t);
  await f.write('before.json', f.before); await f.write('after.json', f.after);
  const args = ['--before=data/jobs/synthetic/before.json', '--after=data/jobs/synthetic/after.json'];
  const options = { project: f.project, cwd: f.project };
  await assert.rejects(reviewDiff([...args, '--outputdir=data/jobs/synthetic/no'], options), /data\/review/);
  await assert.rejects(fs.access(path.join(f.job, 'no')));
  await fs.mkdir(path.join(f.project, 'data', 'jobs', 'other'));
  await fs.writeFile(path.join(f.project, 'data', 'jobs', 'other', 'after.json'), JSON.stringify(f.after));
  await assert.rejects(reviewDiff([args[0], '--after=data/jobs/other/after.json'], options), /同一/);
});

test('CLI rejects output directory junction escaping review boundary', async t => {
  const f = await workspace(t);
  await f.write('before.json', f.before); await f.write('after.json', f.after);
  const output = path.join(f.project, 'data', 'review'); await fs.mkdir(output);
  const link = path.join(output, 'outside');
  await fs.symlink(f.job, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(reviewDiff(['--before=data/jobs/synthetic/before.json', '--after=data/jobs/synthetic/after.json',
    '--outputdir=data/review/outside/uncreated'], { project: f.project, cwd: f.project }), /junction|软链接/);
  await assert.rejects(fs.access(path.join(f.job, 'uncreated')));
});
