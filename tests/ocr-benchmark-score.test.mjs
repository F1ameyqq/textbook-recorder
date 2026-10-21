import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { characterEdits, scoreOcrBenchmark, formatOcrScoreTable, runOcrBenchmark } from '../scripts/score-ocr-benchmark.mjs';

const truth = samples => ({ schemaVersion: 1, samples });
const predictions = samples => ({ schemaVersion: 1, engine: 'synthetic-engine', device: 'synthetic-device', samples });
const sample = (id, text, extra = {}) => ({ id, text, kind: 'synthetic', ...extra });
const predicted = (id, text, status = 'ok', extra = {}) => ({ id, text, status, ...extra });

test('Levenshtein counts substitutions, deletions and insertions over Unicode code points', () => {
  assert.deepEqual(characterEdits('中文😀', '中丈😀'), { N: 3, S: 1, D: 0, I: 0, errors: 1 });
  assert.deepEqual(characterEdits('ABC', 'AC'), { N: 3, S: 0, D: 1, I: 0, errors: 1 });
  assert.deepEqual(characterEdits('ABC', 'ABXC'), { N: 3, S: 0, D: 0, I: 1, errors: 1 });
  assert.deepEqual(characterEdits('😀', ''), { N: 1, S: 0, D: 1, I: 0, errors: 1 });
  assert.equal(characterEdits('kitten', 'sitting').errors, 3);
});

test('micro CER uses total characters rather than an unweighted average of sample rates', () => {
  const score = scoreOcrBenchmark(truth([sample('short', '甲'), sample('long', '123456789')]),
    predictions([predicted('short', '乙'), predicted('long', '123456789')]));
  assert.equal(score.primary.N, 10); assert.equal(score.primary.S, 1);
  assert.equal(score.primary.cer, 0.1); assert.equal(score.primary.charAccuracy, 0.9);
  assert.equal(score.primary.exactMatches, 1); assert.equal(score.primary.exactMatchRate, 0.5);
});

test('failed and missing predictions remain in the denominator; only explicit not_run is excluded', () => {
  const score = scoreOcrBenchmark(truth([sample('ok', '12'), sample('failed', 'ABC'), sample('missing', '中文'), sample('unrun', '长题')]),
    predictions([predicted('ok', '12'), predicted('failed', 'ABC', 'failed'), predicted('unrun', '', 'NOT_RUN')]));
  assert.deepEqual(score.counts, { total: 4, included: 3, completed: 1, failed: 1, missing: 1, not_run: 1 });
  assert.equal(score.primary.N, 7); assert.equal(score.primary.D, 5); assert.equal(score.primary.cer, 5 / 7);
  assert.equal(score.primary.exactMatches, 1); assert.equal(score.primary.exactMatchRate, 1 / 3);
  assert.equal(score.samples[1].primary.exactMatch, false);
  assert.equal(score.samples[3].primary, null); assert.equal(score.samples[3].included, false);
});

test('all not_run gives null rates rather than a misleading zero CER or perfect accuracy', () => {
  const score = scoreOcrBenchmark(truth([sample('q', '合成')]), predictions([predicted('q', '', 'not_run')]));
  assert.equal(score.primary.N, 0); assert.equal(score.primary.cer, null);
  assert.equal(score.primary.charAccuracy, null); assert.equal(score.primary.exactMatchRate, null);
  assert.match(formatOcrScoreTable(score), /n\/a/u);
});

test('primary changes only CRLF; punctuation, numerals, superscripts and Unicode composition stay distinct', () => {
  const expected = '甲\r\n1，x² e\u0301', actual = '甲\n1,x2 é';
  const score = scoreOcrBenchmark(truth([sample('q', expected)]), predictions([predicted('q', actual)]));
  assert.equal(score.primary.N, Array.from(expected.replace(/\r\n/gu, '\n')).length);
  assert.equal(score.primary.exactMatches, 0); assert.ok(score.primary.errors >= 3);
  const equal = scoreOcrBenchmark(truth([sample('q', '甲\r\n乙')]), predictions([predicted('q', '甲\n乙')]));
  assert.equal(equal.primary.exactMatches, 1);
  const loneCarriage = scoreOcrBenchmark(truth([sample('q', '甲\r乙')]), predictions([predicted('q', '甲\n乙')]));
  assert.equal(loneCarriage.primary.S, 1);
});

test('ignore-whitespace result is explicitly secondary and cannot replace the primary metric', () => {
  const score = scoreOcrBenchmark(truth([sample('q', '甲　乙\n3')]), predictions([predicted('q', '甲乙3')]));
  assert.equal(score.primary.D, 2); assert.equal(score.primary.exactMatches, 0);
  assert.equal(score.secondary.N, 3); assert.equal(score.secondary.cer, 0); assert.equal(score.secondary.exactMatches, 1);
  assert.match(score.secondary.label, /SECONDARY ONLY/u);
  assert.match(formatOcrScoreTable(score), /IGNORE WHITESPACE \(secondary\)/u);
});

test('CER can exceed one while character accuracy is clamped at zero', () => {
  const score = scoreOcrBenchmark(truth([sample('q', '甲')]), predictions([predicted('q', '甲乙丙丁')]));
  assert.equal(score.primary.I, 3); assert.equal(score.primary.cer, 3); assert.equal(score.primary.charAccuracy, 0);
});

test('sample order is irrelevant, but duplicate, extra and invalid identities are rejected', () => {
  const expected = truth([sample('a', '甲'), sample('b', '乙')]);
  assert.equal(scoreOcrBenchmark(expected, predictions([predicted('b', '乙'), predicted('a', '甲')])).primary.cer, 0);
  for (const bad of [predictions([predicted('a', '甲'), predicted('a', '甲')]), predictions([predicted('foreign', '甲')])]) {
    assert.throws(() => scoreOcrBenchmark(expected, bad), /duplicate|extra/u);
  }
  assert.throws(() => scoreOcrBenchmark(truth([sample('a', '甲'), sample('a', '乙')]), predictions([])), /duplicate/u);
  assert.throws(() => scoreOcrBenchmark(truth([]), predictions([])), /truth/u);
  assert.throws(() => scoreOcrBenchmark(truth([sample('q', '')]), predictions([])), /non-blank/u);
  assert.throws(() => scoreOcrBenchmark(truth([sample('q', ' \n　')]), predictions([])), /non-blank/u);
  assert.throws(() => scoreOcrBenchmark(truth([sample('q', '\ud800')]), predictions([])), /Unicode/u);
});

test('kind is optional in truth but malformed declared kind and absent/unknown prediction status are rejected', () => {
  assert.equal(scoreOcrBenchmark(truth([{ id: 'q', text: '甲' }]), predictions([predicted('q', '甲')])).primary.cer, 0);
  assert.throws(() => scoreOcrBenchmark(truth([sample('q', '甲', { kind: '' })]), predictions([])), /kind/u);
  for (const p of [{ id: 'q', text: '甲' }, predicted('q', '甲', 'skipped')]) {
    assert.throws(() => scoreOcrBenchmark(truth([sample('q', '甲')]), predictions([p])), /status/u);
  }
  assert.throws(() => scoreOcrBenchmark(truth([sample('q', '甲')]), predictions([predicted('q', '甲', 'ok', { seconds: -1 })])), /seconds/u);
});

test('optional source hash, bbox and kind are validated and mismatches reject before scoring', () => {
  const expected = truth([sample('q', '甲', { sourceSha256: 'a'.repeat(64), bbox: [1, 2, 3, 4] })]);
  const matching = predicted('q', '甲', 'ok', { sourceSha256: 'a'.repeat(64), bbox: [1, 2, 3, 4], kind: 'synthetic' });
  assert.equal(scoreOcrBenchmark(expected, predictions([matching])).samples[0].sourceIdentity, 'sha256-matched');
  assert.equal(scoreOcrBenchmark(expected, predictions([predicted('q', '甲')])).samples[0].sourceIdentity, 'not-reported');
  for (const extra of [{ sourceSha256: 'b'.repeat(64) }, { bbox: [1, 2, 4, 5] }, { kind: 'other' }]) {
    assert.throws(() => scoreOcrBenchmark(expected, predictions([{ ...matching, ...extra }])), /identity/u);
  }
  assert.throws(() => scoreOcrBenchmark(truth([sample('q', '甲')]), predictions([matching])), /identity/u);
  assert.throws(() => scoreOcrBenchmark(truth([sample('q', '甲', { sourceSha256: 'bad' })]), predictions([])), /SHA256/u);
  assert.throws(() => scoreOcrBenchmark(truth([sample('q', '甲', { bbox: [1, 2, 1, 4] })]), predictions([])), /bbox/u);
});

test('CLI binds exact input bytes, writes with wx, and returns a short table without source text', async () => {
  const cwd = path.resolve('synthetic-benchmark'), data = new Map();
  data.set(path.join(cwd, 'truth.json'), Buffer.from('\uFEFF' + JSON.stringify(truth([sample('q', 'PRIVATE_SYNTHETIC_SOURCE')])) + '\r\n'));
  data.set(path.join(cwd, 'predictions.json'), Buffer.from(JSON.stringify(predictions([predicted('q', 'PRIVATE_SYNTHETIC_SOURCE')]))));
  const readFile = async file => { if (!data.has(file)) throw new Error('ENOENT'); return Buffer.from(data.get(file)); };
  const writeFile = async (file, bytes, options) => {
    assert.equal(options.flag, 'wx');
    if (data.has(file)) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
    data.set(file, Buffer.from(bytes));
  };
  const args = ['--truth=truth.json', '--predictions', 'predictions.json', '--output=score.json'];
  const result = await runOcrBenchmark(args, { cwd, readFile, writeFile });
  const stored = JSON.parse(data.get(path.join(cwd, 'score.json')));
  assert.equal(stored.primary.cer, 0); assert.match(stored.inputs.truth.sha256, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(stored), /PRIVATE_SYNTHETIC_SOURCE/u);
  assert.doesNotMatch(result.table, /PRIVATE_SYNTHETIC_SOURCE/u);
  assert.equal(result.table.split('\n').length, 4);
  const frozen = Buffer.from(data.get(path.join(cwd, 'score.json')));
  await assert.rejects(runOcrBenchmark(args, { cwd, readFile, writeFile }), /EEXIST/u);
  assert.deepEqual(data.get(path.join(cwd, 'score.json')), frozen);
  await assert.rejects(runOcrBenchmark(['--truth=truth.json', '--predictions=predictions.json', '--output=truth.json'], { cwd, readFile, writeFile }), /replace/u);
});

test('CLI help has no IO; malformed arguments or scoring failures never write output', async () => {
  let reads = 0, writes = 0;
  const io = { readFile: async () => { reads++; return Buffer.from('{"schemaVersion":1,"samples":[]}'); }, writeFile: async () => { writes++; } };
  assert.match((await runOcrBenchmark(['--help'], io)).help, /--truth/u); assert.equal(reads, 0);
  await assert.rejects(runOcrBenchmark(['--truth=a', '--truth=b'], io), /duplicate/u);
  await assert.rejects(runOcrBenchmark(['--unknown=x'], io), /Unknown/u);
  await assert.rejects(runOcrBenchmark(['--truth=a', '--predictions=b', '--output=c'], io), /truth/u);
  assert.equal(writes, 0);
});
