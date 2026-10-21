import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIncidentPacket } from '../scripts/create-incident-packet.mjs';
import { INCIDENT_INPUT_MAX_BYTES } from '../src/local-incident-packet.mjs';
import { sha256 } from '../src/preparation-files.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
async function fixture(t) {
  const temporary = path.join(root, 'data', 'incident-test-fixtures');
  await fs.mkdir(temporary, { recursive: true });
  const project = await fs.mkdtemp(path.join(temporary, 'case-'));
  const base = path.join(project, 'data', 'jobs', 'synthetic');
  await fs.mkdir(base, { recursive: true });
  t.after(async () => {
    const relative = path.relative(temporary, project);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(project, { recursive: true, force: true });
  });
  const write = async (name, value) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    await fs.writeFile(path.join(base, name), bytes); return bytes;
  };
  const arg = name => 'data/jobs/synthetic/' + name;
  const run = args => createIncidentPacket(args.map(([key, name]) => `--${key}=${arg(name)}`), { project, cwd: project });
  return { project, base, write, arg, run };
}
const manifest = () => ({ schemaVersion: 1, kind: 'new-system-batch', bookId: 900001, source: 'fixture', tasks: [{ id: 'q1', stem: { blocks: [{ type: 'text', text: 'PRIVATE_SOURCE_QUOTE' }] } }] });
const progress = () => ({ schemaVersion: 1, kind: 'new-system-run', bookId: 900001, id: 'run-1', manifestHash: 'a'.repeat(64), status: 'failed', tasks: [{ taskId: 'q1', status: 'failed', lastError: 'PRIVATE_PROGRESS_ERROR' }] });

test('explicit frozen inputs produce a bounded unknown incident and preserve every input and previous output', async t => {
  const f = await fixture(t), original = new Map();
  const frozen = await f.write('manifest.json', manifest()); original.set('manifest.json', frozen);
  original.set('progress.json', await f.write('progress.json', progress()));
  original.set('report.json', await f.write('report.json', { bookId: 900001, action: 'execute', commandId: 'cmd-1', boundRunId: 'run-1', taskId: 'q1', failureStage: 'source-pages', manifestSha256: sha256(frozen), manifestHash: 'a'.repeat(64), pending: { id: 'cmd-1' }, writeBlocked: true, error: 'source timeout', counts: { completed: 3, failed: 1 } }));
  const args = [['report', 'report.json'], ['manifest', 'manifest.json'], ['progress', 'progress.json'], ['output', 'incident.json']];
  const result = await f.run(args), bytes = await fs.readFile(path.join(f.base, 'incident.json')), packet = JSON.parse(bytes);
  assert.equal(result.outputSha256, sha256(bytes));
  assert.equal(packet.identity.manifestBinding, 'raw-sha256-matched');
  assert.equal(packet.identity.progressBinding, 'local-task-identities-matched');
  assert.equal(packet.observed.phase, 'source-pages');
  assert.equal(packet.observed.pending, true);
  assert.equal(packet.nextStep.code, 'preserve-original-unknown');
  for (const key of ['safeToContinue', 'writeUnlocked', 'retryPerformed', 'readyForExecution', 'platformWritePerformed', 'productionChecked']) assert.equal(packet[key], false);
  assert.equal(packet.saveOutcome, 'unknown');
  assert.ok(bytes.length < 16000);
  assert.ok(JSON.stringify(result).length < 1000);
  assert.ok(!bytes.includes(Buffer.from('PRIVATE_SOURCE_QUOTE')));
  await assert.rejects(f.run(args), /EEXIST/);
  assert.deepEqual(await fs.readFile(path.join(f.base, 'incident.json')), bytes);
  for (const [name, prior] of original) assert.deepEqual(await fs.readFile(path.join(f.base, name)), prior);
});

test('preparation failures need no manifest or progress and missing facts remain unknown', async t => {
  const f = await fixture(t);
  await f.write('report.json', { kind: 'local-preparation-result', status: 'failed', steps: [{ name: 'pair', ok: false, phase: 'pairing', error: 'JSON input invalid' }] });
  await f.run([['report', 'report.json'], ['output', 'incident.json']]);
  const packet = JSON.parse(await fs.readFile(path.join(f.base, 'incident.json')));
  assert.equal(packet.identity.bookId, null);
  assert.equal(packet.identity.commandId, null);
  assert.equal(packet.identity.manifestBinding, 'not-provided');
  assert.equal(packet.observed.pending, null);
  assert.equal(packet.observed.writeBlocked, null);
  assert.equal(packet.observed.phase, 'pairing');
  assert.equal(packet.nextStep.code, 'inspect-local-preparation');
  assert.equal(packet.safeToContinue, false);
});

test('whitelisting omits secrets, source quotes, HTML and arbitrary embedded URLs in every error field', async t => {
  const f = await fixture(t), secrets = ['COOKIE_SECRET', 'TOKEN_SECRET', 'PASSWORD_SECRET', 'SOURCE_QUOTE_SECRET', 'URL_SECRET', 'HEADER_SECRET', 'PRIVATE_PROGRESS_ERROR'];
  const raw = 'timeout cookie=COOKIE_SECRET token=TOKEN_SECRET password=PASSWORD_SECRET <p>SOURCE_QUOTE_SECRET</p> https://example.invalid/URL_SECRET';
  await f.write('report.json', { bookId: 900001, phase: 'answer-native-paste-readback', cookie: secrets[0], token: secrets[1], password: secrets[2], source: { quote: secrets[3] }, headers: { Authorization: secrets[5] }, error: raw, supervisionError: raw, result: { error: raw, html: raw, records: [{ stem: raw }] }, counts: { failed: 1, token: secrets[1], completed: 1000001 }, errorPath: 'not-supplied.json', readbackPath: 'https://example.invalid/URL_SECRET', inventoryPath: '../../config/recorder.json' });
  await f.write('progress.json', progress());
  const priorFetch = globalThis.fetch; globalThis.fetch = () => { throw new Error('NETWORK_MUST_NOT_BE_USED'); };
  t.after(() => { globalThis.fetch = priorFetch; });
  const result = await f.run([['report', 'report.json'], ['progress', 'progress.json'], ['output', 'incident.json']]);
  const text = await fs.readFile(path.join(f.base, 'incident.json'), 'utf8'), packet = JSON.parse(text);
  for (const secret of secrets) assert.ok(!text.includes(secret) && !JSON.stringify(result).includes(secret), secret);
  assert.ok(!text.includes('https://') && !text.includes('<p>'));
  assert.deepEqual(packet.observed.counts, { failed: 1, recoveryRequiredTasks: 0 });
  assert.deepEqual(packet.declaredReferences, [{ field: 'errorPath', path: 'not-supplied.json', sha256: null, read: false, verification: 'declared-only' }]);
  assert.ok(packet.error.rawTextOmitted);
});

test('never discovers real config/session or follows references from the report or manifest', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.project, 'config'));
  await fs.writeFile(path.join(f.project, 'config', 'recorder.json'), 'INVALID_REAL_CONFIG');
  await fs.mkdir(path.join(f.project, 'data', 'persistent-executor'));
  await fs.writeFile(path.join(f.project, 'data', 'persistent-executor', 'session.json'), 'INVALID_REAL_SESSION');
  await f.write('report.json', { status: 'completed', writeBlocked: false, pending: null, evidencePath: 'missing-evidence.json' });
  const m = manifest(); m.baseDir = '../../outside'; m.sourceIndex = { path: '../secret.json' };
  await f.write('manifest.json', m);
  await f.run([['report', 'report.json'], ['manifest', 'manifest.json'], ['output', 'incident.json']]);
  const packet = JSON.parse(await fs.readFile(path.join(f.base, 'incident.json')));
  assert.equal(packet.observed.status, 'completed');
  assert.equal(packet.safeToContinue, false);
  assert.equal(packet.saveOutcome, 'unknown');
  assert.equal(packet.identity.manifestBinding, 'not-reported');
  assert.equal(packet.declaredReferences[0].read, false);
});

test('rejects book, raw hash, internal hash, command, run and task identity conflicts without output', async t => {
  const f = await fixture(t), bytes = await f.write('manifest.json', manifest());
  await f.write('progress.json', progress());
  const variants = [
    { bookId: 900002 }, { manifestSha256: 'b'.repeat(64) }, { manifestSha256: 'not-a-hash' },
    { manifestHash: 'b'.repeat(64) }, { commandId: 'cmd-1', result: { commandId: 'cmd-2' } },
    { boundRunId: 'different-run' }, { taskId: 'other-task' }, { taskId: '../escape' },
    { commandId: 'cmd-1', pending: { id: 'cmd-2' } },
  ];
  for (const variant of variants) {
    await f.write('report.json', { manifestSha256: sha256(bytes), ...variant });
    await assert.rejects(f.run([['report', 'report.json'], ['manifest', 'manifest.json'], ['progress', 'progress.json'], ['output', 'incident.json']]), /冲突|身份|hash/);
    await assert.rejects(fs.stat(path.join(f.base, 'incident.json')), { code: 'ENOENT' });
  }
  const changed = progress(); changed.tasks[0].taskId = 'other-task'; await f.write('progress.json', changed);
  await f.write('report.json', {});
  await assert.rejects(f.run([['report', 'report.json'], ['manifest', 'manifest.json'], ['progress', 'progress.json'], ['output', 'incident.json']]), /任务身份冲突/);
});

test('rejects oversized files before parsing, invalid JSON, excessive entries and invalid manifest/progress shapes', async t => {
  const f = await fixture(t);
  for (const value of [Buffer.alloc(INCIDENT_INPUT_MAX_BYTES + 1, 32), Buffer.from('{not-json'), Buffer.from('[]'), { rounds: Array.from({ length: 1001 }, () => ({})) }]) {
    await f.write('report.json', value);
    await assert.rejects(f.run([['report', 'report.json'], ['output', 'incident.json']]), /大小|JSON|条目/);
  }
  await f.write('report.json', {});
  await f.write('manifest.json', { ...manifest(), tasks: [{ id: 'q1' }, { id: 'q1' }] });
  await assert.rejects(f.run([['report', 'report.json'], ['manifest', 'manifest.json'], ['output', 'incident.json']]), /任务身份/);
  await f.write('progress.json', { ...progress(), id: '../bad' });
  await assert.rejects(f.run([['report', 'report.json'], ['progress', 'progress.json'], ['output', 'incident.json']]), /progress 身份/);
});

test('rejects traversal, another job, nested files, config/session inputs and existing outputs', async t => {
  const f = await fixture(t); await f.write('report.json', {});
  await fs.mkdir(path.join(f.project, 'data', 'jobs', 'other'));
  await fs.writeFile(path.join(f.project, 'data', 'jobs', 'other', 'progress.json'), JSON.stringify(progress()));
  const context = { project: f.project, cwd: f.project };
  for (const args of [
    ['--report=../../outside.json', `--output=${f.arg('incident.json')}`],
    [`--report=${f.arg('report.json')}`, '--output=data/jobs/other/incident.json'],
    [`--report=${f.arg('report.json')}`, '--progress=data/jobs/other/progress.json', `--output=${f.arg('incident.json')}`],
    ['--report=config/recorder.json', `--output=${f.arg('incident.json')}`],
    ['--report=data/persistent-executor/session.json', `--output=${f.arg('incident.json')}`],
    [`--report=${f.arg('nested/report.json')}`, `--output=${f.arg('incident.json')}`],
  ]) await assert.rejects(createIncidentPacket(args, context), /准备文件|同一|ENOENT/);
  const prior = Buffer.from('KEEP_OLD_FILE'); await f.write('incident.json', prior);
  await assert.rejects(f.run([['report', 'report.json'], ['output', 'incident.json']]), /EEXIST/);
  assert.deepEqual(await fs.readFile(path.join(f.base, 'incident.json')), prior);
});

test('CLI optional paths are explicit and unknown/duplicate arguments never echo input secrets', async t => {
  const f = await fixture(t), context = { project: f.project, cwd: f.project };
  await assert.rejects(createIncidentPacket(['--report=TOKEN_SECRET', '--report=PASSWORD_SECRET'], context), error => /重复/.test(error.message) && !error.message.includes('SECRET'));
  await assert.rejects(createIncidentPacket(['--cookie=COOKIE_SECRET'], context), error => /未知/.test(error.message) && !error.message.includes('SECRET'));
  await assert.rejects(createIncidentPacket(['--report=x'], context), /明确提供/);
  assert.match((await createIncidentPacket(['--help'], context)).help, /\[--manifest=/);
});

test('directory junctions cannot escape the explicit job and nested error objects retain only fixed categories', async t => {
  const f = await fixture(t), other = path.join(f.project, 'frozen-outside');
  await fs.mkdir(other);
  await fs.writeFile(path.join(other, 'report.json'), JSON.stringify({ error: 'DO_NOT_READ_OUTSIDE' }));
  const linked = path.join(f.project, 'data', 'jobs', 'linked');
  await fs.symlink(other, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createIncidentPacket(['--report=data/jobs/linked/report.json', `--output=${f.arg('incident.json')}`], { project: f.project, cwd: f.project }), /越界|越出|同一/);
  await f.write('report.json', { kind: 'local-preparation-result', failedStep: 'prepare-draft', error: { message: 'password=NESTED_SECRET JSON input invalid' } });
  await f.run([['report', 'report.json'], ['output', 'incident.json']]);
  const text = await fs.readFile(path.join(f.base, 'incident.json'), 'utf8'), packet = JSON.parse(text);
  assert.equal(packet.observed.phase, 'prepare-draft');
  assert.ok(packet.error.classifications.includes('local-input'));
  assert.ok(!text.includes('NESTED_SECRET'));
});

test('preparation receipt references retain path and declared hash without opening referenced artifacts', async t => {
  const f = await fixture(t), frozen = await f.write('manifest.json', manifest());
  await f.write('report.json', { kind: 'local-preparation-result', stage: 'review-blocked', phase: 'review-decisions', failureStage: 'review-decisions',
    inputs: { manifest: { path: 'manifest.json', sha256: sha256(frozen) }, records: { path: 'not-read-records.json', sha256: 'c'.repeat(64) }, cookie: { path: 'COOKIE_SECRET.json', sha256: 'd'.repeat(64) } },
    artifacts: { reviewDecisions: { path: 'missing-decisions.json', sha256: 'b'.repeat(64) }, 'mapping-template': { path: 'mapping-template.json', sha256: 'd'.repeat(64) }, 'decisions-template': { path: 'decisions-template.json', sha256: 'e'.repeat(64) } },
    error: { code: 'LOCAL_PREPARATION_BLOCKED', message: 'input password=RECEIPT_SECRET blocked' } });
  await f.run([['report', 'report.json'], ['manifest', 'manifest.json'], ['output', 'incident.json']]);
  const text = await fs.readFile(path.join(f.base, 'incident.json'), 'utf8'), packet = JSON.parse(text);
  assert.equal(packet.observed.phase, 'review-decisions');
  assert.deepEqual(packet.declaredReferences.find(row => row.field === 'inputs.manifest'), { field: 'inputs.manifest', path: 'manifest.json', sha256: null, read: false, verification: 'declared-only', declaredSha256: sha256(frozen) });
  assert.deepEqual(packet.declaredReferences.find(row => row.field === 'inputs.records'), { field: 'inputs.records', path: 'not-read-records.json', sha256: null, read: false, verification: 'declared-only', declaredSha256: 'c'.repeat(64) });
  assert.ok(packet.declaredReferences.some(row => row.field === 'artifacts.mapping-template'));
  assert.ok(packet.declaredReferences.some(row => row.field === 'artifacts.decisions-template'));
  assert.ok(!text.includes('COOKIE_SECRET') && !text.includes('RECEIPT_SECRET'));
  await f.write('report.json', { evidencePath: 'manifest.json', inputs: { manifest: { path: 'manifest.json', sha256: 'b'.repeat(64) } } });
  await assert.rejects(f.run([['report', 'report.json'], ['manifest', 'manifest.json'], ['output', 'incident-2.json']]), /hash.*不一致/);
});
