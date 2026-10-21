import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolvePython, runPythonTool } from '../scripts/run-python-tool.mjs';

const winRoot = 'C:\\isolated recorder';
const python = folder => path.win32.join(winRoot, folder, 'Scripts', 'python.exe');
const executable = file => ({ path: file, exists: true, isFile: true, isExecutable: true });
const pure = (tool, options = {}) => resolvePython(tool, { root: winRoot, platform: 'win32', ...options });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-python-selection-'));
  t.after(() => {
    const target = path.resolve(root), relative = path.relative(path.resolve(os.tmpdir()), target);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(target).startsWith('recorder-python-selection-'));
    fs.rmSync(target, { recursive: true, force: true });
  });
  const suffix = process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python'];
  const addPython = folder => {
    const file = path.join(root, folder, ...suffix);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'test fixture, never executed\n');
    if (process.platform !== 'win32') fs.chmodSync(file, 0o755);
    return file;
  };
  const config = value => {
    const file = path.join(root, 'config', 'python.local.json'); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file;
  };
  const calls = [], spawn = (...args) => { calls.push(args); return { status: 23 }; };
  return { root, addPython, config, calls, spawn, run: (argv, options = {}) => runPythonTool(argv, { root, env: {}, spawn, ...options }) };
}

test('pure OCR selection prioritizes its environment override over general override and local config', () => {
  const selected = python('explicit gpu');
  assert.deepEqual(pure('ocr', { env: { TEXTBOOK_RECORDER_OCR_PYTHON: selected, TEXTBOOK_RECORDER_PYTHON: 'invalid ignored' },
    ocrConfig: { invalid: true }, files: [executable(selected)] }), { python: selected, source: 'TEXTBOOK_RECORDER_OCR_PYTHON' });
});

test('general environment override precedes OCR local config and auto-detected environments', () => {
  const selected = python('general');
  assert.deepEqual(pure('ocr', { env: { TEXTBOOK_RECORDER_OCR_PYTHON: '', TEXTBOOK_RECORDER_PYTHON: selected },
    ocrConfig: { invalid: true }, files: [executable(selected), executable(python('.venv-ocr-gpu'))] }),
  { python: selected, source: 'TEXTBOOK_RECORDER_PYTHON' });
});

test('OCR local config selects an explicit validated absolute interpreter before project fallbacks', () => {
  const selected = 'D:\\already verified gpu\\Scripts\\python.exe';
  assert.deepEqual(pure('ocr', { ocrConfig: { schemaVersion: 1, ocrPython: selected },
    files: [executable(selected), executable(python('.venv-ocr-gpu'))] }), { python: selected, source: 'config/python.local.json' });
});

test('OCR project fallback order is gpu, workflow, ocr, then PATH', () => {
  for (const [folders, selected] of [[['.venv-ocr-gpu', '.venv-workflow', '.venv-ocr'], '.venv-ocr-gpu'],
    [['.venv-workflow', '.venv-ocr'], '.venv-workflow'], [['.venv-ocr'], '.venv-ocr']]) {
    assert.deepEqual(pure('ocr', { files: folders.map(folder => executable(python(folder))) }), { python: python(selected), source: selected });
  }
  assert.deepEqual(pure('ocr'), { python: 'python', source: 'PATH' });
});

test('crop preserves general-environment and original project fallback rules, ignoring all OCR settings', () => {
  const selected = python('general');
  assert.deepEqual(pure('crop', { env: { TEXTBOOK_RECORDER_OCR_PYTHON: 'ignored', TEXTBOOK_RECORDER_PYTHON: selected },
    ocrConfig: null, files: [{ ...executable(selected), isExecutable: false }] }), { python: selected, source: 'TEXTBOOK_RECORDER_PYTHON' });
  assert.deepEqual(pure('crop', { env: { TEXTBOOK_RECORDER_OCR_PYTHON: 'ignored' }, ocrConfig: { invalid: true },
    files: [executable(python('.venv-ocr-gpu')), { path: python('.venv-workflow'), exists: true }, executable(python('.venv-ocr'))] }),
  { python: python('.venv-workflow'), source: '.venv-workflow' });
  assert.deepEqual(pure('crop', { files: [executable(python('.venv-ocr'))] }), { python: python('.venv-ocr'), source: '.venv-ocr' });
  assert.deepEqual(pure('crop', { files: [executable(python('.venv-ocr-gpu'))] }), { python: 'python', source: 'PATH' });
});

test('invalid explicit overrides and local configs fail without selecting a lower-priority interpreter', () => {
  const valid = python('.venv-ocr-gpu'), files = [executable(valid)];
  for (const value of ['python', 'relative/python.exe', '', null, 5, 'C:\\bad\0python.exe']) {
    if (value === '') continue; // Empty environment values retain their old absent-value meaning.
    assert.throws(() => pure('ocr', { env: { TEXTBOOK_RECORDER_OCR_PYTHON: value }, files }), /absolute|existing/u);
  }
  for (const config of [null, [], {}, { schemaVersion: 2, ocrPython: valid }, { schemaVersion: 1, ocrPython: 'python' },
    { schemaVersion: 1, ocrPython: valid, device: 'cpu' }, { schemaVersion: 1, ocrPython: 'C:\\missing\\python.exe' }]) {
    assert.throws(() => pure('ocr', { ocrConfig: config, files }), /python.local.json/u);
  }
  for (const metadata of [{ path: valid, exists: true, isFile: false, isExecutable: false },
    { path: valid, exists: true, isFile: true, isExecutable: false }]) {
    assert.throws(() => pure('ocr', { files: [metadata] }), /executable Python file/u);
  }
});

test('POSIX selection requires execute permission for explicit OCR paths', () => {
  const file = '/verified gpu/bin/python', options = { root: '/project', platform: 'linux', env: { TEXTBOOK_RECORDER_OCR_PYTHON: file } };
  assert.equal(resolvePython('ocr', { ...options, files: [executable(file)] }).python, file);
  assert.throws(() => resolvePython('ocr', { ...options, files: [{ ...executable(file), isExecutable: false }] }), /executable Python file/u);
});

test('launcher forwards arguments exactly with shell disabled and the selected existing local interpreter', t => {
  const f = fixture(t), selected = f.addPython('verified GPU env');
  f.config({ schemaVersion: 1, ocrPython: selected });
  const args = ['--index=data/jobs/job with spaces/index.json', '--pages=1,2', '--device', 'cpu', '--output=$(do-not-run)', '--dry-run'];
  const returned = f.run(['ocr', ...args]);
  assert.equal(returned.python, selected); assert.equal(returned.result.status, 23);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0], [selected, [path.join(f.root, 'scripts', 'ocr-pages.py'), ...args],
    { cwd: f.root, stdio: 'inherit', windowsHide: true, shell: false }]);
});

test('OCR environment override never reads even malformed local config, for either environment variable', t => {
  const f = fixture(t), selected = f.addPython('selected'); f.config('{ broken JSON');
  const fileSystem = { ...fs, lstatSync: () => { throw new Error('local config must not be inspected'); }, readFileSync: () => { throw new Error('must not read config'); } };
  for (const name of ['TEXTBOOK_RECORDER_OCR_PYTHON', 'TEXTBOOK_RECORDER_PYTHON']) {
    assert.equal(f.run(['ocr', '--help'], { env: { [name]: selected }, fileSystem }).python, selected);
  }
  assert.equal(f.calls.length, 2);
});

test('crop never probes OCR config or GPU environment and stops after its first old fallback', t => {
  const f = fixture(t), selected = f.addPython('.venv-workflow'); f.config('{ broken JSON');
  const probed = [], fileSystem = { ...fs,
    lstatSync: () => { throw new Error('crop must not inspect config'); },
    readFileSync: () => { throw new Error('crop must not read OCR config'); },
    statSync: () => { throw new Error('old crop fallback only tests existence'); },
    existsSync: file => { probed.push(file); return fs.existsSync(file); } };
  assert.equal(f.run(['crop', '--plan=x', '--output=y'], { env: { TEXTBOOK_RECORDER_OCR_PYTHON: 'ignored bad path' }, fileSystem }).python, selected);
  assert.deepEqual(probed, [selected]); assert.equal(f.calls.length, 1);
});

test('malformed config, non-file config and invalid OCR interpreter prevent any child launch', t => {
  const f = fixture(t); f.addPython('.venv-ocr-gpu');
  for (const value of ['{ malformed', { schemaVersion: 1, ocrPython: path.join(f.root, 'missing.exe') },
    { schemaVersion: 1, ocrPython: f.root }, { schemaVersion: 1, ocrPython: 'python' }, { schemaVersion: 1, ocrPython: f.root, extra: true }]) {
    f.config(value); assert.throws(() => f.run(['ocr', '--dry-run']), /python.local.json/u);
  }
  const configPath = path.join(f.root, 'config', 'python.local.json'); fs.unlinkSync(configPath); fs.mkdirSync(configPath);
  assert.throws(() => f.run(['ocr']), /regular local file/u);
  assert.equal(f.calls.length, 0);
});

test('Windows OCR paths require an exe file and unknown tools cannot construct a script path', () => {
  const fakePath = 'C:\\verified\\python.txt', fileSystem = { existsSync: () => true, statSync: () => ({ isFile: () => true }) };
  let calls = 0;
  assert.throws(() => runPythonTool(['ocr'], { root: winRoot, platform: 'win32', env: { TEXTBOOK_RECORDER_OCR_PYTHON: fakePath },
    fileSystem, spawn: () => { calls++; } }), /executable Python file/u);
  for (const tool of ['../ocr-pages.py', 'cmd', undefined]) assert.throws(() => pure(tool), /fixed crop\/ocr/u);
  assert.equal(calls, 0);
});
