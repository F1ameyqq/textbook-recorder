import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { patchPreparationSource, preparationBlocksSha256 } from '../src/local-preparation-patch.mjs';
import { applyPreparationPatch } from '../scripts/patch-preparation.mjs';
import { sha256, readJobJson } from '../src/preparation-files.mjs';

const approvedReview = () => ({ status: 'approved', checks: { sourceText: true, answerMatch: true, wholeQuestion: true, format: true },
  evidence: 'historical review', issues: ['retain unresolved issue'], specialReview: { printedSquaresConfirmed: true } });
const record = (id, text) => ({ id, chapter: '合成章', group: '基础', questionNumber: 1, rawOcr: text,
  source: { pages: [1], images: ['images/page-1.png'], regions: [{ page: 1, image: 'images/page-1.png', bbox: [0, 0, 20, 20] }] },
  blocks: [{ type: 'text', text, strictSpacing: true }], review: approvedReview() });
const records = () => ({ schemaVersion: 1, bookId: 900001, questions: [record('q1', '旧题干'), record('q2', '保留题干')],
  answers: [record('a1', '旧答案')], pairings: [{ questionId: 'q1', answerId: 'a1' }] });
const patchFor = (sourceSha256, operations) => ({ schemaVersion: 1, kind: 'local-preparation-patch', sourceSha256, operations });
const replaceText = (extra = {}) => ({ op: 'replace-text', collection: 'questions', recordId: 'q1', blockIndex: 0,
  expectedText: '旧题干', text: '修订题干', ...extra });

async function fixture(t, source = records()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'recorder-local-patch-'));
  t.after(async () => {
    const target = path.resolve(root), relative = path.relative(path.resolve(os.tmpdir()), target);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(target).startsWith('recorder-local-patch-'));
    await fs.rm(target, { recursive: true, force: true });
  });
  const job = path.join(root, 'data', 'jobs', 'synthetic');
  await fs.mkdir(job, { recursive: true });
  // Deliberately bind BOM and CRLF source bytes rather than reserialized JSON.
  const sourceBytes = Buffer.from('\uFEFF' + JSON.stringify(source, null, 2).replace(/\n/gu, '\r\n') + '\r\n', 'utf8');
  await fs.writeFile(path.join(job, 'source.json'), sourceBytes);
  const sourceSha256 = sha256(sourceBytes);
  const writePatch = async operations => {
    const bytes = Buffer.from(JSON.stringify(patchFor(sourceSha256, operations)) + '\n');
    await fs.writeFile(path.join(job, 'patch.json'), bytes);
    return bytes;
  };
  const argv = (output = 'output.json') => ['--input=data/jobs/synthetic/source.json', '--patch=data/jobs/synthetic/patch.json', `--output=data/jobs/synthetic/${output}`];
  return { root, job, source, sourceBytes, sourceSha256, writePatch, argv,
    apply: output => applyPreparationPatch(argv(output), { root, cwd: root }) };
}

test('bound local text edits preserve original bytes, identities and sources while returning only a short summary', async t => {
  const f = await fixture(t), patchBytes = await f.writePatch([replaceText()]);
  const result = await f.apply(), outputBytes = await fs.readFile(result.outputPath), output = JSON.parse(outputBytes);
  assert.equal(output.questions[0].blocks[0].text, '修订题干');
  assert.equal(output.questions[0].blocks[0].strictSpacing, true);
  assert.deepEqual(output.questions.map(item => item.id), f.source.questions.map(item => item.id));
  assert.deepEqual(output.questions.map(item => item.source), f.source.questions.map(item => item.source));
  assert.deepEqual(output.pairings, f.source.pairings); assert.equal(output.bookId, f.source.bookId);
  for (const entry of [...output.questions, ...output.answers]) {
    assert.equal(entry.review.status, 'pending'); assert.equal(entry.review.evidence, '');
    assert.ok(Object.values(entry.review.checks).every(value => value === false));
    assert.equal(entry.review.specialReview, undefined); assert.deepEqual(entry.review.issues, ['retain unresolved issue']);
  }
  assert.deepEqual(await fs.readFile(path.join(f.job, 'source.json')), f.sourceBytes);
  assert.deepEqual(await fs.readFile(path.join(f.job, 'patch.json')), patchBytes);
  assert.equal(result.outputSha256, sha256(outputBytes)); assert.equal(result.sourceSha256, f.sourceSha256);
  assert.deepEqual(result.affectedIds, ['q1']); assert.deepEqual(result.affectedTargets, [{ collection: 'questions', recordId: 'q1' }]);
  assert.equal(result.requiresReview, true); assert.equal(result.platformWritePerformed, false);
  assert.equal(result.value, undefined); assert.equal(result.blocks, undefined);
  assert.ok(!JSON.stringify(result).includes('修订题干'));
});

test('multiple distinct blocks are edited without duplicate affected targets; overlapping operations fail atomically', async t => {
  const source = records(); source.questions[0].blocks.push({ type: 'text', text: '第二段' });
  const f = await fixture(t, source);
  await f.writePatch([replaceText(), replaceText({ blockIndex: 1, expectedText: '第二段', text: '第二段修订' })]);
  const result = await f.apply(); assert.equal(result.affectedTargets.length, 1);
  const output = JSON.parse(await fs.readFile(result.outputPath, 'utf8'));
  assert.deepEqual(output.questions[0].blocks.map(block => block.text), ['修订题干', '第二段修订']);
  await f.writePatch([replaceText(), replaceText()]);
  await assert.rejects(f.apply('duplicate.json'), /重复|重叠/u);
  await assert.rejects(fs.stat(path.join(f.job, 'duplicate.json')), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(path.join(f.job, 'source.json')), f.sourceBytes);
});

test('whole blocks replacement supports explicit new Unicode emphasis and hashes the old value', async t => {
  const source = records();
  source.questions[0].blocks = [{ type: 'text', text: '甲乙', emphasis: { schemaVersion: 1, indexUnit: 'unicode-code-points', marks: [{ type: 'underline', start: 1, end: 2, text: '乙' }] } }];
  const f = await fixture(t, source), blocks = [{ type: 'text', text: '甲😀乙', strictSpacing: true,
    emphasis: { schemaVersion: 1, indexUnit: 'unicode-code-points', marks: [{ type: 'underline', start: 2, end: 3, text: '乙' }] } }];
  await f.writePatch([{ op: 'replace-blocks', collection: 'questions', recordId: 'q1',
    expectedBlocksSha256: preparationBlocksSha256(source.questions[0].blocks), blocks }]);
  const result = await f.apply(); const output = JSON.parse(await fs.readFile(result.outputPath, 'utf8'));
  assert.deepEqual(output.questions[0].blocks, blocks);
  await f.writePatch([{ op: 'replace-blocks', collection: 'questions', recordId: 'q1', expectedBlocksSha256: '0'.repeat(64), blocks }]);
  await assert.rejects(f.apply('bad-hash.json'), /expectedBlocksSha256/u);
});

test('formatted text changes require explicit whole blocks and reject stale or invalid new ranges', async t => {
  for (const format of ['emphasis', 'runs', 'parts']) {
    const source = records(), target = format === 'parts' ? source.answers[0] : source.questions[0];
    target.blocks = format === 'runs' ? [{ type: 'text', runs: [{ type: 'text', text: '甲' }, { type: 'sup', text: '1' }] }]
      : format === 'parts' ? [{ type: 'text', parts: ['甲', '乙'] }]
        : [{ type: 'text', text: '旧题干', emphasis: { schemaVersion: 1, indexUnit: 'unicode-code-points', marks: [{ type: 'bold', start: 0, end: 1, text: '旧' }] } }];
    const f = await fixture(t, source);
    await f.writePatch([replaceText(format === 'parts' ? { collection: 'answers', recordId: 'a1', expectedText: '甲' } : {})]);
    await assert.rejects(f.apply(), /完整 blocks/u);
    assert.deepEqual(await fs.readFile(path.join(f.job, 'source.json')), f.sourceBytes);
  }
  const f = await fixture(t), blocks = [{ type: 'text', text: '甲😀乙', emphasis: { schemaVersion: 1,
    indexUnit: 'unicode-code-points', marks: [{ type: 'underline', start: 1, end: 2, text: '乙' }] } }];
  await f.writePatch([{ op: 'replace-blocks', collection: 'questions', recordId: 'q1', expectedBlocksSha256: preparationBlocksSha256(f.source.questions[0].blocks), blocks }]);
  await assert.rejects(f.apply(), /格式范围/u);
  await assert.rejects(fs.stat(path.join(f.job, 'output.json')), { code: 'ENOENT' });
});

test('mapping patches only replacementBlocks, resetting stale reviews and coverage without moving targets or sources', async t => {
  const source = { schemaVersion: 1, kind: 'new-system-draft-mapping', bookId: 900001, source: 'fixture',
    index: { path: 'index.json', sha256: 'a'.repeat(64) }, reviewEvidence: { approved: true },
    placements: ['q1', 'q2'].map((questionId, index) => ({ questionId, target: { chapterLabel: '合成章', sectionLabel: '合成节', record: index + 1 },
      answerRequirement: { kind: 'question', evidence: '回答问题' }, answerStatus: 'provided', review: approvedReview(),
      agentReview: { checkedAgainstOriginal: true, evidence: 'old' }, replacementBlocks: { stem: [{ type: 'text', text: '旧题干' }] } })),
    coverage: { coverageChecked: true, evidence: 'old', pages: [{ page: 1, imagePath: 'page.png', coverageChecked: true, evidence: 'old', candidates: [{ taskIds: ['q1'] }] }] } };
  const f = await fixture(t, source);
  await f.writePatch([{ op: 'replace-text', questionId: 'q1', side: 'stem', blockIndex: 0, expectedText: '旧题干', text: '修订题干' }]);
  const result = await f.apply(), output = JSON.parse(await fs.readFile(result.outputPath, 'utf8'));
  assert.deepEqual(output.placements.map(entry => entry.target), source.placements.map(entry => entry.target));
  assert.deepEqual(output.index, source.index); assert.equal(output.source, source.source);
  assert.equal(output.reviewEvidence, undefined); assert.equal(output.coverage.coverageChecked, false);
  assert.equal(output.coverage.pages[0].coverageChecked, false); assert.equal(output.coverage.pages[0].evidence, '');
  assert.deepEqual(output.coverage.pages[0].candidates, source.coverage.pages[0].candidates);
  for (const entry of output.placements) {
    assert.ok(Object.values(entry.review.checks).every(value => value === false));
    assert.deepEqual(entry.agentReview, { checkedAgainstOriginal: false, evidence: '' });
  }
  assert.deepEqual(result.affectedTargets, [{ questionId: 'q1', side: 'stem' }]);
  await f.writePatch([{ op: 'replace-blocks', questionId: 'q1', side: 'answer', expectedBlocksSha256: preparationBlocksSha256(undefined), blocks: [{ type: 'text', text: '新答案' }] }]);
  const created = JSON.parse(await fs.readFile((await f.apply('with-answer.json')).outputPath, 'utf8'));
  assert.equal(created.placements[0].replacementBlocks.answer[0].text, '新答案');
  assert.deepEqual(await fs.readFile(path.join(f.job, 'source.json')), f.sourceBytes);
});

test('hash mismatch, old text mismatch and missing IDs produce no new source artifact', async t => {
  const f = await fixture(t);
  for (const operation of [replaceText({ expectedText: '错误原值' }), replaceText({ recordId: 'missing' })]) {
    await f.writePatch([operation]); await assert.rejects(f.apply(), /原值|不存在/u);
  }
  const patch = patchFor('0'.repeat(64), [replaceText()]);
  await fs.writeFile(path.join(f.job, 'patch.json'), JSON.stringify(patch));
  await assert.rejects(f.apply(), /SHA256/u);
  await f.writePatch([replaceText()]);
  await fs.appendFile(path.join(f.job, 'source.json'), ' ');
  await assert.rejects(f.apply(), /SHA256/u);
  await assert.rejects(fs.stat(path.join(f.job, 'output.json')), { code: 'ENOENT' });
});

test('strict patch fields reject identity, source, target, review and execution state writes', async t => {
  const f = await fixture(t);
  for (const field of ['id', 'source', 'bookId', 'target', 'review', 'readyForExecution', '__proto__']) {
    const operation = JSON.parse(JSON.stringify(replaceText()));
    Object.defineProperty(operation, field, { value: true, enumerable: true });
    await f.writePatch([operation]); await assert.rejects(f.apply(), /非法字段/u);
  }
  for (const operation of [replaceText({ collection: '__proto__' }), replaceText({ blockIndex: -1 }), replaceText({ op: 'delete' })]) {
    await f.writePatch([operation]); await assert.rejects(f.apply());
  }
  const patch = patchFor(f.sourceSha256, [replaceText()]); patch.approved = true;
  assert.throws(() => patchPreparationSource(f.source, f.sourceSha256, patch), /非法字段/u);
  assert.throws(() => patchPreparationSource({ ...f.source, kind: 'new-system-batch' }, f.sourceSha256, patchFor(f.sourceSha256, [replaceText()])), /只允许/u);
  assert.deepEqual(await fs.readFile(path.join(f.job, 'source.json')), f.sourceBytes);
});

test('block replacements reject hidden fields, malformed runs and paths outside the job', async t => {
  const f = await fixture(t);
  for (const blocks of [[{ type: 'text', text: '新文字', source: { pages: [2] } }],
    [{ type: 'text', runs: [{ type: 'sup', text: '1', style: 'font-size:10px' }] }],
    [{ type: 'image', path: '../outside.png', align: 'center' }], [{ type: 'image', path: 'C:\\outside.png', align: 'center' }],
    [{ type: 'image', path: 'https://example.invalid/image.png', align: 'center' }], [{ type: 'analysis-separator' }]]) {
    await f.writePatch([{ op: 'replace-blocks', collection: 'questions', recordId: 'q1', expectedBlocksSha256: preparationBlocksSha256(f.source.questions[0].blocks), blocks }]);
    await assert.rejects(f.apply());
  }
  await assert.rejects(fs.stat(path.join(f.job, 'output.json')), { code: 'ENOENT' });
});

test('same-job real path confinement rejects cross-job, traversal, nested output and escaped junction inputs', async t => {
  const f = await fixture(t); await f.writePatch([replaceText()]);
  const other = path.join(f.root, 'data', 'jobs', 'other'); await fs.mkdir(other, { recursive: true });
  await fs.copyFile(path.join(f.job, 'patch.json'), path.join(other, 'patch.json'));
  const options = { root: f.root, cwd: f.root };
  await assert.rejects(applyPreparationPatch(['--input=data/jobs/synthetic/source.json', '--patch=data/jobs/other/patch.json', '--output=data/jobs/synthetic/output.json'], options), /同一/u);
  await assert.rejects(applyPreparationPatch(['--input=data/jobs/synthetic/source.json', '--patch=data/jobs/synthetic/patch.json', '--output=data/jobs/other/output.json'], options), /同一/u);
  await assert.rejects(f.apply('../outside.json'), /根目录/u);
  await assert.rejects(f.apply('nested/output.json'), /根目录/u);
  const external = path.join(f.root, 'external'); await fs.mkdir(external);
  await fs.copyFile(path.join(f.job, 'source.json'), path.join(external, 'source.json'));
  const link = path.join(f.root, 'data', 'jobs', 'escape');
  await fs.symlink(external, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(applyPreparationPatch(['--input=data/jobs/escape/source.json', '--patch=data/jobs/synthetic/patch.json', '--output=data/jobs/synthetic/output.json'], options), /越界|真实路径/u);
  assert.deepEqual(await fs.readFile(path.join(f.job, 'source.json')), f.sourceBytes);
});

test('outputs refuse overwrite, including the original input; later validation errors do not create partial output', async t => {
  const f = await fixture(t); await f.writePatch([replaceText()]);
  const sentinel = Buffer.from('existing output\r\n'); await fs.writeFile(path.join(f.job, 'output.json'), sentinel);
  await assert.rejects(f.apply(), { code: 'EEXIST' });
  assert.deepEqual(await fs.readFile(path.join(f.job, 'output.json')), sentinel);
  await assert.rejects(f.apply('source.json'), { code: 'EEXIST' });
  assert.deepEqual(await fs.readFile(path.join(f.job, 'source.json')), f.sourceBytes);
  await f.writePatch([replaceText(), { ...replaceText(), recordId: 'q2', expectedText: 'wrong' }]);
  await assert.rejects(f.apply('atomic.json'), /原值/u);
  await assert.rejects(fs.stat(path.join(f.job, 'atomic.json')), { code: 'ENOENT' });
});

test('plain text edits preserve all existing image source metadata and whole replacements cannot change image identity or position', async t => {
  for (const mapping of [false, true]) {
    const source = mapping ? { schemaVersion: 1, kind: 'new-system-draft-mapping', bookId: 900001, source: 'fixture',
      placements: [{ questionId: 'q1', target: { chapterLabel: '章', sectionLabel: '节', record: 1 }, replacementBlocks: { stem: [{ type: 'text', text: '旧题干' }] } }] } : records();
    const blocks = mapping ? source.placements[0].replacementBlocks.stem : source.questions[0].blocks;
    const image = { type: 'image', path: 'figures/old.png', align: 'center', purpose: 'diagram', cropId: 'crop-1',
      sha256: 'c'.repeat(64), bbox: [1, 2, 3, 4], source: { page: 1, image: 'images/page-1.png', bbox: [1, 2, 3, 4], sha256: 'a'.repeat(64) } };
    blocks.push(image);
    const selector = mapping ? { questionId: 'q1', side: 'stem' } : { collection: 'questions', recordId: 'q1' };
    const f = await fixture(t, source);
    await f.writePatch([{ op: 'replace-text', ...selector, blockIndex: 0, expectedText: '旧题干', text: '修订题干' }]);
    const output = JSON.parse(await fs.readFile((await f.apply()).outputPath, 'utf8'));
    const actual = mapping ? output.placements[0].replacementBlocks.stem : output.questions[0].blocks;
    assert.deepEqual(actual[1], image);
    const replacement = [{ ...blocks[0], text: '明确重写题干' }, structuredClone(image)];
    await f.writePatch([{ op: 'replace-blocks', ...selector, expectedBlocksSha256: preparationBlocksSha256(blocks), blocks: replacement }]);
    const explicit = JSON.parse(await fs.readFile((await f.apply('whole.json')).outputPath, 'utf8'));
    assert.deepEqual((mapping ? explicit.placements[0].replacementBlocks.stem : explicit.questions[0].blocks)[1], image);
    const variants = [replacement.slice(0, 1), [replacement[1], replacement[0]],
      [replacement[0], { ...image, path: 'figures/changed.png' }],
      [replacement[0], { ...image, source: { ...image.source, sha256: 'b'.repeat(64) } }],
      [replacement[0], { ...image, bbox: [0, 0, 3, 4] }]];
    for (const next of variants) {
      await f.writePatch([{ op: 'replace-blocks', ...selector, expectedBlocksSha256: preparationBlocksSha256(blocks), blocks: next }]);
      await assert.rejects(f.apply('changed-image.json'), /不允许.*图片/u);
    }
    assert.deepEqual(await fs.readFile(path.join(f.job, 'source.json')), f.sourceBytes);
  }
});

test('input and patch changes during preparation are rechecked before any output is created', async t => {
  for (const changed of ['source.json', 'patch.json']) {
    const f = await fixture(t); await f.writePatch([replaceText()]);
    let reads = 0;
    const readJson = async (root, requested) => {
      const result = await readJobJson(root, requested);
      // Mutate after both first reads and before the final bound-input checks.
      if (++reads === 2) await fs.appendFile(path.join(f.job, changed), ' ');
      return result;
    };
    await assert.rejects(applyPreparationPatch(f.argv(), { root: f.root, cwd: f.root, readJson }), /处理期间已变化/u);
    await assert.rejects(fs.stat(path.join(f.job, 'output.json')), { code: 'ENOENT' });
    if (changed !== 'source.json') assert.deepEqual(await fs.readFile(path.join(f.job, 'source.json')), f.sourceBytes);
  }
});
