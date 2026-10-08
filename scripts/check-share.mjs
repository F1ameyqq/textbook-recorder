import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { listShareFiles, inspectShareFiles } from '../src/share-scan.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = await listShareFiles(root);
const report = await inspectShareFiles(root, files);
try {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean);
  if (tracked.length) {
    const trackedReport = await inspectShareFiles(root, tracked);
    report.errors.push(...trackedReport.errors);
    report.valid = report.errors.length === 0;
  }
} catch { /* Initial local packaging can precede git init. */ }
console.log(JSON.stringify(report, null, 2));
if (!report.valid) process.exitCode = 1;
