import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectReviewedBatch, renderReviewedBatchPreview } from '../src/review-preflight.mjs';
import { reviewBatch } from '../scripts/review-batch.mjs';

// Synthetic one-pixel raster, never downloaded or copied from a real book.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const checks = () => ({ sourceText: true, answerMatch: true, wholeQuestion: true, format: true });
const PROJECT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUTPUT_ROOT = path.join(PROJECT, 'data', 'review');

function task(id, record, pages, stem = '1. 已知甲量为2，乙量为3，求两量的和。') {
  return { id, target: { chapterLabel: '合成章节', sectionLabel: '合成第1节', record },
    source: { pages, answerPages: [9] },
    stem: { blocks: [{ type: 'text', text: stem }] }, answer: { blocks: [{ type: 'text', text: '5' }] },
    answerRequirement: { kind: 'question', evidence: '求两量的和。' }, answerStatus: 'provided',
    review: { status: 'approved', issues: [], checks: checks() } };
}

function fixture() {
  const tasks = [task('synthetic-1', 1, [1]), task('synthetic-knowledge', 2, [1], '知识建构：总量=甲量+______。'),
    task('synthetic-whole', 3, [1, 2], '活动一：(1)求和。(2)比较甲乙量大小。')];
  tasks[1].answerRequirement = { kind: 'fill-in', evidence: '总量=甲量+______' };
  return { schemaVersion: 1, kind: 'new-system-batch', bookId: 101, source: 'fixture', tasks,
    coverage: { pages: [{ page: 1, imagePath: 'synthetic.png', candidates: [
      { id: 'p1-q1', type: 'question', decision: 'include', taskIds: ['synthetic-1'] },
      { id: 'p1-knowledge', type: 'knowledge-construction', decision: 'include', taskIds: ['synthetic-knowledge'] },
      { id: 'p1-whole-start', type: 'whole-activity', decision: 'include', taskIds: ['synthetic-whole'] },
    ] }, { page: 2, imagePath: 'synthetic.png', candidates: [
      { id: 'p2-whole-end', type: 'whole-activity', decision: 'include', taskIds: ['synthetic-whole'] },
      { id: 'p2-not-question', type: 'non-question', decision: 'exclude', taskIds: [], reason: '仅展示评价流程，无作答要求' },
    ] }] } };
}

async function workspace(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'textbook-share-review-'));
  await fs.writeFile(path.join(dir, 'synthetic.png'), PNG);
  t.after(async () => {
    assert.ok(path.dirname(dir) === path.resolve(os.tmpdir()) && path.basename(dir).startsWith('textbook-share-review-'));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function outputWorkspace(t) {
  await fs.mkdir(OUTPUT_ROOT, { recursive: true });
  const dir = await fs.mkdtemp(path.join(OUTPUT_ROOT, 'preflight-test-'));
  t.after(async () => {
    assert.ok(path.dirname(dir) === OUTPUT_ROOT && path.basename(dir).startsWith('preflight-test-'));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function directoryLink(t, target, link) {
  try { await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
      t.skip('Windows cannot create the actual directory link/junction on this host'); return false;
    }
    throw error;
  }
  return true;
}

const hasError = (report, text) => report.errors.some(error => error.includes(text));

test('complete synthetic cross-page coverage and unnumbered knowledge pass without mutation', async t => {
  const dir = await workspace(t), manifest = fixture(), before = JSON.stringify(manifest);
  const report = inspectReviewedBatch(manifest, dir);
  assert.equal(report.valid, true, report.errors.join('\n'));
  assert.equal(report.readyForExecution, true);
  assert.deepEqual(report.summary, { tasks: 3, sourcePages: 2, candidates: 5, includedCandidates: 4,
    excludedNonQuestions: 1, originalPagesAvailable: 2, approvedTasks: 3,
    specialReviewRisks: 0, unresolvedSpecialReview: 0 });
  assert.equal(JSON.stringify(manifest), before);
});

test('original core source-zero error is retained', async t => {
  const manifest = fixture(); manifest.tasks[0].source.pages = [0];
  const report = inspectReviewedBatch(manifest, await workspace(t));
  assert.equal(report.coreValid, false);
  assert.equal(report.valid, false);
  assert.ok(hasError(report, '正整数'));
});

test('malformed core input is rejected with an inert preview rather than a supplemental crash', async t => {
  const dir = await workspace(t), manifest = fixture();
  manifest.tasks[0].source.pages = 7;
  manifest.tasks[0].source.answerPages = 'not-an-array';
  manifest.tasks[0].answer.blocks[0].parts = 3;
  const report = inspectReviewedBatch(manifest, dir);
  assert.equal(report.valid, false); assert.equal(report.coreValid, false);
  assert.ok(renderReviewedBatchPreview(manifest, dir, report).includes('未通过'));
});

test('knowledge omission or unresolved candidate cannot pass coverage', async t => {
  const dir = await workspace(t);
  for (const mutate of [
    m => { m.coverage.pages[0].candidates[1].decision = 'exclude'; m.coverage.pages[0].candidates[1].taskIds = []; m.coverage.pages[0].candidates[1].reason = '没有题号'; },
    m => { m.coverage.pages[0].candidates[1].decision = 'pending'; },
    m => { m.coverage.pages[0].candidates.splice(1, 1); },
    m => { m.coverage.pages[1].candidates.shift(); },
  ]) {
    const manifest = fixture(); mutate(manifest);
    assert.equal(inspectReviewedBatch(manifest, dir).valid, false);
  }
});

test('whole activity cannot map to split tasks and unknown tasks cannot fill coverage', async t => {
  const dir = await workspace(t), manifest = fixture();
  manifest.coverage.pages[0].candidates[2].taskIds = ['synthetic-whole', 'synthetic-1'];
  assert.ok(hasError(inspectReviewedBatch(manifest, dir), '恰好一条'));
  manifest.coverage.pages[0].candidates[2].taskIds = ['not-a-task'];
  assert.equal(inspectReviewedBatch(manifest, dir).valid, false);
});

test('absence of reference answer is not an answer requirement', async t => {
  const dir = await workspace(t), manifest = fixture();
  manifest.tasks[0].answerStatus = 'not-provided';
  manifest.tasks[0].answer.blocks[0].text = '原书未提供参考答案';
  assert.equal(inspectReviewedBatch(manifest, dir).valid, true);
  manifest.tasks[0].answerRequirement.evidence = '原书未提供参考答案';
  assert.ok(hasError(inspectReviewedBatch(manifest, dir), '缺答备注不能作为入题依据'));
});

test('provided and not-provided answer status must match the actual answer label', async t => {
  const dir = await workspace(t), manifest = fixture();
  manifest.tasks[0].answerStatus = 'not-provided';
  assert.equal(inspectReviewedBatch(manifest, dir).valid, false);
  manifest.tasks[0].answerStatus = 'provided'; manifest.tasks[0].answer.blocks[0].text = '原书未提供参考答案';
  assert.equal(inspectReviewedBatch(manifest, dir).valid, false);
});

test('pending review is not approved and approved requires all four human checks', async t => {
  const dir = await workspace(t), manifest = fixture();
  manifest.tasks[0].review.status = 'pending'; manifest.tasks[0].review.checks.answerMatch = false;
  let report = inspectReviewedBatch(manifest, dir);
  assert.equal(report.valid, true); assert.equal(report.readyForExecution, false);
  manifest.tasks[0].review.status = 'approved';
  report = inspectReviewedBatch(manifest, dir);
  assert.equal(report.valid, false); assert.ok(hasError(report, '必须全部 true'));
  delete manifest.tasks[0].review.checks.format;
  assert.ok(hasError(inspectReviewedBatch(manifest, dir), '四项布尔检查'));
});

test('raster diagram/table allowed but whole-question or missing purpose blocked', async t => {
  const dir = await workspace(t), manifest = fixture();
  const block = { type: 'image', path: 'synthetic.png', align: 'center', purpose: 'diagram' };
  manifest.tasks[0].stem.blocks.push(block);
  assert.equal(inspectReviewedBatch(manifest, dir).valid, true);
  block.purpose = 'table'; assert.equal(inspectReviewedBatch(manifest, dir).valid, true);
  block.purpose = 'whole-question'; assert.ok(hasError(inspectReviewedBatch(manifest, dir), '整题截图禁止'));
  delete block.purpose; assert.equal(inspectReviewedBatch(manifest, dir).valid, false);
});

test('fraction suspicion and bad OCR characters warn while units remain acceptable', async t => {
  const dir = await workspace(t), manifest = fixture();
  manifest.tasks[0].answer.blocks[0].text = 'R=U/I';
  let report = inspectReviewedBatch(manifest, dir);
  assert.equal(report.valid, true); assert.ok(report.warnings.some(warning => warning.includes('疑似斜杠分式')));
  manifest.tasks[0].answer.blocks[0].text = 'J/kg';
  report = inspectReviewedBatch(manifest, dir);
  assert.equal(report.valid, true); assert.equal(report.requiresSpecialReview.length, 0);
  manifest.tasks[0].stem.blocks[0].text += '□�';
  assert.ok(inspectReviewedBatch(manifest, dir).warnings.some(warning => warning.includes('方框')));
});

test('suspected fraction remains previewable but cannot execute until both human linear confirmations', async t => {
  const dir = await workspace(t), manifest = fixture();
  manifest.tasks[0].answer.blocks[0].text = 'R=U/I';
  let report = inspectReviewedBatch(manifest, dir);
  assert.equal(report.valid, true); assert.equal(report.readyForExecution, false);
  assert.equal(report.unresolvedSpecialReview.length, 1);
  assert.equal(report.unresolvedSpecialReview[0].reason, 'possible-stacked-fraction');
  assert.ok(renderReviewedBatchPreview(manifest, dir, report).includes('执行准入：未就绪'));
  for (const special of [{ fractionLayoutConfirmed: true }, { sourceLayout: 'linear' },
    { fractionLayoutConfirmed: false, sourceLayout: 'linear' }]) {
    manifest.tasks[0].review.specialReview = special;
    assert.equal(inspectReviewedBatch(manifest, dir).readyForExecution, false);
  }
  manifest.tasks[0].review.specialReview = { fractionLayoutConfirmed: true, sourceLayout: 'linear' };
  report = inspectReviewedBatch(manifest, dir);
  assert.equal(report.valid, true); assert.equal(report.readyForExecution, true);
  assert.equal(report.unresolvedSpecialReview.length, 0);
  assert.equal(report.requiresSpecialReview[0].resolution, 'human-review-metadata');
  assert.equal(report.requiresSpecialReview[0].sourceVerifiedByTool, false);
  manifest.tasks[0].review.specialReview.fractionLayoutConfirmed = 'true';
  assert.equal(inspectReviewedBatch(manifest, dir).valid, false);
});

test('stacked source geometry is unsupported despite generic or special review confirmations', async t => {
  const dir = await workspace(t), manifest = fixture();
  manifest.tasks[0].answer.blocks[0].text = 'R=U/I';
  manifest.tasks[0].review.specialReview = { fractionLayoutConfirmed: true, sourceLayout: 'stacked' };
  const report = inspectReviewedBatch(manifest, dir);
  assert.equal(report.valid, false); assert.equal(report.readyForExecution, false);
  assert.ok(hasError(report, '原书为上下排分式'));
  assert.ok(report.unresolvedSpecialReview.some(risk => risk.reason === 'unsupported-stacked-source-layout'));
});

test('real printed square symbols need their own confirmation; U+FFFD cannot be confirmed away', async t => {
  const dir = await workspace(t), manifest = fixture();
  manifest.tasks[0].stem.blocks[0].text = '请在□中填写数值，■表示已选中。';
  let report = inspectReviewedBatch(manifest, dir);
  assert.equal(report.valid, true); assert.equal(report.readyForExecution, false);
  assert.equal(report.unresolvedSpecialReview[0].reason, 'printed-square-symbol');
  manifest.tasks[0].review.specialReview = { printedSquaresConfirmed: true };
  report = inspectReviewedBatch(manifest, dir);
  assert.equal(report.valid, true); assert.equal(report.readyForExecution, true);
  manifest.tasks[0].stem.blocks[0].text += '\uFFFD';
  report = inspectReviewedBatch(manifest, dir);
  assert.equal(report.valid, false); assert.equal(report.readyForExecution, false);
  assert.ok(hasError(report, 'U+FFFD'));
  assert.ok(report.unresolvedSpecialReview.some(risk => risk.reason === 'replacement-character'));
});

test('unsupported native formulas and combining emphasis are explicitly gated', async t => {
  const dir = await workspace(t), manifest = fixture();
  manifest.tasks[0].answer.blocks = [{ type: 'formula', latex: '\\frac{1}{2}' }];
  assert.equal(inspectReviewedBatch(manifest, dir).valid, false);
  manifest.tasks[0].answer.blocks = [{ type: 'text', text: '风\u0323尘\u0323' }];
  assert.ok(hasError(inspectReviewedBatch(manifest, dir), '未实现原生强调'));
});

test('preview escapes hostile text/metadata and embeds only verified local raster bytes', async t => {
  const dir = await workspace(t), manifest = fixture();
  const attack = '<script src="https://evil.invalid/x.js"></script><img src=x onerror=alert(1)>';
  manifest.tasks[0].stem.blocks[0].text = attack;
  manifest.tasks[0].answerRequirement.evidence = attack;
  manifest.tasks[0].target.chapterLabel = attack;
  manifest.coverage.pages[1].candidates[1].reason = '说明 ' + attack;
  const html = renderReviewedBatchPreview(manifest, dir);
  assert.ok(!/<script\b|<[a-z][^>]*\son(?:click|error)=/iu.test(html));
  assert.ok(html.includes('&lt;script'));
  assert.ok(html.includes('data:image/png;base64,'));
  assert.ok(html.includes("default-src 'none'"));
  assert.ok(!/<(?:img|iframe|link)[^>]+(?:src|href)=["']?https?:/iu.test(html));
  assert.ok(html.includes('题干') && html.includes('答案') && html.includes('原书页'));
});

test('original raster escape and foreign SVG source are rejected without active preview markup', async t => {
  const dir = await workspace(t), manifest = fixture();
  await fs.writeFile(path.join(dir, 'evil.svg'), '<svg onload="alert(1)"></svg>');
  for (const asset of ['evil.svg', 'https://evil.invalid/x.png', '../outside.png']) {
    manifest.coverage.pages[0].imagePath = asset;
    assert.equal(inspectReviewedBatch(manifest, dir).valid, false);
    const html = renderReviewedBatchPreview(manifest, dir);
    assert.ok(!/<svg\b/iu.test(html));
    assert.ok(!/<img[^>]+src=["']?https?:/iu.test(html));
  }
});

test('CLI outputs local report/preview without modifying or approving the manifest; no overwrite', async t => {
  const dir = await workspace(t), manifest = fixture();
  manifest.tasks[0].review.status = 'pending';
  const file = path.join(dir, 'batch.json'), output = await outputWorkspace(t);
  const raw = JSON.stringify(manifest, null, 2); await fs.writeFile(file, raw);
  const result = await reviewBatch(['--manifest', file, '--outputdir', output], dir);
  assert.equal(result.valid, true); assert.equal(result.readyForExecution, false);
  const report = JSON.parse(await fs.readFile(result.reportPath, 'utf8'));
  assert.equal(report.summary.approvedTasks, 2);
  assert.equal(await fs.readFile(file, 'utf8'), raw);
  assert.ok((await fs.readFile(result.previewPath, 'utf8')).includes('原状态 pending'));
  await assert.rejects(reviewBatch(['--manifest=' + file, '--outputdir=' + output], dir), /输出已存在/u);
  await assert.rejects(reviewBatch(['--manifest', file, '--bogus'], dir), /未知/u);
});

test('CLI rejects a lexical output escape before creating any directory', async t => {
  const dir = await workspace(t), file = path.join(dir, 'batch.json');
  await fs.writeFile(file, JSON.stringify(fixture()));
  const outside = path.join(dir, 'must-not-be-created');
  await assert.rejects(reviewBatch(['--manifest', file, '--outputdir', outside], dir), /data\/review/u);
  await assert.rejects(fs.access(outside), { code: 'ENOENT' });
});

test('CLI rejects an actual symlink/junction ancestor escaping the trusted output root', async t => {
  const dir = await workspace(t), output = await outputWorkspace(t), file = path.join(dir, 'batch.json');
  await fs.writeFile(file, JSON.stringify(fixture()));
  const link = path.join(output, 'outside-link');
  if (!await directoryLink(t, dir, link)) return;
  await assert.rejects(reviewBatch(['--manifest', file, '--outputdir', path.join(link, 'uncreated')], dir), /junction|软链接/u);
  await assert.rejects(fs.access(path.join(dir, 'uncreated')), { code: 'ENOENT' });
});

test('CLI also rejects a junction into the project but outside data/review', async t => {
  const dir = await workspace(t), output = await outputWorkspace(t), file = path.join(dir, 'batch.json');
  await fs.writeFile(file, JSON.stringify(fixture()));
  const link = path.join(output, 'project-data-link');
  if (!await directoryLink(t, path.dirname(OUTPUT_ROOT), link)) return;
  await assert.rejects(reviewBatch(['--manifest', file, '--outputdir', path.join(link, 'uncreated-' + path.basename(output))], dir), /junction|软链接/u);
  await assert.rejects(fs.access(path.join(path.dirname(OUTPUT_ROOT), 'uncreated-' + path.basename(output))), { code: 'ENOENT' });
});
