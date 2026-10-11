import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  PINNED_CORE_VERSION,
  installFixtureExtensionWindowBridge,
  parseExtensionBridgeArguments,
} from '../scripts/install-extension-window-bridge.mjs';

const snippet = '    const browser = await playwright.chromium.connectOverCDP(relay.cdpEndpoint(), { isLocal: true, timeout: 0, noDefaults: true });\n    browser.on("disconnected", () => relay.stop());';
const source = `async function createExtensionBrowser() {\n  try {\n${snippet}\n    return browser;\n  } catch (error) {\n    relay.stop();\n    throw error;\n  }\n}\n`;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function fixture(t, { coreSource = source, version = PINNED_CORE_VERSION, module = true, originalSha256 = hash(coreSource) } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-bridge-fixture-'));
  t.after(async () => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.match(path.basename(resolved), /^extension-bridge-fixture-/u);
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const coreFile = path.join(root, 'node_modules/playwright-core/lib/coreBundle.js');
  const packageFile = path.join(root, 'node_modules/playwright-core/package.json');
  const moduleFile = path.join(root, 'src/extension-window-state.mjs');
  const backupFile = path.join(root, `data/persistent-executor/extension-window-bridge/${originalSha256}.coreBundle.original`);
  await fs.mkdir(path.dirname(coreFile), { recursive: true });
  await fs.writeFile(coreFile, coreSource);
  await fs.writeFile(packageFile, JSON.stringify({ version }));
  if (module) {
    await fs.mkdir(path.dirname(moduleFile), { recursive: true });
    await fs.writeFile(moduleFile, 'export function installExtensionRecorderWindowBridge() {}\n');
  }
  return { root, coreFile, packageFile, moduleFile, backupFile, originalSha256, run: (check = false) => installFixtureExtensionWindowBridge({ root, originalSha256, check }) };
}

async function absent(filename) {
  await assert.rejects(fs.stat(filename), { code: 'ENOENT' });
}

test('check validates a fixture without creating backup directories or modifying core', async (t) => {
  const f = await fixture(t);
  const report = await f.run(true);
  assert.equal(report.installed, false);
  assert.equal(report.unchanged, false);
  assert.equal(report.version, PINNED_CORE_VERSION);
  assert.equal(report.originalSha256, f.originalSha256);
  assert.equal(report.fileCount, 3);
  assert.notEqual(report.patchedSha256, f.originalSha256);
  assert.equal(await fs.readFile(f.coreFile, 'utf8'), source);
  await absent(path.join(f.root, 'data'));
});

test('install imports only the fixed local module before registering disconnect cleanup and preserves original bytes', async (t) => {
  const f = await fixture(t);
  const report = await f.run();
  const patched = await fs.readFile(f.coreFile, 'utf8');
  const importText = `await (await import(${JSON.stringify(pathToFileURL(await fs.realpath(f.moduleFile)).href)})).installExtensionRecorderWindowBridge`;
  assert.equal(report.installed, true);
  assert.equal(report.unchanged, false);
  assert.equal(hash(patched), report.currentSha256);
  assert.equal(report.currentSha256, report.patchedSha256);
  assert.equal(patched.split(importText).length - 1, 1);
  assert.ok(patched.indexOf(importText) > patched.indexOf('await playwright.chromium.connectOverCDP'));
  assert.ok(patched.indexOf(importText) < patched.indexOf('browser.on("disconnected"'));
  assert.match(patched, /model: relay\._handler\._model, extensionId: playwrightExtensionId/u);
  assert.equal(await fs.readFile(f.backupFile, 'utf8'), source);
  assert.deepEqual(await fs.readdir(path.dirname(f.coreFile)), ['coreBundle.js']);
});

test('repeat installation and check of the same root are byte-preserving and idempotent', async (t) => {
  const f = await fixture(t);
  await f.run();
  const before = await fs.readFile(f.coreFile);
  const backup = await fs.readFile(f.backupFile);
  for (const check of [false, true]) {
    const report = await f.run(check);
    assert.equal(report.installed, false);
    assert.equal(report.unchanged, true);
    assert.deepEqual(await fs.readFile(f.coreFile), before);
    assert.deepEqual(await fs.readFile(f.backupFile), backup);
  }
});

test('a different core version refuses before any writes', async (t) => {
  const f = await fixture(t, { version: '1.64.0' });
  await assert.rejects(f.run(), /version differs/u);
  assert.equal(await fs.readFile(f.coreFile, 'utf8'), source);
  await absent(path.join(f.root, 'data'));
});

test('source drift refuses even when the insertion snippet is still present', async (t) => {
  const f = await fixture(t, { coreSource: `${source}// unexpected source change\n`, originalSha256: hash(source) });
  await assert.rejects(f.run(), /source or installed module path differs/u);
  assert.equal(await fs.readFile(f.coreFile, 'utf8'), `${source}// unexpected source change\n`);
  await absent(path.join(f.root, 'data'));
});

test('a non-unique insertion snippet refuses even with an injected fixture hash', async (t) => {
  const duplicate = source + source;
  const f = await fixture(t, { coreSource: duplicate });
  await assert.rejects(f.run(), /snippet is not unique/u);
  assert.equal(await fs.readFile(f.coreFile, 'utf8'), duplicate);
  await absent(path.join(f.root, 'data'));
});

test('a bridge copied from a different repository root is rejected without being reset', async (t) => {
  const first = await fixture(t);
  const second = await fixture(t);
  await first.run();
  const foreignPatch = await fs.readFile(first.coreFile);
  await fs.writeFile(second.coreFile, foreignPatch);
  await assert.rejects(second.run(), /source or installed module path differs/u);
  assert.deepEqual(await fs.readFile(second.coreFile), foreignPatch);
  await absent(path.join(second.root, 'data'));
});

test('additional edits to an installed bridge are rejected', async (t) => {
  const f = await fixture(t);
  await f.run();
  const altered = (await fs.readFile(f.coreFile, 'utf8')) + '// unrelated edit\n';
  await fs.writeFile(f.coreFile, altered);
  await assert.rejects(f.run(), /other source changes/u);
  assert.equal(await fs.readFile(f.coreFile, 'utf8'), altered);
  assert.equal(await fs.readFile(f.backupFile, 'utf8'), source);
});

test('a corrupt existing original backup is not overwritten', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.dirname(f.backupFile), { recursive: true });
  await fs.writeFile(f.backupFile, 'not the original core');
  await assert.rejects(f.run(), /backup is invalid/u);
  assert.equal(await fs.readFile(f.coreFile, 'utf8'), source);
  assert.equal(await fs.readFile(f.backupFile, 'utf8'), 'not the original core');
});

test('an installed bridge without a verified backup is refused', async (t) => {
  const f = await fixture(t);
  await f.run();
  const patched = await fs.readFile(f.coreFile);
  await fs.unlink(f.backupFile);
  await assert.rejects(f.run(), /no verified original backup/u);
  assert.deepEqual(await fs.readFile(f.coreFile), patched);
  await absent(f.backupFile);
});

test('missing fixed module refuses before any writes', async (t) => {
  const f = await fixture(t, { module: false });
  await assert.rejects(f.run(), /Required fixed file is unavailable: src\/extension-window-state/u);
  assert.equal(await fs.readFile(f.coreFile, 'utf8'), source);
  await absent(path.join(f.root, 'data'));
});

test('a source directory junction to another repository cannot select a foreign module', async (t) => {
  const f = await fixture(t, { module: false });
  const other = await fixture(t);
  try { await fs.symlink(path.dirname(other.moduleFile), path.dirname(f.moduleFile), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('Directory symlink permission unavailable'); return; } throw error; }
  await assert.rejects(f.run(), /resolves outside its required path/u);
  assert.equal(await fs.readFile(f.coreFile, 'utf8'), source);
  await absent(path.join(f.root, 'data'));
});

test('a backup directory junction is rejected without writing outside the repository', async (t) => {
  const f = await fixture(t);
  const other = await fixture(t);
  const external = path.join(other.root, 'backup-target');
  await fs.mkdir(external);
  try { await fs.symlink(external, path.join(f.root, 'data'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('Directory symlink permission unavailable'); return; } throw error; }
  await assert.rejects(f.run(), /fixed repository path/u);
  assert.equal(await fs.readFile(f.coreFile, 'utf8'), source);
  assert.deepEqual(await fs.readdir(external), []);
});

test('CLI supports only check or installation with no path or script overrides', () => {
  assert.deepEqual(parseExtensionBridgeArguments([]), { check: false });
  assert.deepEqual(parseExtensionBridgeArguments(['--check']), { check: true });
  for (const args of [['--root=other'], ['--module=other.mjs'], ['--check', '--check'], ['--check', '--root=other']]) {
    assert.throws(() => parseExtensionBridgeArguments(args), /paths are fixed/u);
  }
});
