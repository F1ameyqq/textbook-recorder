import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PINNED_CORE_VERSION = '1.64.0-alpha-1790635538000';
export const PINNED_CORE_SHA256 = 'cd6730be1bbcff00771a0fc1390f200306d28428ce68e305420ca623cb39cdeb';
const defaultRoot = fileURLToPath(new URL('../', import.meta.url));
const originalSnippet = '    const browser = await playwright.chromium.connectOverCDP(relay.cdpEndpoint(), { isLocal: true, timeout: 0, noDefaults: true });\n    browser.on("disconnected", () => relay.stop());';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const occurrences = (source, snippet) => source.split(snippet).length - 1;
const samePath = (left, right) => path.relative(left, right) === '';

export function parseExtensionBridgeArguments(args) {
  if (args.length === 0) return { check: false };
  if (args.length === 1 && args[0] === '--check') return { check: true };
  throw new Error('Only --check is supported; repository and module paths are fixed');
}

async function fixedFile(root, relativePath) {
  const expected = path.join(root, ...relativePath.split('/'));
  let actual, stat;
  try { actual = await fs.realpath(expected); stat = await fs.stat(actual); }
  catch { throw new Error(`Required fixed file is unavailable: ${relativePath}`); }
  if (!samePath(actual, expected) || !stat.isFile()) throw new Error(`Fixed file resolves outside its required path: ${relativePath}`);
  return actual;
}

async function backupDirectory(root, create) {
  let current = root;
  for (const part of ['data', 'persistent-executor', 'extension-window-bridge']) {
    current = path.join(current, part);
    if (create) {
      try { await fs.mkdir(current); }
      catch (error) { if (error.code !== 'EEXIST') throw new Error('Backup directory could not be created'); }
    }
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) { if (!create && error.code === 'ENOENT') return undefined; throw new Error('Backup directory is unavailable'); }
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await fs.realpath(current), current)) {
      throw new Error('Backup directory must remain inside the fixed repository path');
    }
  }
  return current;
}

async function inspectBackup(root, originalHash) {
  const directory = await backupDirectory(root, false);
  if (!directory) return undefined;
  const filename = path.join(directory, `${originalHash}.coreBundle.original`);
  try {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || !samePath(await fs.realpath(filename), filename)) throw new Error('Invalid backup file');
    const bytes = await fs.readFile(filename);
    if (hash(bytes) !== originalHash) throw new Error('Original core backup hash does not match');
    return filename;
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new Error('Original core backup is invalid; no files were reset');
  }
}

async function runInstaller({ root: requestedRoot, pinnedVersion, originalHash, check }) {
  const root = await fs.realpath(requestedRoot);
  const packageFile = await fixedFile(root, 'node_modules/playwright-core/package.json');
  const coreFile = await fixedFile(root, 'node_modules/playwright-core/lib/coreBundle.js');
  const moduleFile = await fixedFile(root, 'src/extension-window-state.mjs');
  let version;
  try { version = JSON.parse(await fs.readFile(packageFile, 'utf8')).version; }
  catch { throw new Error('Core package metadata is invalid'); }
  if (version !== pinnedVersion) throw new Error('Core version differs from the pinned version');
  const bytes = await fs.readFile(coreFile);
  const source = bytes.toString('utf8');
  if (!Buffer.from(source, 'utf8').equals(bytes)) throw new Error('Core source is not canonical UTF-8');
  const moduleUrl = pathToFileURL(moduleFile).href;
  const patchedSnippet = originalSnippet.replace('\n    browser.on', `\n    await (await import(${JSON.stringify(moduleUrl)})).installExtensionRecorderWindowBridge({ browser, model: relay._handler._model, extensionId: playwrightExtensionId });\n    browser.on`);
  const currentHash = hash(bytes);
  let originalBytes, patchedBytes, unchanged = false;
  if (currentHash === originalHash) {
    if (occurrences(source, originalSnippet) !== 1) throw new Error('Pinned insertion snippet is not unique');
    originalBytes = bytes;
    patchedBytes = Buffer.from(source.replace(originalSnippet, patchedSnippet), 'utf8');
  } else {
    if (occurrences(source, patchedSnippet) !== 1) throw new Error('Core source or installed module path differs from the pinned bridge');
    const restored = source.replace(patchedSnippet, originalSnippet);
    originalBytes = Buffer.from(restored, 'utf8');
    if (hash(originalBytes) !== originalHash || occurrences(restored, originalSnippet) !== 1) throw new Error('Patched core contains other source changes');
    patchedBytes = Buffer.from(restored.replace(originalSnippet, patchedSnippet), 'utf8');
    if (!patchedBytes.equals(bytes)) throw new Error('Installed bridge source is not canonical');
    unchanged = true;
  }
  const existingBackup = await inspectBackup(root, originalHash);
  if (unchanged && !existingBackup) throw new Error('Installed bridge has no verified original backup');
  const report = { installed: false, unchanged, checked: true, version, originalSha256: originalHash, currentSha256: currentHash, patchedSha256: hash(patchedBytes), fileCount: 3 };
  if (check || unchanged) return report;
  const directory = await backupDirectory(root, true);
  const backupFile = path.join(directory, `${originalHash}.coreBundle.original`);
  try { await fs.writeFile(backupFile, originalBytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST' || !(await inspectBackup(root, originalHash))) throw new Error('Original core backup could not be preserved');
  }
  if (!samePath(await fs.realpath(coreFile), coreFile) || !(await fs.readFile(coreFile)).equals(originalBytes)) throw new Error('Core changed before installation');
  const temporary = `${coreFile}.recorder-window-bridge-${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, patchedBytes, { flag: 'wx', mode: (await fs.stat(coreFile)).mode });
    if (!(await fs.readFile(coreFile)).equals(originalBytes)) throw new Error('Core changed before replacement');
    await fs.rename(temporary, coreFile);
  } finally {
    try { await fs.unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw new Error('Temporary core cleanup failed'); }
  }
  if (hash(await fs.readFile(coreFile)) !== report.patchedSha256) throw new Error('Installed core verification failed');
  return { ...report, installed: true, currentSha256: report.patchedSha256 };
}

export function installExtensionWindowBridge({ check = false } = {}) {
  return runInstaller({ root: defaultRoot, pinnedVersion: PINNED_CORE_VERSION, originalHash: PINNED_CORE_SHA256, check });
}

// Tests use a disposable repository tree; the executable CLI accepts no path overrides.
export function installFixtureExtensionWindowBridge({ root, originalSha256, pinnedVersion = PINNED_CORE_VERSION, check = false }) {
  if (!/^[a-f0-9]{64}$/u.test(originalSha256)) throw new Error('Fixture original hash is invalid');
  return runInstaller({ root, pinnedVersion, originalHash: originalSha256, check });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { console.log(JSON.stringify(await installExtensionWindowBridge(parseExtensionBridgeArguments(process.argv.slice(2))))); }
  catch (error) { console.error(`Extension window bridge installation refused: ${error.message}`); process.exitCode = 1; }
}
