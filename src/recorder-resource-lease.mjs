import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { pidAlive } from './persistent-recorder-lock.mjs';
import { writableWorkspacePath } from './recorder-config.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const keyPath = value => process.platform === 'win32' ? value.toLowerCase() : value;
const validPid = value => Number.isSafeInteger(value) && value > 0;

/** Account labels are diagnostic only: changing a label never changes a book lock. */
export function validateRecorderIsolationFields(value) {
  if (value.accountScope === undefined) return {};
  if (typeof value.accountScope !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/u.test(value.accountScope)) throw new Error('accountScope 必须是 1–80 位非敏感账号标签');
  return { accountScope: value.accountScope };
}

/** Resolve existing ancestors too, so profile aliases cannot create separate lease keys. */
export async function canonicalRuntimePath(filename) {
  const absolute = path.resolve(filename);
  let current = absolute;
  for (;;) {
    try { return path.resolve(await fs.realpath(current), path.relative(current, absolute)); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try { await fs.lstat(current); throw new Error('运行目录链接无法解析，保留资源租约'); }
      catch (statError) { if (statError.code !== 'ENOENT') throw statError; }
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

export function defaultRecorderLeaseDirectory() {
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'TextbookRecorder', 'resource-leases');
}

export async function recorderResourceIdentity(config, root, { sessionPath = 'data/persistent-executor/session.json' } = {}) {
  const canonicalRoot = await fs.realpath(root), originalSession = await writableWorkspacePath(root, sessionPath);
  const backend = config.browserBackend ?? 'extension';
  const readOnly = config.readOnly ?? false;
  if (!['extension', 'headless'].includes(backend) || typeof readOnly !== 'boolean' || !Number.isSafeInteger(config.bookId) || config.bookId < 1 || config.origin !== 'https://easylearn.baidu.com') throw new Error('资源租约需要有效的书籍和浏览器配置');
  const profileEntry = backend === 'headless' ? await writableWorkspacePath(root, path.join(config.browserProfileDir ?? `data/browser-profiles/book-${config.bookId}`, '.recorder-lease-path-check')) : null;
  const profilePath = profileEntry ? path.dirname(await canonicalRuntimePath(profileEntry)) : null;
  if (profilePath && keyPath(profilePath) === keyPath(canonicalRoot)) throw new Error('浏览器 profile 必须是项目内独立目录，不能使用项目根目录');
  const resources = [
    { kind: 'workspace', identity: keyPath(canonicalRoot) },
    { kind: 'book', identity: JSON.stringify([config.origin, config.bookId]) },
    { kind: 'browser', identity: backend === 'extension' ? 'extension:msedge:Default' : 'headless:' + keyPath(profilePath) },
  ].map(resource => ({ ...resource, key: hash(JSON.stringify([resource.kind, resource.identity])) })).sort((a, b) => a.key.localeCompare(b.key));
  return { root: canonicalRoot, sessionPath: originalSession, bookId: config.bookId, browserBackend: backend, readOnly, profilePath, ...validateRecorderIsolationFields(config), resources };
}

async function sessionSafety(identity) {
  try {
    const filename = await writableWorkspacePath(identity.root, identity.sessionPath);
    const state = JSON.parse(await fs.readFile(filename, 'utf8'));
    if (state.schemaVersion !== 1 || state.bookId !== identity.bookId || (state.readOnly ?? false) !== identity.readOnly || typeof state.writeBlocked !== 'boolean' || !Object.hasOwn(state, 'pending') || !Object.hasOwn(state, 'blockedContext')) throw new Error('原会话安全状态无效或读写身份不符');
    return { present: true, safe: state.pending === null && state.writeBlocked === false && state.blockedContext === null, pendingPid: state.pending?.servicePid };
  } catch (error) { if (error.code === 'ENOENT') return { present: false, safe: true }; throw new Error('原会话安全状态无法核对，保留全局资源租约'); }
}

/**
 * User-level leases span checkout directories. A gate is never forcibly recovered:
 * a crash during this short critical section fails closed for manual inspection.
 * A dead owner may resume only in its canonical original root and session; another
 * checkout cannot discard an unknown save by choosing another account label.
 */
export async function acquireRecorderResourceLease(config, root, { sessionPath, leaseDirectory = defaultRecorderLeaseDirectory(), alive = pidAlive, pid = process.pid } = {}) {
  if (!validPid(pid)) throw new Error('资源租约进程标识无效');
  const identity = await recorderResourceIdentity(config, root, { sessionPath });
  await fs.mkdir(leaseDirectory, { recursive: true });
  const directory = await fs.realpath(leaseDirectory), token = randomUUID();
  const filename = resource => path.join(directory, resource.key + '.json');
  const gates = async () => {
    const owned = [];
    try {
      for (const resource of identity.resources) {
        const file = path.join(directory, resource.key + '.gate');
        const handle = await fs.open(file, 'wx'); owned.push({ file, handle });
        await handle.writeFile(JSON.stringify({ schemaVersion: 1, pid, token })); await handle.sync();
      }
    } catch (error) {
      for (const gate of owned.reverse()) { await gate.handle.close(); await fs.unlink(gate.file); }
      if (error.code === 'EEXIST') throw new Error('全局资源租约正在更新或更新进程退出未确认；保留原租约，不并行接管');
      throw error;
    }
    return async () => { for (const gate of owned.reverse()) { await gate.handle.close(); await fs.unlink(gate.file); } };
  };
  const read = async resource => {
    try {
      const saved = JSON.parse(await fs.readFile(filename(resource), 'utf8'));
      if (saved.schemaVersion !== 1 || saved.kind !== 'recorder-resource-lease' || saved.resource?.key !== resource.key || saved.resource?.identity !== resource.identity || !validPid(saved.pid) || typeof saved.token !== 'string' || typeof saved.unconfirmedService !== 'boolean' || !(saved.servicePid === null || validPid(saved.servicePid)) || !['extension', 'headless'].includes(saved.browserBackend) || typeof (saved.readOnly ?? false) !== 'boolean' || !(saved.profilePath === null || typeof saved.profilePath === 'string') || typeof saved.root !== 'string' || typeof saved.sessionPath !== 'string') throw new Error('租约结构无效');
      return saved;
    } catch (error) { if (error.code === 'ENOENT') return null; throw new Error('全局资源租约无法核对；保留租约，不接管'); }
  };
  const write = async (resource, value) => {
    const temp = filename(resource) + '.' + randomUUID() + '.tmp';
    const handle = await fs.open(temp, 'wx');
    try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temp, filename(resource));
  };
  let details = { schemaVersion: 1, kind: 'recorder-resource-lease', token, pid, servicePid: null, unconfirmedService: false, root: identity.root, sessionPath: identity.sessionPath, bookId: identity.bookId, browserBackend: identity.browserBackend, readOnly: identity.readOnly, profilePath: identity.profilePath, ...(identity.accountScope ? { accountScope: identity.accountScope } : {}), createdAt: new Date().toISOString() }, released = false;
  const unlock = await gates();
  try {
    for (const resource of identity.resources) {
      const previous = await read(resource);
      if (!previous) continue;
      if (previous.unconfirmedService || alive(previous.pid) || alive(previous.servicePid)) throw new Error('书籍或浏览器资源已有执行器，禁止跨目录并行写入同一资源');
      if (keyPath(previous.root) !== keyPath(identity.root) || keyPath(previous.sessionPath) !== keyPath(identity.sessionPath) || previous.bookId !== identity.bookId) throw new Error('全局资源属于另一目录的原任务；只能回到原目录和原会话恢复，不能抢占');
      if (previous.browserBackend !== identity.browserBackend || keyPath(previous.profilePath ?? '') !== keyPath(identity.profilePath ?? '')) throw new Error('原资源租约的 browser backend/profile 已变化；保留原会话恢复，不能换浏览器接续');
      if ((previous.readOnly ?? false) !== identity.readOnly) throw new Error('原资源租约的 readOnly 模式已变化；不能在同一原会话中切换读写身份');
      const original = await sessionSafety(identity);
      if (!original.present || original.pendingPid && alive(original.pendingPid)) throw new Error('原会话或原子服务退出无法确认，保留全局资源租约');
    }
    for (const resource of identity.resources) await write(resource, { ...details, resource });
  } finally { await unlock(); }
  const update = async change => {
    if (released) throw new Error('资源租约已释放');
    const unlock = await gates();
    try {
      for (const resource of identity.resources) if ((await read(resource))?.token !== token) throw new Error('全局资源租约身份已变化，停止更新');
      details = { ...details, ...change };
      for (const resource of identity.resources) await write(resource, { ...details, resource });
    } finally { await unlock(); }
  };
  return {
    snapshot: () => ({ directory, bookId: identity.bookId, browserBackend: identity.browserBackend, readOnly: identity.readOnly, profilePath: identity.profilePath, accountScope: identity.accountScope ?? null, resources: identity.resources.map(resource => resource.kind), released }),
    markConnecting: () => update({ unconfirmedService: true }),
    updateServicePid: async servicePid => { if (!validPid(servicePid)) throw new Error('子服务PID无效'); await update({ servicePid, unconfirmedService: false }); },
    confirmNoService: async () => { if (alive(details.servicePid)) throw new Error('原浏览器子服务仍在运行，保留全局租约'); await update({ servicePid: null, unconfirmedService: false }); },
    release: async () => {
      if (released) return { released: true };
      if (details.unconfirmedService || alive(details.servicePid)) throw new Error('浏览器子服务退出未确认，保留全局资源租约');
      const original = await sessionSafety(identity);
      if (!original.safe) return { released: false, reason: 'original-session-recovery-required' };
      const unlock = await gates();
      try {
        for (const resource of identity.resources) if ((await read(resource))?.token !== token) throw new Error('全局资源租约身份已变化，禁止释放');
        for (const resource of identity.resources) await fs.unlink(filename(resource));
        released = true; return { released: true };
      } finally { await unlock(); }
    },
  };
}
