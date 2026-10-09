import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { preparationArgumentPath, readJobJson, sha256 } from '../src/preparation-files.mjs';
import { existingWorkspacePath } from '../src/recorder-config.mjs';
import { createReviewMaterials } from '../src/review-materials.mjs';
import { reviewOutputDirectory, writeReviewFiles } from '../src/review-output.mjs';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};
const help = 'workflow:materials --manifest=data/jobs/<job>/draft.json (--tasks=q1,q2 | --diagnostics=error|warning|review|all | --diff=data/review/<directory>/diff.json) [--outputdir=data/review/<new-directory>]';

function argumentsOf(argv) {
  const options = {};
  for (const token of argv) {
    if (token === '--help' || token === '-h') { options.help = true; continue; }
    const match = /^--(manifest|tasks|diagnostics|diff|outputdir)=(.+)$/u.exec(token);
    if (!match || Object.hasOwn(options, match[1])) throw new Error(`未知、重复或非 --key=value 参数：${token}`);
    options[match[1]] = match[2];
  }
  if (!options.help && (!options.manifest || ['tasks', 'diagnostics', 'diff'].filter(key => options[key] !== undefined).length !== 1)) throw new Error(help);
  return options;
}

async function readBoundDiff(project, cwd, requested, manifest) {
  const file = await existingWorkspacePath(project, await preparationArgumentPath(cwd, requested));
  const root = path.join(await fs.realpath(project), 'data', 'review');
  if (!inside(root, file) || path.basename(file) !== 'diff.json' || await fs.realpath(root) !== root || !(await fs.stat(file)).isFile()) throw new Error('diff 必须是当前项目 data/review 内已有 diff.json');
  const bytes = await fs.readFile(file), report = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, ''));
  if (typeof report.beforePath !== 'string' || path.basename(report.beforePath) !== report.beforePath) throw new Error('diff beforePath 须为同 job 文件名');
  const before = await readJobJson(project, path.join(manifest.baseDir, report.beforePath));
  if (before.baseDir !== manifest.baseDir || path.basename(before.file) !== report.beforePath) throw new Error('diff before/after 必须位于同 job 并保持实际文件名');
  return { report, before: before.value, beforeSha256: before.sha256,
    path: path.relative(project, file).split(path.sep).join('/'), sha256: sha256(bytes) };
}

export async function reviewMaterials(argv, { project = projectRoot, cwd = process.cwd() } = {}) {
  const options = argumentsOf(argv);
  if (options.help) return { help };
  const manifest = await readJobJson(project, await preparationArgumentPath(cwd, options.manifest));
  const selection = { manifestPath: path.basename(manifest.file),
    ...(options.tasks !== undefined ? { taskIds: options.tasks.split(',') } : {}),
    ...(options.diagnostics !== undefined ? { diagnosticSeverity: options.diagnostics } : {}),
    ...(options.diff !== undefined ? { diff: await readBoundDiff(project, cwd, options.diff, manifest) } : {}) };
  const result = createReviewMaterials(manifest.value, manifest.sha256, manifest.baseDir, selection);
  // Bind the display to the initially read complete manifest, never a subset.
  if (sha256(await fs.readFile(manifest.file)) !== manifest.sha256) throw new Error('材料准备期间完整草稿字节变化，请重新运行');
  const selectionHash = sha256(Buffer.from(JSON.stringify(result.packet.selection))).slice(0, 12);
  const directory = await reviewOutputDirectory(project, cwd, options.outputdir
    ? await preparationArgumentPath(cwd, options.outputdir)
    : path.join(project, 'data', 'review', `materials-${manifest.sha256.slice(0, 12)}-${selectionHash}`));
  const files = await writeReviewFiles(project, directory, { 'materials.json': JSON.stringify(result.packet, null, 2) + '\n', 'materials.html': result.html });
  return { ...result.summary, selectedTaskIds: result.packet.selectedTaskIds, reportPath: files['materials.json'],
    previewPath: files['materials.html'], manifestSha256: manifest.sha256, referenceOnly: true,
    automaticApproval: false, readyForExecution: false, platformWritePerformed: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await reviewMaterials(process.argv.slice(2)); console.log(result.help ?? JSON.stringify(result, null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
