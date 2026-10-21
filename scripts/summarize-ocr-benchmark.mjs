import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { scoreOcrBenchmark } from './score-ocr-benchmark.mjs';

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const parse = bytes => JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, ''));
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const escape = value => String(value).replace(/[&<>"']/gu, token => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[token]));
const canonical = value => JSON.stringify(Array.isArray(value) ? value.map(item => JSON.parse(canonical(item))) :
  value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])) : value);
const same = (left, right) => left !== undefined && right !== undefined && canonical(left) === canonical(right);
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const finitePositive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const models = {
  'v5-mobile': ['PP-OCRv5_mobile_det', 'PP-OCRv5_mobile_rec'],
  'v5-server': ['PP-OCRv5_server_det', 'PP-OCRv5_server_rec'],
  'v6-small': ['PP-OCRv6_small_det', 'PP-OCRv6_small_rec'],
  'v6-medium': ['PP-OCRv6_medium_det', 'PP-OCRv6_medium_rec']
};

function packageIdentity(packages) {
  if (!packages || typeof packages !== 'object' || Array.isArray(packages)) return null;
  const builds = ['paddlepaddle', 'paddlepaddle-gpu'].filter(key => Object.hasOwn(packages, key));
  if (builds.length !== 1 || !['paddleocr', 'paddlex', builds[0]].every(key => typeof packages[key] === 'string' && packages[key])) return null;
  if (Object.values(packages).some(value => typeof value !== 'string' || !value)) return null;
  return { distribution: builds[0], version: packages[builds[0]],
    comparable: { paddleCoreVersion: packages[builds[0]], packages: Object.fromEntries(Object.entries(packages).filter(([key]) => key !== builds[0])) } };
}

function validModelHashes(prediction) {
  const hashes = prediction.modelFileHashes;
  return hashes && typeof hashes === 'object' && !Array.isArray(hashes) && same(Object.keys(hashes).sort(), [...prediction.models].sort()) &&
    Object.values(hashes).every(files => files && typeof files === 'object' && !Array.isArray(files) && Object.keys(files).length > 0 &&
      Object.entries(files).every(([name, value]) => name && !path.win32.isAbsolute(name) && !path.posix.isAbsolute(name) &&
        !name.split(/[\\/]/u).some(part => part === '..' || part === '.' || part === '') && sha256(value)));
}

async function verifyRun({ root, name, bytes, prediction, monitorName, truth, bindings }) {
  const issues = [], check = (condition, message) => { if (!condition) issues.push(message); };
  check(prediction.schemaVersion === 1 && prediction.status === 'completed', 'Prediction is not a completed schemaVersion 1 run');
  check(same(prediction.models, models[prediction.engine]), 'Unexpected or missing model identities');
  check(['cpu', 'gpu:0'].includes(prediction.device), 'Unexpected device');
  for (const [key, wanted] of Object.entries({ truthSha256: bindings.truth.sha256, truthReviewSha256: bindings.review.sha256, runnerSha256: bindings.runner.sha256 })) {
    check(prediction[key] === wanted, 'Prediction binding mismatch: ' + key);
  }
  check(prediction.threads === 2 && prediction.cooldownSeconds === 2, 'Missing or unexpected finite runner options');
  check(same(prediction.ocrParameters, { use_doc_orientation_classify: false, use_doc_unwarping: false,
    use_textline_orientation: false, enable_mkldnn: false, cpu_threads: 2, text_recognition_batch_size: 1 }), 'Missing or unexpected OCR parameters');
  check(Boolean(packageIdentity(prediction.packages)), 'Missing or ambiguous package versions');
  check(Array.isArray(prediction.models) && Boolean(validModelHashes(prediction)), 'Missing or invalid model file hashes');
  check(prediction.deviceProof?.actualDevice === prediction.device, 'Missing or mismatched device evidence');
  if (prediction.device === 'gpu:0') {
    check(prediction.compiledWithCuda === true && /^Place\(gpu/u.test(prediction.deviceProof?.tensorPlace ?? ''), 'Missing GPU tensor evidence');
  }
  const predictors = prediction.ocrPredictors;
  check(Array.isArray(predictors) && predictors.length === 2 && ['detection', 'recognition'].every((role, index) => {
    const actual = predictors.find(item => item.role === role);
    return actual && actual.modelName === prediction.models?.[index] &&
      (actual.device === prediction.device || (prediction.device === 'gpu:0' && actual.device === 'gpu')) &&
      actual.engineConfig?.device_type === (prediction.device === 'cpu' ? 'cpu' : 'gpu');
  }), 'OCR predictor device/model configuration is incomplete');
  const expectedIds = truth.samples.map(sample => sample.id), expectedPages = [...new Set(truth.samples.map(sample => sample.image))];
  const samples = Array.isArray(prediction.samples) ? prediction.samples : [];
  check(samples.length === expectedIds.length && new Set(samples.map(sample => sample.id)).size === expectedIds.length &&
    same(samples.map(sample => sample.id).sort(), [...expectedIds].sort()), 'Incomplete or duplicate region identities');
  check(truth.samples.every(sample => {
    const actual = samples.find(item => item.id === sample.id);
    return actual?.status === 'ok' && typeof actual.text === 'string' && ['kind', 'sourceSha256', 'bbox'].every(key => same(actual[key], sample[key]));
  }), 'Region result/source/geometry is incomplete');
  check(Array.isArray(prediction.pages) && same(prediction.pages.map(page => page.image), expectedPages) &&
    prediction.pages.every(page => finitePositive(page.seconds)), 'Incomplete pages or invalid timings');
  let monitor, monitorBytes;
  try {
    monitorBytes = await fs.readFile(path.join(root, 'results', monitorName));
    monitor = parse(monitorBytes);
  } catch (error) { issues.push('Resource monitor unavailable or invalid: ' + error.message); }
  if (monitor) {
    const label = name.slice(0, -5);
    check(monitor.schemaVersion === 1 && monitor.kind === 'isolated-ocr-resource-monitor', 'Unexpected monitor schema/kind');
    check(monitor.status === 'PROCESS_EXITED' && monitor.exitCode === 0 && monitor.accepted === true && monitor.resultValidated === true,
      'Monitor did not accept a normally exited, validated success');
    check(monitor.label === label && monitor.engine === prediction.engine && monitor.device === prediction.device, 'Monitor run identity mismatch');
    check(monitor.result?.path === 'results/' + name && monitor.result?.sha256 === hash(bytes), 'Monitor/result hash or path mismatch');
    check(same(monitor.expected, { sampleCount: expectedIds.length, sampleIds: expectedIds, pageImages: expectedPages, pageCount: expectedPages.length }),
      'Monitor expected region/page inventory mismatch');
    for (const [role, wanted] of Object.entries(bindings)) check(same(monitor.inputs?.[role], wanted), 'Monitor input binding mismatch: ' + role);
    check(Array.isArray(monitor.samples) && monitor.samples.length > 0 && monitor.samples.every(sample =>
      ['freeRamMiB', 'totalGpuUsedMiB', 'gpuTemperatureC', 'totalGpuUtilizationPercent', 'elapsed'].every(key =>
        typeof sample[key] === 'number' && Number.isFinite(sample[key]) && sample[key] >= 0)), 'Monitor has no valid resource observations');
    const logPath = 'logs/' + label + '.txt';
    check(monitor.log?.path === logPath && sha256(monitor.log?.sha256), 'Monitor/log binding is incomplete');
    if (monitor.log?.path === logPath && sha256(monitor.log?.sha256)) {
      try { check(hash(await fs.readFile(path.join(root, 'logs', label + '.txt'))) === monitor.log.sha256, 'Monitor/log hash mismatch'); }
      catch (error) { issues.push('Bound log unavailable: ' + error.message); }
    }
    check(!monitor.evidenceErrors?.length && !monitor.childTermination, 'Monitor reports evidence or child shutdown issues');
  }
  return { eligible: issues.length === 0, issues, monitor, monitorSha256: monitorBytes ? hash(monitorBytes) : null };
}

export async function summarize(root, outputName = 'BENCHMARK-REPORT') {
  root = path.resolve(root);
  if (!/^[A-Za-z0-9-]+$/u.test(outputName)) throw new Error('Use a simple fresh output name');
  const outputs = ['json', 'html'].map(extension => path.join(root, outputName + '.' + extension));
  for (const output of outputs) {
    try { await fs.access(output); throw new Error('Report evidence already exists: ' + output); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const [truthBytes, reviewBytes, runnerBytes, guardBytes] = await Promise.all([
    fs.readFile(path.join(root, 'samples', 'ground-truth.json')), fs.readFile(path.join(root, 'samples', 'TRUTH-REVIEW.json')),
    fs.readFile(path.join(scriptDirectory, 'benchmark-gpu-ocr.py')), fs.readFile(path.join(scriptDirectory, 'run-guarded-ocr.py'))]);
  const review = parse(reviewBytes), truth = parse(truthBytes);
  if (review.status !== 'ACCEPTED_FINITE_REGION_TRUTH' || review.truthSha256 !== hash(truthBytes)) throw new Error('Truth review mismatch');
  if (truth.schemaVersion !== 1 || !Array.isArray(truth.samples) || !truth.samples.length || truth.samples.length > 12 ||
      new Set(truth.samples.map(sample => sample.id)).size !== truth.samples.length) throw new Error('Invalid finite truth inventory');
  const bindings = { truth: { path: 'samples/ground-truth.json', sha256: hash(truthBytes) },
    review: { path: 'samples/TRUTH-REVIEW.json', sha256: hash(reviewBytes) },
    runner: { path: 'benchmark-gpu-ocr.py', sha256: hash(runnerBytes) }, guard: { path: 'run-guarded-ocr.py', sha256: hash(guardBytes) } };
  const variants = [], predictions = new Map();
  for (const name of (await fs.readdir(path.join(root, 'results'))).sort()) {
    if (!name.endsWith('.json') || name.endsWith('-resource-monitor.json')) continue;
    const bytes = await fs.readFile(path.join(root, 'results', name)), prediction = parse(bytes);
    if (prediction.mode !== 'full-page-inference-region-scoring') continue;
    const monitorName = name.replace(/\.json$/u, '-resource-monitor.json');
    const verification = await verifyRun({ root, name, bytes, prediction, monitorName, truth, bindings });
    const byKind = {};
    if (verification.eligible) {
      // Validate the entire inventory before scoring either subset; extra IDs must not disappear during filtering.
      scoreOcrBenchmark(truth, prediction);
      for (const kind of ['text', 'formula']) {
        const subset = truth.samples.filter(sample => sample.kind === kind), ids = new Set(subset.map(sample => sample.id));
        byKind[kind] = subset.length ? scoreOcrBenchmark({ schemaVersion: 1, samples: subset },
          { ...prediction, samples: prediction.samples.filter(sample => ids.has(sample.id)) }) : null;
      }
    }
    const observations = Array.isArray(verification.monitor?.samples) ? verification.monitor.samples : [];
    const usableObservations = observations.filter(sample => ['freeRamMiB', 'totalGpuUsedMiB', 'gpuTemperatureC'].every(key => Number.isFinite(sample[key])));
    const pages = Array.isArray(prediction.pages) ? prediction.pages : [], timedPages = pages.filter(page => finitePositive(page.seconds));
    variants.push({ file: name, sha256: hash(bytes), engine: prediction.engine, device: prediction.device,
      status: prediction.status, error: prediction.error, comparisonEligible: verification.eligible, rejectionReasons: verification.issues,
      packages: prediction.packages, models: prediction.models, modelFileHashes: prediction.modelFileHashes,
      threads: prediction.threads, ocrParameters: prediction.ocrParameters, runnerSha256: prediction.runnerSha256,
      truthSha256: prediction.truthSha256, truthReviewSha256: prediction.truthReviewSha256,
      deviceProof: prediction.deviceProof, ocrPredictors: prediction.ocrPredictors,
      timing: { pageCount: pages.length, totalPageSeconds: timedPages.reduce((sum, page) => sum + page.seconds, 0),
        meanPageSeconds: mean(timedPages.map(page => page.seconds)), initializationIncludingDownloadSeconds: prediction.initializationSeconds,
        wallSecondsIncludingInitializationWarmupCooldown: prediction.totalSecondsIncludingInitializationAndCooldown },
      resources: { monitor: monitorName, sha256: verification.monitorSha256, status: verification.monitor?.status ?? 'MISSING',
        observationPolicy: 'Sampled shared-device observations, not hard resource caps; utilization gates startup only.',
        ...(usableObservations.length ? { minimumFreeRamMiB: Math.min(...usableObservations.map(sample => sample.freeRamMiB)),
          maximumTotalGpuUsedMiB: Math.max(...usableObservations.map(sample => sample.totalGpuUsedMiB)),
          maximumGpuTemperatureC: Math.max(...usableObservations.map(sample => sample.gpuTemperatureC)) } : {}) },
      boundaryIntersectionCounts: (Array.isArray(prediction.samples) ? prediction.samples : []).map(sample => ({ id: sample.id, count: sample.boundaryIntersections?.length ?? 0 })),
      scores: verification.eligible ? byKind : null });
    predictions.set(name, prediction);
  }
  const eligible = variants.filter(variant => variant.comparisonEligible && variant.engine === 'v5-mobile');
  const cpus = eligible.filter(variant => variant.device === 'cpu'), gpus = eligible.filter(variant => variant.device === 'gpu:0');
  let paired = null, pairing = { status: 'UNAVAILABLE', reason: 'Requires one eligible v5-mobile CPU run and one eligible GPU run' };
  if (cpus.length * gpus.length > 1) {
    pairing = { status: 'REFUSED', reason: 'Multiple eligible CPU/GPU candidate pairs; automatic selection is forbidden',
      cpuCandidates: cpus.map(item => item.file), gpuCandidates: gpus.map(item => item.file) };
  } else if (cpus.length === 1 && gpus.length === 1) {
    const cpu = cpus[0], gpu = gpus[0], left = predictions.get(cpu.file), right = predictions.get(gpu.file);
    const mismatches = ['models', 'modelFileHashes', 'ocrParameters', 'threads', 'cooldownSeconds', 'runnerSha256', 'truthSha256', 'truthReviewSha256']
      .filter(key => !same(left[key], right[key]));
    if (!same(packageIdentity(left.packages)?.comparable, packageIdentity(right.packages)?.comparable)) mismatches.push('package versions');
    if (!same(left.pages.map(page => page.image), right.pages.map(page => page.image))) mismatches.push('ordered page images');
    if (mismatches.length) pairing = { status: 'REFUSED', reason: 'CPU/GPU conditions differ', mismatches };
    else {
      pairing = { status: 'PAIRED', cpu: cpu.file, gpu: gpu.file };
      paired = { cpu: cpu.file, gpu: gpu.file, meanPageSpeedup: cpu.timing.meanPageSeconds / gpu.timing.meanPageSeconds,
        paddleBuilds: { cpu: packageIdentity(left.packages).distribution, gpu: packageIdentity(right.packages).distribution,
          version: packageIdentity(left.packages).version, differentBuilds: packageIdentity(left.packages).distribution !== packageIdentity(right.packages).distribution },
        exactRegionTextEquality: left.samples.map(sample => ({ id: sample.id, identical: right.samples.find(other => other.id === sample.id)?.text === sample.text })),
        condition: 'Identical reviewed pages, model file hashes, OCR options, threads, runner, truth/review and package versions. Paddle CPU/GPU distributions at the same version are different builds. Separate serial processes; one timed pass per page after a small-region warmup.' };
    }
  }
  const report = { schemaVersion: 1, kind: 'finite-ocr-comparison', truthSha256: hash(truthBytes), truthReviewSha256: hash(reviewBytes),
    textRegionCount: truth.samples.filter(sample => sample.kind === 'text').length,
    formulaRegionCount: truth.samples.filter(sample => sample.kind === 'formula').length,
    pageCount: new Set(truth.samples.map(sample => sample.image)).size,
    independentTruthReview: review.status, variants, pairing, paired,
    productionVersionSwitched: false, productionWritesPerformed: false,
    limitations: [
      'Finite pre-reviewed regions do not estimate full-book or full-page detection/omission accuracy.',
      'Only normally exited, hash-bound complete runs with accepted monitor and matching log are scored or paired.',
      'Predictions come from full original pages; recognized line centers select regions. Boundary intersections require visual geometry audit.',
      'Primary CER retains spacing/punctuation/numerals/Unicode. Secondary CER removes only Unicode whitespace.',
      'Formula string CER is not mathematical equivalence; two-dimensional layout requires separate visual review.',
      'Timing excludes model download, initialization and cooldown; one pass per page is indicative latency, not throughput.',
      'Equal Paddle versions in paddlepaddle and paddlepaddle-gpu are different builds; other recorded package versions must match.',
      'Sampled RAM/total-GPU observations are not hard caps. GPU utilization gates startup only. No production throughput measurement was made.'
    ] };
  const percent = value => value == null ? '—' : (100 * value).toFixed(2) + '%';
  const rows = variants.map(variant => '<tr><td>' + escape(variant.engine) + '</td><td>' + escape(variant.device) + '</td><td>' +
    escape(variant.comparisonEligible ? variant.status : '不纳入比较：' + variant.rejectionReasons.join('; ')) + '</td><td>' +
    percent(variant.scores?.text?.primary.charAccuracy) + '</td><td>' + percent(variant.scores?.text?.secondary.charAccuracy) + '</td><td>' +
    (variant.comparisonEligible ? variant.timing.meanPageSeconds?.toFixed(3) ?? '—' : '—') + '</td><td>' +
    (variant.scores?.text?.counts.completed ?? '—') + '/' + report.textRegionCount + '</td><td><a href="results/' + escape(variant.file) + '">原始结果</a></td></tr>').join('\n');
  const html = '<!doctype html><meta charset="utf-8"><title>离线 GPU OCR 有限对照</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:1160px;margin:40px auto;padding:0 24px;color:#1d2c35}table{border-collapse:collapse;width:100%;font-size:14px}th,td{padding:10px;border-bottom:1px solid #d8e0e4;text-align:left}th{background:#f1f5f7}a{color:#1569a1}.note{padding:16px;background:#f4f6f8;border-radius:8px}li{margin:8px 0}</style><h1>离线 GPU OCR 有限对照</h1><p>原图转录真值已独立复核：' +
    report.pageCount + ' 页、' + report.textRegionCount + ' 个文字区域、' + report.formulaRegionCount +
    ' 个公式区域。结果、日志与监控证据须通过完整绑定校验。</p><table><thead><tr><th>模型</th><th>设备</th><th>运行状态</th><th>文字字符正确率 1−CER</th><th>忽略空白（次要指标）</th><th>均秒/整页</th><th>完成文字区域</th><th>证据</th></tr></thead><tbody>' +
    rows + '</tbody></table><p class="note">字符正确率不是 OCR confidence；小样本不能代表整书准确率。公式不与文字混算。' +
    (paired ? '本次 CPU/GPU 平均每页耗时比：' + paired.meanPageSpeedup.toFixed(2) + ' 倍；Paddle CPU/GPU 同版本属于不同构建。' : escape(pairing.reason)) +
    '</p><p><a href="' + outputName + '.json">完整指标与边界</a> · <a href="samples/ground-truth.json">原图真值</a> · <a href="samples/TRUTH-REVIEW.json">独立复核</a></p><ul>' +
    report.limitations.map(item => '<li>' + escape(item) + '</li>').join('') + '</ul>';
  await fs.writeFile(outputs[0], JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  await fs.writeFile(outputs[1], html, { flag: 'wx' });
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await summarize(process.argv[2], process.argv[3]);
    console.log(JSON.stringify({ variants: report.variants.length, pairing: report.pairing, paired: report.paired, switched: report.productionVersionSwitched }));
    if (report.pairing.status === 'REFUSED') process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
