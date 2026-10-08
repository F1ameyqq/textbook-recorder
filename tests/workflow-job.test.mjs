import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { sha256 } from '../src/preparation-files.mjs';
import { initializeWorkflowJob, workflowJobStatus, nextWorkflowArtifact, registerWorkflowArtifact, validateWorkflowPlan } from '../src/workflow-job.mjs';
import { workflowJob } from '../scripts/workflow-job.mjs';
import { preparePairedBatch } from '../src/paired-batch.mjs';
import { prepareDraftBatch } from '../src/draft-batch.mjs';
import { approveReviewedDraft } from '../src/review-approval.mjs';
import { createNewSystemRun } from '../src/new-system-core.mjs';

const copy = value => structuredClone(value);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');

async function fixture(t, source = 'fixture') {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'recorder-workflow-job-'));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const job = 'data/jobs/synthetic', baseDir = path.join(project, job);
  await fs.mkdir(path.join(baseDir, 'images'), { recursive: true });
  const plan = { schemaVersion: 1, kind: 'local-workflow-plan', bookId: 900001, source,
    scope: { pages: [1, 2], sections: [{ chapterLabel: '示例章', sectionLabel: '示例节', startRecord: 1, recordLimit: 20 }] } };
  const save = async (name, value) => { const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n'); await fs.writeFile(path.join(baseDir, name), bytes); return { path: name, sha256: sha256(bytes) }; };
  await save('plan.json', plan);
  const pages = [];
  for (let page = 1; page <= 2; page++) {
    const file = `images/page-${page}.png`; await fs.writeFile(path.join(baseDir, file), png);
    pages.push({ systemPage: page, file, sha256: sha256(png), width: 1, height: 1, bytes: png.length, mimeType: 'image/png' });
  }
  const index = { schemaVersion: 1, bookId: plan.bookId, pages }, indexRef = await save('index.json', index);
  const origin = page => ({ pages: [page], images: [pages[page - 1].file], regions: [{ page, image: pages[page - 1].file, bbox: [0, 0, 1, 1] }] });
  const records = { schemaVersion: 1, bookId: plan.bookId,
    questions: [{ id: 'q1', chapter: '示例章', unit: '示例节', group: '基础', questionNumber: '1', rawOcr: '', blocks: [{ type: 'text', text: '1. 合成问题？' }], source: origin(1) }],
    answers: [{ id: 'a1', chapter: '示例章', unit: '示例节', group: '基础', questionNumber: '1', rawOcr: '', blocks: [{ type: 'text', text: '合成答案' }], source: origin(2) }] };
  const mapping = { schemaVersion: 1, kind: 'new-system-draft-mapping', bookId: plan.bookId, source, index: indexRef,
    placements: [{ questionId: 'q1', target: { chapterLabel: '示例章', sectionLabel: '示例节', record: 1 }, answerRequirement: { kind: 'question', evidence: '合成问题？' }, answerStatus: 'provided' }],
    coverage: { pages: [{ page: 1, imagePath: pages[0].file, candidates: [{ id: 'candidate-1', type: 'question', decision: 'include', taskIds: ['q1'] }] }] } };
  const paired = preparePairedBatch(records), pairedRef = await save('paired.json', paired), mappingRef = await save('mapping.json', mapping);
  const draft = prepareDraftBatch(paired, mapping, baseDir, { paired: pairedRef, mapping: mappingRef }).manifest, draftRef = await save('draft.json', draft);
  const decisions = { schemaVersion: 1, manifestSha256: draftRef.sha256, coverageChecked: true,
    tasks: [{ taskId: 'q1', checks: { sourceText: true, answerMatch: true, wholeQuestion: true, format: true }, evidence: '仅合成 fixture 的第1页题干和第2页答案核对证据' }] };
  const decisionsRef = await save('decisions.json', decisions), approved = approveReviewedDraft(draft, draftRef.sha256, decisions, baseDir, decisionsRef.sha256).manifest;
  await save('approved.json', approved); await save('records.json', records);
  await initializeWorkflowJob(project, job, path.join(baseDir, 'plan.json'));
  const register = async (role, name = `${role}.json`) => { const bytes = await fs.readFile(path.join(baseDir, name)); return registerWorkflowArtifact(project, job, { role, file: path.join(baseDir, name), expectedSha256: sha256(bytes) }); };
  const registerPrepared = async () => { for (const role of ['index', 'records', 'paired', 'mapping', 'draft', 'decisions', 'approved']) await register(role); };
  if (source === 'production') { await fs.mkdir(path.join(project, 'config')); await fs.writeFile(path.join(project, 'config', 'recorder.json'), JSON.stringify({ bookId: plan.bookId })); }
  return { project, job, baseDir, plan, save, register, registerPrepared, records, mapping, paired, draft, decisions, approved, index };
}

test('init freezes supplied scope, preserves evidence, rejects overwrite and does not contact platform', async t => {
  const f = await fixture(t), before = await fs.readFile(path.join(f.baseDir, 'job.json'));
  assert.deepEqual(JSON.parse(before).plan, f.plan);
  await assert.rejects(initializeWorkflowJob(f.project, f.job, path.join(f.baseDir, 'plan.json')), /EEXIST/);
  assert.deepEqual(await fs.readFile(path.join(f.baseDir, 'job.json')), before);
  const status = await workflowJobStatus(f.project, f.job);
  assert.equal(status.stage, 'planned'); assert.equal(status.platformExecutionAllowed, false);
  assert.equal(status.authorizationEvidenceStored, false); assert.equal(status.safety.checked, false);
  assert.equal(status.platformAcceptanceVerified, false);
});

test('plan requires explicit book, source and scope and never invents approval', () => {
  const plan = { schemaVersion: 1, kind: 'local-workflow-plan', bookId: 900001, source: 'fixture', scope: { pages: [1] } };
  assert.deepEqual(validateWorkflowPlan(plan), plan);
  assert.throws(() => validateWorkflowPlan({ ...plan, source: 'production-ready' }), /plan/);
  assert.throws(() => validateWorkflowPlan({ ...plan, scope: {} }), /scope/);
  assert.throws(() => validateWorkflowPlan({ ...plan, scope: { pages: [1, 1] } }), /pages/);
  assert.throws(() => validateWorkflowPlan({ ...plan, authorizationEvidence: { authorized: true } }), /authorizationEvidence/);
  assert.throws(() => validateWorkflowPlan({ ...plan, scope: { sections: [{ chapterLabel: '章', sectionLabel: '节', startRecord: 0 }] } }), /startRecord/);
  const withEvidence = { ...plan, authorizationEvidence: { userQuote: '真实授权原话仅作为存档', evidenceReference: '本次会话引用' } };
  assert.deepEqual(validateWorkflowPlan(withEvidence), withEvidence);
});

test('registration creates immutable hash-linked snapshots and next gives unused local names', async t => {
  const f = await fixture(t), initial = await fs.readFile(path.join(f.baseDir, 'job.json'));
  const result = await f.register('records'); assert.equal(result.version, 1);
  const snapshot = JSON.parse(await fs.readFile(result.file));
  assert.deepEqual(snapshot.previous, { path: 'job.json', sha256: sha256(initial) });
  assert.equal((await workflowJobStatus(f.project, f.job)).stage, 'records-awaiting-pairing');
  const before = await fs.readdir(f.baseDir), first = await nextWorkflowArtifact(f.project, f.job, 'draft');
  assert.equal(first.relativePath, 'data/jobs/synthetic/draft.v0001.json'); assert.equal(first.reserved, false);
  assert.deepEqual(await fs.readdir(f.baseDir), before);
  await f.save('draft.v0001.json', f.draft);
  assert.equal((await nextWorkflowArtifact(f.project, f.job, 'draft')).relativePath, 'data/jobs/synthetic/draft.v0002.json');
  assert.deepEqual(await fs.readFile(path.join(f.baseDir, 'job.json')), initial);
});

test('wrong hash, wrong source and stale current reference fail closed without new snapshot', async t => {
  const f = await fixture(t);
  await assert.rejects(registerWorkflowArtifact(f.project, f.job, { role: 'records', file: path.join(f.baseDir, 'records.json'), expectedSha256: 'a'.repeat(64) }), /SHA256/);
  await f.register('records'); await f.save('records.json', { ...f.records, bookId: 42 });
  const status = await workflowJobStatus(f.project, f.job);
  assert.equal(status.stage, 'blocked-local-evidence'); assert.equal(status.localReviewReady, false);
  assert.ok(status.blockers.some(message => /SHA256/.test(message)));
  await assert.rejects(f.register('paired'), /SHA256/);
  assert.equal((await fs.readdir(f.baseDir)).filter(name => name.startsWith('job.v')).length, 1);
  await f.save('foreign-source.json', { ...f.mapping, source: 'production' });
  await assert.rejects(f.register('mapping', 'foreign-source.json'), /source/);
});

test('edited history or missing registration version cannot be treated as latest', async t => {
  const f = await fixture(t); await f.register('records'); await f.register('paired');
  await fs.appendFile(path.join(f.baseDir, 'job.v0001.json'), '\n');
  await assert.rejects(workflowJobStatus(f.project, f.job), /前版 SHA256/);
});

test('valid local approval is revalidated against actual draft, decisions and original bytes', async t => {
  const f = await fixture(t); await f.registerPrepared();
  const status = await workflowJobStatus(f.project, f.job);
  assert.equal(status.localReviewReady, true); assert.equal(status.platformExecutionAllowed, false);
  await fs.appendFile(path.join(f.baseDir, 'images/page-1.png'), 'changed');
  const changed = await workflowJobStatus(f.project, f.job);
  assert.equal(changed.localReviewReady, false); assert.equal(changed.stage, 'blocked-local-evidence');
  assert.ok(changed.blockers.some(message => /原图|SHA/.test(message)));
});

test('unapproved or altered approved content cannot be registered as approved', async t => {
  const f = await fixture(t); await f.register('draft'); await f.register('decisions');
  await f.save('forged.json', { ...f.approved, tasks: [{ ...f.approved.tasks[0], answer: { blocks: [{ type: 'text', text: '更改后的内容' }] } }] });
  await assert.rejects(f.register('approved', 'forged.json'), /原草稿|审校决定/);
  await assert.rejects(f.register('approved', 'draft.json'), /原草稿|审校决定/);
});

test('state is bound to manifest and assets; completed fixture is not platform acceptance', async t => {
  const f = await fixture(t); await f.registerPrepared();
  const state = createNewSystemRun(f.approved, { baseDir: f.baseDir });
  state.tasks[0].status = 'completed'; state.status = 'completed';
  await f.save('state.json', state); await f.register('state');
  const status = await workflowJobStatus(f.project, f.job);
  assert.equal(status.stage, 'fixture-local-completed'); assert.equal(status.progress.completed, 1);
  assert.equal(status.platformAcceptanceVerified, false); assert.equal(status.platformExecutionAllowed, false);
  await assert.rejects(nextWorkflowArtifact(f.project, f.job, 'state'), /原进度/);
  await f.save('other-state.json', state);
  await assert.rejects(f.register('state', 'other-state.json'), /原 state/);
  await f.save('state.json', { ...state, manifestHash: 'b'.repeat(64) });
  const changed = await workflowJobStatus(f.project, f.job);
  assert.equal(changed.localReviewReady, false); assert.ok(changed.blockers.some(message => /state 与当前题单/.test(message)));
});

test('unknown run remains visible and blocks replacing progress or proposing another approved manifest', async t => {
  const f = await fixture(t); await f.registerPrepared();
  const state = createNewSystemRun(f.approved, { baseDir: f.baseDir });
  state.tasks[0].status = 'failed'; state.tasks[0].attempts = 1; state.tasks[0].recoveryRequired = true; state.status = 'failed';
  await f.save('original-progress.json', state);
  const status = await workflowJobStatus(f.project, f.job);
  assert.equal(status.stage, 'blocked-unknown-save'); assert.equal(status.safety.unknown, true);
  assert.equal(status.platformExecutionAllowed, false); assert.ok(status.nextSteps[0].includes('原恢复流程'));
  await assert.rejects(nextWorkflowArtifact(f.project, f.job, 'state'), /原进度/);
  await assert.rejects(nextWorkflowArtifact(f.project, f.job, 'approved'), /未知保存/);
  const draft = await nextWorkflowArtifact(f.project, f.job, 'draft'); assert.equal(draft.platformExecutionAllowed, false);
});

test('changed registered state is still examined for uncertainty before reporting hash drift', async t => {
  const f = await fixture(t); await f.registerPrepared();
  const state = createNewSystemRun(f.approved, { baseDir: f.baseDir }); await f.save('state.json', state); await f.register('state');
  state.tasks[0].status = 'writing'; state.tasks[0].attempts = 1; state.tasks[0].recoveryRequired = true;
  await f.save('state.json', state);
  const status = await workflowJobStatus(f.project, f.job);
  assert.equal(status.stage, 'blocked-unknown-save'); assert.equal(status.safety.unknown, true);
  assert.ok(status.blockers.some(message => /SHA256/.test(message)));
});

test('malformed registered state and malformed unregistered run return uncertainty without crashing', async t => {
  const f = await fixture(t); await f.registerPrepared();
  const state = createNewSystemRun(f.approved, { baseDir: f.baseDir }); await f.save('state.json', state); await f.register('state');
  for (const value of [null, { ...state, tasks: {} }, { ...state, tasks: 'invalid' }]) {
    await f.save('state.json', value);
    const status = await workflowJobStatus(f.project, f.job);
    assert.equal(status.stage, 'blocked-unknown-save'); assert.equal(status.safety.unknown, true); assert.equal(status.platformExecutionAllowed, false);
  }
  const g = await fixture(t); await g.save('old-run.json', { kind: 'new-system-run', tasks: {} });
  assert.equal((await workflowJobStatus(g.project, g.job)).stage, 'blocked-unknown-save');
});

test('production safety reads only a fixed local summary and never returns session secrets', async t => {
  const f = await fixture(t, 'production'); await f.registerPrepared();
  const folder = path.join(f.project, 'data', 'persistent-executor'); await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'session.json'), JSON.stringify({ schemaVersion: 1, bookId: f.plan.bookId, pending: { id: 'original-command', action: 'execute' }, writeBlocked: true,
    key: 'must-not-be-returned', blockedContext: { manifest: 'private-manifest', state: 'private-state' } }));
  const lock = path.join(f.project, 'data', 'new-system-browser'); await fs.mkdir(lock); await fs.writeFile(path.join(lock, 'extension-Default.lock'), 'held');
  const status = await workflowJobStatus(f.project, f.job);
  assert.equal(status.stage, 'blocked-unknown-save'); assert.equal(status.safety.pending, true); assert.equal(status.safety.writeBlocked, true);
  assert.equal(status.safety.browserLockPresent, true);
  assert.doesNotMatch(JSON.stringify(status), /must-not-be-returned|private-manifest|private-state|original-command/);
  assert.equal(status.platformAcceptanceVerified, false);
});

test('fixture skips production configuration and session entirely; production always needs live baseline checks', async t => {
  const f = await fixture(t); await f.registerPrepared();
  const folder = path.join(f.project, 'data', 'persistent-executor'); await fs.mkdir(folder, { recursive: true }); await fs.writeFile(path.join(folder, 'session.json'), 'invalid');
  assert.equal((await workflowJobStatus(f.project, f.job)).localReviewReady, true);
  const p = await fixture(t, 'production'); await p.registerPrepared();
  const status = await workflowJobStatus(p.project, p.job);
  assert.equal(status.platformExecutionAllowed, false); assert.ok(status.requiredLiveChecks.some(message => message.includes('首次追加前')));
});

test('existing null or incomplete production session is damaged state, not a missing service', async t => {
  const f = await fixture(t, 'production'), folder = path.join(f.project, 'data', 'persistent-executor'); await fs.mkdir(folder, { recursive: true });
  for (const value of [null, {}, { schemaVersion: 1, bookId: f.plan.bookId, writeBlocked: false }]) {
    await fs.writeFile(path.join(folder, 'session.json'), JSON.stringify(value));
    const status = await workflowJobStatus(f.project, f.job);
    assert.equal(status.stage, 'blocked-unknown-save'); assert.equal(status.localReviewReady, false);
    assert.ok(status.blockers.some(message => /安全状态结构无效/.test(message)));
  }
});

test('changed original plan is rejected and preparation registry cannot point at different current inputs', async t => {
  const f = await fixture(t); await f.registerPrepared();
  await f.save('mapping.v0001.json', f.mapping); await f.register('mapping', 'mapping.v0001.json');
  const status = await workflowJobStatus(f.project, f.job);
  assert.equal(status.localReviewReady, false); assert.ok(status.blockers.some(message => /mapping 绑定/.test(message)));
  await f.save('plan.json', { ...f.plan, scope: { pages: [1] } });
  await assert.rejects(workflowJobStatus(f.project, f.job), /原 plan 文件 SHA256/);
});

test('coverage exclusions stay inside plan scope and local progress locks block replacement suggestions', async t => {
  const f = await fixture(t);
  const outside = copy(f.draft); outside.coverage.pages.push({ page: 3, candidates: [{ id: 'outside-page', type: 'non-question', decision: 'exclude', taskIds: [], reason: '仅说明流程' }] });
  await f.save('outside-draft.json', outside); await f.register('draft', 'outside-draft.json');
  const status = await workflowJobStatus(f.project, f.job);
  assert.equal(status.localReviewReady, false); assert.ok(status.blockers.some(message => /coverage 来源页越出/.test(message)));
  await fs.writeFile(path.join(f.baseDir, 'original-progress.json.lock'), 'locked');
  const locked = await workflowJobStatus(f.project, f.job);
  assert.deepEqual(locked.safety.stateLocks, ['original-progress.json.lock']);
  assert.ok(locked.blockers.some(message => /运行锁仍存在/.test(message)));
  await assert.rejects(nextWorkflowArtifact(f.project, f.job, 'state'), /原进度/);
  await assert.rejects(nextWorkflowArtifact(f.project, f.job, 'approved'), /原运行锁/);
  assert.equal(await fs.readFile(path.join(f.baseDir, 'original-progress.json.lock'), 'utf8'), 'locked');
});

test('historical baseline must be a complete section export and cannot silently move the starting record', async t => {
  const f = await fixture(t, 'production');
  await f.save('baseline.json', { bookId: f.plan.bookId, chapterLabel: '示例章', sectionLabel: '示例节', nodeID: 42, serverSnapshotAt: '2026-10-08T10:00:00Z', records: [] });
  await f.register('baseline'); assert.deepEqual((await workflowJobStatus(f.project, f.job)).blockers, []);
  await f.save('baseline.json', { bookId: f.plan.bookId, chapterLabel: '示例章', sectionLabel: '示例节', nodeID: 42, serverSnapshotAt: '2026-10-08T10:10:00Z', records: [{ seqIndex: 1, shitiID: 5, nodeID: 42 }] });
  await f.register('baseline'); const status = await workflowJobStatus(f.project, f.job);
  assert.equal(status.stage, 'blocked-local-evidence'); assert.ok(status.blockers.some(message => /静默平移/.test(message)));
  await f.save('count-only.json', { bookId: f.plan.bookId, recordCount: 1 });
  await assert.rejects(f.register('baseline', 'count-only.json'), /完整|records/);
});

test('CLI validates action-specific parameters, handles local cwd paths and help', async t => {
  const f = await fixture(t);
  const status = await workflowJob(['--action=status', '--job=data/jobs/synthetic'], { root: f.project, cwd: f.project });
  assert.equal(status.version, 0);
  assert.match((await workflowJob(['--help'], { root: f.project, cwd: f.project })).help, /不会连接平台/);
  await assert.rejects(workflowJob(['--action=status', '--job=data/jobs/synthetic', '--role=draft'], { root: f.project, cwd: f.project }), /冲突/);
  await assert.rejects(workflowJob(['--action=next', '--action=next', '--job=data/jobs/synthetic', '--role=draft'], { root: f.project, cwd: f.project }), /重复/);
  await assert.rejects(workflowJob(['--action=execute', '--job=data/jobs/synthetic'], { root: f.project, cwd: f.project }), /冲突/);
});

test('cross-job and nested registration references are rejected without producing snapshots', async t => {
  const f = await fixture(t), other = path.join(f.project, 'data', 'jobs', 'other'); await fs.mkdir(other);
  const bytes = Buffer.from(JSON.stringify(f.records)); await fs.writeFile(path.join(other, 'records.json'), bytes);
  await assert.rejects(registerWorkflowArtifact(f.project, f.job, { role: 'records', file: path.join(other, 'records.json'), expectedSha256: sha256(bytes) }), /同 job/);
  await fs.mkdir(path.join(f.baseDir, 'nested')); await fs.writeFile(path.join(f.baseDir, 'nested', 'records.json'), bytes);
  await assert.rejects(registerWorkflowArtifact(f.project, f.job, { role: 'records', file: path.join(f.baseDir, 'nested', 'records.json'), expectedSha256: sha256(bytes) }), /根目录/);
  assert.equal((await fs.readdir(f.baseDir)).some(name => name.startsWith('job.v')), false);
});

test('actual junction escaping data/jobs is rejected before init writes anything outside', async t => {
  const f = await fixture(t), outside = await fs.mkdtemp(path.join(os.tmpdir(), 'recorder-workflow-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'plan.json'), JSON.stringify(f.plan));
  const alias = path.join(f.project, 'data', 'jobs', 'escape');
  try { await fs.symlink(outside, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) { t.skip('Windows 无权创建 junction'); return; } throw error; }
  await assert.rejects(initializeWorkflowJob(f.project, 'data/jobs/escape', path.join(alias, 'plan.json')), /越界|越出/);
  assert.deepEqual(await fs.readdir(outside), ['plan.json']);
});
