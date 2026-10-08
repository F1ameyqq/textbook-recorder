import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const REVIEW_STATUSES = new Set(['pending', 'approved']);
const RUN_STATUSES = new Set(['pending', 'review_required', 'ready', 'writing', 'verifying', 'completed', 'failed']);
const activeRuns = new Set();
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const nonemptyString = value => typeof value === 'string' && value.trim().length > 0;
const cleanWhitespace = value => value.replace(/\s/gu, '');
const approvedForWrite = task => isObject(task.review) && task.review.status === 'approved' &&
  (task.review.issues === undefined || (Array.isArray(task.review.issues) && task.review.issues.length === 0));

export function resolveAssetPath(assetPath, baseDir = process.cwd()) {
  if (!nonemptyString(assetPath) || assetPath.includes('\0')) throw new Error('图片路径必须是非空字符串');
  if (path.isAbsolute(assetPath)) throw new Error('图片必须使用相对路径，禁止绝对路径');
  const root = path.resolve(baseDir);
  const resolved = path.resolve(root, assetPath);
  const relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('图片路径越界，必须位于题单目录内');
  return resolved;
}

function inspectManifest(manifest, baseDir, checkFiles) {
  const errors = [];
  const warnings = [];
  const checkFile = (filename, location) => {
    if (!nonemptyString(filename)) {
      errors.push(`${location}: 图片路径必须是非空字符串`);
      return;
    }
    let resolved;
    try { resolved = resolveAssetPath(filename, baseDir); }
    catch (error) { errors.push(`${location}: ${error.message}`); return; }
    if (!IMAGE_EXTENSIONS.has(path.extname(filename).toLowerCase())) {
      errors.push(`${location}: 图片格式只支持 png、jpg、jpeg、webp`);
      return;
    }
    if (!checkFiles) return;
    try {
      if (!statSync(resolved).isFile()) throw new Error('不是文件');
      accessSync(resolved, constants.R_OK);
      const root = realpathSync(baseDir);
      const actual = realpathSync(resolved);
      const relative = path.relative(root, actual);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        errors.push(`${location}: 图片软链接越界，必须位于题单目录内`);
        return;
      }
    } catch {
      errors.push(`${location}: 图片文件不存在或不可读取: ${resolved}`);
    }
  };
  if (!isObject(manifest)) return { valid: false, errors: ['manifest 必须是对象'], warnings };
  if (manifest.schemaVersion !== 1) errors.push('schemaVersion 必须是 1');
  if (!positiveInteger(manifest.bookId)) errors.push('bookId 必须是正整数');
  if (manifest.mode !== 'body') errors.push("mode 必须是 'body'，当前版本仅录正文");
  if (!['fixture', 'production'].includes(manifest.source)) errors.push('source 必须是 fixture 或 production');
  if (!Array.isArray(manifest.tasks)) {
    errors.push('tasks 必须是数组');
    return { valid: false, errors, warnings };
  }
  if (manifest.tasks.length === 0) warnings.push('题单为空，没有可录入的题目');
  const ids = new Set();
  const explicitTargets = new Set();
  for (const [index, task] of manifest.tasks.entries()) {
    const prefix = `tasks[${index}]`;
    if (!isObject(task)) {
      errors.push(`${prefix}: 题目必须是对象`);
      continue;
    }
    if (!nonemptyString(task.id) || !/^[A-Za-z0-9_-]+$/.test(task.id)) errors.push(`${prefix}.id 只能含英文字母、数字、下划线和短横线`);
    else if (ids.has(task.id)) errors.push(`${prefix}.id 重复: ${task.id}`);
    else ids.add(task.id);
    if (!isObject(task.target)) errors.push(`${prefix}.target 必须包含 chapter、unit、record`);
    else {
      for (const key of ['chapter', 'unit']) {
        if (!positiveInteger(task.target[key])) errors.push(`${prefix}.target.${key} 必须是正整数`);
      }
      if (task.target.record !== null && !positiveInteger(task.target.record)) errors.push(`${prefix}.target.record 必须是正整数或 null`);
      if (manifest.source === 'production' && task.target.record === null) errors.push(`${prefix}: production 必须指定正整数题号，禁止自动追加到未知位置`);
      if (positiveInteger(task.target.chapter) && positiveInteger(task.target.unit) && positiveInteger(task.target.record)) {
        const targetKey = `${task.target.chapter}/${task.target.unit}/${task.target.record}`;
        if (explicitTargets.has(targetKey)) errors.push(`${prefix}.target 目标冲突: ${targetKey}`);
        else explicitTargets.add(targetKey);
      }
      if (task.target.record === null) warnings.push(`${prefix}: 追加题必须由 adapter 保存实际题号，恢复时先回读`);
    }
    if (!isObject(task.source)) errors.push(`${prefix}.source 必须是对象`);
    else {
      if (!Array.isArray(task.source.pages) || task.source.pages.length === 0 || task.source.pages.some(page => !positiveInteger(page))) errors.push(`${prefix}.source.pages 必须是非空正整数数组`);
      else if (task.source.pages.length > 1) warnings.push(`${prefix}: 跨页题需要对照所有来源页审校`);
      if (!nonemptyString(task.source.label)) errors.push(`${prefix}.source.label 必须是非空字符串`);
      if (task.source.images !== undefined) {
        if (!Array.isArray(task.source.images)) errors.push(`${prefix}.source.images 必须是数组`);
        else task.source.images.forEach((filename, imageIndex) => checkFile(filename, `${prefix}.source.images[${imageIndex}]`));
      }
      if (!Array.isArray(task.source.images) || task.source.images.length === 0) warnings.push(`${prefix}: 没有来源原图，不能仅凭保存一致性确认 OCR 准确性`);
    }
    if (!Array.isArray(task.blocks) || task.blocks.length === 0) errors.push(`${prefix}.blocks 必须含有正文或图片`);
    else for (const [blockIndex, block] of task.blocks.entries()) {
      const location = `${prefix}.blocks[${blockIndex}]`;
      if (!isObject(block)) errors.push(`${location}: 内容块必须是对象`);
      else if (block.type === 'text') {
        if (!nonemptyString(block.text)) errors.push(`${location}.text 正文不能为空`);
      } else if (block.type === 'image') checkFile(block.path, `${location}.path`);
      else errors.push(`${location}.type 只能是 text 或 image`);
    }
    if (!isObject(task.review) || !REVIEW_STATUSES.has(task.review.status)) errors.push(`${prefix}.review.status 必须是 pending 或 approved`);
    else if (task.review.issues !== undefined) {
      if (!Array.isArray(task.review.issues) || task.review.issues.some(issue => !nonemptyString(issue))) errors.push(`${prefix}.review.issues 必须是非空字符串数组`);
      else if (task.review.status === 'approved' && task.review.issues.length > 0) errors.push(`${prefix}: approved 题目仍有未解决 issues`);
    }
  }
  return { valid: errors.length === 0, errors, warnings };
}

/** Synchronous, local-only schema, target, duplicate and asset checks. */
export function validateManifest(manifest, baseDir = process.cwd()) {
  return inspectManifest(manifest, baseDir, true);
}

export function expectedText(task) {
  return task.blocks.filter(block => block.type === 'text').map(block => block.text).join('\n');
}

/** Compare text and image loading/counts; it does not prove OCR accuracy or image identity. */
export function compareReadback(task, readback) {
  const errors = [];
  const loadingErrors = [];
  if (!isObject(readback)) return { ok: false, pending: false, errors: ['回读结果必须是对象'] };
  if (typeof readback.text !== 'string') errors.push('回读正文必须是字符串');
  else if (cleanWhitespace(readback.text) !== cleanWhitespace(expectedText(task))) errors.push('回读正文与题单不一致');
  if (readback.target !== undefined) {
    if (!isObject(readback.target)) errors.push('回读目录必须是对象');
    else {
      for (const key of ['chapter', 'unit']) if (readback.target[key] !== task.target[key]) errors.push(`回读目录 ${key} 不一致`);
      if (task.target.record !== null && readback.target.record !== task.target.record) errors.push('回读题号不一致');
    }
  }
  if (!Array.isArray(readback.images)) errors.push('回读图片必须是数组');
  else {
    const markerCount = readback.images.filter(item => item?.marker === true).length;
    const questionCount = readback.images.filter(item => item?.marker === false).length;
    const expectedCount = task.blocks.filter(block => block.type === 'image').length;
    if (markerCount !== 1) errors.push(`题目开始标记应为 1 个，实际 ${markerCount} 个`);
    if (questionCount !== expectedCount) errors.push(`正文图片应为 ${expectedCount} 张，实际 ${questionCount} 张`);
    for (const [index, item] of readback.images.entries()) {
      if (!isObject(item) || typeof item.marker !== 'boolean') errors.push(`图片 ${index + 1} 缺少 marker 布尔字段`);
      else if (item.complete !== true || !Number.isFinite(item.width) || !Number.isFinite(item.height) || item.width <= 0 || item.height <= 0) loadingErrors.push(`图片 ${index + 1} 尚未完整加载`);
    }
  }
  return { ok: errors.length === 0 && loadingErrors.length === 0, pending: errors.length === 0 && loadingErrors.length > 0, errors: [...errors, ...loadingErrors] };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  if (value === undefined) throw new Error('manifest 不允许 undefined 字段，请保存为标准 JSON');
  return JSON.stringify(value);
}

export function manifestHash(manifest) {
  // Review permission can change while the immutable content/target remains the same.
  // Every runNext checks current approval again before writing.
  const content = {
    ...manifest,
    tasks: manifest.tasks.map(task => {
      const review = { ...task.review };
      delete review.status;
      delete review.issues;
      return { ...task, review };
    }),
  };
  return createHash('sha256').update(stableJson(content)).digest('hex');
}

export function createRun(manifest) {
  const validation = inspectManifest(manifest, process.cwd(), false);
  if (!validation.valid) throw new Error(`题单无效: ${validation.errors.join('; ')}`);
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: randomUUID(),
    manifestHash: manifestHash(manifest),
    bookId: manifest.bookId,
    source: manifest.source,
    status: manifest.tasks.length ? 'pending' : 'completed',
    createdAt: now,
    updatedAt: now,
    tasks: manifest.tasks.map(task => ({ taskId: task.id, status: 'pending', receipt: null, attempts: 0, recoveryRequired: false, lastError: null })),
  };
}

export function summarizeManifest(manifest) {
  return {
    bookId: manifest.bookId,
    source: manifest.source,
    tasks: manifest.tasks.length,
    approved: manifest.tasks.filter(task => task.review.status === 'approved').length,
    pendingReview: manifest.tasks.filter(task => task.review.status !== 'approved').length,
    imageBlocks: manifest.tasks.reduce((sum, task) => sum + task.blocks.filter(block => block.type === 'image').length, 0),
    textCharacters: manifest.tasks.reduce((sum, task) => sum + expectedText(task).length, 0),
  };
}

export function summarizeRun(run) {
  const counts = Object.fromEntries([...RUN_STATUSES].map(status => [status, 0]));
  for (const entry of run.tasks) counts[entry.status] = (counts[entry.status] ?? 0) + 1;
  return { id: run.id, bookId: run.bookId, source: run.source, status: run.status, total: run.tasks.length, counts };
}

function validateRun(run, manifest) {
  if (!isObject(run) || run.schemaVersion !== 1 || !nonemptyString(run.id)) throw new Error('run 无效');
  if (run.manifestHash !== manifestHash(manifest)) throw new Error('题单内容或目标已修改，原 run 失效；请重新审校并创建 run');
  if (run.bookId !== manifest.bookId || run.source !== manifest.source) throw new Error('run 与题单书籍或来源不一致');
  if (!Array.isArray(run.tasks) || run.tasks.length !== manifest.tasks.length) throw new Error('run 任务列表不一致');
  run.tasks.forEach((entry, index) => {
    if (!isObject(entry) || entry.taskId !== manifest.tasks[index].id || !RUN_STATUSES.has(entry.status)) throw new Error(`run 第 ${index + 1} 条状态无效`);
  });
}

/**
 * Adapter contract:
 *   source: 'fixture' | 'production', optional bookId (must match when supplied).
 *   write(task, context) -> receipt: create/replace one approved body, never submit review.
 *   read(task, context) -> {text, images:[{marker, complete, width, height}], target}.
 *   target: {chapter, unit, record}; required for production directory verification.
 *   reconcile(task, context) -> {status:'found'|'missing'|'ambiguous', receipt?, readback?}.
 * A receipt must identify an appended record durably. Before modifying the website,
 * write may call context.checkpoint(receipt) to persist its located target. A caller
 * must hold a process/file lock on a production run. Core guards same-process runs.
 * In-progress recovery is read-only: missing/ambiguous records never get re-created.
 * An on-disk run is required for production; persist receives a detached JSON snapshot.
 */
export async function runNext(run, manifest, adapter, { persist } = {}) {
  validateRun(run, manifest);
  if (!isObject(adapter) || !['fixture', 'production'].includes(adapter.source)) throw new Error('adapter.source 必须是 fixture 或 production');
  if (manifest.source === 'fixture' && adapter.source === 'production') throw new Error('fixture 题单禁止写入生产平台');
  if (adapter.bookId !== undefined && adapter.bookId !== manifest.bookId) throw new Error('adapter 书籍 ID 不一致');
  if (adapter.source === 'production' && typeof persist !== 'function') throw new Error('生产录入必须提供持久化 persist');
  if (activeRuns.has(run.id)) throw new Error('同一个 run 正在执行，禁止并发录入');
  const entryIndex = run.tasks.findIndex(entry => entry.status !== 'completed');
  if (entryIndex === -1) return run;
  const entry = run.tasks[entryIndex];
  const task = manifest.tasks[entryIndex];
  const save = async () => {
    run.updatedAt = new Date().toISOString();
    run.status = run.tasks.find(item => item.status !== 'completed')?.status ?? 'completed';
    if (persist) await persist(structuredClone(run));
  };
  const context = {
    runId: run.id, bookId: manifest.bookId, taskId: task.id, receipt: entry.receipt,
    checkpoint: async receipt => {
      entry.receipt = receipt;
      context.receipt = receipt;
      await save();
    },
  };
  const verify = async readback => {
    const result = compareReadback(task, readback);
    if (adapter.source === 'production' && !isObject(readback?.target)) {
      result.ok = false;
      result.pending = false;
      result.errors.push('生产回读缺少 target，无法核对题目目录');
    }
    entry.lastError = result.ok ? null : result.errors.join('; ');
    entry.recoveryRequired = false;
    entry.status = result.ok ? 'completed' : result.pending ? 'verifying' : 'failed';
    if (result.ok) entry.completedAt = new Date().toISOString();
    await save();
  };
  activeRuns.add(run.id);
  try {
    // Writing may already have changed the website before the process stopped.
    // Even a failed attempt with uncertain effects must reconcile, never blindly write.
    if (['writing', 'verifying'].includes(entry.status) || entry.recoveryRequired) {
      if (typeof adapter.reconcile !== 'function') throw new Error('恢复录入需要 adapter.reconcile，不能自动重建');
      const recovered = await adapter.reconcile(task, context);
      if (!isObject(recovered) || !['found', 'missing', 'ambiguous'].includes(recovered.status)) throw new Error('reconcile 返回结果无效');
      if (recovered.receipt !== undefined) {
        entry.receipt = recovered.receipt;
        context.receipt = recovered.receipt;
      }
      if (recovered.status !== 'found') {
        entry.status = recovered.status === 'ambiguous' ? 'review_required' : 'failed';
        entry.recoveryRequired = recovered.status === 'ambiguous';
        entry.lastError = recovered.status === 'ambiguous' ? '恢复时发现多个可能记录，需人工确认；未重新创建' : '写入曾开始但未找到已录记录，需人工确认；未重新创建';
        await save();
        return run;
      }
      entry.status = 'verifying';
      await save();
      if (typeof adapter.read !== 'function' && !recovered.readback) throw new Error('adapter.read 缺失');
      await verify(recovered.readback ?? await adapter.read(task, context));
      return run;
    }
    if (entry.status === 'failed') return run;
    if (!approvedForWrite(task)) {
      entry.status = 'review_required';
      entry.lastError = '题目尚未审校通过，未写入平台';
      await save();
      return run;
    }
    entry.status = 'ready';
    entry.lastError = null;
    await save();
    // Approval can be revoked by the local review UI during asynchronous persistence.
    if (!approvedForWrite(task)) {
      entry.status = 'review_required';
      entry.lastError = '题目审校许可已撤回，未写入平台';
      await save();
      return run;
    }
    if (typeof adapter.write !== 'function' || typeof adapter.read !== 'function') throw new Error('adapter 必须实现 write 和 read');
    entry.status = 'writing';
    entry.recoveryRequired = true;
    entry.attempts += 1;
    // If this persistence fails, write is not called. The durable state remains safe.
    await save();
    const receipt = await adapter.write(task, context);
    if (receipt !== undefined) {
      entry.receipt = receipt;
      context.receipt = receipt;
    }
    entry.status = 'verifying';
    await save();
    await verify(await adapter.read(task, context));
    return run;
  } catch (error) {
    entry.lastError = error instanceof Error ? error.message : String(error);
    // Preserve uncertainty after any attempt that could have written to the platform.
    entry.recoveryRequired ||= ['writing', 'verifying'].includes(entry.status);
    entry.status = 'failed';
    try { await save(); } catch { /* Original error is more useful than a second persistence failure. */ }
    throw error;
  } finally {
    activeRuns.delete(run.id);
  }
}
