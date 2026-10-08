import { isDeepStrictEqual } from 'node:util';
import { renderBlockHtml } from './new-system-core.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const describe = value => value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
const escape = value => describe(value).replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
  .replace(/"/gu, '&quot;').replace(/'/gu, '&#39;');
const get = (value, field) => field.split('.').reduce((current, key) => current?.[key], value);
const fields = [
  ['target', '平台位置'], ['source', '来源页'], ['stem', '题干'], ['answer', '答案'],
  ['answerRequirement', '作答要求'], ['answerStatus', '答案状态'],
  ['preparation.originalPairing', '答案配对'], ['preparation.records', '原始转录与来源区域'],
  ['preparation.agentReview', '原图审校说明'], ['preparation.originalReview', '原始配对审校记录'],
  ['preparation.notes', '缺答规则与审校说明'], ['review', '审校记录'],
];

function tasksOf(manifest) {
  if (!object(manifest) || manifest.kind !== 'new-system-batch' || manifest.schemaVersion !== 1
      || !Number.isSafeInteger(manifest.bookId) || manifest.bookId < 1 || !['fixture', 'production'].includes(manifest.source)
      || !Array.isArray(manifest.tasks) || !manifest.tasks.length) throw new Error('版本比较要求明确书号、source 和非空题单');
  const result = new Map();
  for (const [index, task] of manifest.tasks.entries()) {
    if (!object(task) || typeof task.id !== 'string' || !task.id.trim() || result.has(task.id)) throw new Error('版本比较要求唯一非空 task ID');
    result.set(task.id, { task, index });
  }
  return result;
}

function coveragePages(manifest) {
  if (!object(manifest.coverage) || !Array.isArray(manifest.coverage.pages)) throw new Error('版本比较要求 coverage.pages 数组');
  const result = new Map();
  for (const page of manifest.coverage.pages) {
    if (!object(page) || !Number.isSafeInteger(page.page) || page.page < 1 || result.has(page.page)
        || !Array.isArray(page.candidates)) throw new Error('覆盖页须唯一且页码有效、candidates 为数组；请先修正结构再比较');
    if (page.candidates.some(candidate => !object(candidate) || !Array.isArray(candidate.taskIds)
        || candidate.taskIds.some(id => typeof id !== 'string' || !id.trim()))) throw new Error('覆盖候选须有明确 taskIds 字符串数组，不能比较无效身份');
    result.set(page.page, page);
  }
  return result;
}

/** Frozen-document comparison only; this never migrates checks or approval. */
export function compareReviewedBatches(before, after, { beforeSha256, afterSha256 } = {}) {
  const previous = tasksOf(before), current = tasksOf(after);
  if (before.bookId !== after.bookId || before.source !== after.source) throw new Error('只能比较同书、同 source 的题单，不能升级 fixture');
  const coverageChanges = [], affectedByCoverage = new Set();
  const pagesBefore = coveragePages(before), pagesAfter = coveragePages(after);
  for (const page of new Set([...pagesBefore.keys(), ...pagesAfter.keys()])) {
    const old = pagesBefore.get(page), next = pagesAfter.get(page);
    if (isDeepStrictEqual(old, next)) continue;
    const taskIds = [...new Set([...(old?.candidates ?? []), ...(next?.candidates ?? [])]
      .flatMap(candidate => Array.isArray(candidate?.taskIds) ? candidate.taskIds : []))];
    taskIds.forEach(id => affectedByCoverage.add(id));
    coverageChanges.push({ page, taskIds, before: old ?? null, after: next ?? null });
  }
  const evidenceChanges = ['index', 'cropEvidence', 'paired', 'mapping'].filter(name =>
    !isDeepStrictEqual(before.preparation?.[name], after.preparation?.[name]));
  // A changed index or crop ledger may affect any original/crop in the batch.
  // Conservatively flag every task; comparison is not proof of unchanged bytes.
  const sourceEvidenceChanged = evidenceChanges.some(name => ['index', 'cropEvidence'].includes(name));
  const tasks = [];
  for (const id of new Set([...previous.keys(), ...current.keys()])) {
    const old = previous.get(id), next = current.get(id), changes = [];
    if (old && next) {
      for (const [field, label] of fields) {
        const left = get(old.task, field), right = get(next.task, field);
        if (!isDeepStrictEqual(left, right)) changes.push({ field, label, before: left ?? null, after: right ?? null });
      }
      if (old.index !== next.index) changes.push({ field: 'position', label: '题单顺序', before: old.index + 1, after: next.index + 1 });
    }
    const status = !old ? 'added' : !next ? 'removed' : changes.length ? 'changed' : 'unchanged';
    const reviewReasons = [];
    if (status !== 'unchanged') reviewReasons.push(status === 'added' ? '新增题目' : status === 'removed' ? '题目移除，需重新核对覆盖' : '题目或审校记录变化');
    if (affectedByCoverage.has(id)) reviewReasons.push('对应逐页覆盖登记变化');
    if (sourceEvidenceChanged) reviewReasons.push('原图索引或裁图证据版本变化');
    tasks.push({ taskId: id, status, beforeIndex: old?.index ?? null, afterIndex: next?.index ?? null, changes, reviewReasons });
  }
  const affectedTaskIds = tasks.filter(task => task.reviewReasons.length).map(task => task.taskId);
  return { schemaVersion: 1, kind: 'reviewed-batch-diff', bookId: after.bookId, source: after.source,
    ...(beforeSha256 ? { beforeSha256 } : {}), ...(afterSha256 ? { afterSha256 } : {}),
    tasks, coverageChanges, evidenceChanges, affectedTaskIds,
    summary: { added: tasks.filter(task => task.status === 'added').length, removed: tasks.filter(task => task.status === 'removed').length,
      changed: tasks.filter(task => task.status === 'changed').length, unchanged: tasks.filter(task => task.status === 'unchanged').length,
      affected: affectedTaskIds.length, coveragePagesChanged: coverageChanges.length },
    draftBytesChanged: beforeSha256 && afterSha256 ? beforeSha256 !== afterSha256 : null,
    automaticApproval: false, platformWritePerformed: false,
    limitations: ['差异仅比较题单声明，不证明原图和裁图的当前字节仍有效',
      '未变化不等于免审；新草稿的批准决定仍绑定当前完整字节哈希',
      '原图与裁图证据变化保守标记整批，覆盖变化同时提示相关跨页题；不复制旧检查或批准'],
  };
}

function editor(task, side, baseDir) {
  if (!task) return '<p class="muted">此版本没有该题。</p>';
  return (Array.isArray(task[side]?.blocks) ? task[side].blocks : []).map(block => {
    try { return renderBlockHtml(block, baseDir); }
    catch (error) { return `<p class="invalid">${escape(error.message)}</p><pre>${escape(JSON.stringify(block, null, 2))}</pre>`; }
  }).join('');
}

export function renderReviewDiff(before, after, report, beforeDir, afterDir = beforeDir) {
  const previous = tasksOf(before), current = tasksOf(after);
  const labels = { added: '新增', removed: '移除', changed: '变化', unchanged: '内容未变，证据需复核' };
  const rows = report.tasks.filter(row => row.reviewReasons.length).map((row, index) => {
    const old = previous.get(row.taskId)?.task, next = current.get(row.taskId)?.task;
    const column = (task, baseDir, label) => `<section><h3>${label}</h3><h4>题干</h4>${editor(task, 'stem', baseDir)}<h4>答案</h4>${editor(task, 'answer', baseDir)}</section>`;
    return `<article id="change-${index}"><h2>${escape(row.taskId)} <span>${escape(labels[row.status])}</span></h2>
      <p>${row.reviewReasons.map(escape).join('；')}</p><p>变化位置：${row.changes.map(change => escape(change.label)).join('、') || '内容字段未变'}</p>
      <div class="columns">${column(old, beforeDir, '上一版本')}${column(next, afterDir, '当前版本')}</div>
      ${row.changes.length ? `<details><summary>查看字段和来源记录变化</summary>${row.changes.map(change => `<h4>${escape(change.label)} · ${escape(change.field)}</h4><div class="columns"><pre>${escape(JSON.stringify(change.before, null, 2))}</pre><pre>${escape(JSON.stringify(change.after, null, 2))}</pre></div>`).join('')}</details>` : ''}</article>`;
  }).join('');
  const coverage = report.coverageChanges.map(row => `<article><h3>来源页 ${escape(row.page)}</h3><p>相关题目：${row.taskIds.map(escape).join('、') || '无映射题目，需核对排除与待定项'}</p><details><summary>查看覆盖登记变化</summary><div class="columns"><pre>${escape(JSON.stringify(row.before, null, 2))}</pre><pre>${escape(JSON.stringify(row.after, null, 2))}</pre></div></details></article>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>题单版本差异</title><style>body{font:16px/1.65 system-ui,sans-serif;background:#f3f5f7;color:#17202b;margin:0}main{max-width:1280px;margin:auto;padding:24px}.notice{padding:16px;background:#fff4d6;border:1px solid #e2c675}article{padding:20px;margin:20px 0;background:white;border:1px solid #d7dee5;overflow-wrap:anywhere}.columns{display:grid;grid-template-columns:1fr 1fr;gap:20px}.columns>*{min-width:0}.columns section{border:1px solid #e0e6ed;padding:14px}p,pre{white-space:pre-wrap}img{max-width:100%;height:auto}.invalid{color:#a01b1b}span,.muted{color:#52606d}a{color:#175e9b}summary{cursor:pointer}@media(max-width:760px){.columns{grid-template-columns:1fr}}</style></head><body><main>
<h1>题单版本差异</h1><p class="notice">用于定位重新审校的重点，不继承或生成批准。当前版本仍须实际读图并绑定新的完整草稿哈希。</p>
<p>书 ${escape(report.bookId)} · ${escape(report.source)}；新增 ${report.summary.added}、移除 ${report.summary.removed}、变化 ${report.summary.changed}；需关注 ${report.summary.affected} 题。</p>
<p>上一版本 SHA256：${escape(report.beforeSha256)}<br>当前版本 SHA256：${escape(report.afterSha256)}</p>
<p>准备证据变化：${report.evidenceChanges.map(escape).join('、') || '无声明变化'}</p>
<nav>${report.tasks.filter(row => row.reviewReasons.length).map((row, index) => `<a href="#change-${index}">${escape(row.taskId)}</a>`).join(' · ')}</nav>
${rows || '<p>没有发现题目或来源声明变化。字节哈希如有变化，仍须为新版本生成绑定决定。</p>'}
<h2>覆盖清单变化</h2>${coverage || '<p>无覆盖声明变化。</p>'}<ul>${report.limitations.map(value => `<li>${escape(value)}</li>`).join('')}</ul>
</main></body></html>`;
}
