import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createDemoDiagram, createDemoManifest } from '../src/demo-batch.mjs';
import { runReviewedBatch } from '../scripts/run-reviewed-batch-service.mjs';

test('sharing CLI rejects unresolved format risks before contacting the local service', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'share-cli-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'config'));
  await fs.mkdir(path.join(root, 'data/jobs/assets'), { recursive: true });
  await fs.writeFile(path.join(root, 'config/recorder.json'), JSON.stringify({ schemaVersion: 1, bookId: 100001 }));
  await fs.writeFile(path.join(root, 'data/jobs/assets/demo-diagram.png'), createDemoDiagram());
  const manifest = createDemoManifest(); manifest.source = 'production';
  manifest.tasks[0].answer.blocks = [{ type: 'text', text: 'R=U/I' }];
  await fs.writeFile(path.join(root, 'data/jobs/batch.json'), JSON.stringify(manifest));
  let requests = 0;
  await assert.rejects(runReviewedBatch(['--action=execute', '--manifest=data/jobs/batch.json', '--state=data/jobs/progress.json'], { root, log: () => {}, request: async () => { requests++; throw new Error('must not connect'); } }), /质检/u);
  assert.equal(requests, 0);
  await assert.rejects(fs.access(path.join(root, 'data/jobs/progress.json')));
});

test('standalone connection module cannot bypass the configured sharing entrypoint', () => {
  for (const mode of ['--execute', '--verify-only']) {
    let failure;
    try { execFileSync(process.execPath, ['scripts/run-new-system-extension.mjs', '--manifest=missing.json', mode], { cwd: path.resolve('.'), encoding: 'utf8', stdio: 'pipe' }); }
    catch (error) { failure = error; }
    assert.equal(failure?.status, 1);
    assert.match(failure.stderr, /共享版浏览器操作请使用/u);
  }
});
