import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareLocal } from '../src/local-preparation.mjs';
import { sha256 } from '../src/preparation-files.mjs';
import { localFixture } from './helpers/local-preparation-fixture.mjs';

const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const run = (f, args = []) => prepareLocal([...f.argv, ...args], { project: f.project, cwd: f.project });

test('one local entry stops at an unapproved mapping skeleton and never creates runtime configuration', async t => {
  const f = await localFixture(t), before = await fs.readFile(f.records.file);
  const result = await run(f), receipt = await read(result.receiptPath);
  assert.equal(result.stage, 'mapping-required'); assert.equal(result.ok, true);
  assert.equal(result.readyForExecution, false); assert.equal(result.platformWritePerformed, false);
  assert.equal(receipt.inputs.records.sha256, sha256(before));
  const mapping = await read(path.join(f.job, result.artifactPaths['mapping-template']));
  assert.equal(mapping.placements[0].answerRequirement.kind, null);
  assert.equal(mapping.placements[0].review.checks.sourceText, false);
  assert.equal(mapping.coverage.coverageChecked, false);
  assert.deepEqual(await fs.readFile(f.records.file), before);
  for (const folder of ['config', 'data/persistent-executor', 'data/new-system-browser']) {
    await assert.rejects(fs.access(path.join(f.project, folder)), /ENOENT/);
  }
});

test('completed mapping compiles full cross-page draft, compact receipt and offline review materials', async t => {
  const f = await localFixture(t), originals = new Map();
  for (const input of [f.plan, f.index, f.records, f.order, f.mapping]) originals.set(input.file, await fs.readFile(input.file));
  const result = await run(f, [`--mapping=${f.mapping.file}`]), receipt = await read(result.receiptPath);
  assert.equal(result.stage, 'review-required'); assert.equal(result.ok, true); assert.equal(result.counts.tasks, 2);
  assert.ok(JSON.stringify(result).length < 2400);
  const draft = await read(path.join(f.job, result.artifactPaths.draft));
  assert.deepEqual(draft.tasks[0].source.pages, [1, 2]);
  assert.ok(draft.tasks.every(task => task.review.status === 'pending' && Object.values(task.review.checks).every(check => check === false)));
  const decisions = await read(path.join(f.job, result.artifactPaths['decisions-template']));
  assert.equal(decisions.manifestSha256, receipt.artifacts.draft.sha256);
  assert.equal(decisions.coverageChecked, false);
  assert.ok(decisions.tasks.every(task => Object.values(task.checks).every(check => check === false)));
  const html = await fs.readFile(path.join(f.project, receipt.reviewFiles['materials.html'].path), 'utf8');
  assert.doesNotMatch(html, /<script|(?:src|href)\s*=\s*["']https?:/iu);
  for (const [file, bytes] of originals) assert.deepEqual(await fs.readFile(file), bytes);
  assert.equal((await fs.readdir(f.job)).some(name => /approved|state|progress|\.lock$/u.test(name)), false);
});

test('explicit next invocation versions and hash-links receipts without overwriting earlier artifacts', async t => {
  const f = await localFixture(t), first = await run(f), bytes = await fs.readFile(first.receiptPath);
  const second = await run(f, [`--mapping=${f.mapping.file}`]);
  assert.equal(second.version, 2);
  assert.deepEqual((await read(second.receiptPath)).previous, { path: path.basename(first.receiptPath), sha256: sha256(bytes) });
  assert.deepEqual(await fs.readFile(first.receiptPath), bytes);
  assert.notEqual(first.artifactPaths.paired, second.artifactPaths.paired);
  await fs.appendFile(first.receiptPath, '\n');
  await assert.rejects(run(f), /历史|SHA256/);
});

test('ambiguous pairing remains blocked and is retained in complete review materials', async t => {
  const f = await localFixture(t, { conflicting: true });
  const result = await run(f, [`--mapping=${f.mapping.file}`]);
  assert.equal(result.ok, false); assert.equal(result.stage, 'review-blocked');
  const receipt = await read(result.receiptPath);
  const materials = await read(path.join(f.project, receipt.reviewFiles['materials.json'].path));
  assert.equal(materials.tasks[0].answerCandidates.length, 2);
  assert.ok(materials.tasks[0].pendingIssues.includes('multiple_answer_candidates'));
  assert.equal(receipt.approved, 0);
});

test('production preparation requires a complete historical baseline but never loads configuration or runtime', async t => {
  const f = await localFixture(t, { source: 'production' });
  const blocked = await run(f);
  assert.equal(blocked.stage, 'blocked-input');
  const baseline = await f.write('baseline.json', { bookId: 900001, chapterLabel: '合成章', sectionLabel: '合成节', nodeID: 1,
    serverSnapshotAt: '2026-10-19T00:00:00.000Z', records: [] });
  const checked = structuredClone(f.mapping.value); checked.sourceBinding.baseline = baseline.sha256;
  const mapping = await f.write('mapping.with-baseline.json', checked);
  await fs.mkdir(path.join(f.project, 'config'));
  await fs.writeFile(path.join(f.project, 'config/recorder.json'), 'intentionally invalid; must not be read');
  const result = await run(f, [`--baseline=${baseline.file}`, `--mapping=${mapping.file}`]);
  assert.equal(result.stage, 'review-required'); assert.equal(result.source, 'production');
  assert.equal(result.platformExecutionAllowed, false);
});

test('changed target, missing requirement and altered image fail closed with retained partial artifacts', async t => {
  for (const variant of ['target', 'requirement', 'image']) {
    const f = await localFixture(t), mapping = structuredClone(f.mapping.value);
    if (variant === 'target') mapping.placements[0].target.record = 9;
    if (variant === 'requirement') delete mapping.placements[0].answerRequirement;
    if (variant === 'image') await fs.appendFile(path.join(f.job, 'images/page-1.png'), 'changed');
    const revised = await f.write(`mapping-${variant}.json`, mapping);
    const result = await run(f, [`--mapping=${revised.file}`]);
    assert.equal(result.stage, 'blocked-input'); assert.equal(result.ok, false);
    assert.equal(result.readyForExecution, false);
    assert.equal((await read(result.receiptPath)).error.code, 'LOCAL_PREPARATION_BLOCKED');
    assert.ok(result.artifactPaths.paired);
    assert.equal((await fs.readdir(f.job)).includes('.preparation.lock'), false);
  }
});

test('cross-job inputs, unconfirmed order, existing run locks and foreign progress cannot be bypassed', async t => {
  const f = await localFixture(t), foreign = await localFixture(t);
  await assert.rejects(run(f, [`--mapping=${foreign.mapping.file}`]), /同一|位于/);
  await fs.writeFile(path.join(f.job, 'original-progress.json'), '{"kind":"new-system-run"}');
  await assert.rejects(run(f), /进度|锁/);
  const g = await localFixture(t), order = structuredClone(g.order.value); order.confirmed = false;
  const other = await g.write('unconfirmed.json', order);
  const args = g.argv.map(value => value.startsWith('--order=') ? `--order=${other.file}` : value);
  const result = await prepareLocal(args, { project: g.project, cwd: g.project });
  assert.equal(result.stage, 'blocked-input');
});

test('overlapping local preparation callers cannot overwrite or silently acquire a new version', async t => {
  const f = await localFixture(t);
  const results = await Promise.allSettled([run(f), run(f)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal((await fs.readdir(f.job)).filter(name => /^prepare\.v/u.test(name)).length, 1);
});

test('old mapping cannot silently bind to changed transcription, even when book, IDs and pages remain the same', async t => {
  const f = await localFixture(t);
  const first = await run(f);
  const skeleton = await read(path.join(f.job, first.artifactPaths['mapping-template']));
  const checked = { ...skeleton, placements: f.mapping.value.placements, coverage: f.mapping.value.coverage };
  const oldMapping = await f.write('mapping.from-template.json', checked);
  const original = await run(f, [`--mapping=${oldMapping.file}`]);
  assert.equal(original.stage, 'review-required');
  const changed = structuredClone(f.records.value); changed.questions[0].blocks[0].text = '改后的同 ID 题干';
  const records = await f.write('records.v2.json', changed);
  const args = f.argv.map(value => value.startsWith('--records=') ? `--records=${records.file}` : value);
  const blocked = await prepareLocal([...args, `--mapping=${oldMapping.file}`], { project: f.project, cwd: f.project });
  assert.equal(blocked.stage, 'blocked-input');
  assert.equal((await read(blocked.receiptPath)).failureStage, 'mapping-binding');
  assert.equal(blocked.artifactPaths.draft, undefined);
});

test('a preparation receipt chain freezes the original job plan bytes and scope', async t => {
  const f = await localFixture(t); await run(f);
  const changed = structuredClone(f.plan.value); changed.scope.sections[0].recordLimit = 50;
  const plan = await f.write('plan.changed.json', changed);
  const args = f.argv.map(value => value.startsWith('--plan=') ? `--plan=${plan.file}` : value);
  await assert.rejects(prepareLocal(args, { project: f.project, cwd: f.project }), /冻结|范围/);
  assert.equal((await fs.readdir(f.job)).filter(name => /^prepare\.v/u.test(name)).length, 1);
});
