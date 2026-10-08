import { readFileSync, realpathSync, statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { resolveAssetPath } from './core.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const sameText = value => String(value).replace(/\r\n?/gu, '\n').replace(/[\u00a0\u3000]/gu, ' ')
  .replace(/[ \t]+/gu, ' ').replace(/ *\n */gu, '\n').replace(/\n{2,}/gu, '\n').trim();
// NBSP has one half-width space's layout while surviving HTML whitespace
// collapse and wangEditor's paste style filter. Full-width spaces are not
// equivalent when the caller has explicitly requested an eight-space gap.
export const ANSWER_PART_SPACE_COUNT = 8;
const answerPartSeparator = '\u00a0'.repeat(ANSWER_PART_SPACE_COUNT);
const spacedText = value => String(value).replace(/\r\n?/gu, '\n').replace(/\u00a0/gu, ' ')
  .replace(/ *\n */gu, '\n').replace(/\n{2,}/gu, '\n').trim();
const validAnswerParts = value => Array.isArray(value) && value.length >= 2
  && value.every(part => nonempty(part) && part === part.trim() && !/[\r\n\t]/u.test(part));
const doneStatuses = new Set(['completed', 'skipped_existing']);
const entryStatuses = new Set(['pending', 'writing', 'verifying', 'completed', 'skipped_existing', 'review_required', 'failed']);
const activeRuns = new Set();
const escape = value => value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&#39;');

/** Resolve relative PNG/JPEG assets, including their real path, before reading bytes. */
function asset(filename, baseDir) {
  const resolved = resolveAssetPath(filename, baseDir);
  const ext = path.extname(resolved).toLowerCase();
  if (!['.png', '.jpg', '.jpeg'].includes(ext)) throw new Error('图片只支持 PNG/JPEG');
  if (!statSync(resolved).isFile()) throw new Error('图片不是文件');
  const root = realpathSync(baseDir);
  const actual = realpathSync(resolved);
  const relative = path.relative(root, actual);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('图片软链接越界');
  const bytes = readFileSync(actual);
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if ((ext === '.png' && !png) || (ext !== '.png' && !jpeg)) throw new Error('图片字节与 PNG/JPEG 扩展名不一致');
  return { path: filename, mime: png ? 'image/png' : 'image/jpeg', bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function blockText(block) {
  if (block.type === 'image') return '';
  if (block.parts !== undefined) return block.parts.join(answerPartSeparator);
  return block.runs ? block.runs.map(run => run.text).join('') : block.text;
}

function inspect(manifest, baseDir, checkFiles) {
  const errors = [];
  const warnings = [];
  if (!object(manifest)) return { valid: false, errors: ['manifest 必须是对象'], warnings };
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'new-system-batch') errors.push('必须使用 schemaVersion:1、kind:new-system-batch');
  if (!positive(manifest.bookId)) errors.push('bookId 必须是正整数');
  if (!['fixture', 'production'].includes(manifest.source)) errors.push('source 必须是 fixture 或 production');
  if (!Array.isArray(manifest.tasks) || !manifest.tasks.length) return { valid: false, errors: [...errors, 'tasks 必须是非空数组'], warnings };
  const ids = new Set();
  const targets = new Set();
  const sections = new Map();
  for (const [index, task] of manifest.tasks.entries()) {
    const prefix = `tasks[${index}]`;
    if (!object(task)) { errors.push(`${prefix} 必须是对象`); continue; }
    if (!nonempty(task.id) || !/^[A-Za-z0-9_-]+$/u.test(task.id) || ids.has(task.id)) errors.push(`${prefix}.id 无效或重复`);
    ids.add(task.id);
    if (!object(task.target)) errors.push(`${prefix}.target 必须是对象`);
    else {
      const target = task.target;
      if (!nonempty(target.chapterLabel) || !nonempty(target.sectionLabel) || !positive(target.record)) errors.push(`${prefix}.target 必须明确 chapterLabel、sectionLabel 和正整数 record`);
      if (target.expectedRecordId !== undefined && !positive(target.expectedRecordId)) errors.push(`${prefix}.target.expectedRecordId 必须是正整数`);
      const section = JSON.stringify([target.chapterLabel, target.sectionLabel]);
      const key = JSON.stringify([target.chapterLabel, target.sectionLabel, target.record]);
      if (targets.has(key)) errors.push(`${prefix}.target 与其他任务冲突`);
      targets.add(key);
      if (sections.has(section) && target.record !== sections.get(section) + 1) errors.push(`${prefix}: 同一节只能按连续题序处理`);
      sections.set(section, target.record);
    }
    if (!object(task.source)) errors.push(`${prefix}.source 必须是对象`);
    else for (const field of ['pages', 'answerPages']) {
      const pages = task.source[field];
      if (!Array.isArray(pages) || !pages.length || pages.some(page => !positive(page)) || new Set(pages).size !== pages.length) errors.push(`${prefix}.source.${field} 必须是非空、不重复正整数数组`);
    }
    for (const side of ['stem', 'answer']) {
      const blocks = task[side]?.blocks;
      if (!Array.isArray(blocks) || !blocks.length) { errors.push(`${prefix}.${side}.blocks 不能为空`); continue; }
      for (const [blockIndex, block] of blocks.entries()) {
        const at = `${prefix}.${side}.blocks[${blockIndex}]`;
        if (!object(block)) { errors.push(`${at} 必须是对象`); continue; }
        if (block.parts !== undefined && (side !== 'answer' || block.type !== 'text')) errors.push(`${at}.parts 只允许用于答案的 text 段落`);
        if (block.type === 'text') {
          if (block.strictSpacing !== undefined && (side !== 'answer' || typeof block.strictSpacing !== 'boolean')) errors.push(`${at}.strictSpacing 仅允许答案文本的布尔值`);
          if (block.parts !== undefined) {
            if (block.text !== undefined || block.runs !== undefined || !validAnswerParts(block.parts)) errors.push(`${at}.parts 必须是至少两个已确认的单行答案，不含首尾空白，不能同时含 text/runs`);
          } else if (block.runs !== undefined) {
            if (block.text !== undefined || !Array.isArray(block.runs) || !block.runs.length || block.runs.some(run => !object(run) || !['text', 'sup', 'sub'].includes(run.type) || !nonempty(run.text))) errors.push(`${at}.runs 必须是 text/sup/sub 文本数组，不能同时含 text`);
          } else if (!nonempty(block.text)) errors.push(`${at}.text 不能为空`);
          if (block.align !== undefined && !['left', 'start'].includes(block.align)) errors.push(`${at}: 文字必须左对齐`);
        } else if (['sup', 'sub'].includes(block.type)) {
          if (!nonempty(block.text)) errors.push(`${at}.text 不能为空`);
        } else if (block.type === 'image') {
          if (block.align !== 'center') errors.push(`${at}: 图片必须明确 align:center`);
          try {
            if (checkFiles) asset(block.path, baseDir);
            else {
              resolveAssetPath(block.path, baseDir);
              if (!['.png', '.jpg', '.jpeg'].includes(path.extname(block.path).toLowerCase())) throw new Error('图片只支持 PNG/JPEG');
            }
          } catch (error) { errors.push(`${at}: ${error.message}`); }
        } else errors.push(`${at}: 不支持 ${String(block.type)}；复杂公式必须人工处理，不能伪造`);
      }
    }
    if (!object(task.review) || !['approved', 'pending'].includes(task.review.status) || !Array.isArray(task.review.issues) || task.review.issues.some(issue => !nonempty(issue))) errors.push(`${prefix}.review 必须明确 approved/pending 和 issues 数组`);
    else if (task.review.status === 'approved' && task.review.issues.length) errors.push(`${prefix}: approved 仍有未解决 issues`);
    else if (task.review.status === 'pending') warnings.push(`${prefix}: 尚未审校，不会写入`);
  }
  return { valid: errors.length === 0, errors, warnings };
}

export function validateNewSystemManifest(manifest, baseDir = process.cwd()) { return inspect(manifest, baseDir, true); }

/** Each block has its own paragraph so centered images cannot center subsequent options. */
export function renderBlockHtml(block, baseDir = process.cwd()) {
  if (block?.type === 'image') {
    if (block.align !== 'center') throw new Error('图片必须明确居中');
    const image = asset(block.path, baseDir);
    // wangEditor filters pasted style attributes. The HTML alignment attribute
    // survives that filter and supplies the same browser presentation hint.
    return `<p style="text-align:center;direction:ltr" dir="ltr" align="center"><img src="data:${image.mime};base64,${image.bytes.toString('base64')}" style="max-width:100%"></p>`;
  }
  const inline = run => {
    if (!object(run) || !['text', 'sup', 'sub'].includes(run.type) || !nonempty(run.text)) throw new Error('只支持 text/sup/sub 文本');
    const text = escape(run.text).replace(/\r\n?|\n/gu, '<br>');
    return run.type === 'text' ? text : `<${run.type}>${text}</${run.type}>`;
  };
  if (!object(block) || !['text', 'sup', 'sub'].includes(block.type)) throw new Error('复杂公式或未知内容类型不支持');
  if (block.parts !== undefined && (block.type !== 'text' || block.text !== undefined || block.runs !== undefined || !validAnswerParts(block.parts))) throw new Error('parts 必须是至少两个已确认的单行答案，不含首尾空白，不能同时含 text/runs');
  if (block.type === 'text' && block.runs !== undefined && (block.text !== undefined || !Array.isArray(block.runs) || !block.runs.length)) throw new Error('runs 无效或与 text 冲突');
  if (block.align !== undefined && !['left', 'start'].includes(block.align)) throw new Error('文字必须左对齐');
  const contents = block.parts !== undefined ? block.parts.map(escape).join('&nbsp;'.repeat(ANSWER_PART_SPACE_COUNT)) : block.runs ? block.runs.map(inline).join('') : inline(block);
  return `<p style="text-align:left;direction:ltr" dir="ltr" align="left">${contents}</p>`;
}

export function renderEditorHtml(editor, baseDir = process.cwd()) {
  if (!Array.isArray(editor?.blocks) || !editor.blocks.length) throw new Error('编辑器内容不能为空');
  return editor.blocks.map(block => renderBlockHtml(block, baseDir)).join('');
}

export function expectedEditor(editor, baseDir = process.cwd()) {
  // Rendering validates all block types and formatting, even if called directly.
  renderEditorHtml(editor, baseDir);
  return {
    text: editor.blocks.filter(block => block.type !== 'image').map(blockText).join('\n'),
    images: editor.blocks.filter(block => block.type === 'image').map(block => {
      const image = asset(block.path, baseDir);
      return { sha256: image.sha256, path: block.path };
    }),
    paragraphs: editor.blocks.map(block => ({ text: blockText(block), imageCount: block.type === 'image' ? 1 : 0, align: block.type === 'image' ? 'center' : 'left', direction: 'ltr', ...(block.parts !== undefined || block.strictSpacing === true ? { strictSpacing: true } : {}) })),
  };
}

const unescape = text => text.replace(/&#(?:x([0-9a-f]+)|(\d+));/giu, (entity, hex, decimal) => {
  const code = Number.parseInt(hex ?? decimal, hex ? 16 : 10);
  return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
})
  .replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"').replace(/&#39;/gu, "'").replace(/&amp;/gu, '&');
function expectedScripts(editor) {
  return editor.blocks.flatMap(block => block.type === 'image' ? [] : block.runs ? block.runs.filter(run => run.type !== 'text').map(run => [run.type, sameText(run.text)]) : ['sup', 'sub'].includes(block.type) ? [[block.type, sameText(block.text)]] : []);
}

/** Content, image identity/order/loading, paragraph isolation/alignment and target checks. */
export function compareNewSystemReadback(task, readback, { baseDir = process.cwd(), bookId } = {}) {
  const errors = [];
  if (!object(readback) || readback.status !== 'found') return { ok: false, errors: ['未找到明确的回读记录'] };
  if (positive(bookId) && readback.bookId !== bookId) errors.push('回读 bookId 不一致');
  if (!positive(readback.recordId)) errors.push('回读缺少持久化题目 ID');
  if (task.target.expectedRecordId !== undefined && readback.recordId !== task.target.expectedRecordId) errors.push('回读题目 ID 与 expectedRecordId 不一致');
  for (const field of ['chapterLabel', 'sectionLabel', 'record']) if (readback.target?.[field] !== task.target[field]) errors.push(`回读目录 ${field} 不一致`);
  if ((readback.source?.pages?.[0] ?? readback.mainPicNum) !== task.source.pages[0]) errors.push('回读正文来源页不一致');
  if ((readback.source?.answerPages?.[0] ?? readback.answerPicNum) !== task.source.answerPages[0]) errors.push('回读答案来源页不一致');
  for (const side of ['stem', 'answer']) {
    const expected = expectedEditor(task[side], baseDir);
    const actual = readback[side];
    if (!object(actual)) { errors.push(`回读 ${side} 缺失`); continue; }
    if (typeof actual.text !== 'string' || sameText(actual.text) !== sameText(expected.text)) errors.push(`${side} 文本与题单不一致`);
    if (task[side].blocks.some(block => block.parts !== undefined) && (typeof actual.text !== 'string' || spacedText(actual.text) !== spacedText(expected.text))) errors.push(`${side} 分段答案或8个半角空格间隔不一致`);
    if (!Array.isArray(actual.images)) errors.push(`${side} 图片列表缺失`);
    else {
      if (actual.images.length !== expected.images.length) errors.push(`${side} 图片数量不一致`);
      actual.images.forEach((image, index) => {
        if (!object(image)) { errors.push(`${side} 图片 ${index + 1} 回读数据无效`); return; }
        if (image.sha256 !== expected.images[index]?.sha256) errors.push(`${side} 图片 ${index + 1} 字节或顺序不一致`);
        if (image.complete !== true || !Number.isFinite(image.width) || image.width <= 0 || !Number.isFinite(image.height) || image.height <= 0) errors.push(`${side} 图片 ${index + 1} 未完整加载`);
        if (image.align !== 'center') errors.push(`${side} 图片 ${index + 1} 未居中`);
      });
    }
    if (!Array.isArray(actual.paragraphs)) errors.push(`${side} 段落样式回读缺失`);
    else {
      const paragraphs = actual.paragraphs.filter(item => sameText(item?.text ?? '') || Number(item?.imageCount) > 0);
      if (paragraphs.length !== expected.paragraphs.length) errors.push(`${side} 段落数量或图片独立段落不一致`);
      paragraphs.forEach((item, index) => {
        if (!object(item)) { errors.push(`${side} 段落 ${index + 1} 回读数据无效`); return; }
        const want = expected.paragraphs[index];
        if (!want || sameText(item?.text ?? '') !== sameText(want.text) || item.imageCount !== want.imageCount) errors.push(`${side} 段落 ${index + 1} 内容或图片位置不一致`);
        if (want?.strictSpacing && spacedText(item?.text ?? '') !== spacedText(want.text)) errors.push(`${side} 段落 ${index + 1} 分段答案或8个半角空格间隔不一致`);
        if (item?.imageCount > 0 && (item.imageCount !== 1 || sameText(item.text ?? '') || item.align !== 'center')) errors.push(`${side} 图片必须独占居中段落`);
        if (sameText(item?.text ?? '') && (!['left', 'start'].includes(item.align) || item.direction !== 'ltr')) errors.push(`${side} 文字段落必须左对齐且 direction:ltr`);
      });
    }
    const scripts = expectedScripts(task[side]);
    if (scripts.length || typeof actual.html === 'string') {
      const found = typeof actual.html === 'string' ? [...actual.html.matchAll(/<(sup|sub)\b[^>]*>([\s\S]*?)<\/\1>/giu)].map(match => [match[1].toLowerCase(), sameText(unescape(match[2].replace(/<[^>]*>/gu, '')))]) : [];
      if (JSON.stringify(scripts) !== JSON.stringify(found)) errors.push(`${side} 上下标标签与原文不一致`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** New saves may omit request shitiID, but must acquire a positive response ID. */
export function verifyNewSystemSave(task, receipt, { bookId, existingRecordId } = {}) {
  const errors = [];
  const fail = text => errors.push(text);
  if (!object(receipt) || !object(receipt.request) || !object(receipt.response)) return { ok: false, errors: ['保存回执缺失请求或响应'] };
  const request = receipt.request;
  const response = receipt.response;
  let body = response.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  if (!positive(bookId) || receipt.bookId !== bookId || request.bookId !== bookId) fail('保存 bookId 与预期不一致');
  if (receipt.seqIndex !== task.target.record || request.seqIndex !== task.target.record) fail('保存题序与预期不一致');
  if (!positive(receipt.shitiID)) fail('保存响应必须取得正整数题目 ID');
  for (const [field, expected] of [['mainPicNum', task.source.pages[0]], ['answerPicNum', task.source.answerPages[0]]]) {
    if (receipt[field] !== expected || request[field] !== expected) fail(`保存来源 ${field} 与题单不一致`);
  }
  if (existingRecordId !== undefined && (!positive(existingRecordId) || receipt.shitiID !== existingRecordId || request.shitiID !== existingRecordId)) fail('已有题目的保存 ID 必须保持一致');
  if (request.shitiID !== undefined && (!positive(request.shitiID) || request.shitiID !== receipt.shitiID)) fail('请求题目 ID 与保存响应不一致');
  if (task.target.expectedRecordId !== undefined && receipt.shitiID !== task.target.expectedRecordId) fail('保存题目 ID 与 expectedRecordId 不一致');
  if (!Number.isSafeInteger(response.status) || response.status < 200 || response.status > 299) fail('保存 HTTP 状态不是 2xx');
  if (!object(body) || body.errno !== 0 || body.errmsg !== 'success') fail('保存业务状态必须 errno:0、errmsg:success，不能仅凭 HTTP 200');
  if (!object(body?.data) || body.data.seqIndex !== task.target.record || body.data.shitiID !== receipt.shitiID || !positive(body.data.shitiID)) fail('保存响应题序或持久化 ID 不一致');
  if (body?.data?.haveAnswer !== true) fail('保存响应未确认答案');
  return { ok: errors.length === 0, errors };
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  if (value === undefined) throw new Error('题单不能含 undefined 字段');
  return JSON.stringify(value);
}
function hashManifest(manifest, baseDir) {
  const content = { ...manifest, tasks: manifest.tasks.map(({ review, ...task }) => task) };
  const files = manifest.tasks.flatMap(task => ['stem', 'answer'].flatMap(side => task[side].blocks.filter(block => block.type === 'image').map(block => ({ path: block.path, sha256: asset(block.path, baseDir).sha256 }))));
  return createHash('sha256').update(stable({ content, files })).digest('hex');
}

export function createNewSystemRun(manifest, { baseDir = process.cwd() } = {}) {
  const validation = validateNewSystemManifest(manifest, baseDir);
  if (!validation.valid) throw new Error(`题单无效: ${validation.errors.join('; ')}`);
  const now = new Date().toISOString();
  return { schemaVersion: 1, kind: 'new-system-run', id: randomUUID(), bookId: manifest.bookId, source: manifest.source,
    manifestHash: hashManifest(manifest, baseDir), status: 'pending', createdAt: now, updatedAt: now,
    tasks: manifest.tasks.map(task => ({ taskId: task.id, status: 'pending', receipt: null, attempts: 0, recoveryRequired: false, lastError: null })) };
}

function validRecoveryConfirmation(confirmation, task, state, manifest, recordId) {
  return object(confirmation) && confirmation.kind === 'new-system-server-readback-recovery'
    && confirmation.schemaVersion === 1 && confirmation.manifestHash === state.manifestHash
    && confirmation.taskId === task.id && confirmation.bookId === manifest.bookId
    && confirmation.recordId === recordId && positive(recordId)
    && JSON.stringify(confirmation.target) === JSON.stringify(task.target)
    && positive(confirmation.nodeID) && confirmation.priorRecordsUnchanged === true
    && confirmation.targetRecordUnique === true && confirmation.fullContentCompared === true
    && Array.isArray(confirmation.priorRecordIds)
    && confirmation.priorRecordIds.length === task.target.record - 1
    && confirmation.priorRecordIds.every(positive)
    && new Set(confirmation.priorRecordIds).size === confirmation.priorRecordIds.length
    && !confirmation.priorRecordIds.includes(recordId) && nonempty(confirmation.evidencePath);
}

/** Apply independently confirmed server readback; never invent an HTTP receipt. */
export function reconcileNewSystemRun({ manifest, state, taskId, recovery, baseDir = process.cwd() }) {
  const validation = validateNewSystemManifest(manifest, baseDir);
  if (!validation.valid) throw new Error(`题单无效: ${validation.errors.join('; ')}`);
  if (!object(state) || state.kind !== 'new-system-run' || state.schemaVersion !== 1 || !nonempty(state.id) || state.bookId !== manifest.bookId || state.source !== manifest.source || state.manifestHash !== hashManifest(manifest, baseDir) || !Array.isArray(state.tasks) || state.tasks.length !== manifest.tasks.length || state.tasks.some((entry,index)=>!object(entry) || entry.taskId !== manifest.tasks[index].id || !entryStatuses.has(entry.status) || !Number.isSafeInteger(entry.attempts) || entry.attempts < 0 || typeof entry.recoveryRequired !== 'boolean')) throw new Error('恢复 run 与题单、目录或资产字节不一致');
  if (activeRuns.has(state.id)) throw new Error('运行尚未终止，禁止并发恢复');
  const index=manifest.tasks.findIndex(task=>task.id === taskId);
  if (index < 0) throw new Error('恢复 taskId 不属于当前题单');
  const task=manifest.tasks[index], entry=state.tasks[index], proof=recovery?.recovery;
  if (task.review.status !== 'approved' || task.review.issues.length || !object(proof) || proof.writeUnlocked !== true || proof.taskId !== taskId || proof.bookId !== manifest.bookId || !positive(proof.nodeID) || proof.priorRecordsUnchanged !== true || !Array.isArray(proof.priorRecordIds) || proof.priorRecordIds.length !== task.target.record - 1 || proof.priorRecordIds.some(id=>!positive(id)) || new Set(proof.priorRecordIds).size !== proof.priorRecordIds.length || !nonempty(proof.evidencePath) || recovery.bookId !== manifest.bookId || JSON.stringify(recovery.target) !== JSON.stringify(task.target)) throw new Error('恢复缺少已解锁的完整、绑定目录的 adapter 证明');
  const now=new Date().toISOString();
  let confirmation=null;
  if (proof.outcome === 'saved') {
    if (recovery.status !== 'found' || recovery.count !== task.target.record || !positive(recovery.recordId) || recovery.recordId !== proof.recordId || proof.priorRecordIds.includes(recovery.recordId) || proof.targetRecordUnique !== true || proof.fullContentCompared !== true) throw new Error('保存恢复缺少唯一服务器记录身份或全文核对证明');
    const compared=compareNewSystemReadback(task,recovery,{baseDir,bookId:manifest.bookId});
    if (!compared.ok) throw new Error('恢复全文回读不符: '+compared.errors.join('; '));
    if (entry.receipt) {
      const verified=verifyNewSystemSave(task,entry.receipt,{bookId:manifest.bookId});
      if (!verified.ok || entry.receipt.shitiID !== recovery.recordId) throw new Error('已有保存回执与恢复服务器身份不符');
    }
    confirmation={kind:'new-system-server-readback-recovery',schemaVersion:1,manifestHash:state.manifestHash,taskId,bookId:manifest.bookId,target:structuredClone(task.target),recordId:recovery.recordId,nodeID:proof.nodeID,priorRecordIds:[...proof.priorRecordIds],priorRecordsUnchanged:true,targetRecordUnique:true,fullContentCompared:true,evidencePath:proof.evidencePath,confirmedAt:now,readbackSha256:createHash('sha256').update(stable(recovery)).digest('hex')};
  } else if (proof.outcome === 'not_saved') {
    if (recovery.status !== 'missing' || recovery.count !== task.target.record - 1 || proof.liveNoSaveRequests !== true || proof.recordId !== null || entry.receipt || entry.recoveryConfirmation) throw new Error('未保存恢复必须有同连接无保存请求证明，且不能抹去已保存证据');
  } else throw new Error('未知写入效果不能恢复');
  if (entry.recoveryHistory !== undefined && !Array.isArray(entry.recoveryHistory)) throw new Error('恢复历史数据无效');
  entry.recoveryHistory ??= [];
  entry.recoveryHistory.push({outcome:proof.outcome,taskId,bookId:manifest.bookId,manifestHash:state.manifestHash,priorStatus:entry.status,priorAttempts:entry.attempts,recordId:recovery.recordId ?? null,evidencePath:proof.evidencePath,confirmedAt:now});
  if (confirmation) { entry.recoveryConfirmation=confirmation; entry.status='completed'; }
  else { entry.status='pending'; entry.attempts=0; delete entry.recoveryConfirmation; }
  entry.recoveryRequired=false;entry.lastError=null;state.updatedAt=now;
  state.status=state.tasks.every(item=>doneStatuses.has(item.status))?'completed':'pending';
  return state;
}

/**
 * Adapter: source/bookId; read(task,{refresh}) -> found/missing, count on missing;
 * append(task,{checkpoint}) -> reduced save receipt. Only one append per task.
 * checkpoint must be awaited immediately after receiving a save ID. No overwrite,
 * deletion, review submission, model call or recovery re-creation is supported.
 */
export async function runNewSystemBatch({ manifest, adapter, state, persist, baseDir = process.cwd(), limit = Infinity, stopRequested = () => false, verifyOnly = false }) {
  const validation = validateNewSystemManifest(manifest, baseDir);
  if (!validation.valid) throw new Error(`题单无效: ${validation.errors.join('; ')}`);
  if (!object(adapter) || adapter.source !== manifest.source || typeof adapter.read !== 'function' || (!verifyOnly && typeof adapter.append !== 'function')) throw new Error('adapter 来源或 read/append 接口无效');
  if (adapter.bookId !== undefined && adapter.bookId !== manifest.bookId) throw new Error('adapter bookId 不一致');
  if (manifest.source === 'production' && typeof persist !== 'function') throw new Error('production 必须持久化检查点并由 CLI 持有运行锁');
  if ((!Number.isSafeInteger(limit) || limit <= 0) && limit !== Infinity) throw new Error('limit 必须为正整数');
  if (typeof stopRequested !== 'function') throw new Error('stopRequested 必须是函数');
  state ??= createNewSystemRun(manifest, { baseDir });
  if (!object(state) || state.kind !== 'new-system-run' || state.schemaVersion !== 1 || !nonempty(state.id) || state.bookId !== manifest.bookId || state.source !== manifest.source || state.manifestHash !== hashManifest(manifest, baseDir)) throw new Error('run 与题单、目录或资产字节不一致');
  if (!Array.isArray(state.tasks) || state.tasks.length !== manifest.tasks.length || state.tasks.some((entry, index) => !object(entry) || entry.taskId !== manifest.tasks[index].id || !entryStatuses.has(entry.status) || !Number.isSafeInteger(entry.attempts) || entry.attempts < 0 || typeof entry.recoveryRequired !== 'boolean')) throw new Error('run 任务状态无效');
  if (activeRuns.has(state.id)) throw new Error('同一 run 已在运行');
  activeRuns.add(state.id);
  const save = async () => { state.updatedAt = new Date().toISOString(); if (persist) await persist(structuredClone(state)); };
  const halt = async (entry, message, status = 'failed') => {
    entry.status = status; entry.lastError = message; state.status = status; await save(); return state;
  };
  let processed = 0;
  try {
    await save();
    for (const [index, task] of manifest.tasks.entries()) {
      const entry = state.tasks[index];
      const countsTowardLimit = verifyOnly || !doneStatuses.has(entry.status);
      if ((countsTowardLimit && processed >= limit) || await stopRequested()) { state.status = 'stopped'; await save(); return state; }
      if (task.review.status !== 'approved' || task.review.issues.length) return await halt(entry, '题目未通过审校，停止写入', 'review_required');
      if (countsTowardLimit) processed += 1;
      let before;
      try { before = await adapter.read(task, { refresh: true }); }
      catch (error) { return await halt(entry, `回读失败: ${error.message}`); }
      if (!object(before) || !['found', 'missing'].includes(before.status)) return await halt(entry, '回读结果不明确，停止写入');
      if (before.status === 'found') {
        const comparison = compareNewSystemReadback(task, before, { baseDir, bookId: manifest.bookId });
        if (!comparison.ok) return await halt(entry, `同题序已有不同内容，拒绝覆盖: ${comparison.errors.join('; ')}`);
        if (entry.recoveryConfirmation && !validRecoveryConfirmation(entry.recoveryConfirmation, task, state, manifest, before.recordId)) return await halt(entry, '恢复确认与当前题单、任务、书籍或服务器ID不一致');
        if (entry.receipt) {
          const verified = verifyNewSystemSave(task, entry.receipt, { bookId: manifest.bookId });
          if (!verified.ok || before.recordId !== entry.receipt.shitiID) return await halt(entry, `保存回执与刷新回读不一致: ${verified.errors.join('; ')}`);
          entry.status = 'completed';
        } else if (entry.recoveryConfirmation) entry.status='completed';
        else if (entry.recoveryRequired || ['writing', 'verifying', 'completed'].includes(entry.status)) return await halt(entry, '中断写入已找到相同记录，但缺少保存回执；需要人工确认，禁止重复新增');
        else entry.status = 'skipped_existing';
        entry.recoveryRequired = false; entry.lastError = null; await save();
        continue;
      }
      if (verifyOnly) return await halt(entry, '只读核对未找到记录，禁止新增');
      if (entry.recoveryRequired || entry.receipt || entry.attempts > 0 || doneStatuses.has(entry.status) || ['writing', 'verifying'].includes(entry.status)) return await halt(entry, '中断或已保存任务的回读记录缺失；停止恢复，禁止重复新增');
      if (task.target.expectedRecordId !== undefined) return await halt(entry, '预期已有题目 ID 的记录缺失，禁止创建替代题目');
      if (!Number.isSafeInteger(before.count) || before.count < 0 || before.count !== task.target.record - 1) return await halt(entry, '目标目录只允许连续新增，当前记录数与题序不一致');
      if (before.bookId !== manifest.bookId || ['chapterLabel', 'sectionLabel'].some(field => before.target?.[field] !== task.target[field])) return await halt(entry, '新增前回读目录或书籍不一致');
      entry.status = 'writing'; entry.attempts += 1; entry.recoveryRequired = true; entry.lastError = null; state.status = 'writing';
      await save(); // Durable write intent precedes all side effects.
      try {
        const checkpoint = async receipt => {
          const checked = verifyNewSystemSave(task, receipt, { bookId: manifest.bookId });
          if (!checked.ok) throw new Error(checked.errors.join('; '));
          if (entry.receipt && entry.receipt.shitiID !== receipt.shitiID) throw new Error('同一任务出现多个保存 ID，停止');
          entry.receipt = structuredClone(receipt); entry.status = 'verifying'; state.status = 'verifying'; await save();
        };
        const receipt = await adapter.append(task, { checkpoint });
        await checkpoint(receipt);
        let after;
        if (Object.hasOwn(receipt,'reloadReadback')) {
          // Use only this append's actual reload result. Resuming an old run
          // always starts with adapter.read(refresh:true) above; stored proofs
          // never substitute for a new server read after an interruption.
          const proof=structuredClone(entry.receipt.reloadReadback);
          if (!object(proof)||proof.schemaVersion!==1||proof.kind!=='new-system-reload-readback'||proof.taskId!==task.id||proof.bookId!==manifest.bookId||!positive(proof.recordId)||proof.recordId!==entry.receipt.shitiID||!nonempty(proof.checkedAt)||!object(proof.readback)||proof.readback.status!=='found'||proof.readback.bookId!==manifest.bookId||proof.readback.recordId!==proof.recordId||proof.readback.count!==task.target.record) throw new Error('本次新增的刷新回读证明未完整绑定任务及保存ID');
          after=proof.readback;
        } else after = await adapter.read(task, { refresh: true });
        const compared = compareNewSystemReadback(task, after, { baseDir, bookId: manifest.bookId });
        if (!compared.ok || after.recordId !== entry.receipt.shitiID) throw new Error(`刷新回读未确认保存记录: ${compared.errors.join('; ')}`);
        entry.status = 'completed'; entry.recoveryRequired = false; entry.lastError = null; await save();
      } catch (error) { return await halt(entry, `写入未完成确认: ${error.message}`); }
    }
    state.status = state.tasks.every(entry => doneStatuses.has(entry.status)) ? 'completed' : 'pending';
    await save(); return state;
  } finally { activeRuns.delete(state.id); }
}
