import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectReviewedBatch, renderReviewedBatchPreview, reviewedManifestHash } from '../src/review-preflight.mjs';
import { writableWorkspacePath } from '../src/recorder-config.mjs';

const inside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || !(relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative));
};

async function existingAncestor(directory) {
  let current = directory;
  while (true) {
    try { await fs.lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent; continue;
    }
    // A dangling link is an error, not a missing directory to skip over.
    return { path: current, realPath: await fs.realpath(current) };
  }
}

async function lexicalProjectForCwd(project, cwd) {
  let current = path.resolve(cwd);
  while (true) {
    if (path.relative(project, await fs.realpath(current)) === '') return current;
    const parent = path.dirname(current);
    if (parent === current) return project;
    current = parent;
  }
}

async function safeOutputDirectory(project, lexicalProject, requested) {
  const trustedRoot = path.join(project, 'data', 'review');
  const lexicalRoot = path.join(lexicalProject, 'data', 'review');
  if (inside(lexicalRoot, requested)) {
    requested = path.resolve(trustedRoot, path.relative(lexicalRoot, requested));
  } else if (!inside(trustedRoot, requested)) {
    throw new Error('输出目录必须位于项目 data/review 内');
  }
  const ancestor = await existingAncestor(requested);
  if (inside(trustedRoot, ancestor.path)) {
    if (!inside(trustedRoot, ancestor.realPath)) throw new Error('输出目录软链接/junction 越出 data/review');
  } else if (path.relative(ancestor.path, ancestor.realPath) !== '') {
    throw new Error('输出根的祖先软链接/junction 改变了 data/review 真实位置');
  }
  await writableWorkspacePath(project, path.join(requested, 'preflight.json'));
  await fs.mkdir(requested, { recursive: true });
  const realRoot = await fs.realpath(trustedRoot), realOutput = await fs.realpath(requested);
  if (path.relative(trustedRoot, realRoot) !== '' || !inside(trustedRoot, realOutput)) {
    throw new Error('创建后的输出目录真实路径越出 data/review');
  }
  await writableWorkspacePath(trustedRoot, path.join(realOutput, 'preflight.json'));
  await writableWorkspacePath(trustedRoot, path.join(realOutput, 'preview.html'));
  return realOutput;
}

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
  const lexicalProject = await lexicalProjectForCwd(project, cwd);
  const name = path.basename(manifestPath, path.extname(manifestPath)).replace(/[^\p{L}\p{N}_-]/gu, '-');
  const requestedOutput = options.outputdir ? path.resolve(cwd, options.outputdir)
    : path.join(project, 'data', 'review', `${name}-${hash.slice(0, 12)}`);
  const preview = renderReviewedBatchPreview(manifest, baseDir, report);
  const document = { ...report, manifestPath, manifestSha256: hash, generatedAt: new Date().toISOString() };
  const outputDir = await safeOutputDirectory(project, lexicalProject, requestedOutput);
  const reportPath = path.join(outputDir, 'preflight.json'), previewPath = path.join(outputDir, 'preview.html');
  // No existing local evidence is overwritten and the manifest is never edited.
  for (const file of [reportPath, previewPath]) {
    try { await fs.access(file); throw new Error(`输出已存在，请选新目录：${file}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await fs.writeFile(reportPath, JSON.stringify(document, null, 2) + '\n', { flag: 'wx' });
  await fs.writeFile(previewPath, preview, { flag: 'wx' });
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
