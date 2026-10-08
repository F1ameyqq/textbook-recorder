import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
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

function syntheticPng(width, height) {
  const chunk = (name, data) => {
    const body = Buffer.concat([Buffer.from(name), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length); body.copy(result, 4); result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
    return result;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(height * (width * 3 + 1), 255);
  for (let row = 0; row < height; row++) pixels[row * (width * 3 + 1)] = 0;
  return Buffer.concat([PNG.subarray(0, 8), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

function sourceRecord(pages, regions, images = ['synthetic.png']) {
  return { source: { pages, images, regions } };
}

test('structured diagnostics locate review issues, exact content blocks and coverage candidates without changing gates', async t => {
  const dir = await workspace(t), manifest = fixture();
  manifest.tasks[0].review.status = 'pending';
  manifest.tasks[0].review.issues = ['answer_missing', 'stem_source_locations_missing'];
  manifest.tasks[0].review.checks.sourceText = false;
  manifest.tasks[0].answer.blocks[0].text = 'R=U/I';
  manifest.coverage.pages[0].candidates[0].decision = 'pending';
  const report = inspectReviewedBatch(manifest, dir);
  assert.equal(report.valid, false); assert.equal(report.readyForExecution, false);
  const issue = report.diagnostics.find(item => item.code === 'answer_missing');
  assert.equal(issue.location.taskIndex, 0); assert.equal(issue.location.side, 'answer');
  assert.equal(issue.location.path, 'tasks[0].review.issues[0]');
  assert.ok(issue.input.includes('pairings'));
  assert.equal(report.diagnostics.find(item => item.code === 'stem_source_locations_missing').anchor, 'task-0-stem-source');
  const risk = report.diagnostics.find(item => item.code === 'special-review');
  assert.equal(risk.anchor, 'task-0-answer-block-0');
  assert.equal(risk.location.path, 'tasks[0].answer.blocks[0]');
  assert.ok(report.diagnostics.some(item => item.anchor === 'coverage-page-0-candidate-0' && item.input === 'mapping.json'));
  const html = renderReviewedBatchPreview(manifest, dir, report);
  for (const anchor of ['task-0-answer', 'task-0-stem-source', 'task-0-answer-block-0', 'coverage-page-0-candidate-0']) {
    assert.ok(html.includes(`href="#${anchor}"`)); assert.ok(html.includes(`id="${anchor}"`));
  }
  assert.ok(html.includes('answer_missing')); assert.ok(html.includes('建议输入'));
});

test('source regions keep declared cross-page order and show genuine pixel windows alongside transcription', async t => {
  const dir = await workspace(t), manifest = fixture();
  await fs.writeFile(path.join(dir, 'synthetic.png'), syntheticPng(4, 4));
  const regions = [{ page: 2, image: 'synthetic.png', bbox: [1, 1, 3, 3] }, { page: 1, image: 'synthetic.png', bbox: [0, 0, 4, 2] }];
  manifest.tasks[2].preparation = { records: { stem: sourceRecord([1, 2], regions), answer: sourceRecord([9], [{ page: 9, image: 'synthetic.png', bbox: [0, 0, 1, 1] }]) } };
  const before = JSON.stringify(manifest), html = renderReviewedBatchPreview(manifest, dir);
  const whole = html.slice(html.indexOf('id="task-2"'), html.indexOf('id="page-coverage"'));
  assert.ok(whole.indexOf('来源区域 1 · 原书页 2') < whole.indexOf('来源区域 2 · 原书页 1'));
  assert.ok(whole.includes('aspect-ratio:2/2'));
  assert.ok(whole.includes('width:200%;height:200%;left:-50%;top:-50%'));
  assert.ok(whole.includes('题干录入内容') && whole.includes('答案原图'));
  assert.ok(whole.includes('查看整页（原像素，可滚动）'));
  assert.ok(whole.includes('width="4" height="4"'));
  assert.equal(JSON.stringify(manifest), before);
  assert.deepEqual((await fs.readdir(dir)).sort(), ['synthetic.png']);
});

test('absent regions fall back to declared page originals and disclose missing answer originals', async t => {
  const dir = await workspace(t), manifest = fixture(), html = renderReviewedBatchPreview(manifest, dir);
  const first = html.slice(html.indexOf('id="task-0"'), html.indexOf('id="task-1"'));
  assert.ok(first.includes('未声明原像素区域'));
  assert.ok(first.includes('原书页 1（未声明区域）'));
  assert.ok(first.includes('原书页 9（未声明区域）：未附本地原图'));
  assert.ok(first.includes('不能证明题目边界或审校完成'));
  assert.ok(first.indexOf('正文原图') < first.indexOf('题干录入内容'));
});

test('bad region boxes and mismatched pages are inert and never become CSS or source requests', async t => {
  const dir = await workspace(t), manifest = fixture();
  const badBoxes = [[0, 0, 2, 1], [-1, 0, 1, 1], [0, 0, 0, 1], [0, 0, 0.5, 1], [0, 0, 1, '1;background:url(https://evil.invalid/)'], null];
  for (const bbox of badBoxes) {
    manifest.tasks[0].preparation = { records: { stem: sourceRecord([1], [{ page: 1, image: 'synthetic.png', bbox }]) } };
    const html = renderReviewedBatchPreview(manifest, dir);
    assert.ok(html.includes('bbox 须为原像素有效范围'));
    assert.ok(!html.includes('style="aspect-ratio:'));
    assert.ok(!/style="[^"]*evil\.invalid/iu.test(html));
  }
  for (const region of [{ page: 2, image: 'synthetic.png', bbox: [0, 0, 1, 1] }, { page: 1, image: 'other.png', bbox: [0, 0, 1, 1] }, null]) {
    manifest.tasks[0].preparation.records.stem.source.regions = [region];
    assert.ok(renderReviewedBatchPreview(manifest, dir).includes('无法显示'));
  }
});

test('hostile source paths and review issues stay escaped through the original safety boundary', async t => {
  const dir = await workspace(t), manifest = fixture();
  const attack = '<script>alert(1)</script><img src=https://evil.invalid/ onerror=alert(1)>';
  manifest.tasks[0].review.status = 'pending'; manifest.tasks[0].review.issues = [attack];
  // Answer page 9 has no coverage original, so the source loader itself must reject these.
  for (const image of ['https://evil.invalid/x.png', '../outside.png', attack, 'foreign.svg']) {
    manifest.tasks[0].preparation = { records: { answer: sourceRecord([9], [{ page: 9, image, bbox: [0, 0, 1, 1] }], [image]) } };
    const html = renderReviewedBatchPreview(manifest, dir);
    assert.ok(html.includes('无法显示'));
    assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(!/<script\b|<svg\b|<[a-z][^>]*\son(?:error|click)=/iu.test(html));
    assert.ok(!/<(?:img|iframe|link)[^>]+(?:src|href)=["']?https?:/iu.test(html));
  }
});

test('source region images reject an actual symlink or junction escaping the manifest directory', async t => {
  const dir = await workspace(t), outside = await workspace(t), manifest = fixture();
  if (!await directoryLink(t, outside, path.join(dir, 'outside-link'))) return;
  const image = 'outside-link/synthetic.png';
  manifest.tasks[0].preparation = { records: { answer: sourceRecord([9], [{ page: 9, image, bbox: [0, 0, 1, 1] }], [image]) } };
  const html = renderReviewedBatchPreview(manifest, dir);
  assert.ok(html.includes('图片软链接越界'));
  const answer = html.slice(html.indexOf('id="task-0-answer-source"'), html.indexOf('答案录入内容'));
  assert.ok(!answer.includes('data:image/'));
});

test('every diagnostic href targets existing markup even for malformed task/page/candidate material', async t => {
  const dir = await workspace(t), manifest = fixture();
  manifest.tasks[0] = null; manifest.coverage.pages[0].candidates[1] = '<img onerror=alert(1)>'; manifest.coverage.pages.push(null);
  const html = renderReviewedBatchPreview(manifest, dir);
  const anchors = new Set([...html.matchAll(/id="([^"]+)"/gu)].map(match => match[1]));
  for (const match of html.matchAll(/href="#([^"]+)"/gu)) assert.ok(anchors.has(match[1]), `Missing target: ${match[1]}`);
});

test('JSON objects shadowing coercion methods stay inert in issues, image captions and other metadata', async t => {
  const dir = await workspace(t), bad = { toString: 'invalid-object', valueOf: 'invalid-value', text: '<script>alert(1)</script>' };
  for (const mutate of [
    manifest => { manifest.tasks[0].review.issues = [bad]; },
    manifest => { manifest.tasks[0].preparation = { records: { stem: sourceRecord([1], [], [bad]) } }; },
    manifest => { manifest.tasks[0].target.chapterLabel = bad; manifest.tasks[0].target.record = bad; manifest.tasks[0].id = bad; },
    manifest => { manifest.tasks[0].stem.blocks[0].text = bad; manifest.tasks[0].source.pages = [bad]; },
    manifest => { manifest.tasks[0].answer.blocks = [{ type: 'text', parts: [bad, '2'] }]; },
    manifest => { manifest.tasks[0].stem.blocks = [{ type: 'text', runs: [{ type: 'text', text: bad }] }]; },
    manifest => { manifest.coverage.pages[0].candidates[0].id = bad; manifest.coverage.pages[0].page = bad; },
  ]) {
    const manifest = fixture(); mutate(manifest);
    const report = inspectReviewedBatch(manifest, dir), html = renderReviewedBatchPreview(manifest, dir, report);
    assert.ok(html.includes('invalid-object')); assert.ok(!/<script\b/iu.test(html));
    const anchors = new Set([...html.matchAll(/id="([^"]+)"/gu)].map(match => match[1]));
    for (const match of html.matchAll(/href="#([^"]+)"/gu)) assert.ok(anchors.has(match[1]), `Missing target: ${match[1]}`);
  }
  const manifest = fixture(); manifest.tasks[0].review.issues = [bad];
  assert.equal(inspectReviewedBatch(manifest, dir).coreValid, false);
});

test('authorized missing-answer pages use a byte-bound index original without inventing a source region', async t => {
  const dir = await workspace(t), manifest = fixture();
  await fs.mkdir(path.join(dir, 'images')); await fs.writeFile(path.join(dir, 'images', 'p3.png'), PNG);
  const index = { schemaVersion: 1, bookId: manifest.bookId, pages: [{ systemPage: 1, file: 'synthetic.png', width: 1, height: 1, sha256: createHash('sha256').update(PNG).digest('hex') },
    { systemPage: 3, file: 'images/p3.png', width: 1, height: 1, sha256: createHash('sha256').update(PNG).digest('hex') }] };
  const indexBytes = Buffer.from(JSON.stringify(index)); await fs.writeFile(path.join(dir, 'index.json'), indexBytes);
  manifest.preparation = { index: { path: 'index.json', sha256: createHash('sha256').update(indexBytes).digest('hex') } };
  manifest.tasks[0].source.answerPages = [3]; manifest.tasks[0].answerStatus = 'not-provided';
  manifest.tasks[0].answer.blocks[0].text = '原书未提供参考答案';
  manifest.tasks[0].preparation = { records: { answer: null }, notes: [{ kind: 'user-authorized-missing-reference', searchedAnswerPages: [3] }] };
  const before = JSON.stringify(manifest), html = renderReviewedBatchPreview(manifest, dir);
  const answer = html.slice(html.indexOf('id="task-0-answer-source"'), html.indexOf('答案录入内容'));
  assert.ok(answer.includes('原书页 3（未声明区域）'));
  assert.ok(answer.includes('data:image/png;base64,'));
  assert.ok(!answer.includes('未附本地原图')); assert.ok(!answer.includes('bbox'));
  assert.equal(JSON.stringify(manifest), before);
  await fs.writeFile(path.join(dir, 'images', 'p3.png'), syntheticPng(2, 2));
  const rejected = renderReviewedBatchPreview(manifest, dir);
  assert.ok(rejected.includes('原图 index 无法用于来源补全'));
  assert.ok(rejected.includes('原书页 3（未声明区域）：未附本地原图'));
});

test('index evidence errors remain visible and cannot fetch paths or use stale reference bytes', async t => {
  const dir = await workspace(t), manifest = fixture();
  for (const reference of [{ path: '../outside.json', sha256: 'a'.repeat(64) }, { path: 'https://evil.invalid/index.json', sha256: 'a'.repeat(64) }, { path: { toString: 'invalid-index' }, sha256: 'a'.repeat(64) }]) {
    manifest.preparation = { index: reference };
    const html = renderReviewedBatchPreview(manifest, dir);
    assert.ok(html.includes('原图 index 无法用于来源补全'));
    assert.ok(html.includes('class="batch-diagnostics" open'));
    assert.ok(!/<(?:img|iframe|link)[^>]+(?:src|href)=["']?https?:/iu.test(html));
  }
  await fs.writeFile(path.join(dir, 'index.json'), '{"schemaVersion":1}');
  manifest.preparation.index = { path: 'index.json', sha256: 'a'.repeat(64) };
  assert.ok(renderReviewedBatchPreview(manifest, dir).includes('index 引用 SHA256 已变化'));
});

test('pending human checks are compact by default while errors open the batch index and navigation remains available', async t => {
  const dir = await workspace(t), manifest = fixture();
  manifest.tasks[0].review.status = 'pending';
  manifest.tasks[0].review.checks = { sourceText: false, answerMatch: false, wholeQuestion: false, format: false };
  let html = renderReviewedBatchPreview(manifest, dir);
  assert.ok(html.includes('<details class="batch-diagnostics"><summary>'));
  assert.ok(html.includes('<details class="task-diagnostics"><summary>'));
  assert.ok(html.includes('class="check-details"><summary>展开人工检查说明（4）'));
  assert.ok(html.includes('aria-label="题目导航"'));
  assert.ok(html.includes('原文 待确认 · 答案归属 待确认 · 整题 待确认 · 格式 待确认'));
  manifest.tasks[0].stem.blocks[0].text += '\uFFFD';
  html = renderReviewedBatchPreview(manifest, dir);
  assert.ok(html.includes('<details class="batch-diagnostics" open>'));
  assert.ok(html.includes('<details class="task-diagnostics" open>'));
});

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

test('CLI accepts explicit data/review output through an actual project-root alias', async t => {
  const dir = await workspace(t), output = await outputWorkspace(t), file = path.join(dir, 'batch.json');
  await fs.writeFile(file, JSON.stringify(fixture()));
  const alias = path.join(dir, 'project-alias');
  if (!await directoryLink(t, PROJECT, alias)) return;
  const relativeOutput = path.relative(PROJECT, output);
  const result = await reviewBatch(['--manifest', file, '--outputdir', relativeOutput], alias);
  assert.equal(result.valid, true);
  assert.equal(result.reportPath, path.join(await fs.realpath(output), 'preflight.json'));
  assert.equal(result.previewPath, path.join(await fs.realpath(output), 'preview.html'));
  assert.equal(await fs.realpath(alias), await fs.realpath(PROJECT));
  const outsideLink = path.join(output, 'outside-link');
  if (!await directoryLink(t, dir, outsideLink)) return;
  await assert.rejects(reviewBatch(['--manifest', file, '--outputdir',
    path.join(relativeOutput, 'outside-link', 'uncreated')], alias), /junction|软链接/u);
  await assert.rejects(fs.access(path.join(dir, 'uncreated')), { code: 'ENOENT' });
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
