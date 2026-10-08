import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { preparePairedBatch } from '../src/paired-batch.mjs';
import { prepareDraftBatch } from '../src/draft-batch.mjs';
import { createDemoDiagram } from '../src/demo-batch.mjs';
import { sha256 } from '../src/preparation-files.mjs';
import { createReviewDecisionsTemplate } from '../src/review-decisions-template.mjs';
import { createReviewDecisions } from '../scripts/create-review-decisions.mjs';
import { approveDraft } from '../scripts/approve-reviewed-draft.mjs';

async function fixture(t, { answer = '蓝色', missing = false } = {}) {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'recorder-decisions-'));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const job = path.join(project, 'data', 'jobs', 'synthetic');
  await fs.mkdir(path.join(job, 'images'), { recursive: true });
  const bytes = createDemoDiagram(), pages = [];
  for (let page = 1; page <= 3; page++) {
    const file = `images/page-${page}.png`;
    await fs.writeFile(path.join(job, file), bytes);
    pages.push({ systemPage: page, file, sha256: sha256(bytes), width: 240, height: 100 });
  }
  const write = async (name, value, { bom = false } = {}) => {
    const raw = Buffer.from((bom ? '\uFEFF' : '') + JSON.stringify(value, null, 2) + '\r\n');
    await fs.writeFile(path.join(job, name), raw);
    return { path: name, sha256: sha256(raw) };
  };
  const index = await write('index.json', { schemaVersion: 1, bookId: 900001, pages });
  const source = chosen => ({ pages: chosen, images: chosen.map(page => pages[page - 1].file),
    regions: chosen.map(page => ({ page, image: pages[page - 1].file, bbox: [10, 5, 200, 90] })) });
  const record = (id, text, chosen) => ({ id, chapter: '合成章', unit: '合成节', group: '基础', questionNumber: 1, rawOcr: text, source: source(chosen) });
  const pairedValue = preparePairedBatch({ schemaVersion: 1, bookId: 900001,
    questions: [record('q', '1. 左边是什么颜色？', [1, 2])], answers: missing ? [] : [record('a', answer, [3])] });
  const paired = await write('paired.json', pairedValue);
  const mappingValue = { schemaVersion: 1, kind: 'new-system-draft-mapping', bookId: 900001, source: 'fixture', index,
    placements: [{ questionId: 'q', target: { chapterLabel: '合成章', sectionLabel: '合成节', record: 1 },
      answerRequirement: { kind: 'question', evidence: '请作答图左边的颜色' }, answerStatus: missing ? 'not-provided' : 'provided',
      ...(missing ? { searchedAnswerPages: [3] } : {}) }],
    coverage: { pages: [1, 2].map(page => ({ page, imagePath: pages[page - 1].file,
      candidates: [{ id: `candidate-q-${page}`, type: 'whole-activity', decision: 'include', taskIds: ['q'] }] })) } };
  const mapping = await write('mapping.json', mappingValue);
  const draft = prepareDraftBatch(pairedValue, mappingValue, job, { paired, mapping }).manifest;
  const manifest = await write('draft.json', draft, { bom: true });
  const create = (output = 'review-decisions.json') => createReviewDecisions([
    '--manifest=data/jobs/synthetic/draft.json', `--output=data/jobs/synthetic/${output}`], { project, cwd: project });
  return { project, job, draft, manifest, pairedValue, mappingValue, write, create };
}

test('exact BOM/CRLF draft bytes bind a fully blank template with cross-page source references', async t => {
  const f = await fixture(t), before = await fs.readFile(path.join(f.job, 'draft.json'));
  const result = await f.create(), decisions = JSON.parse(await fs.readFile(result.outputPath, 'utf8'));
  assert.equal(decisions.manifestSha256, sha256(before));
  assert.equal(decisions.manifestSha256, f.manifest.sha256);
  assert.equal(decisions.coverageChecked, false); assert.equal(decisions.source, 'fixture');
  assert.equal(decisions.sourceSemanticsVerifiedByTool, false); assert.equal(decisions.platformWritePerformed, false);
  assert.equal(result.approved, 0); assert.equal(result.readyForExecution, false); assert.equal(result.draftValid, true);
  assert.equal(result.platformWritePerformed, false); assert.equal(result.manifestSha256, f.manifest.sha256);
  assert.deepEqual(decisions.tasks[0].checks, { sourceText: false, answerMatch: false, wholeQuestion: false, format: false });
  assert.equal(decisions.tasks[0].evidence, ''); assert.equal(decisions.tasks[0].specialReview, undefined);
  assert.equal(decisions.tasks[0].sourceReferences.referenceOnly, true);
  assert.deepEqual(decisions.tasks[0].sourceReferences.stem.pages, [1, 2]);
  assert.deepEqual(decisions.tasks[0].sourceReferences.stem.regions, f.draft.tasks[0].preparation.records.stem.source.regions);
  assert.deepEqual(decisions.tasks[0].sourceReferences.answer.pages, [3]);
  assert.deepEqual(decisions.tasks[0].sourceReferences.answer.regions, f.draft.tasks[0].preparation.records.answer.source.regions);
  assert.deepEqual(await fs.readFile(path.join(f.job, 'draft.json')), before);
});

test('unfilled template and blank evidence still cannot pass the real approval entry point', async t => {
  const f = await fixture(t); const result = await f.create();
  const argv = ['--manifest=data/jobs/synthetic/draft.json', '--decisions=data/jobs/synthetic/review-decisions.json', '--output=data/jobs/synthetic/approved.json'];
  await assert.rejects(approveDraft(argv, f.project), /coverage|逐页/);
  const decisions = JSON.parse(await fs.readFile(result.outputPath, 'utf8')); decisions.coverageChecked = true;
  await f.write('review-decisions.json', decisions);
  await assert.rejects(approveDraft(argv, f.project), /四项检查/);
  for (const key of Object.keys(decisions.tasks[0].checks)) decisions.tasks[0].checks[key] = true;
  await f.write('review-decisions.json', decisions);
  await assert.rejects(approveDraft(argv, f.project), /实际原图依据/);
  await assert.rejects(fs.access(path.join(f.job, 'approved.json')), /ENOENT/);
});

test('completed actual review can use the template extras with the existing approval tool', async t => {
  const f = await fixture(t); const result = await f.create();
  const decisions = JSON.parse(await fs.readFile(result.outputPath, 'utf8'));
  decisions.coverageChecked = true;
  for (const key of Object.keys(decisions.tasks[0].checks)) decisions.tasks[0].checks[key] = true;
  decisions.tasks[0].evidence = '合成测试：已核对正文第1、2页所列区域、完整活动和第3页答案区域，颜色及格式对应';
  await f.write('review-decisions.json', decisions);
  const approved = await approveDraft(['--manifest=data/jobs/synthetic/draft.json', '--decisions=data/jobs/synthetic/review-decisions.json', '--output=data/jobs/synthetic/approved.json'], f.project);
  assert.equal(approved.approved, 1); assert.equal(approved.readyForExecution, true);
  assert.equal(approved.platformWritePerformed, false);
  assert.equal(JSON.parse(await fs.readFile(approved.manifestPath, 'utf8')).source, 'fixture');
});

test('blocked draft preserves issues, missing reference and searched answer image pointers without inventing regions', async t => {
  const f = await fixture(t, { missing: true }); const result = await f.create();
  const decisions = JSON.parse(await fs.readFile(result.outputPath, 'utf8')), task = decisions.tasks[0];
  assert.equal(result.draftValid, false); assert.equal(result.approved, 0);
  assert.ok(task.pendingIssues.includes('answer_missing')); assert.equal(task.sourceReferences.answer, null);
  assert.deepEqual(task.sourceReferences.answerPages, [3]);
  assert.deepEqual(task.sourceReferences.searchedAnswerImages, [{ page: 3, image: 'images/page-3.png', sha256: sha256(createDemoDiagram()) }]);
  assert.ok(Object.values(task.checks).every(value => value === false)); assert.equal(task.evidence, '');
});

test('special review is a pending hint rather than a copied confirmation', async t => {
  const f = await fixture(t, { answer: 'Q/W □' }); const result = await f.create();
  const task = JSON.parse(await fs.readFile(result.outputPath, 'utf8')).tasks[0];
  assert.deepEqual(task.specialReviewRequired.map(item => item.reason).sort(), ['possible-stacked-fraction', 'printed-square-symbol']);
  assert.ok(task.specialReviewRequired.every(item => item.resolved === false));
  assert.equal(task.specialReview, undefined);
});

test('requires nonempty, unique valid task IDs and workflow draft provenance', async t => {
  const f = await fixture(t);
  for (const tasks of [[], null, [...f.draft.tasks, ...f.draft.tasks], [{ ...f.draft.tasks[0], id: '../escape' }], [{ ...f.draft.tasks[0], id: '' }], [null]]) {
    const draft = structuredClone(f.draft); draft.tasks = tasks;
    assert.throws(() => createReviewDecisionsTemplate(draft, f.manifest.sha256, f.job), /tasks|ID/);
  }
  const noSource = structuredClone(f.draft); delete noSource.preparation;
  assert.throws(() => createReviewDecisionsTemplate(noSource, f.manifest.sha256, f.job), /workflow:draft/);
  const noPaired = structuredClone(f.draft); delete noPaired.preparation.paired;
  assert.throws(() => createReviewDecisionsTemplate(noPaired, f.manifest.sha256, f.job), /paired/);
  assert.throws(() => createReviewDecisionsTemplate(f.draft, 'bad', f.job), /SHA256/);
});

test('approved, forged production and changed old true or special confirmation cannot be reused', async t => {
  const f = await fixture(t);
  const changes = [draft => { draft.tasks[0].review.status = 'approved'; },
    draft => { draft.source = 'production'; }, draft => { draft.tasks[0].review.checks.sourceText = true; },
    draft => { draft.tasks[0].review.specialReview = { printedSquaresConfirmed: true }; },
    draft => { draft.reviewEvidence = { coverageChecked: true }; },
    draft => { draft.preparation.automaticallyApproved = true; },
    draft => { draft.preparation.sourceSemanticsVerifiedByTool = true; },
    draft => { draft.tasks[0].stem.blocks[0].text = '改过的草稿内容'; }];
  for (const change of changes) {
    const draft = structuredClone(f.draft); change(draft);
    assert.throws(() => createReviewDecisionsTemplate(draft, f.manifest.sha256, f.job), /批准|冻结|来源自动确认/);
  }
});

test('changed provenance bytes or source image bytes reject template before output is written', async t => {
  const f = await fixture(t);
  await fs.appendFile(path.join(f.job, 'paired.json'), ' ');
  await assert.rejects(f.create(), /paired SHA256/);
  await f.write('paired.json', f.pairedValue);
  await fs.appendFile(path.join(f.job, 'images/page-1.png'), 'changed');
  await assert.rejects(f.create(), /原图 SHA/);
  await assert.rejects(fs.access(path.join(f.job, 'review-decisions.json')), /ENOENT/);
});

test('same job, root confinement and overwrite protection preserve previously written bytes', async t => {
  const f = await fixture(t); const result = await f.create(); const before = await fs.readFile(result.outputPath);
  await assert.rejects(f.create(), /EEXIST/); assert.deepEqual(await fs.readFile(result.outputPath), before);
  const create = output => createReviewDecisions(['--manifest=data/jobs/synthetic/draft.json', '--output', output], { project: f.project, cwd: f.project });
  await assert.rejects(create('data/jobs/other/out.json'), /同一/);
  await assert.rejects(create('outside/out.json'), /data\/jobs/);
  await assert.rejects(create('data/jobs/synthetic/nested/out.json'), /根目录/);
  await assert.rejects(create('data/jobs/synthetic/draft.json'), /EEXIST/);
  await assert.rejects(fs.access(path.join(f.project, 'data/jobs/other/out.json')), /ENOENT/);
});

test('outside preparation references and actual output junctions cannot escape the job', async t => {
  const f = await fixture(t); const draft = structuredClone(f.draft); draft.preparation.paired.path = '../other/paired.json';
  assert.throws(() => createReviewDecisionsTemplate(draft, f.manifest.sha256, f.job), /越出同一 job/);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'recorder-decisions-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const link = path.join(f.project, 'data/jobs/escape');
  try { await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) { t.skip('Windows 无权创建实际 junction'); return; } throw error; }
  await assert.rejects(createReviewDecisions(['--manifest=data/jobs/synthetic/draft.json', '--output=data/jobs/escape/out.json'], { project: f.project, cwd: f.project }), /越界|越出|真实路径/);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('help and missing or unknown CLI arguments never access a book or create output', async () => {
  const help = await createReviewDecisions(['--help'], { project: 'does-not-exist', cwd: 'does-not-exist' });
  assert.match(help.help, /仅准备待填写模板/);
  await assert.rejects(createReviewDecisions([]), /必须明确提供/);
  await assert.rejects(createReviewDecisions(['--manifest=a', '--output=b', '--source=production']), /未知或重复/);
});
