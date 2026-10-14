import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { planRecorderFleet, controlRecorderFleet, recorderFleetRequest } from '../src/recorder-fleet.mjs';
import { main } from '../scripts/recorder-fleet.mjs';
import { startRecorderService } from '../scripts/run-recorder-service.mjs';

async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'recorder-fleet-test-'));
  const cleanups = [];
  t.after(async () => { for (const cleanup of cleanups) await cleanup(); assert.equal(path.dirname(parent), path.resolve(os.tmpdir())); assert.ok(path.basename(parent).startsWith('recorder-fleet-test-')); await fs.rm(parent, { recursive: true, force: true }); });
  const roots = [path.join(parent, 'book-a'), path.join(parent, 'book-b')]; await Promise.all(roots.map(root => fs.mkdir(root)));
  const fleet = { schemaVersion: 1, kind: 'recorder-fleet', books: roots.map((root, index) => ({ name: 'book-' + (index ? 'b' : 'a'), root })) };
  const configs = new Map(roots.map((root, i) => [root, { bookId: 101 + i, port: 8791 + i, browserBackend: 'headless', focusMode: 'background', windowMode: 'headless', browserProfileDir: 'data/browser-profiles/book-' + (101 + i) }]));
  const file = path.join(parent, 'fleet.json');
  const plan = async () => { await fs.writeFile(file, JSON.stringify(fleet)); return planRecorderFleet(parent, file, { loadConfig: async root => ({ ...configs.get(root), configPath: path.join(root, 'config/recorder.json') }) }); };
  return { parent, roots, fleet, configs, file, plan, cleanups };
}
test('fleet planning validates explicit independent roots without creating profiles or runtime files', async t => {
  const f = await fixture(t), plan = await f.plan(); assert.equal(plan.localIsolationValidated, true); assert.equal(plan.platformExecutionAllowed, false);
  assert.deepEqual(plan.books.map(book => book.bookId), [101, 102]);
  assert.deepEqual(await fs.readdir(f.roots[0]), []); assert.deepEqual(await fs.readdir(f.roots[1]), []);
});
test('duplicate book, port, shared Edge and nested roots are rejected before startup', async t => {
  const f = await fixture(t), second = f.configs.get(f.roots[1]);
  second.bookId = 101; await assert.rejects(f.plan(), /同一本/u); second.bookId = 102;
  second.port = 8791; await assert.rejects(f.plan(), /端口/u); second.port = 8792;
  second.browserBackend = 'extension'; await assert.rejects(f.plan(), /Edge Default/u); second.browserBackend = 'headless';
  const nested = path.join(f.roots[0], 'child'); await fs.mkdir(nested); f.fleet.books[1].root = nested; f.configs.set(nested, second); await assert.rejects(f.plan(), /嵌套/u);
});
test('root aliases are rejected rather than treated as independent books', async t => {
  const f = await fixture(t), alias = path.join(f.parent, 'alias'); await fs.symlink(f.roots[0], alias, process.platform === 'win32' ? 'junction' : 'dir');
  f.fleet.books[1].root = alias; await assert.rejects(f.plan(), /重复|同一本/u);
});
test('explicit user exclusions are preserved and an excluded book cannot enter a fleet plan', async t => {
  const f = await fixture(t); f.fleet.books.forEach((book, index) => { book.bookId = 101 + index; }); f.fleet.excludedBookIds = [146965, 148056]; f.fleet.userChange = 'The user replaced the second book and excluded these two books.';
  const plan = await f.plan(); assert.deepEqual(plan.excludedBookIds, f.fleet.excludedBookIds); assert.equal(plan.userChange, f.fleet.userChange);
  f.fleet.books[1].bookId = 148056; f.fleet.books[1].root = path.join(f.parent, 'excluded-directory-not-present'); await assert.rejects(f.plan(), /明确排除/u);
});
test('start is explicitly selected and invokes only lazy local supervisors concurrently', async t => {
  const f = await fixture(t), plan = await f.plan(), starts = [], forbidden = async () => { throw new Error('browser/control dispatch forbidden'); };
  await assert.rejects(controlRecorderFleet(plan, 'start', {}, { ensure: forbidden }), /明确/u);
  const result = await controlRecorderFleet(plan, 'start', { all: true }, { ensure: async (root, options) => { starts.push({ root, options }); return { bookId: plan.books.find(book => book.root === root).bookId, connection: 'disconnected', writeBlocked: false }; }, request: forbidden });
  assert.equal(result.ok, true); assert.equal(starts.length, 2); assert.equal(result.platformExecutionAllowed, false); assert.ok(starts.every(row => path.isAbsolute(row.options.configPath)));
});
test('status defaults to local health, remote is explicit, and pause targets one book without unlocking', async t => {
  const f = await fixture(t), plan = await f.plan(), calls = [], request = async (book, action) => { calls.push({ name: book.name, action }); return { bookId: book.bookId, writeBlocked: true, pending: { id: 'original-command', action: 'execute' }, pauseControl: { generation: 4, paused: action === 'pause' } }; };
  const status = await controlRecorderFleet(plan, 'status', {}, { request }); assert.deepEqual(calls.map(call => call.action), ['health', 'health']); assert.ok(status.books.every(book => book.writeBlocked)); assert.ok(status.books.every(book => book.statusSource === 'local-health'));
  calls.length = 0; await controlRecorderFleet(plan, 'status', { book: 'book-a', remote: true }, { request }); assert.deepEqual(calls, [{ name: 'book-a', action: 'status' }]);
  calls.length = 0; const pause = await controlRecorderFleet(plan, 'pause', { book: '102' }, { request }); assert.deepEqual(calls, [{ name: 'book-b', action: 'pause' }]); assert.equal(pause.books[0].writeBlocked, true); assert.equal(pause.books[0].pending.id, 'original-command');
  await assert.rejects(controlRecorderFleet(plan, 'execute', { all: true }, { request }), /只支持/u);
});
test('one failed service remains visible without resubmitting or hiding other books', async t => {
  const f = await fixture(t), plan = await f.plan(), calls = [];
  const result = await controlRecorderFleet(plan, 'status', {}, { request: async book => { calls.push(book.name); if (book.name === 'book-a') throw new Error('service disconnected'); return { bookId: book.bookId, connection: 'disconnected' }; } });
  assert.equal(result.ok, false); assert.deepEqual(calls, ['book-a', 'book-b']); assert.equal(result.books[0].originalTaskPreserved, true); assert.equal(result.books[1].bookId, 102);
});
test('local health does not connect a browser and pause never forwards execute or clears unknown save', async t => {
  const f = await fixture(t), plan = await f.plan(), book = plan.books[0], key = 'a'.repeat(64), requests = [];
  const control = { schemaVersion: 1, bookId: book.bookId, port: book.port, sessionPath: book.sessionPath, browserBackend: book.browserBackend, browserProfileDir: book.browserProfileDir, focusMode: book.focusMode, windowMode: book.windowMode, key };
  const file = path.join(book.root, 'data/persistent-executor/control.json'); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(control));
  const identity = { ...control, key: undefined, connection: 'disconnected', writeBlocked: true, pending: { id: 'original-command', action: 'execute' }, pauseControl: { schemaVersion: 1, generation: 4, paused: false } };
  const fetchImpl = async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => ({ ...identity, ...(url.endsWith('/command') ? { stopRequested: true, pauseControl: { ...identity.pauseControl, generation: 5, paused: true } } : {}) }) }; };
  const health = await recorderFleetRequest(book, 'health', { fetchImpl }); assert.equal(health.writeBlocked, true); assert.equal(requests.length, 1); assert.ok(requests[0].url.endsWith('/health')); assert.ok(!JSON.stringify(health).includes(key));
  requests.length = 0; const paused = await recorderFleetRequest(book, 'pause', { fetchImpl }); assert.equal(paused.writeBlocked, true); assert.equal(paused.pending.id, 'original-command');
  assert.deepEqual(requests.map(row => new URL(row.url).pathname), ['/health', '/command']); assert.deepEqual(JSON.parse(requests[1].options.body), { action: 'pause', args: {} });
  assert.equal(await fs.readFile(file, 'utf8'), JSON.stringify(control));
});
test('health identity mismatch or stale control profile prevents any pause command', async t => {
  const f = await fixture(t), book = (await f.plan()).books[0], control = { schemaVersion: 1, ...book, key: 'b'.repeat(64) }, file = path.join(book.root, 'data/persistent-executor/control.json');
  await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(control));
  const requests = [], fetchImpl = async url => { requests.push(url); return { ok: true, json: async () => ({ ...book, bookId: 999 }) }; };
  await assert.rejects(recorderFleetRequest(book, 'pause', { fetchImpl }), /健康检查身份不符/u); assert.equal(requests.length, 1); assert.ok(requests[0].endsWith('/health'));
  control.browserProfileDir += '-wrong'; await fs.writeFile(file, JSON.stringify(control)); requests.length = 0;
  await assert.rejects(recorderFleetRequest(book, 'pause', { fetchImpl }), /profile 不符/u); assert.equal(requests.length, 0);
});
test('a read-only fleet cannot reuse writable controller, health or offline session identities', async t => {
  const f = await fixture(t); f.configs.get(f.roots[0]).readOnly = true; const book = (await f.plan()).books[0]; assert.equal(book.readOnly, true);
  const file = path.join(book.root, 'data/persistent-executor/control.json'), control = { schemaVersion: 1, ...book, readOnly: false, key: 'd'.repeat(64) }; await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(control));
  let fetches = 0; const fetchImpl = async () => { fetches++; return { ok: true, json: async () => ({ ...book, readOnly: false }) }; };
  await assert.rejects(recorderFleetRequest(book, 'health', { fetchImpl }), /readOnly 身份/u); assert.equal(fetches, 0);
  control.readOnly = true; await fs.writeFile(file, JSON.stringify(control)); await assert.rejects(recorderFleetRequest(book, 'health', { fetchImpl }), /健康检查身份/u); assert.equal(fetches, 1);
  await fs.unlink(file); await fs.writeFile(book.sessionPath, JSON.stringify({ schemaVersion: 1, bookId: book.bookId, readOnly: false, writeBlocked: false, pending: null, blockedContext: null }));
  await assert.rejects(recorderFleetRequest(book, 'health', { fetchImpl }), /原会话无法安全核对/u);
});
test('an offline book still reports its original unknown-save lock from local session', async t => {
  const f = await fixture(t), plan = await f.plan(), book = plan.books[0]; await fs.mkdir(path.dirname(book.sessionPath), { recursive: true });
  const original = { schemaVersion: 1, bookId: book.bookId, pending: { id: 'lost-result', action: 'execute' }, writeBlocked: true, blockedContext: { taskId: 'original-task', pendingPath: 'original-intent.json' }, pauseControl: { schemaVersion: 1, generation: 8, paused: true } };
  const frozen = JSON.stringify(original); await fs.writeFile(book.sessionPath, frozen);
  const result = await controlRecorderFleet(plan, 'status', { book: book.name }); assert.equal(result.ok, true); assert.equal(result.books[0].statusSource, 'local-session'); assert.equal(result.books[0].running, false);
  assert.equal(result.books[0].writeBlocked, true); assert.equal(result.books[0].pending.id, 'lost-result'); assert.equal(result.books[0].recovery.taskId, 'original-task');
  const paused = await controlRecorderFleet(plan, 'pause', { book: book.name }); assert.equal(paused.ok, false); assert.match(paused.books[0].error, /未提交 pause/u);
  assert.equal(await fs.readFile(book.sessionPath, 'utf8'), frozen);
});
test('two isolated local services aggregate health and independently pause without opening browsers', async t => {
  const f = await fixture(t), services = [], resourceLeaseDirectory = path.join(f.parent, 'global-leases');
  f.cleanups.push(async () => { for (const service of services) await service.shutdown(); });
  for (const [index, root] of f.roots.entries()) {
    await fs.mkdir(path.join(root, 'config'));
    const config = { bookId: 501 + index, port: 8791 + index, browserBackend: 'headless', browserProfileDir: 'data/browser-profiles/isolated', focusMode: 'background', windowMode: 'headless' };
    const file = path.join(root, 'config/recorder.json'); await fs.writeFile(file, JSON.stringify(config));
    const service = await startRecorderService({ root, port: 0, resourceLeaseDirectory, connect: async () => { throw new Error('The synthetic fleet must never connect a browser'); }, log: () => {} }); services.push(service);
    const control = JSON.parse(await fs.readFile(service.controlFile, 'utf8')); await fs.writeFile(file, JSON.stringify({ ...config, port: control.port }));
  }
  await fs.writeFile(f.file, JSON.stringify(f.fleet)); const plan = await planRecorderFleet(f.parent, f.file);
  services[0].session.state.writeBlocked = true; services[0].session.state.blockedContext = { taskId: 'original-task', manifest: path.join(f.roots[0], 'data/approved.json'), state: path.join(f.roots[0], 'data/run.json'), manifestSha256: 'c'.repeat(64) }; await services[0].session.persist();
  const status = await controlRecorderFleet(plan, 'status'); assert.equal(status.ok, true, JSON.stringify(status)); assert.deepEqual(status.books.map(book => book.connection), ['disconnected', 'disconnected']);
  const paused = await controlRecorderFleet(plan, 'pause', { book: 'book-a' }); assert.equal(paused.ok, true, JSON.stringify(paused)); assert.equal(paused.books[0].writeBlocked, true);
  assert.equal(services[0].session.state.pauseControl.paused, true); assert.equal(services[1].session.state.pauseControl.paused, false);
  assert.ok(services.every(service => service.session.connection === null));
  for (const service of services) await service.shutdown(); services.length = 0;
});
test('CLI cannot forward execute, start all implicitly, or connect from plan', async t => {
  let plans = 0, controls = 0;
  const plan = async () => { plans++; return { books: [] }; }, control = async () => { controls++; return {}; }, log = () => {};
  await assert.rejects(main(['execute', '--fleet=config/fleet.json'], { plan, control, log }), /用法/u);
  await assert.rejects(main(['plan', '--fleet=config/fleet.json', '--remote'], { plan, control, log }), /remote/u);
  await main(['plan', '--fleet=config/fleet.json'], { plan, control, log }); assert.equal(plans, 1); assert.equal(controls, 0);
});
