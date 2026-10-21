import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { patchPreparationSource } from '../src/local-preparation-patch.mjs';
import { preparationArguments, preparationArgumentPath, readJobJson, writeJobJson } from '../src/preparation-files.mjs';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export async function applyPreparationPatch(argv, { root = projectRoot, cwd = process.cwd(), readJson = readJobJson } = {}) {
  const options = preparationArguments(argv, ['input', 'patch', 'output']);
  if (options.help) return { help: 'node scripts/patch-preparation.mjs --input=data/jobs/<job>/records.json --patch=data/jobs/<job>/patch.json --output=data/jobs/<job>/records.v2.json' };
  const inputPath = await preparationArgumentPath(cwd, options.input), patchPath = await preparationArgumentPath(cwd, options.patch);
  const input = await readJson(root, inputPath);
  const patch = await readJson(root, patchPath);
  if (input.baseDir !== patch.baseDir) throw new Error('input/patch/output 必须位于同一 data/jobs/<job>/ 根');
  const result = patchPreparationSource(input.value, input.sha256, patch.value);
  // Re-read just before writing, including canonical paths, so a concurrent edit
  // or link retarget cannot quietly produce an artifact bound to an older read.
  for (const [label, requested, original] of [['input', inputPath, input], ['patch', patchPath, patch]]) {
    const current = await readJson(root, requested);
    if (current.sha256 !== original.sha256 || current.file !== original.file || current.baseDir !== original.baseDir) {
      throw new Error(`${label} 在补丁处理期间已变化；保留原文件，不生成新材料`);
    }
  }
  const output = await writeJobJson(root, await preparationArgumentPath(cwd, options.output), result.value, input.baseDir);
  return { outputPath: output.file, outputSha256: output.sha256, sourceSha256: input.sha256, patchSha256: patch.sha256,
    affectedIds: result.affectedIds, affectedTargets: result.affectedTargets, requiresReview: true, platformWritePerformed: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await applyPreparationPatch(process.argv.slice(2)); console.log(result.help ?? JSON.stringify(result, null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
