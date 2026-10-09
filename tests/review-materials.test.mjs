import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { preparePairedBatch } from '../src/paired-batch.mjs';
import { prepareDraftBatch } from '../src/draft-batch.mjs';
import { createDemoDiagram } from '../src/demo-batch.mjs';
import { sha256 } from '../src/preparation-files.mjs';
import { createReviewMaterials } from '../src/review-materials.mjs';
import { reviewMaterials } from '../scripts/create-review-materials.mjs';
import { reviewDiff } from '../scripts/review-diff.mjs';

async function fixture(t, { conflicting = false, unlocated = false, candidatePage = 3 } = {}) {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'recorder-materials-'));
  t.after(async () => {
    const target = await fs.realpath(project), temp = await fs.realpath(os.tmpdir());
    assert.ok(path.relative(temp, target).startsWith('recorder-materials-'));
    await fs.rm(target, { recursive: true, force: true });
  });
  const job = path.join(project, 'data', 'jobs', 'synthetic');
  await fs.mkdir(path.join(job, 'images'), { recursive: true });
  const bytes = createDemoDiagram(), pages = [];
  for (let page = 1; page <= 4; page++) {
    const file = `images/page-${page}.png`;
    await fs.writeFile(path.join(job, file), bytes);
    pages.push({ systemPage: page, file, sha256: sha256(bytes), width: 240, height: 100 });
  }
  const write = async (name, value, { bom = false } = {}) => {
    const raw = Buffer.from((bom ? '\uFEFF' : '') + JSON.stringify(value, null, 2) + '\r\n');
    await fs.writeFile(path.join(job, name), raw);
    return { path: name, sha256: sha256(raw) };
  };
  const source = chosen => ({ pages: chosen, images: chosen.map(page => pages[page - 1].file),
    regions: chosen.filter(page => !unlocated || page !== 2).map(page => ({ page, image: pages[page - 1].file, bbox: [10, 5, 200, 90] })) });
  const record = (id, text, chosen, questionNumber) => ({ id, chapter: '合成章', unit: '合成节', group: '基础', questionNumber, rawOcr: text, source: source(chosen) });
  const records = { schemaVersion: 1, bookId: 900001,
    questions: [record('q1', '1. 完整第一题\n跨页续文 <script>不执行</script>', [1, 2], 1), record('q2', '2. 第二题', [2], 2)],
    answers: [record('a1', '第一题完整答案', [3], 1), record('a2', '第二题完整答案', [3], 2),
      ...(conflicting ? [record('a1b', '第一题其他候选\n候选续文', [candidatePage], 1)] : [])] };
  const input = await write('records.json', records), index = await write('index.json', { schemaVersion: 1, bookId: 900001, pages });
  const pairedValue = preparePairedBatch(records);
  pairedValue.preparation = { kind: 'deterministic-local-pairing', input,
    unmatchedAnswers: records.answers.filter(record => pairedValue.unmatchedAnswerIds.includes(record.id)), automaticallyApproved: false };
  const paired = await write('paired.json', pairedValue);
  const mappingValue = { schemaVersion: 1, kind: 'new-system-draft-mapping', bookId: 900001, source: 'fixture', index,
    placements: records.questions.map((question, position) => ({ questionId: question.id,
      target: { chapterLabel: '合成章', sectionLabel: '合成节', record: position + 1 },
      answerRequirement: { kind: 'question', evidence: '请回答完整题目中的问题' },
      answerStatus: conflicting && position === 0 ? 'not-provided' : 'provided',
      ...(conflicting && position === 0 ? { searchedAnswerPages: [3] } : {}) })),
    coverage: { pages: [1, 2].map(page => ({ page, imagePath: pages[page - 1].file,
      candidates: records.questions.filter(question => question.source.pages.includes(page)).map(question => ({
        id: `candidate-${question.id}-${page}`, type: 'whole-activity', decision: 'include', taskIds: [question.id] })) })) } };
  const mapping = await write('mapping.json', mappingValue);
  const draft = prepareDraftBatch(pairedValue, mappingValue, job, { paired, mapping }).manifest;
  const manifest = await write('draft.json', draft, { bom: true });
  const create = (selector = '--tasks=q1', directory = 'packet') => reviewMaterials([
    '--manifest=data/jobs/synthetic/draft.json', selector, `--outputdir=data/review/${directory}`], { project, cwd: project });
  const packet = async (selector, directory) => {
    const result = await create(selector, directory);
    return { result, value: JSON.parse(await fs.readFile(result.reportPath, 'utf8')), html: await fs.readFile(result.previewPath, 'utf8') };
  };
  return { project, job, draft, manifest, records, pairedValue, mappingValue, write, create, packet };
}

test('task selection retains complete cross-page content, candidates and exact raw draft hash without changing approval', async t => {
  const f = await fixture(t), before = await fs.readFile(path.join(f.job, 'draft.json'));
  const { result, value } = await f.packet();
  assert.equal(value.kind, 'local-review-materials');
  assert.deepEqual(value.selectedTaskIds, ['q1']); assert.equal(result.totalTasks, 2);
  assert.equal(value.manifest.sha256, sha256(before)); assert.equal(value.manifest.sha256, f.manifest.sha256);
  assert.deepEqual(value.tasks[0].stem, f.draft.tasks[0].stem);
  assert.deepEqual(value.tasks[0].answer, f.draft.tasks[0].answer);
  assert.deepEqual(value.tasks[0].records, f.draft.tasks[0].preparation.records);
  assert.deepEqual(value.tasks[0].sourceReferences.stem.map(item => item.page), [1, 2]);
  assert.deepEqual(value.tasks[0].sourceReferences.answer.map(item => item.page), [3]);
  assert.equal(value.tasks[0].answerCandidates[0].record.rawOcr, '第一题完整答案');
  assert.equal(value.tasks[0].coverageCandidates.length, 2);
  assert.equal(value.coverageContext[1].candidates.length, 2, 'complete page context preserves other question candidates');
  assert.equal(value.tasks[0].checks, undefined); assert.equal(value.tasks[0].review, undefined);
  for (const flag of ['automaticApproval', 'coverageChecked', 'sourceSemanticsVerifiedByTool', 'platformWritePerformed', 'readyForExecution']) assert.equal(value[flag], false);
  assert.equal(value.firstFullCoverageReviewStillRequired, true);
  assert.deepEqual(await fs.readFile(path.join(f.job, 'draft.json')), before);
});

test('analysis layout markers remain visible offline without external native assets or changing pending content', async t => {
  const f = await fixture(t);
  const blocks = [{ type: 'text', text: '第一题完整答案' }, { type: 'analysis-separator' }, { type: 'text', text: '第一题逐题解析' }];
  f.mappingValue.placements[0].replacementBlocks = { answer: blocks };
  f.mappingValue.placements[0].agentReview = { checkedAgainstOriginal: true, evidence: '合成原图已核对，答案与解析按明确布局保留' };
  const mapping = await f.write('mapping.analysis.json', f.mappingValue);
  const draft = prepareDraftBatch(f.pairedValue, f.mappingValue, f.job, { paired: f.draft.preparation.paired, mapping }).manifest;
  const manifest = await f.write('draft.analysis.json', draft);
  const before = await fs.readFile(path.join(f.job, manifest.path));
  const { packet, html } = createReviewMaterials(draft, manifest.sha256, f.job, { manifestPath: manifest.path, taskIds: ['q1'] });
  assert.deepEqual(packet.tasks[0].answer.blocks, blocks);
  const answerStart = html.indexOf('<h3>完整答案');
  const answerHtml = html.slice(answerStart, html.indexOf('</section>', answerStart));
  const answerAt = answerHtml.indexOf('第一题完整答案'), separatorAt = answerHtml.indexOf('<hr role="separator"'), analysisAt = answerHtml.indexOf('第一题逐题解析');
  assert.ok(answerAt >= 0 && separatorAt > answerAt && analysisAt > separatorAt, 'answer and analysis stay on opposite sides of the offline separator');
  assert.match(answerHtml, /aria-label="答案与解析分隔"/);
  assert.doesNotMatch(html, /此原生格式仍需人工处理|<script|\b(?:src|href)\s*=\s*["']https?:/iu);
  assert.equal(packet.readyForExecution, false);
  assert.equal(packet.automaticApproval, false);
  assert.equal(draft.tasks[0].review.status, 'pending');
  assert.ok(Object.values(draft.tasks[0].review.checks).every(value => value === false));
  assert.deepEqual(await fs.readFile(path.join(f.job, manifest.path)), before);
});

test('same actual image hash and bbox share one displayed region while every task preserves page/path references', async t => {
  const f = await fixture(t), { value, html } = await f.packet('--tasks=q2,q1');
  assert.deepEqual(value.selectedTaskIds, ['q1', 'q2'], 'preserve manifest order');
  const refs = value.tasks.flatMap(task => [...task.sourceReferences.stem, ...task.sourceReferences.answer]);
  assert.equal(new Set(refs.map(item => item.regionId)).size, 1);
  assert.deepEqual(value.sourceImages[0].origins.map(origin => origin.page).sort(), [1, 2, 3]);
  assert.equal(value.sourceImages.length, 1); assert.equal(value.regions.length, 2, 'one declared bbox plus full-page context');
  assert.equal((html.match(/<figure id="region-1"/gu) ?? []).length, 1);
  assert.deepEqual(refs.map(item => item.page), [1, 2, 3, 2, 3]);
  assert.ok(refs.every(item => item.imageSha256 === value.sourceImages[0].sha256));
});

test('unpaired alternatives include full candidate records and all candidate regions, preserving unresolved issues', async t => {
  const f = await fixture(t, { conflicting: true, candidatePage: 4 }), { value, html } = await f.packet();
  const task = value.tasks[0];
  assert.equal(task.records.answer, null); assert.equal(task.sourceReferences.answer.length, 0);
  assert.deepEqual(task.answerCandidates.map(candidate => candidate.record.id), ['a1', 'a1b']);
  assert.equal(task.answerCandidates[1].record.rawOcr, '第一题其他候选\n候选续文');
  assert.deepEqual(task.answerCandidates[1].sourceReferences.map(item => item.page), [4]);
  assert.ok(task.pendingIssues.includes('multiple_answer_candidates')); assert.ok(task.pendingIssues.includes('answer_missing'));
  assert.equal(task.sourceReferences.searchedAnswer[0].bbox, null);
  assert.equal(task.sourceReferences.searchedAnswer[0].located, false);
  assert.match(html, /答案未配对/);
});

test('unlocated cross-page portions stay full-page locators and do not invent a confirmed bbox', async t => {
  const f = await fixture(t, { unlocated: true }), { value } = await f.packet();
  const refs = value.tasks[0].sourceReferences.stem;
  assert.deepEqual(refs.map(item => item.page), [1, 2]);
  assert.equal(refs[1].bbox, null); assert.equal(refs[1].located, false);
  assert.ok(value.tasks[0].pendingIssues.includes('stem_source_pages_unlocated'));
});

test('fresh diagnostic selection maps current task problems and review severity retains pending review work', async t => {
  const f = await fixture(t, { conflicting: true }), { value } = await f.packet('--diagnostics=error');
  assert.equal(value.selection.computedFromCurrentManifest, true);
  assert.ok(value.selection.diagnostics.every(item => item.severity === 'error'));
  assert.deepEqual(value.selectedTaskIds, ['q1']);
  const next = await f.packet('--diagnostics=review', 'review-packet');
  assert.deepEqual(next.value.selectedTaskIds, ['q1', 'q2']);
  assert.ok(next.value.selection.diagnostics.some(item => item.code === 'review-check-pending'));
});

test('current diff selects changed tasks only and binds both frozen raw versions', async t => {
  const f = await fixture(t), old = structuredClone(f.draft);
  old.tasks[0].stem.blocks[0].text = '上一版本正文';
  const before = await f.write('before.json', old, { bom: true });
  const diff = await reviewDiff(['--before=data/jobs/synthetic/before.json', '--after=data/jobs/synthetic/draft.json'], { project: f.project, cwd: f.project });
  const { value } = await f.packet(`--diff=${diff.reportPath}`);
  assert.deepEqual(value.selectedTaskIds, ['q1']);
  assert.equal(value.selection.beforeSha256, before.sha256); assert.equal(value.selection.afterSha256, f.manifest.sha256);
  assert.equal(value.selection.sha256, sha256(await fs.readFile(diff.reportPath)));
});

test('stale diff version hashes and forged affected IDs fail before output', async t => {
  const f = await fixture(t), old = structuredClone(f.draft); old.tasks[0].stem.blocks[0].text = '旧';
  await f.write('before.json', old);
  const diff = await reviewDiff(['--before=data/jobs/synthetic/before.json', '--after=data/jobs/synthetic/draft.json'], { project: f.project, cwd: f.project });
  const value = JSON.parse(await fs.readFile(diff.reportPath, 'utf8'));
  await fs.writeFile(diff.reportPath, JSON.stringify({ ...value, afterSha256: '0'.repeat(64) }));
  await assert.rejects(f.create(`--diff=${diff.reportPath}`), /afterPath|SHA256/);
  await fs.writeFile(diff.reportPath, JSON.stringify({ ...value, affectedTaskIds: ['q2'] }));
  await assert.rejects(f.create(`--diff=${diff.reportPath}`), /重算结果不一致/);
  await assert.rejects(fs.access(path.join(f.project, 'data', 'review', 'packet')), /ENOENT/);
});

test('page-level diff expands relevant questions and preserves complete cross-page sources', async t => {
  const f = await fixture(t), old = structuredClone(f.draft);
  old.coverage.pages[1].candidates[0].reason = '旧页面声明';
  await f.write('before.json', old);
  const diff = await reviewDiff(['--before=data/jobs/synthetic/before.json', '--after=data/jobs/synthetic/draft.json'], { project: f.project, cwd: f.project });
  const { value } = await f.packet(`--diff=${diff.reportPath}`);
  assert.deepEqual(value.selectedTaskIds, ['q1', 'q2']);
  assert.deepEqual(value.tasks[0].sourceReferences.stem.map(item => item.page), [1, 2]);
});

test('removed diff tasks remain explicit coverage work without fabricating current question content', async t => {
  const f = await fixture(t), old = structuredClone(f.draft), removed = structuredClone(old.tasks[0]);
  removed.id = 'removed'; old.tasks.push(removed);
  old.coverage.pages[0].candidates.push({ id: 'removed-candidate', type: 'whole-activity', decision: 'include', taskIds: ['removed'] });
  await f.write('before.json', old);
  const diff = await reviewDiff(['--before=data/jobs/synthetic/before.json', '--after=data/jobs/synthetic/draft.json'], { project: f.project, cwd: f.project });
  const { value, html } = await f.packet(`--diff=${diff.reportPath}`);
  assert.deepEqual(value.removedTaskIds, ['removed']); assert.equal(value.fullBatchReviewRequired, true);
  assert.deepEqual(value.selectedTaskIds, ['q1']); assert.ok(value.tasks.every(task => task.taskId !== 'removed'));
  assert.match(html, /重新核对完整覆盖/);
});

test('same bytes under a different after filename do not satisfy diff identity', async t => {
  const f = await fixture(t), old = structuredClone(f.draft); old.tasks[0].stem.blocks[0].text = '旧';
  await f.write('before.json', old);
  await fs.copyFile(path.join(f.job, 'draft.json'), path.join(f.job, 'other.json'));
  const diff = await reviewDiff(['--before=data/jobs/synthetic/before.json', '--after=data/jobs/synthetic/draft.json'], { project: f.project, cwd: f.project });
  await assert.rejects(reviewMaterials(['--manifest=data/jobs/synthetic/other.json', `--diff=${diff.reportPath}`], { project: f.project, cwd: f.project }), /afterPath/);
});

test('whole draft provenance is validated before selection, including unselected task edits', async t => {
  const f = await fixture(t); f.draft.tasks[1].stem.blocks[0].text = '手改未选中的题';
  await f.write('draft.json', f.draft);
  await assert.rejects(f.create(), /冻结 paired\/mapping/);
  assert.equal((await fs.readdir(path.join(f.project, 'data'))).includes('review'), false);
});

test('approved state and inherited true checks cannot turn a packet into review evidence', async t => {
  const f = await fixture(t), original = structuredClone(f.draft);
  f.draft.tasks[0].review.status = 'approved'; await f.write('draft.json', f.draft);
  await assert.rejects(f.create(), /不是待审草稿/);
  original.tasks[1].review.checks.sourceText = true; await f.write('draft.json', original);
  await assert.rejects(f.create(), /旧检查/);
});

test('changed original hash fails even when the changed page belongs only to an unresolved alternative', async t => {
  const f = await fixture(t, { conflicting: true, candidatePage: 4 });
  await fs.appendFile(path.join(f.job, 'images', 'page-4.png'), Buffer.from('changed'));
  await assert.rejects(f.create(), /SHA256/);
  assert.equal((await fs.readdir(path.join(f.project, 'data'))).includes('review'), false);
});

test('candidate bbox outside actual original dimensions fails before output', async t => {
  const f = await fixture(t, { conflicting: true, candidatePage: 4 });
  f.records.answers[2].source.regions[0].bbox = [10, 5, 241, 90];
  const input = await f.write('records.json', f.records), pairedValue = preparePairedBatch(f.records);
  pairedValue.preparation = { kind: 'deterministic-local-pairing', input,
    unmatchedAnswers: f.records.answers.filter(record => pairedValue.unmatchedAnswerIds.includes(record.id)), automaticallyApproved: false };
  const paired = await f.write('paired.json', pairedValue);
  const mapping = f.draft.preparation.mapping;
  const next = prepareDraftBatch(pairedValue, f.mappingValue, f.job, { paired, mapping }).manifest;
  await f.write('draft.json', next);
  await assert.rejects(f.create(), /bbox.*越界/);
});

test('missing candidate records fail explicitly instead of silently dropping alternatives', async t => {
  const f = await fixture(t, { conflicting: true });
  delete f.pairedValue.preparation;
  const paired = await f.write('paired.json', f.pairedValue);
  const next = prepareDraftBatch(f.pairedValue, f.mappingValue, f.job, { paired, mapping: f.draft.preparation.mapping }).manifest;
  await f.write('draft.json', next);
  await assert.rejects(f.create(), /缺少完整冻结记录/);
});

test('HTML embeds real PNG/JPEG bytes offline and escapes original source text', async t => {
  const f = await fixture(t), { html } = await f.packet();
  assert.match(html, /img-src data:/); assert.match(html, /<img src="data:image\/png;base64,/);
  assert.ok(!/<script\b/iu.test(html)); assert.ok(!/<(?:iframe|object|link|form)\b/iu.test(html));
  assert.ok(!/\b(?:src|href)\s*=\s*["'](?:https?:|\/\/|file:)/iu.test(html));
  assert.match(html, /&lt;script&gt;不执行&lt;\/script&gt;/);
  const base64 = /src="data:image\/png;base64,([A-Za-z0-9+/=]+)"/u.exec(html)[1];
  assert.equal(sha256(Buffer.from(base64, 'base64')), sha256(createDemoDiagram()));
});

test('CLI rejects unknown, repeated, multiple, blank and split selectors without creating material output', async t => {
  const f = await fixture(t), run = args => reviewMaterials(args, { project: f.project, cwd: f.project });
  for (const args of [[], ['--manifest=data/jobs/synthetic/draft.json'],
    ['--manifest=data/jobs/synthetic/draft.json', '--tasks=q1', '--diagnostics=all'],
    ['--manifest=data/jobs/synthetic/draft.json', '--tasks=q1', '--tasks=q2'],
    ['--manifest=data/jobs/synthetic/draft.json', '--tasks', 'q1'],
    ['--manifest=data/jobs/synthetic/draft.json', '--tasks=q1,'],
    ['--manifest=data/jobs/synthetic/draft.json', '--tasks=q1,q1'],
    ['--manifest=data/jobs/synthetic/draft.json', '--tasks=unknown'],
    ['--manifest=data/jobs/synthetic/draft.json', '--diagnostics=other']]) await assert.rejects(run(args));
  assert.match((await run(['--help'])).help, /--manifest=.*--tasks=/);
  assert.equal((await fs.readdir(path.join(f.project, 'data'))).includes('review'), false);
});

test('output remains confined to data/review, refuses overwrite and preserves inputs', async t => {
  const f = await fixture(t), initial = await fs.readFile(path.join(f.job, 'records.json'));
  await assert.rejects(f.create('--tasks=q1', '../jobs/synthetic'), /data\/review/);
  const result = await f.create(), packet = await fs.readFile(result.reportPath), html = await fs.readFile(result.previewPath);
  await assert.rejects(f.create(), /输出已存在/);
  assert.deepEqual(await fs.readFile(result.reportPath), packet); assert.deepEqual(await fs.readFile(result.previewPath), html);
  assert.deepEqual(await fs.readFile(path.join(f.job, 'records.json')), initial);
});

test('diff source outside review boundary and before source traversal are rejected', async t => {
  const f = await fixture(t);
  await f.write('diff.json', { beforePath: '../other.json' });
  await assert.rejects(f.create('--diff=data/jobs/synthetic/diff.json'), /data\/review/);
  await fs.mkdir(path.join(f.project, 'data', 'review', 'forged'), { recursive: true });
  await fs.writeFile(path.join(f.project, 'data', 'review', 'forged', 'diff.json'), JSON.stringify({ beforePath: '../other.json' }));
  await assert.rejects(f.create('--diff=data/review/forged/diff.json'), /同 job 文件名/);
});

test('core selector cannot omit current full manifest identity', async t => {
  const f = await fixture(t);
  assert.throws(() => createReviewMaterials(f.draft, f.manifest.sha256, f.job, { taskIds: ['q1'] }), /manifestPath/);
  assert.throws(() => createReviewMaterials(f.draft, f.manifest.sha256, f.job, { manifestPath: 'draft.json', taskIds: ['q1'], diagnosticSeverity: 'all' }), /恰选/);
});

test('source image junction escapes fail instead of reading an outside original', async t => {
  const f = await fixture(t), outside = path.join(f.project, 'outside-synthetic');
  await fs.mkdir(outside);
  await fs.rename(path.join(f.job, 'images', 'page-1.png'), path.join(outside, 'page-1.png'));
  await fs.rename(path.join(f.job, 'images', 'page-2.png'), path.join(outside, 'page-2.png'));
  await fs.rename(path.join(f.job, 'images', 'page-3.png'), path.join(outside, 'page-3.png'));
  await fs.rename(path.join(f.job, 'images', 'page-4.png'), path.join(outside, 'page-4.png'));
  await fs.rmdir(path.join(f.job, 'images'));
  await fs.symlink(outside, path.join(f.job, 'images'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.create(), /软链接越界|越出作业根/);
  await fs.unlink(path.join(f.job, 'images'));
});

test('review output junction escapes fail and never write to their synthetic outside destination', async t => {
  const f = await fixture(t), outside = path.join(f.project, 'outside-synthetic');
  await fs.mkdir(outside); await fs.mkdir(path.join(f.project, 'data', 'review'), { recursive: true });
  await fs.symlink(outside, path.join(f.project, 'data', 'review', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.create('--tasks=q1', 'escape'), /越出 data\/review/);
  assert.deepEqual(await fs.readdir(outside), []);
  await fs.unlink(path.join(f.project, 'data', 'review', 'escape'));
});

test('reproducible invalid coverage exports diagnostics and verbatim bad declarations without inventing task mappings', async t => {
  const cases = [
    ['missing-taskids', mapping => { delete mapping.coverage.pages[1].candidates[0].taskIds; }],
    ['non-array-taskids', mapping => { mapping.coverage.pages[1].candidates[0].taskIds = 'q1'; }],
    ['non-array-candidates', mapping => { mapping.coverage.pages[1].candidates = { invalid: 'candidates' }; }],
    ['missing-candidates', mapping => { delete mapping.coverage.pages[1].candidates; }],
    ['null-candidate', mapping => { mapping.coverage.pages[1].candidates[0] = null; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, async nested => {
    const f = await fixture(nested); mutate(f.mappingValue);
    const mapping = await f.write('mapping.json', f.mappingValue);
    const generated = prepareDraftBatch(f.pairedValue, f.mappingValue, f.job, { paired: f.draft.preparation.paired, mapping });
    assert.equal(generated.report.valid, false);
    const manifest = await f.write('draft.json', generated.manifest, { bom: true });
    const inputBytes = await fs.readFile(path.join(f.job, 'draft.json'));
    const expectedBadPage = generated.manifest.coverage.pages[1];
    for (const [selector, directory, expectedIds] of [
      ['--diagnostics=error', 'errors', ['q1', 'q2']], ['--tasks=q1', 'task', ['q1']],
    ]) {
      const { value, html, result } = await f.packet(selector, directory);
      assert.equal(result.draftValid, false); assert.deepEqual(value.selectedTaskIds, expectedIds);
      assert.equal(value.manifest.sha256, manifest.sha256);
      const page = value.coverageContext.find(item => item.page === 2);
      assert.deepEqual(page.candidates, expectedBadPage.candidates);
      assert.equal(Object.hasOwn(page, 'candidates'), Object.hasOwn(expectedBadPage, 'candidates'));
      assert.ok(value.coverageDiagnostics.some(item => item.severity === 'error' && item.location.pageIndex === 1));
      assert.deepEqual(value.tasks[0].sourceReferences.stem.map(item => item.page), [1, 2]);
      assert.ok(value.tasks.every(task => task.checks === undefined && task.review === undefined));
      assert.equal(value.coverageChecked, false); assert.equal(value.automaticApproval, false); assert.equal(value.readyForExecution, false);
      assert.match(html, /当前覆盖诊断（问题未被修复或清除）/);
      assert.match(html, /coverage\.pages\[1\]/);
    }
    assert.deepEqual(await fs.readFile(path.join(f.job, 'draft.json')), inputBytes);
  });
});
