import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMappingTemplate } from '../src/mapping-template.mjs';
import { preparationArguments, preparationArgumentPath, readJobJson, writeJobJson } from '../src/preparation-files.mjs';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const required = ['input', 'plan', 'order', 'index', 'output'];
const optional = ['baseline', 'crops'];

function mappingArguments(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    return preparationArguments(argv, [...required, ...optional]);
  }
  // The shared parser knows every flag, but treats its known list as required.
  // Suppress only that final requirement check, then enforce our required set.
  const options = preparationArguments([...argv, '--help'], [...required, ...optional]);
  delete options.help;
  if (required.some(key => !options[key])) throw new Error(`必须明确提供 ${required.map(key => '--' + key).join(' ')}；不会读取真实书或平台`);
  return options;
}

export async function createMapping(argv, { project = projectRoot, cwd = process.cwd() } = {}) {
  const options = mappingArguments(argv);
  if (options.help) return { help: 'node scripts/create-mapping-template.mjs --input=data/jobs/<job>/paired.json --plan=data/jobs/<job>/plan.json --order=data/jobs/<job>/order.json --index=data/jobs/<job>/index.json --output=data/jobs/<job>/mapping.template.json [--baseline=data/jobs/<job>/baseline.json] [--crops=data/jobs/<job>/source.json]' };
  const references = {}, inputs = [];
  for (const [flag, role] of [['input', 'paired'], ['plan', 'plan'], ['order', 'order'], ['index', 'index'], ['baseline', 'baseline'], ['crops', 'cropEvidence']]) {
    if (options[flag] === undefined) continue;
    const artifact = await readJobJson(project, await preparationArgumentPath(cwd, options[flag]));
    if (inputs.length && inputs[0].baseDir !== artifact.baseDir) throw new Error('所有 mapping 输入和输出必须位于同一 data/jobs/<job>/ 根');
    inputs.push(artifact); references[role] = { path: path.basename(artifact.file), sha256: artifact.sha256 };
  }
  const template = createMappingTemplate(references, inputs[0].baseDir);
  const output = await writeJobJson(project, await preparationArgumentPath(cwd, options.output), template, inputs[0].baseDir);
  return { outputPath: output.file, outputSha256: output.sha256, bookId: template.bookId, source: template.source,
    tasks: template.placements.length, requiredFields: template.requiredFields, approved: 0, readyForExecution: false, platformWritePerformed: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await createMapping(process.argv.slice(2)); console.log(result.help ?? JSON.stringify(result, null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
