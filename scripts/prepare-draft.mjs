import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareDraftBatch } from '../src/draft-batch.mjs';
import { preparationArguments, preparationArgumentPath, readJobJson, writeJobJson } from '../src/preparation-files.mjs';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export async function prepareDraft(argv, { project = projectRoot, cwd = process.cwd() } = {}) {
  const options = preparationArguments(argv, ['input','mapping','output']);
  if (options.help) return { help: 'node scripts/prepare-draft.mjs --input=data/jobs/<job>/paired.json --mapping=data/jobs/<job>/mapping.json --output=data/jobs/<job>/draft.json' };
  const input = await readJobJson(project, await preparationArgumentPath(cwd, options.input));
  const mapping = await readJobJson(project, await preparationArgumentPath(cwd, options.mapping));
  if (input.baseDir !== mapping.baseDir) throw new Error('input/mapping/output 必须位于同一 data/jobs/<job>/ 根');
  const { manifest, report, summary } = prepareDraftBatch(input.value, mapping.value, input.baseDir,
    { paired: { path: path.basename(input.file), sha256: input.sha256 }, mapping: { path: path.basename(mapping.file), sha256: mapping.sha256 } });
  const output = await writeJobJson(project, await preparationArgumentPath(cwd, options.output), manifest, input.baseDir);
  // A blocked draft remains useful for original-image review. The CLI reports
  // the failure and never treats creation of a JSON file as approval.
  return { ...summary, outputPath: output.file, outputSha256: output.sha256, errors: report.errors, warnings: report.warnings,
    unresolvedSpecialReview: report.unresolvedSpecialReview };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await prepareDraft(process.argv.slice(2)); console.log(result.help ?? JSON.stringify(result, null, 2)); process.exitCode = result.help || result.valid ? 0 : 1; }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
