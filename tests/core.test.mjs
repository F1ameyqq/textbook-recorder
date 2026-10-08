import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  validateManifest, expectedText, compareReadback, manifestHash,
  createRun, runNext, summarizeRun, summarizeManifest,
} from '../src/core.mjs';

function task(id = 'q1', overrides = {}) {
  return {
    id, target: { chapter: 1, unit: 2, record: 6 },
    source: { pages: [8], label: '第 2 题' },
    blocks: [{ type: 'text', text: '2. 分子不停地做无规则运动。' }],
    review: { status: 'approved', issues: [] }, ...overrides,
  };
}

function manifest(tasks = [task()], overrides = {}) {
  return { schemaVersion: 1, bookId: 100001, mode: 'body', source: 'fixture', tasks, ...overrides };
}

function readback(item, overrides = {}) {
  return {
    text: expectedText(item), target: structuredClone(item.target),
    images: [{ marker: true, complete: true, width: 1028, height: 40 }, ...item.blocks.filter(block => block.type === 'image').map(() => ({ marker: false, complete: true, width: 100, height: 80 }))],
    ...overrides,
  };
}

function fixtureAdapter(overrides = {}) {
  const calls = { write: 0, read: 0, reconcile: 0 };
  const adapter = {
    source: 'fixture',
    async write(item) { calls.write += 1; return { chapter: item.target.chapter, unit: item.target.unit, record: item.target.record }; },
    async read(item) { calls.read += 1; return readback(item); },
    async reconcile(item, context) { calls.reconcile += 1; return { status: 'found', receipt: context.receipt, readback: readback(item) }; },
    ...overrides,
  };
  return { adapter, calls };
}

test('schema checks directories, repeated IDs/targets, body and assets', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'recording-core-'));
  try {
    writeFileSync(path.join(directory, 'figure.png'), 'fixture-image');
    const valid = manifest([task('q1', { source: { pages: [8, 9], label: '实验题', images: ['figure.png'] }, blocks: [{ type: 'image', path: 'figure.png' }] })]);
    const result = validateManifest(valid, directory);
    assert.equal(result.valid, true);
    assert.match(result.warnings.join('\n'), /跨页/);
    const invalid = manifest([
      task('q1', { target: { chapter: 0, unit: 2, record: 6 }, blocks: [{ type: 'text', text: '  ' }] }),
      task('q1', { blocks: [{ type: 'image', path: 'missing.png' }] }),
      task('q3'),
    ]);
    const invalidResult = validateManifest(invalid, directory);
    assert.equal(invalidResult.valid, false);
    assert.match(invalidResult.errors.join('\n'), /chapter/);
    assert.match(invalidResult.errors.join('\n'), /id 重复/);
    assert.match(invalidResult.errors.join('\n'), /目标冲突/);
    assert.match(invalidResult.errors.join('\n'), /正文不能为空/);
    assert.match(invalidResult.errors.join('\n'), /图片文件不存在/);
    assert.match(invalidResult.warnings.join('\n'), /没有来源原图/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('production forbids unknown appended position and unresolved approved issues', () => {
  const result = validateManifest(manifest([task('q1', { target: { chapter: 1, unit: 2, record: null }, review: { status: 'approved', issues: ['需要核对配图'] } })], { source: 'production' }));
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /production 必须指定/);
  assert.match(result.errors.join('\n'), /未解决 issues/);
  const appendFixture = validateManifest(manifest([task('q1', { target: { chapter: 1, unit: 2, record: null } }), task('q2', { target: { chapter: 1, unit: 2, record: null } })]));
  assert.equal(appendFixture.valid, true);
});

test('asset scope rejects absolute paths, escapes, unsupported formats and unsafe task IDs', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'recording-scope-'));
  try {
    const baseDir = path.join(directory, 'book');
    mkdirSync(baseDir);
    writeFileSync(path.join(directory, 'outside.png'), 'fixture');
    for (const filename of [path.join(directory, 'outside.png'), '../outside.png', 'file.svg']) {
      const spec = manifest([task('q1', { blocks: [{ type: 'image', path: filename }] })]);
      assert.equal(validateManifest(spec, baseDir).valid, false);
    }
    for (const id of ['../q1', 'q/1', '题1', 'q 1']) {
      const result = validateManifest(manifest([task(id)]), baseDir);
      assert.equal(result.valid, false);
      assert.match(result.errors.join('\n'), /id 只能/);
    }
    assert.equal(validateManifest(manifest([task('q_1-A')]), baseDir).valid, true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('junction/symlink to outside asset directory is rejected after realpath', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'recording-link-'));
  try {
    const baseDir = path.join(directory, 'book');
    const external = path.join(directory, 'external');
    mkdirSync(baseDir);
    mkdirSync(external);
    writeFileSync(path.join(external, 'figure.png'), 'fixture');
    symlinkSync(external, path.join(baseDir, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = validateManifest(manifest([task('q1', { blocks: [{ type: 'image', path: 'link/figure.png' }] })]), baseDir);
    assert.equal(result.valid, false);
    assert.match(result.errors.join('\n'), /软链接越界/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('text order preserved; only whitespace ignored; punctuation and directory mismatches rejected', () => {
  const item = task('q1', { blocks: [{ type: 'text', text: '问题：' }, { type: 'image', path: 'image.png' }, { type: 'text', text: 'A. 第一项\nB. 第二项' }] });
  assert.equal(expectedText(item), '问题：\nA. 第一项\nB. 第二项');
  assert.equal(compareReadback(item, readback(item, { text: ' 问题：\nA.第一项 B.第二项 ' })).ok, true);
  assert.match(compareReadback(item, readback(item, { text: '问题:A. 第一项 B. 第二项' })).errors.join(), /正文/);
  assert.match(compareReadback(item, readback(item, { target: { chapter: 1, unit: 3, record: 6 } })).errors.join(), /unit/);
});

test('exactly one loaded marker and all expected loaded question images required', () => {
  const item = task('q1', { blocks: [{ type: 'text', text: '图示。' }, { type: 'image', path: 'image.png' }] });
  const pending = compareReadback(item, readback(item, { images: [{ marker: true, complete: true, width: 1028, height: 40 }, { marker: false, complete: false, width: 0, height: 0 }] }));
  assert.equal(pending.ok, false);
  assert.equal(pending.pending, true);
  assert.equal(compareReadback(item, readback(item, { images: [] })).pending, false);
  assert.equal(compareReadback(item, readback(item, { images: [{ marker: true, complete: true, width: 1028, height: 40 }, { marker: true, complete: true, width: 1028, height: 40 }] })).ok, false);
});

test('pending review blocks writes, approval permits continuing the same run', async () => {
  const spec = manifest([task('q1', { review: { status: 'pending', issues: ['待核对'] } })]);
  const run = createRun(spec);
  const { adapter, calls } = fixtureAdapter();
  await runNext(run, spec, adapter);
  assert.equal(run.tasks[0].status, 'review_required');
  assert.equal(calls.write, 0);
  const initialHash = manifestHash(spec);
  spec.tasks[0].review = { status: 'approved', issues: [] };
  assert.equal(manifestHash(spec), initialHash);
  await runNext(run, spec, adapter);
  assert.equal(run.tasks[0].status, 'completed');
  assert.equal(calls.write, 1);
});

test('one approved task per call, persistence before writing, completed runs idempotent', async () => {
  const spec = manifest([task('q1'), task('q2', { target: { chapter: 1, unit: 2, record: 7 } })]);
  const run = createRun(spec);
  const persisted = [];
  const { adapter, calls } = fixtureAdapter({ async write(item) {
    calls.write += 1;
    assert.equal(persisted.at(-1).tasks.find(entry => entry.taskId === item.id).status, 'writing');
    return { record: item.target.record };
  } });
  const persist = async snapshot => { persisted.push(snapshot); };
  await runNext(run, spec, adapter, { persist });
  assert.equal(calls.write, 1);
  assert.equal(run.tasks[0].status, 'completed');
  assert.equal(run.tasks[1].status, 'pending');
  await runNext(run, spec, adapter, { persist });
  await runNext(run, spec, adapter, { persist });
  assert.equal(calls.write, 2);
  assert.equal(run.status, 'completed');
  assert.equal(summarizeRun(run).counts.completed, 2);
  assert.equal(summarizeManifest(spec).approved, 2);
});

test('editing body, target, source or asset paths invalidates run; object key order does not', async () => {
  const spec = manifest();
  const run = createRun(spec);
  const { adapter, calls } = fixtureAdapter();
  const reordered = { tasks: spec.tasks, source: 'fixture', mode: 'body', bookId: 100001, schemaVersion: 1 };
  assert.equal(manifestHash(reordered), manifestHash(spec));
  for (const mutate of [
    changed => { changed.tasks[0].blocks[0].text += '改'; },
    changed => { changed.tasks[0].target.unit = 3; },
    changed => { changed.source = 'production'; },
    changed => { changed.tasks[0].source.images = ['other.png']; },
  ]) {
    const changed = structuredClone(spec);
    mutate(changed);
    await assert.rejects(runNext(run, changed, adapter), /run 失效/);
  }
  assert.equal(calls.write, 0);
});

test('fixture cannot cross to production adapter; production requires persistence and directory readback', async () => {
  const fixture = manifest();
  const { adapter, calls } = fixtureAdapter({ source: 'production' });
  await assert.rejects(runNext(createRun(fixture), fixture, adapter, { persist: async () => {} }), /fixture 题单禁止/);
  const production = manifest([task()], { source: 'production' });
  await assert.rejects(runNext(createRun(production), production, adapter), /持久化/);
  const run = createRun(production);
  adapter.read = async item => { const result = readback(item); delete result.target; return result; };
  await runNext(run, production, adapter, { persist: async () => {} });
  assert.equal(run.status, 'failed');
  assert.match(run.tasks[0].lastError, /缺少 target/);
  assert.equal(calls.write, 1);
});

test('writing interruption adopts existing matching record without creating duplicate', async () => {
  const spec = manifest();
  const run = createRun(spec);
  run.tasks[0].status = 'writing';
  run.tasks[0].recoveryRequired = true;
  run.tasks[0].receipt = { record: 6 };
  const { adapter, calls } = fixtureAdapter();
  await runNext(run, spec, adapter);
  assert.equal(calls.reconcile, 1);
  assert.equal(calls.write, 0);
  assert.equal(run.tasks[0].status, 'completed');
});

test('missing or ambiguous recovery never blindly creates another record', async () => {
  for (const recoveryStatus of ['missing', 'ambiguous']) {
    const spec = manifest();
    const run = createRun(spec);
    run.tasks[0].status = 'writing';
    run.tasks[0].recoveryRequired = true;
    const { adapter, calls } = fixtureAdapter({ async reconcile() { calls.reconcile += 1; return { status: recoveryStatus }; } });
    await runNext(run, spec, adapter);
    await runNext(run, spec, adapter);
    assert.equal(calls.write, 0);
    assert.equal(run.tasks[0].status, recoveryStatus === 'missing' ? 'failed' : 'review_required');
  }
});

test('a write exception preserves target checkpoint and resumes through read-only reconcile', async () => {
  const spec = manifest();
  const run = createRun(spec);
  const persisted = [];
  const { adapter, calls } = fixtureAdapter({ async write(item, context) {
    calls.write += 1;
    await context.checkpoint({ record: 6, located: true });
    throw new Error('连接在输入后断开');
  } });
  await assert.rejects(runNext(run, spec, adapter, { persist: async snapshot => persisted.push(snapshot) }), /输入后断开/);
  assert.equal(run.tasks[0].recoveryRequired, true);
  assert.equal(persisted.at(-1).tasks[0].receipt.located, true);
  await runNext(run, spec, adapter);
  assert.equal(calls.write, 1);
  assert.equal(calls.reconcile, 1);
  assert.equal(run.status, 'completed');
});

test('image loading delay stays verifying and next call reconciles instead of re-pasting', async () => {
  const spec = manifest([task('q1', { blocks: [{ type: 'text', text: '看图。' }, { type: 'image', path: 'figure.png' }] })]);
  const run = createRun(spec);
  const { adapter, calls } = fixtureAdapter({ async read(item) {
    calls.read += 1;
    const result = readback(item);
    result.images[1] = { marker: false, complete: false, width: 0, height: 0 };
    return result;
  } });
  await runNext(run, spec, adapter);
  assert.equal(run.tasks[0].status, 'verifying');
  await runNext(run, spec, adapter);
  assert.equal(run.status, 'completed');
  assert.equal(calls.write, 1);
  assert.equal(calls.reconcile, 1);
});

test('same-process concurrency cannot write one run twice', async () => {
  const spec = manifest();
  const run = createRun(spec);
  let release;
  let entered;
  const waiting = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const { adapter, calls } = fixtureAdapter({ async write() { calls.write += 1; entered(); await waiting; return { record: 6 }; } });
  const first = runNext(run, spec, adapter);
  await started;
  await assert.rejects(runNext(structuredClone(run), spec, adapter), /禁止并发/);
  release();
  await first;
  assert.equal(calls.write, 1);
});

test('failure to persist writing never calls adapter.write', async () => {
  const spec = manifest();
  const run = createRun(spec);
  const { adapter, calls } = fixtureAdapter();
  await assert.rejects(runNext(run, spec, adapter, { persist: async snapshot => { if (snapshot.tasks[0].status === 'writing') throw new Error('磁盘不可写'); } }), /磁盘不可写/);
  assert.equal(calls.write, 0);
});

test('malformed or withdrawn review permission never permits a write', async () => {
  const spec = manifest();
  const run = createRun(spec);
  const { adapter, calls } = fixtureAdapter();
  spec.tasks[0].review.issues = null;
  await runNext(run, spec, adapter);
  assert.equal(run.status, 'review_required');
  assert.equal(calls.write, 0);
  spec.tasks[0].review.issues = [];
  await runNext(run, spec, adapter, { persist: async snapshot => {
    if (snapshot.tasks[0].status === 'ready') spec.tasks[0].review.status = 'pending';
  } });
  assert.equal(run.status, 'review_required');
  assert.equal(calls.write, 0);
});
