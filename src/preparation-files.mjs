import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writableWorkspacePath } from './recorder-config.mjs';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, file) => { const rel = path.relative(root, file); return rel === '' || !(rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)); };

async function ancestorOf(file) {
  let current = file;
  while (true) {
    try { await fs.lstat(current); return { path: current, real: await fs.realpath(current) }; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // A dangling junction/symlink must never be treated as a missing directory.
      try { await fs.lstat(current); throw new Error('路径链接无法解析'); } catch (again) { if (again.code !== 'ENOENT') throw again; }
      const parent = path.dirname(current); if (parent === current) throw error; current = parent;
    }
  }
}

/** All preparation artifacts share one real data/jobs/<job>/ base directory. */
export async function preparationJob(root, requested, { create = false } = {}) {
  const lexicalRoot = path.resolve(root), project = await fs.realpath(root), trusted = path.join(project, 'data', 'jobs');
  let file = path.resolve(project, requested);
  if (inside(lexicalRoot, file)) file = path.resolve(project, path.relative(lexicalRoot, file));
  const rel = path.relative(trusted, file);
  if (!inside(trusted, file) || rel.split(path.sep).length !== 2 || !rel.split(path.sep).every(part => part && part !== '.' && part !== '..')) {
    throw new Error('准备文件必须直接位于项目 data/jobs/<job>/ 根目录');
  }
  const parent = path.dirname(file), existing = await ancestorOf(parent);
  if ((inside(trusted, existing.path) && !inside(trusted, existing.real)) || (!inside(trusted, existing.path) && existing.path !== existing.real)) {
    throw new Error('data/jobs 路径软链接/junction 越界');
  }
  await writableWorkspacePath(project, file);
  if (create) await fs.mkdir(parent, { recursive: true });
  const realTrusted = await fs.realpath(trusted), realParent = await fs.realpath(parent);
  if (realTrusted !== trusted || !inside(trusted, realParent) || path.relative(trusted, realParent).split(path.sep).length !== 1) throw new Error('准备目录真实路径越出 data/jobs');
  return { project, baseDir: realParent, file: path.join(realParent, path.basename(file)) };
}

/** Relative CLI paths follow a real cwd even when the project has a junction alias. */
export async function preparationArgumentPath(cwd, filename) {
  const lexicalCwd = path.resolve(cwd), realCwd = await fs.realpath(cwd), file = path.resolve(lexicalCwd, filename);
  return inside(lexicalCwd, file) ? path.resolve(realCwd, path.relative(lexicalCwd, file)) : path.resolve(realCwd, filename);
}

export async function readJobJson(root, requested) {
  const job = await preparationJob(root, requested);
  const realFile = await fs.realpath(job.file);
  if (!inside(job.baseDir, realFile) || path.dirname(realFile) !== job.baseDir || !(await fs.stat(realFile)).isFile()) throw new Error('输入文件软链接越出作业根');
  const bytes = await fs.readFile(realFile);
  return { ...job, file: realFile, sha256: sha256(bytes), value: JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, '')) };
}

export async function writeJobJson(root, requested, value, baseDir) {
  const job = await preparationJob(root, requested, { create: true });
  // Windows short paths and project junction aliases can name the same job.
  // Output clamping above remains lexical and physical; only compare the
  // already-existing input base directory by its canonical real path.
  if (baseDir !== undefined && job.baseDir !== await fs.realpath(baseDir)) throw new Error('input/mapping/output 必须位于同一 data/jobs/<job>/ 根');
  // Recheck after mkdir; opening with wx rejects files and dangling links alike.
  await writableWorkspacePath(job.baseDir, job.file);
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  await fs.writeFile(job.file, bytes, { flag: 'wx' });
  return { file: job.file, sha256: sha256(bytes) };
}

export function preparationArguments(argv, required) {
  const result = {};
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--help' || token === '-h') { result.help = true; continue; }
    const match = /^--([a-z]+)(?:=(.*))?$/u.exec(token);
    if (!match || !required.includes(match[1]) || Object.hasOwn(result, match[1])) throw new Error(`未知或重复参数：${token}`);
    const value = match[2] ?? argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${token} 缺少路径`);
    result[match[1]] = value;
  }
  if (!result.help && required.some(key => !result[key])) throw new Error(`必须明确提供 ${required.map(key => '--' + key).join(' ')}；不会读取真实书或平台`);
  return result;
}
