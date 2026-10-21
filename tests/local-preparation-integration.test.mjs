import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareLocal } from '../src/local-preparation.mjs';
import { applyPreparationPatch } from '../scripts/patch-preparation.mjs';
import { createIncidentPacket } from '../scripts/create-incident-packet.mjs';
import { localFixture } from './helpers/local-preparation-fixture.mjs';

const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));

test('prepare, patch and incident work together offline without inheriting old review or changing originals', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('network is prohibited in local preparation'); });
  const f = await localFixture(t), originals = new Map();
  for (const input of [f.plan, f.index, f.records, f.order, f.mapping]) originals.set(input.file, await fs.readFile(input.file));
  const prepare = args => prepareLocal([...f.argv, ...args], { project: f.project, cwd: f.project });
  const first = await prepare([]);
  const template = await read(path.join(f.job, first.artifactPaths['mapping-template']));
  const mapping = await f.write('mapping.reviewed.v1.json', { ...template,
    placements: f.mapping.value.placements, coverage: f.mapping.value.coverage });
  const initial = await prepare([`--mapping=${mapping.file}`]);
  assert.equal(initial.stage, 'review-required');
  const initialDraft = await read(path.join(f.job, initial.artifactPaths.draft));
  const patch = await f.write('answer.patch.json', { schemaVersion: 1, kind: 'local-preparation-patch', sourceSha256: f.records.sha256,
    operations: [{ op: 'replace-text', collection: 'answers', recordId: 'a1', blockIndex: 0,
      expectedText: '合成答案甲', text: '离线修订后的合成答案甲' }] });
  const amended = await applyPreparationPatch([`--input=${f.records.file}`, `--patch=${patch.file}`, `--output=${path.join(f.job, 'records.v2.json')}`],
    { root: f.project, cwd: f.project });
  assert.equal(amended.requiresReview, true);
  const changedArgs = f.argv.map(arg => arg.startsWith('--records=') ? `--records=${amended.outputPath}` : arg);
  const stale = await prepareLocal([...changedArgs, `--mapping=${mapping.file}`], { project: f.project, cwd: f.project });
  assert.equal(stale.stage, 'blocked-input');
  const incident = await createIncidentPacket([`--report=${stale.receiptPath}`, `--output=${path.join(f.job, 'incident.json')}`], { project: f.project, cwd: f.project });
  const packet = await read(path.join(f.project, incident.outputPath));
  assert.equal(packet.observed.phase, 'mapping-binding');
  assert.equal(packet.nextStep.code, 'inspect-local-preparation');
  assert.equal(packet.saveOutcome, 'unknown');
  assert.equal(packet.safeToContinue, false);
  assert.ok(packet.declaredReferences.some(entry => entry.field === 'inputs.records' && entry.read === false));
  assert.doesNotMatch(JSON.stringify(packet), /离线修订后的合成答案甲|合成跨页题/);
  const rebuilt = await prepareLocal(changedArgs, { project: f.project, cwd: f.project });
  const newTemplate = await read(path.join(f.job, rebuilt.artifactPaths['mapping-template']));
  assert.notDeepEqual(newTemplate.sourceBinding, template.sourceBinding);
  const freshMapping = await f.write('mapping.reviewed.v2.json', { ...newTemplate,
    placements: f.mapping.value.placements, coverage: f.mapping.value.coverage });
  const finished = await prepareLocal([...changedArgs, `--mapping=${freshMapping.file}`], { project: f.project, cwd: f.project });
  const newDraft = await read(path.join(f.job, finished.artifactPaths.draft));
  assert.equal(finished.stage, 'review-required');
  assert.equal(newDraft.tasks[0].answer.blocks[0].text, '离线修订后的合成答案甲');
  for (const key of ['stem', 'answer', 'source', 'target']) assert.deepEqual(newDraft.tasks[1][key], initialDraft.tasks[1][key]);
  assert.ok(newDraft.tasks.every(task => task.review.status === 'pending' && Object.values(task.review.checks).every(value => value === false)));
  for (const [file, bytes] of originals) assert.deepEqual(await fs.readFile(file), bytes);
  assert.equal((await fs.readdir(f.job)).some(name => /approved|state|progress|\.lock$/u.test(name)), false);
});
