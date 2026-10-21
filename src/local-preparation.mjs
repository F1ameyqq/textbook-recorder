import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readJobJson, writeJobJson, preparationArgumentPath, preparationJob, sha256 } from './preparation-files.mjs';
import { validateWorkflowPlan } from './workflow-job.mjs';
import { createMappingTemplate } from './mapping-template.mjs';
import { createReviewMaterials } from './review-materials.mjs';
import { createReviewDecisionsTemplate } from './review-decisions-template.mjs';
import { reviewOutputDirectory, writeReviewFiles } from './review-output.mjs';
import { pairBatch } from '../scripts/pair-batch.mjs';
import { reportPairingConflicts } from '../scripts/report-pairing-conflicts.mjs';
import { prepareDraft } from '../scripts/prepare-draft.mjs';

const flags = ['plan', 'records', 'index', 'order', 'mapping', 'baseline', 'crops'];
const required = ['plan', 'records', 'index', 'order'];
const reference = input => ({ path: path.basename(input.file), sha256: input.sha256 });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const help = 'workflow:prepare --plan=data/jobs/<job>/plan.json --records=data/jobs/<job>/records.json --index=data/jobs/<job>/index.json --order=data/jobs/<job>/order.json [--mapping=data/jobs/<job>/mapping.checked.json] [--baseline=...] [--crops=...]';

function argumentsOf(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    if (['--help', '-h'].includes(argv[index])) { options.help = true; continue; }
    const match = /^--([a-z]+)(?:=(.*))?$/u.exec(argv[index]);
    if (!match || !flags.includes(match[1]) || Object.hasOwn(options, match[1])) throw new Error('未知或重复的本地准备参数');
    const value = match[2] ?? argv[++index];
    if (!value || value.startsWith('--')) throw new Error('准备参数缺少明确文件路径');
    options[match[1]] = value;
  }
  if (!options.help && required.some(key => !options[key])) throw new Error(help);
  return options;
}

async function nextVersion(project, baseDir) {
  const names = (await fs.readdir(baseDir)).filter(name => /^prepare\.v\d{4,}\.json$/u.test(name))
    .sort((a, b) => Number(a.match(/\d+/u)[0]) - Number(b.match(/\d+/u)[0]));
  let previous = null, identity = null;
  for (let index = 0; index < names.length; index++) {
    const expected = `prepare.v${String(index + 1).padStart(4, '0')}.json`;
    if (names[index] !== expected) throw new Error('prepare 历史不连续；保留产物并检查，不自动重跑');
    const input = await readJobJson(project, path.join(baseDir, expected));
    if (input.value.kind !== 'local-preparation-result' || input.value.version !== index + 1
        || !isDeepStrictEqual(input.value.previous, previous)) throw new Error('prepare 历史或前版 SHA256 不一致');
    const currentIdentity = { bookId: input.value.bookId, source: input.value.source, planSha256: input.value.inputs?.plan?.sha256 };
    if (identity && !isDeepStrictEqual(currentIdentity, identity)) throw new Error('prepare 历史书号或计划身份不一致');
    identity ??= currentIdentity;
    previous = reference(input);
  }
  return { version: names.length + 1, previous, identity };
}

const sourceBinding = inputs => Object.fromEntries(['records', 'plan', 'order', 'index', 'baseline', 'crops']
  .filter(key => inputs[key]).map(key => [key, inputs[key].sha256]));

function checkedMapping(input, template) {
  const mapping = input.value;
  const allowed = ['schemaVersion', 'kind', 'bookId', 'source', 'index', 'cropEvidence', 'placements', 'coverage',
    'missingReferencePolicy', 'sourceReferences', 'requiredFields', 'preparation', 'sourceBinding'];
  if (!object(mapping) || Object.keys(mapping).some(key => !allowed.includes(key))
      || mapping.schemaVersion !== 1 || mapping.kind !== template.kind || mapping.bookId !== template.bookId || mapping.source !== template.source
      || !isDeepStrictEqual(mapping.index, template.index) || !isDeepStrictEqual(mapping.cropEvidence, template.cropEvidence)
      || !Array.isArray(mapping.placements) || mapping.placements.length !== template.placements.length) {
    throw new Error('mapping 身份、原图/裁图绑定或追加类型不一致；此入口不处理旧题修订或改变范围');
  }
  if (!isDeepStrictEqual(mapping.sourceBinding, template.sourceBinding)) {
    throw new Error('mapping sourceBinding 与当前 records/plan/order/原图输入 SHA256 不一致；重新生成骨架并实际核对，不能沿用旧稿声明');
  }
  if (mapping.preparation !== undefined) {
    const old = mapping.preparation;
    if (old.kind !== 'local-mapping-template' || !object(old.references)
        || Object.keys(template.preparation.references).some(key => old.references[key]?.sha256 !== template.preparation.references[key].sha256)
        || Object.keys(old.references).some(key => !Object.hasOwn(template.preparation.references, key))) {
      throw new Error('mapping 模板来源绑定已变化，不能静默重绑旧审校声明');
    }
  }
  mapping.placements.forEach((placement, index) => {
    const target = template.placements[index];
    if (!object(placement) || placement.questionId !== target.questionId || !isDeepStrictEqual(placement.target, target.target)) {
      throw new Error('mapping 题序或目标与明确 plan/order/baseline 不一致，不能静默平移');
    }
  });
  return { ...structuredClone(mapping), sourceReferences: template.sourceReferences, preparation: template.preparation };
}

function assertSourceScope(draft, plan) {
  if (!plan.scope.pages) return;
  const allowed = new Set(plan.scope.pages);
  if (draft.tasks.some(task => [...task.source.pages, ...task.source.answerPages].some(page => !allowed.has(page)))
      || draft.coverage?.pages?.some(page => !allowed.has(page.page))) throw new Error('题目或覆盖来源页越出 plan');
}

/** Local files only. No config, controller, browser, model, approval or execution. */
export async function prepareLocal(argv, { project, cwd = project } = {}) {
  const options = argumentsOf(argv);
  if (options.help) return { help };
  if (!project) throw new Error('须提供本地项目根');
  const inputs = {};
  for (const key of flags) {
    if (!options[key]) continue;
    inputs[key] = await readJobJson(project, await preparationArgumentPath(cwd, options[key]));
    if (inputs.plan && inputs[key].baseDir !== inputs.plan.baseDir) throw new Error('全部输入必须位于同一 data/jobs/<job>/ 根');
  }
  const plan = validateWorkflowPlan(inputs.plan.value), baseDir = inputs.plan.baseDir;
  if (inputs.records.value.bookId !== plan.bookId || inputs.index.value.bookId !== plan.bookId || inputs.order.value.bookId !== plan.bookId) throw new Error('输入书号与 plan 不一致');
  // This command never inspects runtime/session files; a caller must use an isolated preparation job.
  const names = await fs.readdir(baseDir);
  if (names.some(name => /\.lock$/u.test(name) || /(?:^|[.-])(?:state|progress|pending|intent)(?:[.-]|$)/iu.test(name))) {
    throw new Error('作业内有原进度、意图或锁；保留现场，使用独立准备 job，不替代原任务恢复');
  }
  const lock = await preparationJob(project, path.join(baseDir, '.preparation.lock'));
  const token = randomUUID();
  await fs.writeFile(lock.file, token, { flag: 'wx' });
  try {
    const { version, previous, identity } = await nextVersion(project, baseDir), suffix = `prepare-v${String(version).padStart(4, '0')}`;
    if (identity && !isDeepStrictEqual(identity, { bookId: plan.bookId, source: plan.source, planSha256: inputs.plan.sha256 })) {
      throw new Error('同 job 的书号、source 和原 plan SHA256 已冻结；改变范围须使用新的独立准备 job');
    }
    const report = { schemaVersion: 1, kind: 'local-preparation-result', version, previous, bookId: plan.bookId, source: plan.source,
      stage: 'preparing', phase: 'pairing', ok: false, inputs: Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, reference(input)])),
      artifacts: {}, todos: [], approved: 0, readyForExecution: false, platformExecutionAllowed: false,
      platformAcceptanceVerified: false, platformWritePerformed: false, sourceSemanticsVerifiedByTool: false };
    const artifactPath = role => path.join(baseDir, `${role}.${suffix}.json`);
    const saveArtifact = async (role, value) => {
      const written = await writeJobJson(project, artifactPath(role), value, baseDir);
      report.artifacts[role] = { path: path.basename(written.file), sha256: written.sha256 };
      return await readJobJson(project, written.file);
    };
    try {
      const pairedResult = await pairBatch([`--input=${inputs.records.file}`, `--output=${artifactPath('paired')}`], { project, cwd });
      const paired = await readJobJson(project, pairedResult.outputPath);
      report.artifacts.paired = reference(paired);
      report.phase = 'pairing-conflicts';
      const conflicts = await reportPairingConflicts([`--input=${paired.file}`, `--records=${inputs.records.file}`,
        `--index=${inputs.index.file}`, `--output=${artifactPath('conflicts')}`], { project, cwd });
      report.artifacts.conflicts = { path: path.basename(conflicts.outputPath), sha256: conflicts.outputSha256 };
      const references = { plan: reference(inputs.plan), order: reference(inputs.order), index: reference(inputs.index), paired: reference(paired),
        ...(inputs.baseline ? { baseline: reference(inputs.baseline) } : {}), ...(inputs.crops ? { cropEvidence: reference(inputs.crops) } : {}) };
      report.phase = 'mapping-template';
      const template = { ...createMappingTemplate(references, baseDir), sourceBinding: sourceBinding(inputs) };
      await saveArtifact('mapping-template', template);
      if (!inputs.mapping) {
        report.ok = true; report.stage = 'mapping-required';
        report.todos = ['补全 mapping 的作答要求、答案状态、逐页候选及实际核对说明，另存后用 --mapping 接续'];
        report.requiredFields = template.requiredFields;
      } else {
        report.phase = 'mapping-binding';
        const mapping = await saveArtifact('mapping', checkedMapping(inputs.mapping, template));
        report.phase = 'draft';
        const drafted = await prepareDraft([`--input=${paired.file}`, `--mapping=${mapping.file}`, `--output=${artifactPath('draft')}`], { project, cwd });
        const draft = await readJobJson(project, drafted.outputPath);
        report.artifacts.draft = reference(draft);
        assertSourceScope(draft.value, plan);
        report.phase = 'review-decisions';
        const { decisions, report: preflight } = createReviewDecisionsTemplate(draft.value, draft.sha256, baseDir);
        await saveArtifact('decisions-template', decisions);
        report.phase = 'review-materials';
        const materials = createReviewMaterials(draft.value, draft.sha256, baseDir, { manifestPath: path.basename(draft.file), diagnosticSeverity: 'all' });
        const directory = await reviewOutputDirectory(project, cwd, path.join(project, 'data', 'review', `${path.basename(baseDir)}-${suffix}`));
        const written = await writeReviewFiles(project, directory, { 'preflight.json': JSON.stringify(preflight, null, 2) + '\n',
          'materials.json': JSON.stringify(materials.packet, null, 2) + '\n', 'materials.html': materials.html });
        report.reviewFiles = Object.fromEntries(await Promise.all(Object.entries(written).map(async ([key, file]) =>
          [key, { path: path.relative(project, file).split(path.sep).join('/'), sha256: sha256(await fs.readFile(file)) }])));
        report.counts = { tasks: draft.value.tasks.length, errors: preflight.errors.length, warnings: preflight.warnings.length,
          unresolvedSpecialReview: preflight.unresolvedSpecialReview.length, selectedTasks: materials.packet.tasks.length };
        report.ok = preflight.valid;
        report.stage = preflight.valid ? 'review-required' : 'review-blocked';
        report.todos = preflight.valid ? ['实际核对当前完整题单及覆盖，为新草稿填写独立的 hash-bound 审校决定']
          : ['按 preflight 和完整题材料修正输入；保留当前阻断草稿，生成新版本后再审校'];
      }
      report.phase = 'input-final-check';
      for (const input of Object.values(inputs)) {
        if (sha256(await fs.readFile(input.file)) !== input.sha256) throw new Error('准备期间输入字节变化；保留当前产物并重新核对');
      }
    } catch (error) {
      report.ok = false; report.stage = 'blocked-input';
      report.failureStage = report.phase;
      report.error = { code: 'LOCAL_PREPARATION_BLOCKED', message: String(error.message).slice(0, 2000) };
      report.todos = ['只读检查本次 receipt 的失败阶段和已有产物；修正输入后另建版本，不自动重试'];
    }
    const receipt = await writeJobJson(project, path.join(baseDir, `prepare.v${String(version).padStart(4, '0')}.json`), report, baseDir);
    return { ok: report.ok, stage: report.stage, version, bookId: plan.bookId, source: plan.source,
      ...(report.counts ? { counts: report.counts } : {}), artifactPaths: Object.fromEntries(Object.entries(report.artifacts).map(([key, value]) => [key, value.path])),
      receiptPath: receipt.file, receiptSha256: receipt.sha256, todos: report.todos,
      approved: 0, readyForExecution: false, platformExecutionAllowed: false, platformWritePerformed: false };
  } finally {
    // Remove only the mutex created by this invocation, never an old execution lock.
    if (await fs.readFile(lock.file, 'utf8') === token) await fs.unlink(lock.file);
  }
}
