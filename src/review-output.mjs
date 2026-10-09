import fs from 'node:fs/promises';
import path from 'node:path';
import { writableWorkspacePath } from './recorder-config.mjs';

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

/** Shared output boundary for local review and version comparisons. */
export async function reviewOutputDirectory(root, cwd, requested) {
  const project = await fs.realpath(root), lexicalProject = await lexicalProjectForCwd(project, cwd);
  const trustedRoot = path.join(project, 'data', 'review'), lexicalRoot = path.join(lexicalProject, 'data', 'review');
  requested = path.resolve(cwd, requested);
  if (inside(lexicalRoot, requested)) requested = path.resolve(trustedRoot, path.relative(lexicalRoot, requested));
  else if (!inside(trustedRoot, requested)) throw new Error('输出目录必须位于项目 data/review 内');
  const ancestor = await existingAncestor(requested);
  if (inside(trustedRoot, ancestor.path)) {
    if (!inside(trustedRoot, ancestor.realPath)) throw new Error('输出目录软链接/junction 越出 data/review');
  } else if (path.relative(ancestor.path, ancestor.realPath) !== '') {
    throw new Error('输出根的祖先软链接/junction 改变了 data/review 真实位置');
  }
  await writableWorkspacePath(project, path.join(requested, 'preflight.json'));
  await fs.mkdir(requested, { recursive: true });
  const realRoot = await fs.realpath(trustedRoot), realOutput = await fs.realpath(requested);
  if (path.relative(trustedRoot, realRoot) !== '' || !inside(trustedRoot, realOutput)) throw new Error('创建后的输出目录真实路径越出 data/review');
  return realOutput;
}

export async function writeReviewFiles(root, directory, entries) {
  const allowed = new Set(['preflight.json', 'preview.html', 'diff.json', 'diff.html', 'materials.json', 'materials.html']);
  const project = await fs.realpath(root);
  const output = await reviewOutputDirectory(project, project, directory);
  const pending = [];
  for (const [name, bytes] of Object.entries(entries)) {
    if (!allowed.has(name)) throw new Error('未知审校输出文件');
    const file = await writableWorkspacePath(project, path.join(output, name));
    try { await fs.lstat(file); throw new Error(`输出已存在，请选新目录：${file}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    pending.push([file, bytes]);
  }
  for (const [file, bytes] of pending) {
    await writableWorkspacePath(project, file);
    await fs.writeFile(file, bytes, { flag: 'wx' });
  }
  return Object.fromEntries(pending.map(([file]) => [path.basename(file), file]));
}
