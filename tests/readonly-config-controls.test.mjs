import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { validateRecorderConfig, loadRecorderConfig } from '../src/recorder-config.mjs';
import { prepareHeadlessProfile } from '../src/recorder-browser-profile.mjs';
import { PersistentRecorderSession } from '../src/persistent-recorder-session.mjs';
import { ensureRecorderService } from '../scripts/ensure-recorder-service.mjs';
import { recorderRequest } from '../scripts/recorder-control.mjs';
import { startRecorderService } from '../scripts/run-recorder-service.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readonly-config-control-test-')), cleanups = [];
  t.after(async () => { for (const cleanup of cleanups) await cleanup(); assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('readonly-config-control-test-')); await fs.rm(root, { recursive: true, force: true }); });
  const config = { schemaVersion: 1, bookId: 601, port: 8901, browserBackend: 'headless', browserProfileDir: 'data/browser-profiles/read-only-book', readOnly: true, focusMode: 'background', windowMode: 'headless' };
  await fs.mkdir(path.join(root, 'config')); await fs.writeFile(path.join(root, 'config/recorder.json'), JSON.stringify(config));
  const loaded = await loadRecorderConfig(root), controlPath = path.join(root, 'data/persistent-executor/control.json');
  const control = { schemaVersion: 1, bookId: loaded.bookId, pid: 90001, port: loaded.port, browserBackend: loaded.browserBackend, browserProfileDir: loaded.browserProfileDir, readOnly: true, focusMode: loaded.focusMode, windowMode: loaded.windowMode, sessionPath: path.join(await fs.realpath(root), 'data/persistent-executor/session.json'), key: 'a'.repeat(64) };
  const putControl = async value => { await fs.mkdir(path.dirname(controlPath), { recursive: true }); await fs.writeFile(controlPath, JSON.stringify(value)); };
  return { root, config, loaded, control, controlPath, putControl, cleanups };
}

test('readOnly is a typed headless-only configuration and never affects Default', () => {
  assert.throws(() => validateRecorderConfig({ bookId: 601, readOnly: true }), /headless backend/u);
  for (const readOnly of [null, 'true', 1]) assert.throws(() => validateRecorderConfig({ bookId: 601, browserBackend: 'headless', readOnly }), /布尔值/u);
  assert.equal(validateRecorderConfig({ bookId: 601, browserBackend: 'headless', readOnly: true }).readOnly, true);
  assert.equal(validateRecorderConfig({ bookId: 601 }).readOnly, undefined);
});
test('a profile mode is fixed on first registration and cannot silently switch either direction', async t => {
  const f = await fixture(t), profile = await prepareHeadlessProfile(f.loaded, f.root), marker = path.join(profile, '.recorder-profile.json'), frozen = await fs.readFile(marker, 'utf8');
  assert.equal(JSON.parse(frozen).readOnly, true);
  await assert.rejects(prepareHeadlessProfile({ ...f.loaded, readOnly: false }, f.root), /readOnly 模式/u); assert.equal(await fs.readFile(marker, 'utf8'), frozen);
  const writable = { ...f.loaded, readOnly: false, browserProfileDir: path.join(f.root, 'data/browser-profiles/write-book') }, writeProfile = await prepareHeadlessProfile(writable, f.root), writeMarker = path.join(writeProfile, '.recorder-profile.json'), original = await fs.readFile(writeMarker, 'utf8');
  await assert.rejects(prepareHeadlessProfile({ ...writable, readOnly: true }, f.root), /readOnly 模式/u); assert.equal(await fs.readFile(writeMarker, 'utf8'), original);
});
test('ensure rejects a writable control or health identity before spawning or reconnecting', async t => {
  const f = await fixture(t); let fetches = 0, spawns = 0;
  const options = { alive: () => true, spawnProcess: () => { spawns++; throw new Error('A second supervisor must not be spawned'); }, fetchImpl: async () => { fetches++; return { ok: true, json: async () => ({ ...f.control, readOnly: false, connection: 'disconnected' }) }; } };
  await f.putControl({ ...f.control, readOnly: false }); await assert.rejects(ensureRecorderService(f.root, options), /readOnly 模式/u); assert.equal(fetches, 0); assert.equal(spawns, 0);
  await f.putControl(f.control); await assert.rejects(ensureRecorderService(f.root, options), /readOnly 模式/u); assert.equal(fetches, 1); assert.equal(spawns, 0);
});
test('controller rejects writable control/service identity and prohibited actions without dispatch', async t => {
  const f = await fixture(t); let fetches = 0;
  const options = { fetchImpl: async () => { fetches++; return { ok: true, json: async () => ({ ...f.control, readOnly: false }) }; } };
  await f.putControl({ ...f.control, readOnly: false }); await assert.rejects(recorderRequest(f.root, { action: 'status' }, options), /readOnly 模式/u); assert.equal(fetches, 0);
  await f.putControl(f.control); await assert.rejects(recorderRequest(f.root, { action: 'status' }, options), /readOnly 模式/u); assert.equal(fetches, 1);
  const execute = { action: 'execute', args: { manifest: 'data/missing-approved.json', state: 'data/original-state.json' } };
  const repair = { action: 'complete-record-repair', args: { ...execute.args, taskId: 'original-task', pendingPath: 'data/original-intent.json' } };
  for (const command of [execute, repair]) await assert.rejects(recorderRequest(f.root, command, options), /readOnly controller/u);
  assert.equal(fetches, 1);
});
test('a cold local service rejects raw execute/record repair commands with zero browser connections', async t => {
  const f = await fixture(t); let connects = 0;
  const service = await startRecorderService({ root: f.root, port: 0, resourceLeaseDirectory: path.join(f.root, 'test-global-leases'), connect: async () => { connects++; throw new Error('Read-only rejection must happen before browser connection'); }, log: () => {} });
  f.cleanups.push(() => service.shutdown()); const control = JSON.parse(await fs.readFile(service.controlFile, 'utf8'));
  assert.equal(service.session.snapshot().readOnly, true);
  const commands = [{ action: 'execute', args: { manifest: 'data/missing-approved.json', state: 'data/original-state.json' } }, { action: 'complete-record-repair', args: { manifest: 'data/missing-approved.json', state: 'data/original-state.json', taskId: 'original-task', pendingPath: 'data/original-intent.json' } }];
  for (const command of commands) {
    const response = await fetch('http://127.0.0.1:' + control.port + '/command', { method: 'POST', headers: { 'x-recorder-key': control.key, 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
    assert.equal(response.status, 409); const value = await response.json(); assert.match(value.error, /readOnly 服务/u); assert.equal(value.status.connection, 'disconnected'); assert.equal(value.status.pending, null);
  }
  assert.equal(connects, 0); assert.equal(service.session.connection, null); assert.equal(service.session.state.writeBlocked, false);
});
test('a read-only session cannot adopt or mutate a writable original session', async t => {
  const f = await fixture(t), statePath = f.control.sessionPath;
  const original = { schemaVersion: 1, bookId: f.loaded.bookId, browserBackend: 'headless', browserProfileDir: f.loaded.browserProfileDir, readOnly: false, pending: null, writeBlocked: false, blockedContext: null, last: null, seenIds: [], connectionCount: 0, pauseControl: { schemaVersion: 1, generation: 2, paused: true } };
  await fs.mkdir(path.dirname(statePath), { recursive: true }); const frozen = JSON.stringify(original); await fs.writeFile(statePath, frozen);
  let connects = 0; const session = new PersistentRecorderSession({ ...f.loaded, root: f.root, connect: async () => { connects++; throw new Error('Identity mismatch must not connect'); } });
  assert.equal(session.browserBackend, original.browserBackend); assert.equal(session.browserProfileDir, original.browserProfileDir);
  await assert.rejects(session.initialize(), /readOnly|backend\/profile/u); assert.equal(connects, 0); assert.equal(await fs.readFile(statePath, 'utf8'), frozen);
});
