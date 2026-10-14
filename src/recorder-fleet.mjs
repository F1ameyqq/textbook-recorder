import fs from 'node:fs/promises';
import path from 'node:path';
import { loadRecorderConfig, existingWorkspacePath, writableWorkspacePath } from './recorder-config.mjs';
import { canonicalRuntimePath } from './recorder-resource-lease.mjs';
import { summarizeRecorderStatus } from './recorder-status-summary.mjs';
import { ensureRecorderService } from '../scripts/ensure-recorder-service.mjs';
import { safeDiagnosticMessage } from '../scripts/run-new-system-extension.mjs';

const canonicalKey = value => process.platform === 'win32' ? value.toLowerCase() : value;
const nested = (a, b) => { const relative = path.relative(a, b); return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
const keys = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));

export function validateRecorderFleet(value) {
  if (!keys(value, ['schemaVersion', 'kind', 'books', 'excludedBookIds', 'userChange']) || value.schemaVersion !== 1 || value.kind !== 'recorder-fleet' || !Array.isArray(value.books) || !value.books.length || value.books.length > 16) throw new Error('fleet 必须是 schemaVersion:1、kind:recorder-fleet，且有 1–16 个 books');
  if (value.excludedBookIds !== undefined && (!Array.isArray(value.excludedBookIds) || value.excludedBookIds.some(bookId => !Number.isSafeInteger(bookId) || bookId < 1) || new Set(value.excludedBookIds).size !== value.excludedBookIds.length)) throw new Error('excludedBookIds 必须是不重复正整数数组');
  if (value.userChange !== undefined && (typeof value.userChange !== 'string' || !value.userChange.trim() || value.userChange.length > 2000)) throw new Error('userChange 必须是简短的实际范围变更说明');
  const names = new Set();
  for (const book of value.books) {
    if (!keys(book, ['name', 'root', 'configPath', 'bookId']) || typeof book.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(book.name) || names.has(book.name) || typeof book.root !== 'string' || !path.isAbsolute(book.root) || book.root.includes('\0') || book.configPath !== undefined && (typeof book.configPath !== 'string' || !book.configPath) || book.bookId !== undefined && (!Number.isSafeInteger(book.bookId) || book.bookId < 1)) throw new Error('每本书须指定不重复 name 和明确的绝对 root，可选项目内 configPath 和正整数 bookId');
    if (value.excludedBookIds !== undefined && book.bookId === undefined) throw new Error('有明确排除范围的 fleet 须在每项声明 bookId，先核对范围再读取目录');
    if (value.excludedBookIds?.includes(book.bookId)) throw new Error('fleet 包含用户明确排除的教材，停止，不读取其目录');
    names.add(book.name);
  }
  return structuredClone(value);
}

/** Checks explicit roots only. No browser, credential file, service or filesystem mutation. */
export async function planRecorderFleet(root, fleetPath, { loadConfig = loadRecorderConfig } = {}) {
  const input = await existingWorkspacePath(root, fleetPath), fleet = validateRecorderFleet(JSON.parse(await fs.readFile(input, 'utf8')));
  const books = [];
  for (const book of fleet.books) {
    const canonicalRoot = await fs.realpath(book.root);
    if (!(await fs.stat(canonicalRoot)).isDirectory()) throw new Error('fleet root 必须是完整项目目录');
    const config = await loadConfig(canonicalRoot, book.configPath ?? 'config/recorder.json');
    if (fleet.excludedBookIds?.includes(config.bookId)) throw new Error('fleet 包含用户明确排除的教材，停止，不启动或控制其服务');
    if (book.bookId !== undefined && book.bookId !== config.bookId) throw new Error('fleet 声明的 bookId 与目录配置不符，停止');
    if (config.browserBackend !== 'headless' || config.focusMode !== 'background' || config.windowMode !== 'headless') throw new Error('多书 fleet 只允许独立 headless 浏览器；共享 Edge Default 不能并行');
    const profilePath = await canonicalRuntimePath(await writableWorkspacePath(canonicalRoot, path.join(config.browserProfileDir, '.fleet-path-check')));
    const browserProfileDir = path.dirname(profilePath);
    const sessionPath = await writableWorkspacePath(canonicalRoot, 'data/persistent-executor/session.json');
    books.push({ name: book.name, root: canonicalRoot, configPath: config.configPath ?? book.configPath ?? 'config/recorder.json', bookId: config.bookId, port: config.port, browserBackend: config.browserBackend, readOnly: config.readOnly ?? false, focusMode: config.focusMode, windowMode: config.windowMode, browserProfileDir, sessionPath, ...(config.accountScope ? { accountScope: config.accountScope } : {}) });
  }
  for (let i = 0; i < books.length; i++) for (let j = i + 1; j < books.length; j++) {
    const a = books[i], b = books[j];
    if (nested(canonicalKey(a.root), canonicalKey(b.root)) || nested(canonicalKey(b.root), canonicalKey(a.root))) throw new Error('fleet 每书项目目录必须独立，不能重复、嵌套或使用同一目录别名');
    if (a.bookId === b.bookId) throw new Error('fleet 同一本教材只能有一个写入器');
    if (a.port === b.port) throw new Error('fleet 每书本地端口必须唯一');
    if (nested(canonicalKey(a.browserProfileDir), canonicalKey(b.browserProfileDir)) || nested(canonicalKey(b.browserProfileDir), canonicalKey(a.browserProfileDir))) throw new Error('fleet 每书 browser profile 必须独立，不能重复、嵌套或使用目录别名');
  }
  return { schemaVersion: 1, kind: 'recorder-fleet-plan', fleetPath: input, localIsolationValidated: true, platformExecutionAllowed: false, ...(fleet.excludedBookIds ? { excludedBookIds: fleet.excludedBookIds } : {}), ...(fleet.userChange ? { userChange: fleet.userChange } : {}), books };
}

function selectBooks(plan, { book, all = false } = {}, required = false) {
  if (all && book !== undefined) throw new Error('--all 与 --book 不能同时使用');
  if (required && !all && book === undefined) throw new Error('start/pause 必须明确 --book=name 或 --all');
  if (book === undefined) return plan.books;
  const found = plan.books.filter(row => row.name === book || String(row.bookId) === String(book));
  if (found.length !== 1) throw new Error('--book 必须匹配一个已登记 name 或 bookId');
  return found;
}

export async function recorderFleetRequest(book, action, { fetchImpl = fetch } = {}) {
  if (!['health', 'status', 'pause'].includes(action)) throw new Error('fleet 请求仅允许本地 health、status 或 pause');
  let control;
  try { control = JSON.parse(await fs.readFile(await existingWorkspacePath(book.root, 'data/persistent-executor/control.json'), 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (action === 'pause') throw new Error('目标服务未启动；原会话和锁保留，未提交 pause');
    let state;
    try {
      state = JSON.parse(await fs.readFile(await existingWorkspacePath(book.root, book.sessionPath), 'utf8'));
      if (state.schemaVersion !== 1 || state.bookId !== book.bookId || (state.readOnly ?? false) !== (book.readOnly ?? false) || typeof state.writeBlocked !== 'boolean' || state.pending !== null && (!state.pending || typeof state.pending !== 'object') || state.writeBlocked && (!state.blockedContext || typeof state.blockedContext !== 'object')) throw new Error('原会话状态无效或 readOnly 身份不符');
    } catch (stateError) { if (stateError.code !== 'ENOENT') throw new Error('原会话无法安全核对，保留原会话和全局资源锁'); }
    return { ...summarizeRecorderStatus({ ...state, bookId: book.bookId, sessionPath: book.sessionPath, browserBackend: book.browserBackend, readOnly: book.readOnly ?? false, browserProfileDir: book.browserProfileDir, connection: 'not-started', ...(state ? { recovery: { required: state.writeBlocked, taskId: state.blockedContext?.taskId ?? null, pendingPath: state.blockedContext?.pendingPath ?? null } } : {}) }), statusSource: state ? 'local-session' : 'local-config', running: false };
  }
  if (control.schemaVersion !== 1 || control.bookId !== book.bookId || control.port !== book.port || control.sessionPath !== book.sessionPath || control.browserBackend !== 'headless' || (control.readOnly ?? false) !== (book.readOnly ?? false) || control.focusMode !== book.focusMode || control.windowMode !== book.windowMode || canonicalKey(control.browserProfileDir ?? '') !== canonicalKey(book.browserProfileDir) || !/^[a-f0-9]{64}$/u.test(control.key ?? '')) throw new Error('本地服务与 fleet 的书籍、端口、会话、readOnly 身份或 browser profile 不符，不发送控制命令');
  const health = await fetchImpl('http://127.0.0.1:' + book.port + '/health', { headers: { 'x-recorder-key': control.key, connection: 'close' }, signal: AbortSignal.timeout(3000) });
  const identity = await health.json();
  if (!health.ok || identity.bookId !== book.bookId || identity.sessionPath !== book.sessionPath || identity.browserBackend !== 'headless' || (identity.readOnly ?? false) !== (book.readOnly ?? false) || identity.focusMode !== book.focusMode || identity.windowMode !== book.windowMode || canonicalKey(identity.browserProfileDir ?? '') !== canonicalKey(book.browserProfileDir)) throw new Error('fleet 本地健康检查身份不符，不发送控制命令');
  if (action === 'health') return { ...summarizeRecorderStatus(identity), statusSource: 'local-health', running: true };
  const remoteStatus = action === 'status';
  const response = await fetchImpl('http://127.0.0.1:' + book.port + (remoteStatus ? '/status' : '/command'), { method: remoteStatus ? 'GET' : 'POST', headers: { 'x-recorder-key': control.key, connection: 'close', ...(remoteStatus ? {} : { 'Content-Type': 'application/json' }) }, ...(remoteStatus ? {} : { body: JSON.stringify({ action: 'pause', args: {} }) }), signal: AbortSignal.timeout(55000) });
  const value = await response.json();
  if (!response.ok || value.bookId !== book.bookId || value.error) throw new Error(value.error ?? 'fleet 服务控制失败，保留原任务和锁');
  return { ...summarizeRecorderStatus(value), running: true };
}

/** Fleet dispatch is deliberately limited to lazy local start, status and pause. */
export async function controlRecorderFleet(plan, action, options = {}, { ensure = ensureRecorderService, request = recorderFleetRequest } = {}) {
  if (!['start', 'status', 'pause'].includes(action)) throw new Error('fleet 只支持 start/status/pause；每书 execute/reconcile 必须沿用原 CLI 和原批准');
  const selected = selectBooks(plan, options, action !== 'status');
  const results = await Promise.allSettled(selected.map(async book => {
    const value = action === 'start' ? await ensure(book.root, { configPath: book.configPath }) : await request(book, action === 'status' && !options.remote ? 'health' : action);
    return { name: book.name, bookId: book.bookId, ...summarizeRecorderStatus(value), ...(action === 'status' ? { statusSource: value.statusSource ?? (options.remote ? 'remote-status' : 'local-health') } : {}), ...(value.running !== undefined ? { running: value.running } : {}) };
  }));
  return { schemaVersion: 1, kind: 'recorder-fleet-result', action, platformExecutionAllowed: false, ok: results.every(result => result.status === 'fulfilled'), books: results.map((result, index) => result.status === 'fulfilled' ? result.value : { name: selected[index].name, bookId: selected[index].bookId, error: safeDiagnosticMessage(result.reason?.message ?? result.reason), originalTaskPreserved: true }) };
}
