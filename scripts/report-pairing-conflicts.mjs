import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPairingConflictsReport } from '../src/pairing-conflicts.mjs';
import { preparationArguments, preparationArgumentPath, readJobJson, writeJobJson } from '../src/preparation-files.mjs';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export async function reportPairingConflicts(argv, { project = projectRoot, cwd = process.cwd() } = {}) {
  const options = preparationArguments(argv, ['input', 'records', 'index', 'output']);
  if (options.help) return { help: 'node scripts/report-pairing-conflicts.mjs --input=data/jobs/<job>/paired.json --records=data/jobs/<job>/records.json --index=data/jobs/<job>/index.json --output=data/jobs/<job>/pairing-conflicts.json' };
  const files = {};
  for (const name of ['input', 'records', 'index']) files[name] = await readJobJson(project, await preparationArgumentPath(cwd, options[name]));
  if (files.input.baseDir !== files.records.baseDir || files.input.baseDir !== files.index.baseDir) throw new Error('input/records/index/output 必须位于同一 data/jobs/<job>/ 根');
  const provenance = Object.fromEntries([['paired', 'input'], ['records', 'records'], ['index', 'index']]
    .map(([name, key]) => [name, { path: path.basename(files[key].file), sha256: files[key].sha256 }]));
  const report = buildPairingConflictsReport(files.input.value, files.records.value, files.index.value, files.input.baseDir, provenance);
  const output = await writeJobJson(project, await preparationArgumentPath(cwd, options.output), report, files.input.baseDir);
  return { reportCreated: true, referenceOnly: true, readyForExecution: false,
    platformWritePerformed: false, sourceSemanticsVerifiedByTool: false, ...report.summary,
    outputPath: output.file, outputSha256: output.sha256 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await reportPairingConflicts(process.argv.slice(2)); console.log(result.help ?? JSON.stringify(result, null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
