import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertOwnedHeadlessPage } from './owned-headless-browser.mjs';
import { PLATFORM_ORIGIN, prepareRuntimeDirectory, writableWorkspacePath } from './recorder-config.mjs';

const contexts = new WeakMap();
const methods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const knownMutationPaths = new Set(['/edushop/textbook/myproducecommit/editshiti']);

/** Guard only a proven, independently launched business context. Login uses a
 * separate headed lifetime and never installs this guard. No request headers,
 * bodies, query strings, cookies, or storage are read or retained. */
export async function installReadonlyNetworkGuard(page, { root, bookId, bindingId, evidencePath }) {
  const owned = assertOwnedHeadlessPage(page), context = page.context();
  if (owned.browserBindingId !== bindingId || !Number.isSafeInteger(bookId) || bookId < 1) throw new Error('只读网络屏障的书籍或独立浏览器身份不符');
  const previous = contexts.get(context);
  if (previous) {
    if (previous.bookId !== bookId || previous.bindingId !== bindingId || previous.root !== path.resolve(root)) throw new Error('独立 context 已绑定其他只读任务');
    return previous.api;
  }
  const directory = await prepareRuntimeDirectory(root, path.join(root, 'data/persistent-executor'));
  const file = await writableWorkspacePath(root, evidencePath ?? path.join(directory, 'read-only-network-'+bindingId+'.json'));
  const records = new Map(), createdAt = new Date().toISOString();
  let revision = 0, writing = Promise.resolve(), persistenceError = null, installed = false;
  const classify = request => {
    try {
      const method = request.method(), url = new URL(request.url());
      return url.origin === PLATFORM_ORIGIN && (methods.has(method) || knownMutationPaths.has(url.pathname)) ? { method, pathname: url.pathname } : null;
    } catch { return null; }
  };
  const observe = request => {
    const identity = classify(request);
    if (!identity) return null;
    if (!records.has(request)) {
      records.set(request, { ...identity, routed: false, blocked: false, abortFailed: false, responded: false }); revision++;
    }
    return records.get(request);
  };
  const snapshot = () => {
    const requests = [...records.values()], groups = new Map();
    for (const record of requests) {
      const key = record.method + ' ' + record.pathname;
      if (!groups.has(key)) groups.set(key, { method: record.method, pathname: record.pathname, attempted: 0, blocked: 0, abortFailed: 0, responded: 0 });
      const group = groups.get(key); group.attempted++;
      if (record.blocked) group.blocked++;
      if (record.abortFailed) group.abortFailed++;
      if (record.responded) group.responded++;
    }
    const attempted = requests.length, blocked = requests.filter(value => value.blocked).length;
    const abortFailed = requests.filter(value => value.abortFailed).length, responded = requests.filter(value => value.responded).length;
    const unrouted = requests.filter(value => !value.routed).length, pending = requests.filter(value => value.routed && !value.blocked && !value.abortFailed).length;
    return { schemaVersion: 1, kind: 'textbook-read-only-network', bookId, readOnly: true, bindingId,
      installed, createdAt, capturedAt: new Date().toISOString(), revision, evidencePath: file,
      counts: { attempted, blocked, abortFailed, responded, unrouted, pending },
      zeroMutationAttempts: attempted === 0,
      allMutationAttemptsBlocked: attempted === blocked && abortFailed === 0 && responded === 0 && unrouted === 0 && pending === 0,
      endpoints: [...groups.values()].sort((a, b) => (a.method + a.pathname).localeCompare(b.method + b.pathname)),
      ...(persistenceError ? { evidenceError: 'read-only-network-evidence-write-failed' } : {}) };
  };
  const persist = () => {
    const value = snapshot();
    writing = writing.catch(() => {}).then(async () => {
      await writableWorkspacePath(root, file);
      const temporary = file + '.' + randomUUID() + '.tmp';
      await writableWorkspacePath(root, temporary);
      await fs.writeFile(temporary, JSON.stringify(value, null, 2), { flag: 'wx' });
      await writableWorkspacePath(root, file); await fs.rename(temporary, file); persistenceError = null;
    }).catch(error => { persistenceError = error; throw error; });
    return writing;
  };
  const schedule = () => { void persist().catch(() => {}); };
  const onRequest = request => { if (observe(request)) schedule(); };
  const onResponse = response => {
    const record = observe(response.request());
    if (record) { record.responded = true; revision++; schedule(); }
  };
  const route = async routing => {
    const request = routing.request(), record = observe(request);
    if (!record) return routing.fallback();
    record.routed = true; revision++;
    try { await routing.abort('blockedbyclient'); record.blocked = true; revision++; }
    catch { record.abortFailed = true; revision++; }
    await persist().catch(() => {});
  };
  context.on('request', onRequest); context.on('response', onResponse);
  await context.route('**/*', route); installed = true;
  const api = Object.freeze({ snapshot, checkpoint: async () => { await persist(); return snapshot(); } });
  contexts.set(context, { root: path.resolve(root), bookId, bindingId, api });
  await api.checkpoint();
  return api;
}

export function readonlyNetworkGuard(page, { bookId, bindingId } = {}) {
  const guard = contexts.get(page?.context?.());
  const owned = assertOwnedHeadlessPage(page);
  if (!guard || guard.bindingId !== owned.browserBindingId
      || bookId !== undefined && guard.bookId !== bookId || bindingId !== undefined && guard.bindingId !== bindingId) throw new Error('当前页面缺少同一独立 context 的只读网络屏障');
  return guard.api;
}

export function readonlyNetworkCommandEvidence(commandId, action, start, end) {
  if (!start || !end || start.bindingId !== end.bindingId || start.bookId !== end.bookId || !start.installed || !end.installed) throw new Error('只读命令网络快照身份不符');
  const delta = Object.fromEntries(Object.keys(end.counts).map(key => [key, end.counts[key] - start.counts[key]]));
  return { schemaVersion: 1, kind: 'textbook-read-only-command-network', commandId, action, bookId: end.bookId,
    bindingId: end.bindingId, readOnly: true, evidencePath: end.evidencePath, start, end, delta,
    zeroMutationAttemptsDuringCommand: delta.attempted === 0,
    allMutationAttemptsBlocked: end.allMutationAttemptsBlocked };
}
