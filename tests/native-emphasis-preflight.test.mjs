import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectReviewedBatch, renderReviewedBatchPreview } from '../src/review-preflight.mjs';

// These are local synthetic fixtures; their review flags are not book approval.
function markedBlock() {
  return { type: 'text', text: '1. 𠮷亵诗歌', emphasis: {
    schemaVersion: 1, indexUnit: 'unicode-code-points',
    marks: [
      { type: 'emphasis-dot', start: 4, end: 5, text: '亵' },
      { type: 'underline', start: 5, end: 7, text: '诗歌' },
    ],
  } };
}

function fixture(block = markedBlock()) {
  return { schemaVersion: 1, kind: 'new-system-batch', bookId: 900101, source: 'fixture',
    tasks: [{ id: 'synthetic-native-emphasis', target: { chapterLabel: '合成章', sectionLabel: '合成节', record: 1 },
      source: { pages: [1], answerPages: [2] },
      stem: { blocks: [block] }, answer: { blocks: [{ type: 'text', text: '合成答案' }] },
      answerRequirement: { kind: 'question', evidence: '请判断合成语句。' }, answerStatus: 'provided',
      review: { status: 'approved', issues: [], checks: { sourceText: true, answerMatch: true, wholeQuestion: true, format: true } } }],
    coverage: { pages: [{ page: 1, candidates: [
      { id: 'synthetic-native-candidate', type: 'question', decision: 'include', taskIds: ['synthetic-native-emphasis'] },
    ] }] } };
}

test('only canonical final-text code-point marks leave the unsupported-format gate', () => {
  const manifest = fixture(), before = JSON.stringify(manifest);
  const report = inspectReviewedBatch(manifest);
  assert.equal(report.valid, true, report.errors.join('; '));
  assert.equal(report.readyForExecution, true);
  assert.equal(report.unresolvedSpecialReview.length, 0);
  assert.equal(JSON.stringify(manifest), before);
  // Supplementary 𠮷 counts as one code point; no UTF-16 shift is accepted.
  assert.equal(Array.from(manifest.tasks[0].stem.blocks[0].text)[4], '亵');
});

test('valid formatting does not approve a pending task or set any review check', () => {
  const manifest = fixture();
  manifest.tasks[0].review = { status: 'pending', issues: [], checks: {
    sourceText: false, answerMatch: false, wholeQuestion: false, format: false,
  } };
  const before = JSON.stringify(manifest), report = inspectReviewedBatch(manifest);
  assert.equal(report.valid, true, report.errors.join('; '));
  assert.equal(report.readyForExecution, false);
  assert.equal(report.summary.approvedTasks, 0);
  assert.equal(JSON.stringify(manifest), before);
});

test('different canonical native kinds can coexist on the same verified text', () => {
  const block = markedBlock();
  block.emphasis.marks[1] = { type: 'underline', start: 4, end: 7, text: '亵诗歌' };
  const report = inspectReviewedBatch(fixture(block));
  assert.equal(report.valid, true, report.errors.join('; '));
  assert.equal(report.unresolvedSpecialReview.length, 0);
});

const invalidCases = [
  ['null metadata', block => { block.emphasis = null; }],
  ['legacy segment-relative metadata', block => { block.emphasis.sourceSegmentText = block.text; }],
  ['legacy token-only marks', block => { block.emphasis.marks = [{ type: 'emphasis-dot', token: '亵', markedText: '亵' }]; }],
  ['missing version', block => { delete block.emphasis.schemaVersion; }],
  ['empty mark list', block => { block.emphasis.marks = []; }],
  ['non-array marks', block => { block.emphasis.marks = {}; }],
  ['UTF-16 unit', block => { block.emphasis.indexUnit = 'utf-16'; }],
  ['unknown type', block => { block.emphasis.marks[0].type = 'overline'; }],
  ['injected style field', block => { block.emphasis.marks[0].style = 'background:url(https://invalid.example)'; }],
  ['wrong marked text', block => { block.emphasis.marks[0].text = '诗'; }],
  ['UTF-16 offset used as a code-point offset', block => { block.emphasis.marks[0].start = 5; block.emphasis.marks[0].end = 6; }],
  ['negative start', block => { block.emphasis.marks[0].start = -1; }],
  ['outside paragraph', block => { block.emphasis.marks[0].end = 999; }],
  ['empty interval', block => { block.emphasis.marks[0].end = block.emphasis.marks[0].start; }],
  ['fractional interval', block => { block.emphasis.marks[0].start = 4.5; }],
  ['duplicate same-kind interval', block => { block.emphasis.marks.push({ ...block.emphasis.marks[0] }); }],
  ['overlapping same-kind interval', block => { block.emphasis.marks.push({ type: 'underline', start: 4, end: 6, text: '亵诗' }); }],
  ['mixed runs', block => { block.runs = [{ type: 'text', text: block.text }]; }],
  ['mixed parts', block => { block.parts = ['亵', '诗歌']; }],
  ['split combining grapheme', block => {
    block.text = '1. e\u0301诗'; block.emphasis.marks = [{ type: 'emphasis-dot', start: 3, end: 4, text: 'e' }];
  }],
  ['cross-line interval', block => {
    block.text = '1. 亵\n诗歌'; block.emphasis.marks = [{ type: 'underline', start: 3, end: 6, text: '亵\n诗' }];
  }],
];
for (const [name, mutate] of invalidCases) {
  test(`malformed emphasis remains blocked: ${name}`, () => {
    const block = markedBlock(); mutate(block);
    const manifest = fixture(block), before = JSON.stringify(manifest), report = inspectReviewedBatch(manifest);
    assert.equal(report.valid, false);
    assert.equal(report.readyForExecution, false);
    assert.ok(report.errors.some(error => error.includes('原生加点/下划线元数据无效')));
    assert.ok(report.unresolvedSpecialReview.some(risk => risk.reason === 'unsupported-native-format' && risk.resolved === false));
    assert.equal(JSON.stringify(manifest), before);
  });
}

test('misplaced emphasis is inspected before separator/image early returns', () => {
  for (const block of [
    { type: 'analysis-separator', emphasis: markedBlock().emphasis },
    { type: 'image', path: 'absent.png', purpose: 'diagram', align: 'center', emphasis: markedBlock().emphasis },
    { type: 'sup', text: '亵', emphasis: markedBlock().emphasis },
  ]) {
    const report = inspectReviewedBatch(fixture(block));
    assert.equal(report.readyForExecution, false);
    assert.ok(report.unresolvedSpecialReview.some(risk => risk.reason === 'unsupported-native-format'));
  }
});

test('legacy combining marks, formulas and per-run metadata stay blocked', () => {
  for (const block of [
    { type: 'text', text: '风\u0323尘\u0323' },
    { type: 'formula', latex: '\\frac{1}{2}' },
    { type: 'text', runs: [{ type: 'text', text: '亵', emphasis: markedBlock().emphasis }] },
  ]) {
    const report = inspectReviewedBatch(fixture(block));
    assert.equal(report.valid, false);
    assert.equal(report.readyForExecution, false);
    assert.ok(report.unresolvedSpecialReview.length > 0);
  }
});

test('stacked fraction confirmation still blocks otherwise valid native emphasis', () => {
  const manifest = fixture();
  manifest.tasks[0].review.specialReview = { fractionLayoutConfirmed: true, sourceLayout: 'stacked' };
  const report = inspectReviewedBatch(manifest);
  assert.equal(report.valid, false);
  assert.equal(report.readyForExecution, false);
  assert.ok(report.unresolvedSpecialReview.some(risk => risk.reason === 'unsupported-stacked-source-layout'));
});

test('preview displays valid native ranges and escapes hostile text', () => {
  const block = { type: 'text', text: '亵<script>alert(1)</script>', emphasis: {
    schemaVersion: 1, indexUnit: 'unicode-code-points',
    marks: [{ type: 'emphasis-dot', start: 0, end: 1, text: '亵' }],
  } };
  const html = renderReviewedBatchPreview(fixture(block));
  assert.ok(html.includes('text-emphasis-position:under right'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!/<script\b/iu.test(html));
});

test('preview exposes malformed native metadata rather than silently dropping it', () => {
  const block = markedBlock(); block.emphasis.marks[0].text = '错误';
  const html = renderReviewedBatchPreview(fixture(block));
  assert.ok(html.includes('class="invalid"'));
  assert.ok(html.includes('&quot;emphasis&quot;'));
  assert.ok(html.includes('错误'));
  assert.ok(!/<script\b/iu.test(html));
});
