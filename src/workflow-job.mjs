import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { preparationJob, readJobJson, writeJobJson, sha256 } from './preparation-files.mjs';
import { existingWorkspacePath, writableWorkspacePath, loadRecorderConfig } from './recorder-config.mjs';
import { inspectReviewedBatch } from './review-preflight.mjs';
import { approveReviewedDraft } from './review-approval.mjs';
import { createNewSystemRun } from './new-system-core.mjs';
import { rasterDimensions } from './draft-batch.mjs';

export const WORKFLOW_ROLES = Object.freeze(['index', 'baseline', 'records', 'paired', 'mapping', 'draft', 'decisions', 'approved', 'state']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const positive = value => Number.isSafeInteger(value) && value > 0;
const hashString = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const inside = (root, file) => { const relative = path.relative(root, file); return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
const snapshotName = version => version === 0 ? 'job.json' : `job.v${String(version).padStart(4, '0')}.json`;
const sectionKey = value => JSON.stringify([value.chapterLabel, value.sectionLabel]);
const done = new Set(['completed', 'skipped_existing']);
const entryStatuses = new Set(['pending', 'writing', 'verifying', 'completed', 'skipped_existing', 'review_required', 'failed']);
const runUncertainty = value => value?.kind === 'new-system-run' && (!Array.isArray(value.tasks)
  || value.tasks.some(entry => !object(entry) || entry.recoveryRequired !== false || ['writing', 'verifying'].includes(entry.status)));

/** This stores supplied scope/evidence only; it neither creates nor grants authorization. */
export function validateWorkflowPlan(plan) {
  if (!object(plan) || plan.schemaVersion !== 1 || plan.kind !== 'local-workflow-plan' || !positive(plan.bookId)
      || !['fixture', 'production'].includes(plan.source) || !object(plan.scope)
      || Object.keys(plan).some(key => !['schemaVersion', 'kind', 'bookId', 'source', 'scope', 'authorizationEvidence'].includes(key))) {
    throw new Error('plan 必须明确 schemaVersion:1、kind:local-workflow-plan、bookId、source 和 scope');
  }
  const { pages, sections } = plan.scope;
  if (Object.keys(plan.scope).some(key => !['pages', 'sections'].includes(key)) || pages === undefined && sections === undefined) throw new Error('scope 须明确来源 pages 和/或目录 sections');
  if (pages !== undefined && (!Array.isArray(pages) || !pages.length || pages.some(page => !positive(page)) || new Set(pages).size !== pages.length)) throw new Error('scope.pages 须为非空、不重复正整数数组');
  if (sections !== undefined) {
    const keys = new Set();
    if (!Array.isArray(sections) || !sections.length) throw new Error('scope.sections 不能为空');
    for (const section of sections) {
      if (!object(section) || !nonempty(section.chapterLabel) || !nonempty(section.sectionLabel) || !positive(section.startRecord)
          || section.recordLimit !== undefined && !positive(section.recordLimit)
          || Object.keys(section).some(key => !['chapterLabel', 'sectionLabel', 'startRecord', 'recordLimit'].includes(key))
          || keys.has(sectionKey(section))) throw new Error('scope.sections 须有精确目录标签、startRecord、可选 recordLimit，且目录不能重复');
      keys.add(sectionKey(section));
    }
  }
  if (plan.authorizationEvidence !== undefined && (!object(plan.authorizationEvidence) || !nonempty(plan.authorizationEvidence.userQuote)
      || !nonempty(plan.authorizationEvidence.evidenceReference) || Object.keys(plan.authorizationEvidence).some(key => !['userQuote', 'evidenceReference'].includes(key)))) {
    throw new Error('authorizationEvidence 只保留实际 userQuote 与 evidenceReference；本地文件不是执行许可');
  }
  return structuredClone(plan);
}

async function directory(root, job, create = false) {
  if (!nonempty(job)) throw new Error('必须明确 --job=data/jobs/<job>');
  return preparationJob(root, path.join(job, 'job.json'), { create });
}

function validReference(reference) {
  return object(reference) && nonempty(reference.path) && !path.isAbsolute(reference.path)
    && path.basename(reference.path) === reference.path && !reference.path.includes('\0') && hashString(reference.sha256);
}

async function readReference(context, reference) {
  if (!validReference(reference)) throw new Error('登记引用须为同 job 根目录文件名和精确 SHA256');
  const result = await readJobJson(context.project, path.join(context.baseDir, reference.path));
  if (result.baseDir !== context.baseDir) throw new Error('登记引用越出同一 job');
  return result;
}

/** Snapshot history is append-only, with each snapshot bound to its exact predecessor bytes. */
async function loadJob(root, job) {
  const context = await directory(root, job);
  const names = (await fs.readdir(context.baseDir)).filter(name => /^job\.v\d{4,}\.json$/u.test(name));
  const versions = names.map(name => Number(name.match(/^job\.v(\d+)\.json$/u)[1])).sort((a, b) => a - b);
  if (versions.some((version, index) => version !== index + 1) || names.some(name => name !== snapshotName(Number(name.match(/^job\.v(\d+)\.json$/u)[1])))) throw new Error('job 注册版本不连续或文件名无效；保留材料并检查');
  let current = await readJobJson(context.project, context.file);
  const initial = current.value;
  if (!object(initial) || initial.kind !== 'local-workflow-job' || initial.schemaVersion !== 1 || initial.version !== 0
      || initial.job !== path.basename(context.baseDir) || !object(initial.references) || Object.keys(initial.references).length) throw new Error('job.json 初始快照无效');
  const plan = validateWorkflowPlan(initial.plan);
  const planInput = await readReference(context, initial.planFile);
  if (planInput.sha256 !== initial.planFile.sha256 || !isDeepStrictEqual(planInput.value, plan)) throw new Error('原 plan 文件 SHA256 或内容已变化；保留任务范围快照');
  for (const version of versions) {
    const next = await readJobJson(context.project, path.join(context.baseDir, snapshotName(version)));
    const value = next.value;
    if (!object(value) || value.kind !== initial.kind || value.schemaVersion !== 1 || value.job !== initial.job || value.version !== version
        || !isDeepStrictEqual(value.plan, plan) || !isDeepStrictEqual(value.planFile, initial.planFile) || !isDeepStrictEqual(value.previous, { path: path.basename(current.file), sha256: current.sha256 })
        || !object(value.references) || Object.keys(value.references).some(role => !WORKFLOW_ROLES.includes(role) || !validReference(value.references[role]))) {
      throw new Error('job 注册快照或前版 SHA256 不一致；不会推断或修复阶段');
    }
    current = next;
  }
  return { ...context, plan, snapshot: current.value, snapshotPath: current.file, snapshotSha256: current.sha256 };
}

function assertArtifact(role, value, plan) {
  if (!object(value)) throw new Error(`${role} 必须是 JSON 对象`);
  if (role === 'decisions') {
    if (value.schemaVersion !== 1 || !hashString(value.manifestSha256) || !Array.isArray(value.tasks)) throw new Error('decisions 不是绑定草稿哈希的审校决定');
    return;
  }
  if (value.bookId !== plan.bookId || role !== 'baseline' && value.schemaVersion !== 1 || value.source !== undefined && value.source !== plan.source) throw new Error(`${role} 版本、bookId 或 source 与 plan 不一致`);
  const expectedKind = { paired: 'paired-batch', mapping: 'new-system-draft-mapping', draft: 'new-system-batch', approved: 'new-system-batch', state: 'new-system-run' }[role];
  if (expectedKind && value.kind !== expectedKind) throw new Error(`${role}.kind 必须是 ${expectedKind}`);
  if (['mapping', 'draft', 'approved', 'state'].includes(role) && value.source !== plan.source) throw new Error(`${role}.source 必须与 plan 一致`);
  if (role === 'index' && (!Array.isArray(value.pages) || !value.pages.length)) throw new Error('index.pages 不能为空');
  if (role === 'records' && (!Array.isArray(value.questions) || !Array.isArray(value.answers))) throw new Error('records 须包含 questions/answers');
  if (role === 'paired' && !Array.isArray(value.tasks) || role === 'mapping' && !Array.isArray(value.placements)) throw new Error(`${role} 数据接口不完整`);
  if (['draft', 'approved', 'state'].includes(role) && (!Array.isArray(value.tasks) || !value.tasks.length)) throw new Error(`${role}.tasks 须为非空数组`);
  if (role === 'baseline') baselineScopes(value);
}

function baselineScopes(value) {
  const scopes = value.kind === 'local-section-baselines' ? value.scopes : [value];
  const seen = new Set();
  if (!Array.isArray(scopes) || !scopes.length) throw new Error('baseline 需要完整单节快照或 local-section-baselines.scopes');
  for (const scope of scopes) {
    if (!object(scope) || scope.bookId !== value.bookId || !nonempty(scope.chapterLabel) || !nonempty(scope.sectionLabel)
        || !positive(scope.nodeID) || !Number.isFinite(Date.parse(scope.serverSnapshotAt)) || !Array.isArray(scope.records)
        || seen.has(sectionKey(scope)) || scope.records.some((record, index) => !object(record) || record.seqIndex !== index + 1 || !positive(record.shitiID) || record.nodeID !== scope.nodeID)
        || new Set(scope.records.map(record => record.shitiID)).size !== scope.records.length) throw new Error('baseline 须有完整、连续、目录绑定的 records；普通 probe 数量不能代替');
    seen.add(sectionKey(scope));
  }
  return scopes;
}

export async function initializeWorkflowJob(root, job, planPath) {
  const context = await directory(root, job, true);
  const input = await readJobJson(context.project, planPath);
  if (input.baseDir !== context.baseDir || path.basename(input.file) === 'job.json' || /^job\.v\d+\.json$/u.test(path.basename(input.file))) throw new Error('plan 文件须在同 job 根目录，不能占用注册快照名称');
  const plan = validateWorkflowPlan(input.value);
  const snapshot = { schemaVersion: 1, kind: 'local-workflow-job', job: path.basename(context.baseDir), version: 0,
    createdAt: new Date().toISOString(), plan, planFile: { path: path.basename(input.file), sha256: input.sha256 }, references: {} };
  const output = await writeJobJson(context.project, context.file, snapshot, context.baseDir);
  return { ...output, version: 0, source: plan.source, platformExecutionAllowed: false };
}

async function localBytes(baseDir, filename) {
  if (!nonempty(filename) || path.isAbsolute(filename) || filename.includes('\0')) throw new Error('资产路径必须是同 job 相对路径');
  const candidate = path.resolve(baseDir, filename);
  if (!inside(baseDir, candidate)) throw new Error('资产路径越出 job');
  const actual = await fs.realpath(candidate);
  if (!inside(baseDir, actual) || !(await fs.stat(actual)).isFile()) throw new Error('资产软链接/junction 越出 job');
  return fs.readFile(actual);
}

async function inspectIndex(value, baseDir, plan) {
  const seen = new Set();
  for (const entry of value.pages) {
    if (!object(entry) || !positive(entry.systemPage) || seen.has(entry.systemPage) || !hashString(entry.sha256)) throw new Error('index 页号/哈希无效或重复');
    const bytes = await localBytes(baseDir, entry.file), dimensions = rasterDimensions(bytes);
    if (sha256(bytes) !== entry.sha256 || dimensions.width !== entry.width || dimensions.height !== entry.height
        || entry.bytes !== undefined && bytes.length !== entry.bytes || entry.mimeType !== undefined && dimensions.mimeType !== entry.mimeType) throw new Error(`index 原图 ${entry.systemPage} 的字节、哈希或尺寸不一致`);
    seen.add(entry.systemPage);
  }
  if (plan.scope.pages?.some(page => !seen.has(page))) throw new Error('index 未覆盖 plan 的全部来源页');
}

function inspectScope(manifest, plan) {
  const sections = new Map((plan.scope.sections ?? []).map(section => [sectionKey(section), section])), counts = new Map();
  for (const task of manifest.tasks ?? []) {
    if (plan.scope.pages && [...(task.source?.pages ?? []), ...(task.source?.answerPages ?? [])].some(page => !plan.scope.pages.includes(page))) throw new Error(`任务 ${task.id} 来源页越出 plan 范围`);
    if (sections.size) {
      const key = sectionKey(task.target ?? {}), section = sections.get(key), count = counts.get(key) ?? 0;
      if (!section || task.target.record !== section.startRecord + count || section.recordLimit !== undefined && count >= section.recordLimit) throw new Error(`任务 ${task.id} 目录或追加序号越出 plan 范围`);
      counts.set(key, count + 1);
    }
  }
  if (plan.scope.pages && Array.isArray(manifest.coverage?.pages)
      && manifest.coverage.pages.some(page => !plan.scope.pages.includes(page?.page))) throw new Error('coverage 来源页越出 plan 范围，排除项也须保留本次边界');
}

function inspectState(state, manifest, baseDir) {
  const expected = createNewSystemRun(manifest, { baseDir });
  if (state.schemaVersion !== 1 || state.kind !== 'new-system-run' || !nonempty(state.id) || state.bookId !== expected.bookId
      || state.source !== expected.source || state.manifestHash !== expected.manifestHash || !Array.isArray(state.tasks)
      || state.tasks.length !== expected.tasks.length || state.tasks.some((entry, index) => !object(entry) || entry.taskId !== expected.tasks[index].taskId
        || !entryStatuses.has(entry.status) || !Number.isSafeInteger(entry.attempts) || entry.attempts < 0 || typeof entry.recoveryRequired !== 'boolean')) throw new Error('state 与当前题单、目录或资产字节不一致；保留原进度');
  return { status: state.status, tasks: state.tasks.length, completed: state.tasks.filter(entry => done.has(entry.status)).length,
    uncertain: state.tasks.some(entry => entry.recoveryRequired === true || ['writing', 'verifying'].includes(entry.status)),
    failed: state.tasks.some(entry => entry.status === 'failed'), fullyCompleted: state.tasks.every(entry => done.has(entry.status)) };
}

/** Reads only fixed local safety paths. No service calls, keys, or whole session in the result. */
async function safetySnapshot(project, plan) {
  const safety = { checked: plan.source === 'production', sessionPresent: false, pending: false, writeBlocked: false, browserLockPresent: false, unknown: false };
  if (!safety.checked) return safety;
  const readOptional = async filename => {
    try { await writableWorkspacePath(project, filename); return JSON.parse(await fs.readFile(await existingWorkspacePath(project, filename), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw new Error('本地执行器安全状态不可核对，须用原 recorder:status 检查'); }
  };
  const session = await readOptional('data/persistent-executor/session.json');
  if (session !== undefined) {
    safety.sessionPresent = true;
    if (!object(session) || session.schemaVersion !== 1 || !positive(session.bookId) || typeof session.writeBlocked !== 'boolean'
        || session.pending !== null && !object(session.pending)) throw new Error('本地执行器安全状态结构无效，保留原锁');
    safety.pending = Boolean(session.pending); safety.writeBlocked = session.writeBlocked;
    safety.bookMatches = session.bookId === plan.bookId;
    safety.unknown = safety.writeBlocked || safety.pending;
  }
  try {
    await writableWorkspacePath(project, 'data/new-system-browser/extension-Default.lock');
    await fs.lstat(await existingWorkspacePath(project, 'data/new-system-browser/extension-Default.lock')); safety.browserLockPresent = true;
  }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('浏览器运行锁不可核对，保留原锁'); }
  return safety;
}

async function inspectReferences(context, references, { strict = false } = {}) {
  const artifacts = {}, observed = {}, blockers = [];
  for (const [role, reference] of Object.entries(references)) {
    try {
      const input = await readReference(context, reference);
      observed[role] = input;
      if (input.sha256 !== reference.sha256) throw new Error(`${role} 文件 SHA256 已变化；只登记实际当前版本，不修改历史快照`);
      assertArtifact(role, input.value, context.plan);
      artifacts[role] = input;
    } catch (error) { if (strict) throw error; blockers.push(error.message); }
  }
  return { artifacts, observed, blockers };
}

/** Derives a local stage. Every result explicitly withholds production execution permission. */
export async function workflowJobStatus(root, job) {
  const context = await loadJob(root, job), { artifacts, observed, blockers } = await inspectReferences(context, context.snapshot.references);
  let safety = { checked: context.plan.source === 'production', unknown: true };
  try { safety = await safetySnapshot(context.project, context.plan); } catch (error) { blockers.push(error.message); }
  if (safety.unknown) blockers.push('执行器仍有 pending 或未知保存/写入锁；只能核对原任务，不能再次执行');
  if (safety.bookMatches === false) blockers.push('本地执行器属于另一书；不得清状态或换题单解锁');
  let review = null, progress = null, approvalBound = false;
  const manifest = artifacts.approved?.value ?? artifacts.draft?.value;
  if (artifacts.index) { try { await inspectIndex(artifacts.index.value, context.baseDir, context.plan); } catch (error) { blockers.push(error.message); } }
  if (manifest) {
    try {
      inspectScope(manifest, context.plan); review = inspectReviewedBatch(manifest, context.baseDir); blockers.push(...review.errors);
      for (const role of ['paired', 'mapping', 'index']) if (context.snapshot.references[role]
          && !isDeepStrictEqual(manifest.preparation?.[role], context.snapshot.references[role])) throw new Error(`题单 ${role} 绑定与登记的当前材料不一致；须重新生成并审校`);
    }
    catch (error) { blockers.push(`题单本地核对失败：${error.message}`); }
  }
  if (artifacts.approved) {
    try {
      if (!artifacts.draft || !artifacts.decisions) throw new Error('approved 须同时登记原 draft 和实际 decisions');
      const regenerated = approveReviewedDraft(artifacts.draft.value, artifacts.draft.sha256, artifacts.decisions.value,
        context.baseDir, artifacts.decisions.sha256).manifest;
      if (!isDeepStrictEqual(regenerated, artifacts.approved.value)) throw new Error('approved 与当前草稿、审校决定或原图证据不一致');
      approvalBound = true;
    } catch (error) { blockers.push(`批准绑定未通过：${error.message}`); }
  }
  if (observed.state) {
    // Analyze uncertainty even when registered state bytes have changed.
    if (!object(observed.state.value) || observed.state.value.kind !== 'new-system-run' || runUncertainty(observed.state.value)) safety.unknown = true;
    try { if (!artifacts.approved) throw new Error('state 需要原 approved 题单'); progress = inspectState(observed.state.value, artifacts.approved.value, context.baseDir); }
    catch (error) { blockers.push(error.message); }
  }
  if (context.snapshot.references.state && !observed.state) safety.unknown = true;
  // Detect an omitted run/intent in the job root instead of recommending a fresh state.
  const localNames = await fs.readdir(context.baseDir);
  safety.stateLocks = localNames.filter(name => name.endsWith('.lock'));
  if (safety.stateLocks.length) blockers.push('本 job 原进度/运行锁仍存在；用原 recorder:status 核对任务终止，保留原锁，不能新建 state 接续');
  for (const name of localNames) {
    if (!name.endsWith('.json') || Object.values(context.snapshot.references).some(reference => reference.path === name) || /^job(?:\.v\d+)?\.json$/u.test(name)) continue;
    try {
      const input = await readJobJson(context.project, path.join(context.baseDir, name));
      if (input.value?.kind === 'new-system-run') {
        blockers.push(`未登记原进度 ${name}；先绑定原题单并核对，不能新建进度接续`);
        if (runUncertainty(input.value)) safety.unknown = true;
      }
      if (input.value?.kind === 'new-system-append-recovery' && !['completed', 'reconciled'].includes(input.value.status)) { safety.unknown = true; blockers.push(`存在未解决的原保存意图 ${name}`); }
    } catch (error) { if (/state|progress|run|pending/iu.test(name)) { safety.unknown = true; blockers.push(`原进度或意图 ${name} 不可安全读取`); } }
  }
  if (context.plan.source === 'production') {
    try { const config = await loadRecorderConfig(context.project); if (config.bookId !== context.plan.bookId) throw new Error('配置书号与 plan 不一致'); }
    catch (error) { blockers.push(error.message); }
    if (artifacts.baseline) {
      try {
        const scopes = new Map(baselineScopes(artifacts.baseline.value).map(scope => [sectionKey(scope), scope]));
        for (const section of context.plan.scope.sections ?? []) if (scopes.get(sectionKey(section))?.records.length !== section.startRecord - 1) throw new Error('本地历史基线与计划 startRecord 不一致；停止重核，不能静默平移');
      } catch (error) { blockers.push(error.message); }
    }
  }
  if (safety.unknown && !blockers.some(message => message.includes('未知保存'))) blockers.push('原进度存在未知保存；保留原题单/state/锁/意图，按恢复流程只读核对');
  const localReviewReady = Boolean(review?.readyForExecution && approvalBound && blockers.length === 0);
  let stage = artifacts.approved ? 'local-review-ready-requires-checks' : artifacts.draft ? 'draft-awaiting-review'
    : artifacts.paired ? 'paired-awaiting-draft' : artifacts.records ? 'records-awaiting-pairing' : artifacts.index ? 'sources-awaiting-transcription' : 'planned';
  if (progress) stage = progress.fullyCompleted ? context.plan.source === 'fixture' ? 'fixture-local-completed' : 'local-progress-completed-awaiting-platform-verification' : 'local-progress-present';
  if (blockers.length) stage = safety.unknown ? 'blocked-unknown-save' : 'blocked-local-evidence';
  const nextSteps = safety.unknown ? ['保留原题单、state、锁和意图；用原 recorder:status 等待终止，再依原恢复流程核对。此入口不执行恢复。']
    : blockers.length ? ['先处理 blockers，保留历史版本；重新登记实际文件哈希后再查看 status。']
      : progress ? ['沿用原题单与原 state，通过原平台 CLI 读取实时状态和整批回读；本地完成状态不证明线上验收。']
        : localReviewReady ? context.plan.source === 'fixture' ? ['本地审校绑定通过；可使用原离线演练入口，继续保留 fixture。']
          : ['依原平台流程确认任务终止、无未知保存，并在每节首次追加前重核实时基线；首本书/首台电脑先试录一题。']
          : ['按当前本地阶段准备下一份材料；next 可返回不覆盖旧文件的新版本路径，实际处理后用 register 登记。'];
  return { schemaVersion: 1, kind: 'local-workflow-status', job: context.snapshot.job, bookId: context.plan.bookId, source: context.plan.source,
    version: context.snapshot.version, snapshotPath: context.snapshotPath, snapshotSha256: context.snapshotSha256, stage,
    references: context.snapshot.references, observedHashes: Object.fromEntries(Object.entries(observed).map(([role, input]) => [role, input.sha256])),
    blockers: [...new Set(blockers)], localReviewReady, platformExecutionAllowed: false, platformAcceptanceVerified: false,
    authorizationEvidenceStored: Boolean(context.plan.authorizationEvidence), safety, progress,
    requiredLiveChecks: context.plan.source === 'production' ? ['普通 probe → 空编辑器 collect → 单节导出基线的顺序由原平台 CLI 实证',
      '每节首次追加前再核对真实基线；历史文件存在或哈希未变不能证明平台未变', '单题试录、保存回执、刷新回读及整批显式 limit 验收'] : [],
    nextSteps, limitations: ['只读取本地文件；不连接平台，不提交 execute/readback/recover，不编辑原素材、批准或进度',
      '审校声明依赖实际原图检查；文件登记不产生用户授权，不证明线上保存或教材覆盖验收'] };
}

export async function registerWorkflowArtifact(root, job, { role, file, expectedSha256 }) {
  if (!WORKFLOW_ROLES.includes(role) || !hashString(expectedSha256)) throw new Error('register 须指定支持的 role、file 和实际 sha256');
  const context = await loadJob(root, job), input = await readJobJson(context.project, file);
  if (input.baseDir !== context.baseDir || /^job(?:\.v\d+)?\.json$/u.test(path.basename(input.file))) throw new Error('登记文件须位于同 job 根，不能登记注册快照');
  if (input.sha256 !== expectedSha256) throw new Error('register SHA256 与实际文件字节不一致');
  assertArtifact(role, input.value, context.plan);
  const reference = { path: path.basename(input.file), sha256: input.sha256 }, previous = context.snapshot.references[role];
  if (role === 'state' && previous && previous.path !== reference.path) throw new Error('已有原 state，禁止通过登记另一进度接续或绕锁');
  if (role === 'approved' && context.snapshot.references.state && !isDeepStrictEqual(previous, reference)) throw new Error('已有原进度，禁止换已审题单沿用原 state');
  const safety = await safetySnapshot(context.project, context.plan);
  if (safety.unknown && ['approved', 'state'].includes(role) && previous && !isDeepStrictEqual(previous, reference)) throw new Error('pending/未知保存期间保留原批准与原 state 登记；先按原恢复流程核对');
  const references = { ...context.snapshot.references, [role]: reference };
  await inspectReferences(context, references, { strict: true });
  if (role === 'state') {
    if (!references.approved) throw new Error('登记 state 前须登记原 approved 题单');
    inspectState(input.value, (await readReference(context, references.approved)).value, context.baseDir);
  }
  if (role === 'approved') {
    if (!references.draft || !references.decisions) throw new Error('登记 approved 前须登记原 draft 和实际 decisions');
    const draft = await readReference(context, references.draft), decisions = await readReference(context, references.decisions);
    if (!isDeepStrictEqual(approveReviewedDraft(draft.value, draft.sha256, decisions.value, context.baseDir, decisions.sha256).manifest, input.value)) throw new Error('approved 与原草稿/审校决定不一致');
  }
  const version = context.snapshot.version + 1, output = await writeJobJson(context.project, path.join(context.baseDir, snapshotName(version)),
    { ...context.snapshot, version, registeredAt: new Date().toISOString(), previous: { path: path.basename(context.snapshotPath), sha256: context.snapshotSha256 }, references }, context.baseDir);
  return { ...output, version, role, reference, platformExecutionAllowed: false };
}

/** Read-only allocation hint; generators still use wx, so competing writers cannot overwrite. */
export async function nextWorkflowArtifact(root, job, role) {
  if (!WORKFLOW_ROLES.includes(role)) throw new Error(`next role 须为 ${WORKFLOW_ROLES.join(', ')}`);
  const context = await loadJob(root, job), status = await workflowJobStatus(root, job);
  if (role === 'state' && (context.snapshot.references.state || status.blockers.some(message => /进度|state/iu.test(message)))) throw new Error('已有原进度或未核对进度，不能分配新 state 接续');
  if ((status.safety.unknown || status.safety.stateLocks?.length) && ['state', 'approved'].includes(role)) throw new Error('pending/未知保存或原运行锁未解除，不能分配替代批准或进度');
  const names = new Set(await fs.readdir(context.baseDir));
  let version = 1;
  while (names.has(`${role}.v${String(version).padStart(4, '0')}.json`)) version++;
  const filename = `${role}.v${String(version).padStart(4, '0')}.json`;
  return { role, version, outputPath: path.join(context.baseDir, filename), relativePath: path.relative(context.project, path.join(context.baseDir, filename)).split(path.sep).join('/'),
    references: context.snapshot.references, reserved: false, platformExecutionAllowed: false, blockers: status.blockers,
    instruction: '路径只是当前未占用提示；实际写入必须拒绝覆盖，完成后用 register 绑定实际 SHA256。不生成批准、state 或执行命令。' };
}
