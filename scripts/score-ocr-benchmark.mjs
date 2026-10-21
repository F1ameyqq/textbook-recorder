import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const label = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 160 && !/[\u0000-\u001f\u007f]/u.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const primaryText = value => value.replace(/\r\n/gu, '\n');
const secondaryText = value => primaryText(value).replace(/\p{White_Space}/gu, '');
const statuses = new Map([['ok', 'completed'], ['success', 'completed'], ['completed', 'completed'],
  ['failed', 'failed'], ['error', 'failed'], ['not_run', 'not_run'], ['NOT_RUN', 'not_run']]);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const help = 'node scripts/score-ocr-benchmark.mjs --truth=<truth.json> --predictions=<predictions.json> --output=<new-score.json>';

function assertText(value, name, { truth = false } = {}) {
  if (typeof value !== 'string' || !value.isWellFormed() || truth && !primaryText(value).trim()) {
    throw new Error(`${name} must be well-formed Unicode text${truth ? ' with a non-blank truth value' : ''}`);
  }
}

function assertBox(value, name) {
  if (!Array.isArray(value) || value.length !== 4 || value.some(item => !Number.isSafeInteger(item) || item < 0)
      || value[2] <= value[0] || value[3] <= value[1]) throw new Error(`${name} must be [left,top,right,bottom] in source pixels`);
}

function samplesById(value, name) {
  if (!object(value) || value.schemaVersion !== 1 || !Array.isArray(value.samples)) throw new Error(`${name} needs schemaVersion:1 and samples`);
  const result = new Map();
  for (const sample of value.samples) {
    if (!object(sample) || !label(sample.id) || result.has(sample.id)) throw new Error(`${name} has an invalid or duplicate sample id`);
    assertText(sample.text, `${name}.text`, { truth: name === 'truth' });
    if (sample.kind !== undefined && !label(sample.kind)) throw new Error(`${name}.kind must be a non-empty label`);
    if (sample.sourceSha256 !== undefined && !hash(sample.sourceSha256)) throw new Error(`${name}.sourceSha256 must be a SHA256`);
    if (sample.bbox !== undefined) assertBox(sample.bbox, `${name}.bbox`);
    if (name === 'predictions') {
      if (!statuses.has(sample.status)) throw new Error('predictions samples need an explicit supported status');
      if (sample.seconds !== undefined && (typeof sample.seconds !== 'number' || !Number.isFinite(sample.seconds) || sample.seconds < 0)) {
        throw new Error('predictions.seconds must be a finite non-negative number');
      }
    }
    result.set(sample.id, sample);
  }
  return result;
}

/** Unicode code point Levenshtein, with deterministic diagonal/deletion/insertion ties. */
export function characterEdits(truth, prediction) {
  const expected = Array.from(truth), actual = Array.from(prediction), n = expected.length, m = actual.length;
  if (truth === prediction) return { N: n, S: 0, D: 0, I: 0, errors: 0 };
  let cost = new Float64Array(m + 1), substitutions = new Float64Array(m + 1);
  let deletions = new Float64Array(m + 1), insertions = new Float64Array(m + 1);
  for (let j = 0; j <= m; j++) { cost[j] = j; insertions[j] = j; }
  for (let i = 1; i <= n; i++) {
    const nextCost = new Float64Array(m + 1), nextS = new Float64Array(m + 1);
    const nextD = new Float64Array(m + 1), nextI = new Float64Array(m + 1);
    nextCost[0] = i; nextD[0] = i;
    for (let j = 1; j <= m; j++) {
      const different = expected[i - 1] === actual[j - 1] ? 0 : 1;
      let best = cost[j - 1] + different, s = substitutions[j - 1] + different;
      let d = deletions[j - 1], ins = insertions[j - 1];
      if (cost[j] + 1 < best) {
        best = cost[j] + 1; s = substitutions[j]; d = deletions[j] + 1; ins = insertions[j];
      }
      if (nextCost[j - 1] + 1 < best) {
        best = nextCost[j - 1] + 1; s = nextS[j - 1]; d = nextD[j - 1]; ins = nextI[j - 1] + 1;
      }
      nextCost[j] = best; nextS[j] = s; nextD[j] = d; nextI[j] = ins;
    }
    cost = nextCost; substitutions = nextS; deletions = nextD; insertions = nextI;
  }
  return { N: n, S: substitutions[m], D: deletions[m], I: insertions[m], errors: cost[m] };
}

function metric(truth, prediction, completed) {
  const edits = characterEdits(truth, completed ? prediction : '');
  return { ...edits, cer: edits.N ? edits.errors / edits.N : null,
    charAccuracy: edits.N ? Math.max(0, 1 - edits.errors / edits.N) : null,
    exactMatch: completed && truth === prediction };
}

function aggregate(samples, field) {
  const eligible = samples.filter(sample => sample.included), totals = { N: 0, S: 0, D: 0, I: 0, errors: 0 };
  for (const sample of eligible) for (const key of Object.keys(totals)) totals[key] += sample[field][key];
  const exactMatches = eligible.filter(sample => sample[field].exactMatch).length;
  return { ...totals, cer: totals.N ? totals.errors / totals.N : null,
    charAccuracy: totals.N ? Math.max(0, 1 - totals.errors / totals.N) : null,
    exactMatches, eligibleSamples: eligible.length, exactMatchRate: eligible.length ? exactMatches / eligible.length : null };
}

/** No spelling, punctuation, numeral, case, script or Unicode normalization is applied. */
export function scoreOcrBenchmark(truth, predictions) {
  const expected = samplesById(truth, 'truth'), actual = samplesById(predictions, 'predictions');
  if (!expected.size) throw new Error('truth must contain at least one non-blank sample');
  if (!label(predictions.engine) || !label(predictions.device)) throw new Error('predictions needs explicit engine and device labels');
  if ([...actual.keys()].some(id => !expected.has(id))) throw new Error('predictions contains an extra sample id outside truth');
  const samples = [];
  for (const [id, source] of expected) {
    const predicted = actual.get(id), status = predicted ? statuses.get(predicted.status) : 'missing';
    for (const key of ['sourceSha256', 'bbox', 'kind']) {
      if (predicted?.[key] !== undefined && !isDeepStrictEqual(predicted[key], source[key])) {
        throw new Error(`sample identity ${key} does not match truth for ${id}`);
      }
    }
    const included = status !== 'not_run', completed = status === 'completed';
    samples.push({ id, ...(source.kind !== undefined ? { kind: source.kind } : {}), status, included,
      sourceIdentity: source.sourceSha256 === undefined ? 'not-specified' : predicted?.sourceSha256 === undefined ? 'not-reported' : 'sha256-matched',
      ...(predicted?.seconds !== undefined ? { seconds: predicted.seconds } : {}),
      primary: included ? metric(primaryText(source.text), primaryText(predicted?.text ?? ''), completed) : null,
      ignoreWhitespace: included ? metric(secondaryText(source.text), secondaryText(predicted?.text ?? ''), completed) : null });
  }
  const counts = Object.fromEntries(['completed', 'failed', 'missing', 'not_run'].map(status => [status, samples.filter(sample => sample.status === status).length]));
  return { schemaVersion: 1, kind: 'ocr-benchmark-score', engine: predictions.engine, device: predictions.device,
    definitions: { primary: 'Micro CER over Unicode code points; only CRLF is changed to LF. Exact match is a whole-segment comparison after that change.',
      secondary: 'IGNORE WHITESPACE (secondary only): CRLF to LF, then remove Unicode White_Space code points.',
      failedOrMissing: 'Included in truth denominator, with all truth characters counted as deletions; partial failed text is ignored.',
      notRun: 'Only explicit not_run/NOT_RUN predictions are excluded. Missing predictions are failures, not exclusions.',
      rates: 'CER=(S+D+I)/N, charAccuracy=max(0,1-CER); empty eligible denominators are null.',
      identity: 'sourceIdentity=not-reported means an available truth source hash was not verified by a prediction; no source file is opened.' },
    counts: { total: samples.length, included: samples.length - counts.not_run, ...counts },
    primary: aggregate(samples, 'primary'), secondary: { label: 'IGNORE WHITESPACE - SECONDARY ONLY', ...aggregate(samples, 'ignoreWhitespace') }, samples };
}

export function formatOcrScoreTable(score) {
  const rate = value => value === null ? 'n/a' : `${(value * 100).toFixed(2)}%`;
  return [`${score.engine} | ${score.device} | included ${score.counts.included}/${score.counts.total} | not_run ${score.counts.not_run} | failed ${score.counts.failed} | missing ${score.counts.missing}`,
    'metric                         N      S      D      I      CER       char accuracy   exact segments',
    ...[['PRIMARY', score.primary], ['IGNORE WHITESPACE (secondary)', score.secondary]].map(([name, row]) =>
      `${name.padEnd(30)} ${String(row.N).padStart(6)} ${String(row.S).padStart(6)} ${String(row.D).padStart(6)} ${String(row.I).padStart(6)} ${rate(row.cer).padStart(9)} ${rate(row.charAccuracy).padStart(15)} ${row.exactMatches}/${row.eligibleSamples} (${rate(row.exactMatchRate)})`)].join('\n');
}

export async function runOcrBenchmark(argv, { cwd = process.cwd(), readFile = fs.readFile, writeFile = fs.writeFile } = {}) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--help' || token === '-h') { options.help = true; continue; }
    const match = /^--(truth|predictions|output)(?:=(.*))?$/u.exec(token);
    if (!match || Object.hasOwn(options, match[1])) throw new Error('Unknown or duplicate benchmark argument');
    const value = match[2] ?? argv[++index];
    if (!value || value.startsWith('--')) throw new Error('Benchmark argument needs an explicit file path');
    options[match[1]] = value;
  }
  if (options.help) return { help };
  if (!options.truth || !options.predictions || !options.output) throw new Error(help);
  const files = Object.fromEntries(Object.entries(options).map(([key, value]) => [key, path.resolve(cwd, value)]));
  if (files.output === files.truth || files.output === files.predictions) throw new Error('Output cannot replace either input');
  const [truthBytes, predictionBytes] = await Promise.all([readFile(files.truth), readFile(files.predictions)]);
  const parse = bytes => JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, ''));
  const score = scoreOcrBenchmark(parse(truthBytes), parse(predictionBytes));
  score.inputs = { truth: { path: path.basename(files.truth), sha256: sha256(truthBytes) },
    predictions: { path: path.basename(files.predictions), sha256: sha256(predictionBytes) } };
  await writeFile(files.output, JSON.stringify(score, null, 2) + '\n', { flag: 'wx' });
  return { score, outputPath: files.output, table: formatOcrScoreTable(score) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await runOcrBenchmark(process.argv.slice(2)); console.log(result.help ?? `${result.table}\nJSON: ${result.outputPath}`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
