import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { preparePairedBatch, validatePairedBatch, summarizePairedBatch } from '../src/paired-batch.mjs';
import { preparationArguments, preparationArgumentPath, readJobJson, writeJobJson } from '../src/preparation-files.mjs';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export async function pairBatch(argv, { project = projectRoot, cwd = process.cwd() } = {}) {
  const options = preparationArguments(argv, ['input','output']);
  if (options.help) return { help: 'node scripts/pair-batch.mjs --input=data/jobs/<job>/records.json --output=data/jobs/<job>/paired.json' };
  const input = await readJobJson(project, await preparationArgumentPath(cwd, options.input));
  const batch = preparePairedBatch(input.value), report = validatePairedBatch(batch, input.baseDir);
  if (!report.valid) throw new Error(`本地配对校验失败：${report.errors.join('; ')}`);
  batch.preparation = { kind: 'deterministic-local-pairing', input: { path: path.basename(input.file), sha256: input.sha256 },
    unmatchedAnswers: input.value.answers.filter(record => batch.unmatchedAnswerIds.includes(record.id)), automaticallyApproved: false };
  const output = await writeJobJson(project, await preparationArgumentPath(cwd, options.output), batch, input.baseDir);
  return { valid: true, readyForExecution: false, ...summarizePairedBatch(batch), outputPath: output.file, outputSha256: output.sha256,
    warnings: report.warnings.length + batch.warnings.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await pairBatch(process.argv.slice(2)); console.log(result.help ?? JSON.stringify(result, null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
