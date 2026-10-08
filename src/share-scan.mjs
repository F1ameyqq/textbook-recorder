import fs from 'node:fs/promises';
import path from 'node:path';

const allowedRoots = new Set(['src', 'scripts', 'tests', 'docs', 'examples', '.github', '.agents', 'config']);
const allowedTop = new Set(['README.md', 'NOTICE.md', '.gitignore', '.gitattributes', 'package.json', 'package-lock.json', 'requirements-ocr.txt', 'requirements-crop.txt']);
const ignoredRoots = new Set(['.git', 'node_modules', 'data', 'profiles', 'imports', 'artifacts', 'screenshots', '__pycache__']);
const sensitiveNames = /(?:control\.json|session\.json|recorder\.json|\.dpapi\.json|\.env(?:\..*)?|\.log|\.lock|\.tmp|\.zip|\.pyc)$/iu;
const patterns = [
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/u],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u],
  ['personal path', /(?:C:[\\/]Users[\\/]ASUS|D:[\\/]Money)[\\/]/iu],
  ['real extension token', /PLAYWRIGHT_MCP_EXTENSION_TOKEN\s*=\s*[A-Za-z0-9_-]{24,}/u],
  ['connection URL', /(?:chrome-)?extension:\/\/[^\s"']+connect\.html\?[^\s"']+/iu],
  ['credential URL', /https:\/\/[^\s/@:]+:[^\s/@]+@github\.com/iu],
];

export async function listShareFiles(root) {
  const files = [];
  async function visit(directory, prefix = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`发布目录含软链接：${relative}`);
      if (entry.isDirectory()) {
        if (!prefix && (ignoredRoots.has(entry.name) || /^\.venv/u.test(entry.name))) continue;
        if (!prefix && !allowedRoots.has(entry.name)) throw new Error(`发布范围外的目录：${relative}`);
        if (entry.name === '__pycache__') continue;
        await visit(path.join(directory, entry.name), relative);
      } else if (entry.isFile()) {
        if (!prefix && !allowedTop.has(entry.name)) throw new Error(`发布范围外的文件：${relative}`);
        if (relative.startsWith('config/') && relative !== 'config/recorder.example.json') continue;
        if (sensitiveNames.test(entry.name) && entry.name !== 'package-lock.json') throw new Error(`本地运行文件不可发布：${relative}`);
        files.push(relative);
      }
    }
  }
  await visit(root);
  return files.sort();
}

export async function inspectShareFiles(root, files) {
  const errors = [];
  for (const relative of files) {
    const parts = relative.split('/');
    if (path.isAbsolute(relative) || parts.some(part => part === '..') || ignoredRoots.has(parts[0]) || (!allowedRoots.has(parts[0]) && !allowedTop.has(relative))) { errors.push({ file: relative, reason: '发布路径越界或包含本地数据' }); continue; }
    if (relative.startsWith('config/') && relative !== 'config/recorder.example.json') { errors.push({ file: relative, reason: '真实配置不能发布' }); continue; }
    if (sensitiveNames.test(path.basename(relative)) && relative !== 'package-lock.json') { errors.push({ file: relative, reason: '运行或凭据文件不能发布' }); continue; }
    const bytes = await fs.readFile(path.join(root, relative));
    if (bytes.length > 1024 * 1024) { errors.push({ file: relative, reason: '代码包单文件超限，检查是否混入原书材料' }); continue; }
    if (['.png', '.jpg', '.jpeg'].includes(path.extname(relative).toLowerCase())) {
      if (!relative.startsWith('examples/assets/')) errors.push({ file: relative, reason: '仅允许登记的合成演练图' });
      continue;
    }
    const source = bytes.toString('utf8');
    for (const [reason, expression] of patterns) if (expression.test(source)) errors.push({ file: relative, reason });
  }
  return { valid: errors.length === 0, files: files.length, errors };
}
