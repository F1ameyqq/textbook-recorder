import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ANALYSIS_SEPARATOR } from '../src/analysis-separator.mjs';
import { validateNewSystemManifest, renderBlockHtml, renderEditorHtml, expectedEditor, compareNewSystemReadback, createNewSystemRun } from '../src/new-system-core.mjs';
import { inspectReviewedBatch, renderReviewedBatchPreview } from '../src/review-preflight.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR9cAAAAASUVORK5CYII=', 'base64');
const separator = () => ({ type: 'analysis-separator' });
function fixture(t) {
  const baseDir = mkdtempSync(path.join(os.tmpdir(), 'recorder-analysis-separator-'));
  t.after(() => {
    assert.equal(path.dirname(baseDir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(baseDir).startsWith('recorder-analysis-separator-'));
    rmSync(baseDir, { recursive: true, force: true });
  });
  writeFileSync(path.join(baseDir, 'figure.png'), PNG);
  const task = {
    id: 'synthetic-analysis', target: { chapterLabel: '示例章', sectionLabel: '示例节', record: 1 },
    source: { pages: [1], answerPages: [2] },
    stem: { blocks: [{ type: 'text', text: '1. 选择正确选项。' }] },
    answer: { blocks: [{ type: 'text', text: '1. B' }, separator(), { type: 'text', text: '1. 解析' },
      { type: 'image', path: 'figure.png', purpose: 'diagram', align: 'center' }, { type: 'text', text: 'B（√）完整解释。' }] },
    answerRequirement: { kind: 'question', evidence: '选择正确选项。' }, answerStatus: 'provided',
    review: { status: 'approved', issues: [], checks: { sourceText: true, answerMatch: true, wholeQuestion: true, format: true } },
  };
  const manifest = { schemaVersion: 1, kind: 'new-system-batch', bookId: 101, source: 'fixture', tasks: [task],
    coverage: { pages: [{ page: 1, candidates: [{ id: 'synthetic-candidate', type: 'question', decision: 'include', taskIds: [task.id] }] }] } };
  return { baseDir, task, manifest };
}
function readback(task, baseDir) {
  const editor = side => {
    const expected = expectedEditor(task[side], baseDir);
    return { ...expected, html: renderEditorHtml(task[side], baseDir), images: expected.images.map(image => ({ ...image,
      complete: true, width: image.width ?? 1, height: image.height ?? 1, align: image.type === 'analysis-separator' ? 'start' : 'center' })) };
  };
  return { status: 'found', bookId: 101, target: structuredClone(task.target), source: structuredClone(task.source), recordId: 1001,
    stem: editor('stem'), answer: editor('answer') };
}

test('native analysis separator is answer-only, unique and requires content on both sides', t => {
  const { manifest, task, baseDir } = fixture(t);
  assert.equal(validateNewSystemManifest(manifest, baseDir).valid, true);
  task.stem.blocks.push(separator(), { type: 'text', text: '题干继续' });
  assert.match(validateNewSystemManifest(manifest, baseDir).errors.join(';'), /仅允许用于答案/u);
  task.stem.blocks = [{ type: 'text', text: '选择正确选项。' }];
  for (const blocks of [[separator(), { type: 'text', text: '解析' }], [{ type: 'text', text: 'B' }, separator()],
    [{ type: 'text', text: 'B' }, separator(), { type: 'text', text: '解析' }, separator(), { type: 'text', text: '第二解析' }],
    [{ type: 'text', text: ' ' }, separator(), { type: 'text', text: '解析' }]]) {
    task.answer.blocks = blocks;
    assert.equal(validateNewSystemManifest(manifest, baseDir).valid, false);
  }
  // Malformed neighboring content must fail validation, never throw while
  // checking whether the separator has a real answer/analysis on either side.
  task.answer.blocks = [{ type: 'text', parts: {} }, separator(), { type: 'text', text: '解析' }];
  assert.equal(validateNewSystemManifest(manifest, baseDir).valid, false);
});

test('separator cannot carry a caller URL, textbook source, text or styling override', t => {
  const { manifest, task, baseDir } = fixture(t);
  for (const extra of [{ src: 'https://example.com/foreign.png' }, { path: 'figure.png' }, { sha256: 'bad' },
    { text: '解析开始' }, { align: 'center' }, { displayWidth: 700 }, { runs: [] }, { source: { page: 2 } }]) {
    task.answer.blocks[1] = { ...separator(), ...extra };
    assert.equal(validateNewSystemManifest(manifest, baseDir).valid, false);
    assert.throws(() => renderBlockHtml(task.answer.blocks[1], baseDir), /仅允许 type 字段/u);
  }
});

test('fixed native separator renders separately from textbook figures and remains nontext', t => {
  const { task, manifest, baseDir } = fixture(t);
  assert.equal(renderBlockHtml(separator(), baseDir), `<p><img style="display: block; width: 500px" src="${ANALYSIS_SEPARATOR.src}"></p>`, 'separator occupies its own paragraph without adding a blank line');
  const expected = expectedEditor(task.answer, baseDir);
  assert.equal(expected.text, '1. B\n1. 解析\nB（√）完整解释。');
  assert.deepEqual(expected.images[0], { type: 'analysis-separator', ...ANALYSIS_SEPARATOR });
  assert.equal(expected.images[1].path, 'figure.png');
  assert.equal(expected.paragraphs[1].type, 'analysis-separator');
  assert.equal(expected.paragraphs[1].align, 'left');
  assert.equal(expected.paragraphs[3].align, 'center');
  assert.doesNotThrow(() => createNewSystemRun(manifest, { baseDir }));
  const without = structuredClone(manifest); without.tasks[0].answer.blocks.splice(1, 1);
  assert.notEqual(createNewSystemRun(manifest, { baseDir }).manifestHash, createNewSystemRun(without, { baseDir }).manifestHash);
});

test('fresh readback requires fixed separator source, byte hash, natural size and 500px display width', t => {
  const { task, baseDir } = fixture(t);
  for (const align of ['left', 'start']) {
    const actual = readback(task, baseDir); actual.answer.images[0].align = align; actual.answer.paragraphs[1].align = align;
    assert.equal(compareNewSystemReadback(task, actual, { baseDir, bookId: 101 }).ok, true);
  }
  const edits = [
    actual => { actual.answer.images[0].src = 'https://example.com/foreign.png'; },
    actual => { actual.answer.html = actual.answer.html.replace(ANALYSIS_SEPARATOR.src, 'https://example.com/foreign.png'); },
    actual => { actual.answer.images[0].sha256 = 'bad'; },
    actual => { actual.answer.images[0].width = 500; },
    actual => { actual.answer.images[0].height = 41; },
    actual => { actual.answer.images[0].align = 'center'; },
    actual => { actual.answer.images[0].complete = false; },
    actual => { actual.answer.html = actual.answer.html.replace('width: 500px', 'width: 499px'); },
    actual => { actual.answer.html = actual.answer.html.replace('display: block', 'display: inline'); },
    actual => { delete actual.answer.html; },
    actual => { actual.answer.html = actual.answer.html.replace('width: 500px', 'width: 500px; width: 700px'); },
    actual => { actual.answer.html = actual.answer.html.replace(' src=', ` src="${ANALYSIS_SEPARATOR.src}" src=`); },
    actual => { actual.answer.paragraphs[1].align = 'center'; },
    actual => { actual.answer.paragraphs[1].text = '正文不可混入'; },
    actual => { actual.answer.paragraphs[1].direction = 'rtl'; },
    actual => { [actual.answer.paragraphs[1], actual.answer.paragraphs[3]] = [actual.answer.paragraphs[3], actual.answer.paragraphs[1]]; },
    actual => { actual.answer.images.reverse(); },
    actual => { actual.answer.images[1].align = 'left'; },
    actual => { actual.answer.html += `<p><img style="display: block; width: 500px" src="${ANALYSIS_SEPARATOR.src}"></p>`; },
  ];
  for (const edit of edits) {
    const actual = readback(task, baseDir); edit(actual);
    assert.equal(compareNewSystemReadback(task, actual, { baseDir, bookId: 101 }).ok, false, edit.toString());
  }
});

test('review and preview accept only the semantic separator without treating it as book text or figure', t => {
  const { manifest, baseDir } = fixture(t);
  const report = inspectReviewedBatch(manifest, baseDir);
  assert.equal(report.valid, true);
  assert.equal(report.readyForExecution, true);
  assert.equal(report.errors.length, 0);
  const preview = renderReviewedBatchPreview(manifest, baseDir, report);
  assert.ok(preview.includes(ANALYSIS_SEPARATOR.src));
  assert.doesNotMatch(preview, /undefined/u);
});
