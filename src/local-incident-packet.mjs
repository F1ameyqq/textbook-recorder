import fs from 'node:fs/promises';
import path from 'node:path';
import { preparationJob, sha256, writeJobJson } from './preparation-files.mjs';

export const INCIDENT_INPUT_MAX_BYTES = 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/u.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 1000000;
const filename = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}\.json$/u.test(value);
const phases = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,79}$/u.test(value) ? value : null;
const statuses = new Set(['pending', 'writing', 'verifying', 'completed', 'stopped', 'failed', 'error', 'blocked', 'paused', 'unknown', 'supervising', 'review_required', 'skipped_existing']);
const countNames = ['pending', 'writing', 'verifying', 'completed', 'failed', 'review_required', 'skipped_existing', 'total', 'tasks', 'rounds', 'processed', 'verifiedReadbacks'];
const referenceRoles = ['records', 'index', 'plan', 'order', 'mapping', 'paired', 'conflicts', 'draft', 'decisions', 'materials', 'manifest', 'progress', 'report', 'baseline', 'crops', 'pairingConflicts', 'mappingTemplate', 'mappingBinding', 'reviewDecisions', 'reviewMaterials', 'mapping-template', 'decisions-template'];
const own = (value, key) => object(value) && Object.hasOwn(value, key);
const fail = message => { throw new Error(message); };

async function readFrozenJson(project, requested) {
  const job = await preparationJob(project, requested);
  if (!filename(path.basename(job.file))) fail('异常包输入须为明确命名的本地 JSON 文件');
  const info = await fs.lstat(job.file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > INCIDENT_INPUT_MAX_BYTES) fail('异常包输入类型或大小超限');
  if (await fs.realpath(job.file) !== job.file) fail('异常包输入链接或真实路径不一致');
  const handle = await fs.open(job.file, 'r');
  let bytes;
  try {
    const buffer = Buffer.alloc(INCIDENT_INPUT_MAX_BYTES + 1);
    let used = 0;
    for (;;) {
      const read = await handle.read(buffer, used, buffer.length - used, null);
      used += read.bytesRead;
      if (used > INCIDENT_INPUT_MAX_BYTES) fail('异常包输入类型或大小超限');
      if (!read.bytesRead) break;
    }
    const after = await handle.stat();
    if (after.size !== used || after.size !== info.size || after.mtimeMs !== info.mtimeMs) fail('异常包输入在读取期间变化');
    bytes = buffer.subarray(0, used);
  } finally { await handle.close(); }
  let value;
  try { value = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, '')); }
  catch { fail('异常包输入不是有效 JSON 对象'); }
  if (!object(value)) fail('异常包输入不是有效 JSON 对象');
  return { ...job, bytes: bytes.length, sha256: sha256(bytes), value };
}

function reportRows(report) {
  const rounds = Array.isArray(report.rounds) ? report.rounds : [];
  const steps = Array.isArray(report.steps) ? report.steps : [];
  if (rounds.length > 1000 || steps.length > 1000) fail('异常包报告条目超限');
  const lastRound = rounds.at(-1), failedStep = [...steps].reverse().find(row => object(row) && (row.ok === false || row.status === 'failed' || row.error));
  return [report, report.summary, report.result, object(report.error) ? report.error : null, report.result?.pendingWrite,
    lastRound, lastRound?.result, lastRound?.result?.pendingWrite, failedStep, failedStep?.result].filter(object);
}

function uniqueIdentity(values, valid, message) {
  const provided = values.filter(value => value !== undefined && value !== null);
  if (provided.some(value => !valid(value)) || new Set(provided).size > 1) fail(message);
  return provided[0] ?? null;
}

function taskList(value, name) {
  if (!Array.isArray(value.tasks) || value.tasks.length > 1000) fail(name + '任务清单无效');
  if (value.tasks.some(task => object(task) && task.id !== undefined && task.taskId !== undefined && task.id !== task.taskId)) fail(name + '任务身份冲突');
  const ids = value.tasks.map(task => object(task) ? task.id ?? task.taskId : undefined);
  if (ids.some(value => !id(value)) || new Set(ids).size !== ids.length) fail(name + '任务身份无效');
  return ids;
}

// Raw error prose can include whole source quotations, HTML, cookies and URLs.
// Keep fixed categories and fixed redacted text, never an excerpt of that prose.
function summarizeErrors(rows) {
  const raw = rows.flatMap(row => ['error', 'lastError', 'supervisionError', 'evidenceError', 'message'].map(key => row[key]))
    .filter(value => typeof value === 'string' && value.length);
  const text = raw.map(value => value.slice(0, 4096)).join('\n').slice(0, 16384);
  const codes = [];
  for (const [code, pattern] of [
    ['timeout', /timeout|timed?\s*out|超时/iu], ['readback', /readback|回读/iu],
    ['save', /save|保存|回执/iu], ['connection', /connect|disconnect|\bmcp\b|连接|断线/iu],
    ['identity', /identity|bookid|身份|书号/iu], ['manifest-binding', /manifest|sha256|hash|题单|哈希/iu],
    ['local-input', /enoent|json|schema|input|本地|输入|参数/iu],
  ]) if (pattern.test(text)) codes.push(code);
  return { present: raw.length > 0, classifications: codes.length ? codes : raw.length ? ['unclassified'] : [],
    summary: raw.length ? '原错误文本已脱敏省略；请在所列冻结本地证据中核对原文。' : '未提供可识别的错误文本；异常原因未知。',
    rawTextOmitted: true };
}

function declaredReferences(rows, files, baseDir) {
  const result = [], seen = new Set();
  const byFile = new Map(Object.values(files).filter(Boolean).map(file => [file.file, file]));
  const candidates = [];
  for (const row of rows) {
    for (const field of ['errorPath', 'evidencePath', 'reportPath', 'jobResultPath', 'preflightPath', 'readbackPath', 'inventoryPath', 'feedbackPath', 'receiptPath']) {
      candidates.push({ field, value: row[field], declaredSha256: field === 'receiptPath' ? row.receiptSha256 : undefined });
    }
    for (const collection of ['inputs', 'artifacts']) if (object(row[collection])) for (const role of referenceRoles) {
      const reference = row[collection][role];
      if (object(reference)) candidates.push({ field: collection + '.' + role, value: reference.path, declaredSha256: reference.sha256 });
    }
  }
  for (const { field, value, declaredSha256 } of candidates) {
    if (typeof value !== 'string' || value.length > 1024 || /[\u0000-\u001f]/u.test(value)) continue;
    const resolved = path.isAbsolute(value) ? path.resolve(value) : value.startsWith('data/') || value.startsWith('data\\') ? path.resolve(files.report.project, value) : path.resolve(baseDir, value);
    if (path.dirname(resolved) !== baseDir || !filename(path.basename(resolved))) continue;
    const hasDeclaredHash = declaredSha256 !== undefined && declaredSha256 !== null;
    if (hasDeclaredHash && !hash(declaredSha256)) fail('异常包声明证据 hash 无效');
    const supplied = byFile.get(resolved);
    if (supplied && hasDeclaredHash && declaredSha256 !== supplied.sha256) fail('异常包声明证据 hash 与明确输入不一致');
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    if (result.length < 16) result.push({ field, path: path.basename(resolved), sha256: null, read: false, verification: 'declared-only', ...(hasDeclaredHash ? { declaredSha256 } : {}) });
  }
  return result;
}

/** Inspect only caller-supplied frozen JSON. No config/session discovery or runtime actions. */
export function buildLocalIncidentPacket(files) {
  const report = files.report?.value;
  if (!object(report)) fail('必须明确提供冻结本地报告');
  const rows = reportRows(report), manifest = files.manifest?.value, progress = files.progress?.value;
  const bookId = uniqueIdentity([...rows.map(row => row.bookId), manifest?.bookId, progress?.bookId], value => Number.isSafeInteger(value) && value > 0, '异常包书号身份冲突或无效');
  let manifestTasks, progressTasks;
  if (manifest) {
    if (manifest.kind !== 'new-system-batch' || manifest.schemaVersion !== 1 || !Number.isSafeInteger(manifest.bookId) || manifest.bookId < 1) fail('异常包 manifest 身份无效');
    manifestTasks = taskList(manifest, 'manifest ');
  }
  if (progress) {
    if (progress.kind !== 'new-system-run' || progress.schemaVersion !== 1 || !id(progress.id) || !Number.isSafeInteger(progress.bookId) || progress.bookId < 1) fail('异常包 progress 身份无效');
    progressTasks = taskList(progress, 'progress ');
    if (manifestTasks && (manifestTasks.length !== progressTasks.length || manifestTasks.some((taskId, index) => taskId !== progressTasks[index]))) fail('异常包 manifest/progress 任务身份冲突');
    uniqueIdentity([...rows.map(row => row.boundRunId), progress.id], id, '异常包 progress run 身份冲突');
  }
  const declaredSha = uniqueIdentity([...rows.map(row => row.manifestSha256), progress?.manifestSha256], hash, '异常包原字节 manifest hash 冲突或无效');
  if (files.manifest && declaredSha && declaredSha !== files.manifest.sha256) fail('异常包原字节 manifest hash 不一致');
  uniqueIdentity([...rows.map(row => row.manifestHash), progress?.manifestHash], hash, '异常包运行 manifest hash 冲突或无效');
  const commandId = uniqueIdentity(rows.flatMap(row => [row.commandId ?? (typeof row.action === 'string' ? row.id : undefined), object(row.pending) ? row.pending.id : undefined]), id, '异常包命令身份冲突或无效');
  const taskIds = [...new Set(rows.flatMap(row => [row.taskId, row.phaseTaskId, object(row.task) ? row.task.id : undefined]).filter(value => value !== undefined && value !== null))];
  if (taskIds.some(value => !id(value)) || taskIds.length > 8 || manifestTasks && taskIds.some(value => !manifestTasks.includes(value)) || progressTasks && taskIds.some(value => !progressTasks.includes(value))) fail('异常包任务身份冲突或无效');
  const phase = rows.map(row => phases(row.failureStage) ?? phases(row.failedStage) ?? phases(row.phase) ?? phases(row.stage)
    ?? phases(row.failedStep) ?? (row.ok === false || row.status === 'failed' || row.error ? phases(row.step) ?? phases(row.name) : null)).find(Boolean) ?? null;
  const status = [...rows, progress].filter(object).map(row => row.status ?? row.stateStatus).find(value => statuses.has(value)) ?? 'unknown';
  const booleanOf = key => {
    const values = rows.filter(row => own(row, key)).map(row => row[key]);
    if (key === 'pending') {
      if (values.some(value => value === true || object(value))) return true;
      if (values.some(value => value === false || value === null)) return false;
    } else { if (values.includes(true)) return true; if (values.includes(false)) return false; }
    return null;
  };
  const counts = {};
  for (const name of countNames) {
    const candidate = rows.map(row => row.counts?.[name] ?? row[name]).find(count);
    if (candidate !== undefined) counts[name] = candidate;
  }
  if (progress) counts.recoveryRequiredTasks = progress.tasks.filter(task => task.recoveryRequired === true).length;
  const error = summarizeErrors(rows), pending = booleanOf('pending'), writeBlocked = booleanOf('writeBlocked');
  let nextStep;
  if (pending === true || writeBlocked === true || error.classifications.some(code => ['save', 'connection', 'readback', 'timeout'].includes(code))) {
    nextStep = { code: 'preserve-original-unknown', instruction: '保留原题单、进度、意图、回执及锁；仅调查原命令证据。冻结日志不能证明已保存、未保存或可以解锁；不要重发。' };
  } else if (report.kind === 'local-preparation-result') {
    nextStep = { code: 'inspect-local-preparation', instruction: '仅核对所列准备报告的失败步骤及明确输入；本包不批准题单，也不判断平台或运行时终态。' };
  } else {
    nextStep = { code: 'inspect-explicit-local-evidence', instruction: '仅核对所列冻结本地证据和缺失身份字段；平台保存结果未知，不据此续写、解锁或重试。' };
  }
  const evidence = Object.fromEntries(Object.entries(files).filter(([, file]) => file).map(([name, file]) => [name, { path: path.basename(file.file), sha256: file.sha256, bytes: file.bytes }]));
  return { schemaVersion: 1, kind: 'local-incident-packet', source: 'explicit-frozen-local-json', readOnly: true,
    productionChecked: false, platformWritePerformed: false, readyForExecution: false, safeToContinue: false, writeUnlocked: false, retryPerformed: false, saveOutcome: 'unknown',
    identity: { bookId, commandId, taskIds, manifestBinding: !manifest ? 'not-provided' : declaredSha ? 'raw-sha256-matched' : 'not-reported', progressBinding: !progress ? 'not-provided' : manifest ? 'local-task-identities-matched' : 'manifest-not-provided' },
    observed: { phase, status, pending, writeBlocked, counts }, error, evidence,
    declaredReferences: declaredReferences(rows, files, files.report.baseDir), nextStep };
}

export async function createLocalIncidentPacket(project, { report, manifest, progress, output }) {
  if (!report || !output) fail('异常包必须明确提供 report 和 output');
  const files = {};
  for (const [name, requested] of Object.entries({ report, manifest, progress })) if (requested !== undefined) files[name] = await readFrozenJson(project, requested);
  const baseDir = files.report.baseDir;
  if (Object.values(files).some(file => file.baseDir !== baseDir)) fail('异常包输入及输出必须位于同一 data/jobs/<job>/ 根');
  const destination = await preparationJob(project, output);
  if (destination.baseDir !== baseDir || !filename(path.basename(destination.file))) fail('异常包输入及输出必须位于同一 data/jobs/<job>/ 根');
  const packet = buildLocalIncidentPacket(files);
  for (const file of Object.values(files)) {
    const current = await readFrozenJson(project, file.file);
    if (current.sha256 !== file.sha256) fail('异常包输入在生成期间变化；不发布结果');
  }
  const written = await writeJobJson(project, destination.file, packet, baseDir);
  return { packetCreated: true, readOnly: true, productionChecked: false, saveOutcome: 'unknown', safeToContinue: false,
    bookId: packet.identity.bookId, commandId: packet.identity.commandId, phase: packet.observed.phase,
    nextStep: packet.nextStep.code, outputPath: path.relative(files.report.project, written.file).split(path.sep).join('/'), outputSha256: written.sha256 };
}
