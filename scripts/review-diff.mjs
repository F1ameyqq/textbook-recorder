import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { preparationArguments, preparationArgumentPath, readJobJson } from '../src/preparation-files.mjs';
import { compareReviewedBatches, renderReviewDiff } from '../src/review-diff.mjs';
import { reviewOutputDirectory, writeReviewFiles } from '../src/review-output.mjs';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export async function reviewDiff(argv, { project = projectRoot, cwd = process.cwd() } = {}) {
  // outputdir is optional; preparationArguments treats listed names as required.
  const provided = argv.some(value => /^--outputdir(?:=|$)/u.test(value));
  const options = preparationArguments(argv, provided ? ['before', 'after', 'outputdir'] : ['before', 'after']);
  if (options.help) return { help: 'workflow:diff --before=data/jobs/<job>/batch.v1.json --after=data/jobs/<job>/batch.v2.json [--outputdir=data/review/<new-directory>]' };
  const before = await readJobJson(project, await preparationArgumentPath(cwd, options.before));
  const after = await readJobJson(project, await preparationArgumentPath(cwd, options.after));
  if (before.baseDir !== after.baseDir) throw new Error('比较的题单必须来自同一 data/jobs/<job>');
  const report = compareReviewedBatches(before.value, after.value, { beforeSha256: before.sha256, afterSha256: after.sha256 });
  const document = { ...report, beforePath: path.basename(before.file), afterPath: path.basename(after.file), generatedAt: new Date().toISOString() };
  const directory = await reviewOutputDirectory(project, cwd, options.outputdir
    ? path.resolve(cwd, options.outputdir) : path.join(project, 'data', 'review', `diff-${before.sha256.slice(0, 12)}-${after.sha256.slice(0, 12)}`));
  const files = await writeReviewFiles(project, directory, { 'diff.json': JSON.stringify(document, null, 2) + '\n',
    'diff.html': renderReviewDiff(before.value, after.value, report, before.baseDir, after.baseDir) });
  return { ...report.summary, reportPath: files['diff.json'], previewPath: files['diff.html'],
    beforeSha256: before.sha256, afterSha256: after.sha256, automaticApproval: false, platformWritePerformed: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await reviewDiff(process.argv.slice(2)); console.log(result.help ?? JSON.stringify(result, null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
