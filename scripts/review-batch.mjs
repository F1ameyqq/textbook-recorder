import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectReviewedBatch, renderReviewedBatchPreview, reviewedManifestHash } from '../src/review-preflight.mjs';
import { reviewOutputDirectory, writeReviewFiles } from '../src/review-output.mjs';

function argumentsFor(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const input = argv[index];
    if (input === '--help' || input === '-h') { options.help = true; continue; }
    const match = /^--(manifest|outputdir)(?:=(.*))?$/u.exec(input);
    if (!match || Object.hasOwn(options, match[1])) throw new Error(`未知或重复参数：${input}`);
    const value = match[2] ?? argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${input} 缺少路径`);
    options[match[1]] = value;
  }
  return options;
}

export async function reviewBatch(argv, cwd = process.cwd()) {
  const options = argumentsFor(argv);
  if (options.help) return { help: 'node scripts/review-batch.mjs --manifest=<本地题单.json> [--outputdir=<项目 data/review 内的子目录>]' };
  if (!options.manifest) throw new Error('必须显式提供 --manifest；不会读取真实书或平台');
  const manifestPath = path.resolve(cwd, options.manifest);
  const bytes = await fs.readFile(manifestPath), hash = reviewedManifestHash(bytes);
  const manifest = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, ''));
  const baseDir = path.dirname(manifestPath), report = inspectReviewedBatch(manifest, baseDir);
  const project = await fs.realpath(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
  const name = path.basename(manifestPath, path.extname(manifestPath)).replace(/[^\p{L}\p{N}_-]/gu, '-');
  const requestedOutput = options.outputdir ? path.resolve(cwd, options.outputdir)
    : path.join(project, 'data', 'review', `${name}-${hash.slice(0, 12)}`);
  const preview = renderReviewedBatchPreview(manifest, baseDir, report);
  const document = { ...report, manifestPath, manifestSha256: hash, generatedAt: new Date().toISOString() };
  const outputDir = await reviewOutputDirectory(project, cwd, requestedOutput);
  const reportPath = path.join(outputDir, 'preflight.json'), previewPath = path.join(outputDir, 'preview.html');
  await writeReviewFiles(project, outputDir, { 'preflight.json': JSON.stringify(document, null, 2) + '\n', 'preview.html': preview });
  return { valid: report.valid, readyForExecution: report.readyForExecution, errors: report.errors.length,
    warnings: report.warnings.length, reportPath, previewPath, manifestSha256: hash };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await reviewBatch(process.argv.slice(2));
    console.log(result.help ?? JSON.stringify(result, null, 2));
    process.exitCode = result.help || result.valid ? 0 : 1;
  } catch (error) {
    console.error(error.message); process.exitCode = 1;
  }
}
