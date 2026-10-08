import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectShareFiles, listShareFiles } from '../src/share-scan.mjs';

test('share gate rejects credentials and local runtime/configuration paths without printing their content', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'share-gate-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src'));
  const secret = 'gh' + 'p_' + 'a'.repeat(36);
  await fs.writeFile(path.join(root, 'src', 'leak.mjs'), `const secret='${secret}';`);
  const result = await inspectShareFiles(root, ['src/leak.mjs', 'data/records.json', 'config/recorder.json']);
  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 3);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('runtime files stay local while the shared source remains inspectable', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'share-gate-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'data'));
  await fs.mkdir(path.join(root, 'config'));
  await fs.writeFile(path.join(root, 'data', 'private.json'), '{}');
  await fs.writeFile(path.join(root, 'config', 'recorder.json'), '{}');
  await fs.writeFile(path.join(root, 'config', 'recorder.example.json'), '{}');
  await fs.writeFile(path.join(root, 'README.md'), '# Example');
  assert.deepEqual(await listShareFiles(root), ['README.md', 'config/recorder.example.json']);
});
