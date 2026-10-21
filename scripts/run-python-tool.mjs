import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const names = { crop: 'crop_sources.py', ocr: 'ocr-pages.py' };
const present = value => value !== undefined && value !== '';
const pathApi = platform => platform === 'win32' ? path.win32 : path.posix;

function assertTool(tool) {
  if (!Object.hasOwn(names, tool)) throw new Error('Only the fixed crop/ocr tools can run');
}

function explicitEnvironment(tool, env) {
  if (tool === 'ocr' && present(env.TEXTBOOK_RECORDER_OCR_PYTHON)) return { python: env.TEXTBOOK_RECORDER_OCR_PYTHON, source: 'TEXTBOOK_RECORDER_OCR_PYTHON' };
  if (present(env.TEXTBOOK_RECORDER_PYTHON)) return { python: env.TEXTBOOK_RECORDER_PYTHON, source: 'TEXTBOOK_RECORDER_PYTHON' };
  return null;
}

function absolutePython(python, source, platform) {
  if (typeof python !== 'string' || !python || python.includes('\0') || !pathApi(platform).isAbsolute(python)) {
    throw new Error(source + ' must be an explicit absolute Python executable path');
  }
}

function localPython(config, platform) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || config.schemaVersion !== 1
      || Object.keys(config).some(key => !['schemaVersion', 'ocrPython'].includes(key))) {
    throw new Error('config/python.local.json must contain only schemaVersion:1 and ocrPython');
  }
  absolutePython(config.ocrPython, 'config/python.local.json ocrPython', platform);
  return config.ocrPython;
}

function candidatePaths(tool, root, platform) {
  const api = pathApi(platform), suffix = platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python'];
  const folders = tool === 'ocr' ? ['.venv-ocr-gpu', '.venv-workflow', '.venv-ocr'] : ['.venv-workflow', '.venv-ocr'];
  return folders.map(folder => ({ python: api.join(root, folder, ...suffix), source: folder }));
}

/** Pure selection over caller-supplied file metadata. It performs no reads or execution. */
export function resolvePython(tool, { root = projectRoot, env = {}, platform = process.platform, ocrConfig, files = [] } = {}) {
  assertTool(tool);
  const api = pathApi(platform), key = file => platform === 'win32' ? api.normalize(file).toLowerCase() : api.normalize(file);
  const state = file => files.find(item => key(item.path) === key(file));
  const verify = (selection, strictExecutable) => {
    absolutePython(selection.python, selection.source, platform);
    const metadata = state(selection.python);
    if (!metadata?.exists || !metadata.isFile || strictExecutable && !metadata.isExecutable) {
      throw new Error(selection.source + ' must name an existing ' + (strictExecutable ? 'executable Python file' : 'Python file'));
    }
    return selection;
  };
  const explicit = explicitEnvironment(tool, env);
  if (explicit) return verify(explicit, tool === 'ocr');
  if (tool === 'ocr' && ocrConfig !== undefined) {
    return verify({ python: localPython(ocrConfig, platform), source: 'config/python.local.json' }, true);
  }
  for (const selection of candidatePaths(tool, root, platform)) {
    if (!state(selection.python)?.exists) continue;
    // Crop retains its original existence-based project fallback and does not read OCR config.
    return tool === 'ocr' ? verify(selection, true) : selection;
  }
  return { python: 'python', source: 'PATH' };
}

function inspectPython(file, platform, fileSystem) {
  const metadata = { path: file, exists: fileSystem.existsSync(file), isFile: false, isExecutable: false };
  if (!metadata.exists) return metadata;
  metadata.isFile = fileSystem.statSync(file).isFile();
  if (metadata.isFile) {
    if (platform === 'win32') metadata.isExecutable = path.win32.extname(file).toLowerCase() === '.exe';
    else {
      try { fileSystem.accessSync(file, fs.constants.X_OK); metadata.isExecutable = true; }
      catch { /* Selected OCR interpreters without execute permission fail explicitly. */ }
    }
  }
  return metadata;
}

function readLocalConfig(root, fileSystem) {
  const file = path.join(root, 'config', 'python.local.json');
  let info;
  try { info = fileSystem.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('config/python.local.json must be a regular local file');
  const actual = fileSystem.realpathSync(file), actualRoot = fileSystem.realpathSync(root), relative = path.relative(actualRoot, actual);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('config/python.local.json must remain within the project');
  try { return JSON.parse(fileSystem.readFileSync(actual, 'utf8').replace(/^\uFEFF/u, '')); }
  catch (error) { throw new Error('Cannot read config/python.local.json: ' + error.message); }
}

export function runPythonTool(argv, { root = projectRoot, env = process.env, platform = process.platform, fileSystem = fs, spawn = spawnSync } = {}) {
  const [tool, ...args] = argv;
  assertTool(tool);
  if (args.some(arg => typeof arg !== 'string')) throw new Error('Python tool arguments must be strings');
  const explicit = explicitEnvironment(tool, env);
  let ocrConfig, files;
  if (explicit) {
    absolutePython(explicit.python, explicit.source, platform);
    files = [inspectPython(explicit.python, platform, fileSystem)];
  } else {
    // This branch is never entered for crop config, or when either OCR environment override is explicit.
    if (tool === 'ocr') ocrConfig = readLocalConfig(root, fileSystem);
    if (ocrConfig !== undefined) files = [inspectPython(localPython(ocrConfig, platform), platform, fileSystem)];
    else {
      files = [];
      for (const item of candidatePaths(tool, root, platform)) {
        const metadata = tool === 'crop' ? { path: item.python, exists: fileSystem.existsSync(item.python) }
          : inspectPython(item.python, platform, fileSystem);
        files.push(metadata);
        if (metadata.exists) break;
      }
    }
  }
  const selection = resolvePython(tool, { root, env, platform, ocrConfig, files });
  const result = spawn(selection.python, [path.join(root, 'scripts', names[tool]), ...args], {
    cwd: root, stdio: 'inherit', windowsHide: true, shell: false,
  });
  return { ...selection, result };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { result } = runPythonTool(process.argv.slice(2));
    if (result.error) console.error(result.error.message);
    process.exitCode = result.status ?? 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
