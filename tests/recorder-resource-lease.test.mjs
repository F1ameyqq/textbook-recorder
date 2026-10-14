import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { acquireRecorderResourceLease, recorderResourceIdentity, validateRecorderIsolationFields } from '../src/recorder-resource-lease.mjs';

async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'recorder-global-lease-test-'));
  t.after(async () => { assert.equal(path.dirname(parent), path.resolve(os.tmpdir())); assert.ok(path.basename(parent).startsWith('recorder-global-lease-test-')); await fs.rm(parent, { recursive: true, force: true }); });
  const roots = [path.join(parent, 'book-a'), path.join(parent, 'book-b')];
  await Promise.all(roots.map(root => fs.mkdir(root)));
  const leaseDirectory = path.join(parent, 'leases'), live = new Set([301, 302]);
  const config = (bookId = 101, extra = {}) => ({ bookId, origin: 'https://easylearn.baidu.com', browserBackend: 'headless', browserProfileDir: `data/browser-profiles/book-${bookId}`, ...extra });
  const acquire = (root, value, pid = 301) => acquireRecorderResourceLease(value, root, { leaseDirectory, pid, alive: pid => live.has(pid) });
  return { parent, roots, leaseDirectory, live, config, acquire };
}
async function session(root, bookId, changes = {}) {
  const file = path.join(root, 'data/persistent-executor/session.json'); await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, bookId, pending: null, writeBlocked: false, blockedContext: null, ...changes })); return file;
}

test('independent books and profiles can hold user-level leases concurrently', async t => {
  const f = await fixture(t), [a, b] = await Promise.all([f.acquire(f.roots[0], f.config(101)), f.acquire(f.roots[1], f.config(102), 302)]);
  assert.equal((await fs.readdir(f.leaseDirectory)).filter(name => name.endsWith('.json')).length, 6);
  assert.equal(a.snapshot().bookId, 101); assert.equal(b.snapshot().bookId, 102);
  assert.deepEqual(await a.release(), { released: true }); assert.deepEqual(await b.release(), { released: true });
  assert.deepEqual(await fs.readdir(f.leaseDirectory), []);
});
test('the same book remains exclusive across roots and account aliases', async t => {
  const f = await fixture(t), a = await f.acquire(f.roots[0], f.config(101, { accountScope: 'account-a' }));
  await assert.rejects(f.acquire(f.roots[1], f.config(101, { accountScope: 'account-b' }), 302), /已有执行器|正在更新/u);
  assert.equal((await fs.readdir(f.leaseDirectory)).filter(name => name.endsWith('.json')).length, 3); await a.release();
});
test('simultaneous acquisition of the same book elects exactly one writer', async t => {
  const f = await fixture(t), results = await Promise.allSettled([f.acquire(f.roots[0], f.config(), 301), f.acquire(f.roots[1], f.config(), 302)]);
  const winners = results.filter(result => result.status === 'fulfilled'); assert.equal(winners.length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1); await winners[0].value.release();
  assert.deepEqual(await fs.readdir(f.leaseDirectory), []);
});
test('direct services for different books cannot overwrite one workspace control/session', async t => {
  const f = await fixture(t), a = await f.acquire(f.roots[0], f.config(101));
  await assert.rejects(f.acquire(f.roots[0], f.config(102), 302), /已有执行器|正在更新/u);
  assert.equal((await fs.readdir(f.leaseDirectory)).filter(name => name.endsWith('.json')).length, 3); await a.release();
});
test('legacy Edge Default is exclusive even for different books and checkout directories', async t => {
  const f = await fixture(t), a = await f.acquire(f.roots[0], f.config(101, { browserBackend: 'extension' }));
  await assert.rejects(f.acquire(f.roots[1], f.config(102, { browserBackend: 'extension' }), 302), /已有执行器|正在更新/u); await a.release();
});
test('canonical root aliases cannot create a second writer', async t => {
  const f = await fixture(t), alias = path.join(f.parent, 'root-alias');
  await fs.symlink(f.roots[0], alias, process.platform === 'win32' ? 'junction' : 'dir');
  const a = await f.acquire(f.roots[0], f.config());
  const identity = await recorderResourceIdentity(f.config(), alias); assert.equal(identity.root, await fs.realpath(f.roots[0]));
  await assert.rejects(f.acquire(alias, f.config(), 302), /已有执行器|正在更新/u); await a.release();
});
test('a live child and unconfirmed connection each retain resource leases', async t => {
  const f = await fixture(t), a = await f.acquire(f.roots[0], f.config());
  await a.markConnecting(); await assert.rejects(a.release(), /退出未确认/u);
  await a.updateServicePid(401); f.live.add(401); await assert.rejects(a.confirmNoService(), /仍在运行/u);
  f.live.delete(401); await a.confirmNoService(); assert.equal((await a.release()).released, true);
});
test('unknown-save shutdown preserves global leases, only the original dead session can resume', async t => {
  const f = await fixture(t), pending = { id: 'original-command', servicePid: 401 }, blockedContext = { taskId: 'original-task' };
  const file = await session(f.roots[0], 101, { pending, writeBlocked: true, blockedContext }), frozen = await fs.readFile(file, 'utf8');
  const a = await f.acquire(f.roots[0], f.config());
  assert.deepEqual(await a.release(), { released: false, reason: 'original-session-recovery-required' });
  f.live.delete(301);
  await assert.rejects(f.acquire(f.roots[1], f.config(), 302), /另一目录|正在更新/u);
  const resumed = await f.acquire(f.roots[0], f.config(), 302);
  assert.equal(await fs.readFile(file, 'utf8'), frozen); assert.equal((await resumed.release()).released, false);
  await session(f.roots[0], 101); assert.equal((await resumed.release()).released, true);
});
test('a missing original session or a live old pending child blocks dead-owner recovery', async t => {
  const f = await fixture(t), a = await f.acquire(f.roots[0], f.config()); f.live.delete(301);
  await assert.rejects(f.acquire(f.roots[0], f.config(), 302), /原会话/u);
  await session(f.roots[0], 101, { pending: { servicePid: 401 }, writeBlocked: true, blockedContext: {} }); f.live.add(401);
  await assert.rejects(f.acquire(f.roots[0], f.config(), 302), /原会话/u);
  f.live.delete(401); await session(f.roots[0], 101); await a.release();
});
test('a dead original session cannot change browser profile or backend to bypass recovery', async t => {
  const f = await fixture(t), a = await f.acquire(f.roots[0], f.config()); await session(f.roots[0], 101, { writeBlocked: true, blockedContext: {} }); f.live.delete(301);
  await assert.rejects(f.acquire(f.roots[0], f.config(101, { browserProfileDir: 'data/browser-profiles/new-profile' }), 302), /backend\/profile/u);
  await assert.rejects(f.acquire(f.roots[0], f.config(101, { browserBackend: 'extension' }), 302), /backend\/profile/u);
  await session(f.roots[0], 101); await a.release();
});
test('read-only mode shares resource keys but cannot adopt a writable original lease/session', async t => {
  const f = await fixture(t), writeIdentity = await recorderResourceIdentity(f.config(), f.roots[0]), readIdentity = await recorderResourceIdentity(f.config(101, { readOnly: true }), f.roots[0]);
  assert.deepEqual(writeIdentity.resources, readIdentity.resources); assert.equal(readIdentity.readOnly, true);
  const a = await f.acquire(f.roots[0], f.config()); assert.equal(a.snapshot().readOnly, false); await session(f.roots[0], 101); f.live.delete(301);
  await assert.rejects(f.acquire(f.roots[0], f.config(101, { readOnly: true }), 302), /readOnly 模式/u); await a.release();
  const read = await f.acquire(f.roots[0], f.config(101, { readOnly: true }), 302); await session(f.roots[0], 101, { readOnly: true }); assert.equal(read.snapshot().readOnly, true); await read.release();
});
test('a stale gate is preserved rather than silently clearing another operation', async t => {
  const f = await fixture(t), identity = await recorderResourceIdentity(f.config(), f.roots[0]); await fs.mkdir(f.leaseDirectory);
  const gate = path.join(f.leaseDirectory, identity.resources[0].key + '.gate'); await fs.writeFile(gate, 'unconfirmed-update');
  await assert.rejects(f.acquire(f.roots[0], f.config()), /更新进程退出未确认/u); assert.equal(await fs.readFile(gate, 'utf8'), 'unconfirmed-update');
});
test('profile junctions outside the project and sensitive account labels are refused', async t => {
  const f = await fixture(t), outside = path.join(f.parent, 'user-browser'), alias = path.join(f.roots[0], 'profile'); await fs.mkdir(outside);
  await fs.symlink(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.acquire(f.roots[0], f.config(101, { browserProfileDir: 'profile' })), /项目|目录|链接/u);
  assert.throws(() => validateRecorderIsolationFields({ accountScope: 'email@example.com' }), /非敏感/u);
  assert.deepEqual(validateRecorderIsolationFields({}), {}); assert.deepEqual(await fs.readdir(outside), []);
});
