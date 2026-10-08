import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const names = { crop: 'crop_sources.py', ocr: 'ocr-pages.py' };
const [tool, ...args] = process.argv.slice(2);
if (!Object.hasOwn(names, tool)) {
  console.error('Only the fixed crop/ocr tools can run'); process.exitCode = 1;
} else {
  let python = process.env.TEXTBOOK_RECORDER_PYTHON;
  if (python && (!path.isAbsolute(python) || !fs.statSync(python).isFile())) throw new Error('TEXTBOOK_RECORDER_PYTHON must be an explicit Python executable path');
  if (!python) {
    const suffix = process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python'];
    python = ['.venv-workflow', '.venv-ocr'].map(folder => path.join(root, folder, ...suffix)).find(file => fs.existsSync(file)) ?? 'python';
  }
  const result = spawnSync(python, [path.join(root, 'scripts', names[tool]), ...args], {
    cwd: root, stdio: 'inherit', windowsHide: true, shell: false,
  });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
}
