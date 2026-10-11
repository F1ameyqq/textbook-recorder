import { createHash } from 'node:crypto';
import { validateNewSystemManifest, renderBlockHtml } from './new-system-core.mjs';
import { assertNativeEmphasis } from './native-emphasis.mjs';
import { buildReviewDiagnostics, reviewAnchor, reviewText } from './review-issues.mjs';
import { previewBlock, renderTaskSources, renderReviewDiagnostic, resolvePreviewSourcePages } from './review-preview.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const positive = value => Number.isSafeInteger(value) && value > 0;
const CHECKS = ['sourceText', 'answerMatch', 'wholeQuestion', 'format'];
const CANDIDATE_TYPES = new Set(['question', 'knowledge-construction', 'whole-activity', 'non-question']);
const escape = value => reviewText(value).replace(/&/gu, '&amp;').replace(/</gu, '&lt;')
  .replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&#39;');
const textOf = block => block?.type === 'analysis-separator' || block?.type === 'image' ? '' : Array.isArray(block?.parts) ? block.parts.map(reviewText).join('\u00a0'.repeat(8))
  : Array.isArray(block?.runs) ? block.runs.map(run => reviewText(run?.text)).join('')
    : reviewText(block?.text);
const missingAnswerLabel = value => /^(?:原书未提供参考答案|无(?:官方)?(?:参考)?答案|未提供(?:参考)?答案|没有(?:参考)?答案)[。.!！]?$/u.test(reviewText(value).trim());

function suspiciousFraction(text) {
  // Units are not fractions to be rejected. The remaining matches are only
  // review hints; no generic algebra parser or automatic rewrite is used.
  const withoutUnits = text.replace(/\b(?:J|kJ|kg|g|m|km|cm|mm|A|V|W|kW|imp|r|元)\s*\/\s*(?:\((?:kg|g|kW|W)[^)]*\)|kg|g|m|s|min|h|A|V|W|kW)(?:\b|(?=[·℃Ω]))/gu, 'UNIT');
  return /(?:[UIRWPQFtcm]\s*\/\s*[A-Za-z0-9(（]|\d\s*\/\s*\d|[)）\]］]\s*\/\s*[A-Za-z0-9(（])|[=＝]\s*[^\n/]+\/[^\n/]+/u.test(withoutUnits);
}

function taskHints(task, at, errors, warnings, specialReview) {
  const confirmation = object(task.review?.specialReview) ? task.review.specialReview : {};
  for (const side of ['stem', 'answer']) {
    if (!Array.isArray(task[side]?.blocks)) continue;
    for (const [index, block] of task[side].blocks.entries()) {
      if (!object(block)) continue;
      const where = `${at}.${side}.blocks[${index}]`;
      // Only the explicit, range-bound native contract may pass this gate.
      // Validate before image/separator early returns so misplaced metadata
      // cannot silently disappear from inspection or preview.
      let invalidEmphasis = false;
      if (block.emphasis !== undefined) {
        try { assertNativeEmphasis(block); }
        catch (error) {
          invalidEmphasis = true;
          errors.push(`${where}: 原生加点/下划线元数据无效：${reviewText(error?.message)}`);
          specialReview.push({ taskId: task.id, side, blockIndex: index, reason: 'unsupported-native-format', resolved: false });
        }
      }
      if (block.type === 'image') {
        if (!['diagram', 'table'].includes(block.purpose)) {
          errors.push(`${where}: 图片 purpose 必须是 diagram/table；whole-question 整题截图禁止`);
        }
        continue;
      }
      if (block.type === 'analysis-separator') continue;
      const text = textOf(block);
      if (/\uFFFD/u.test(text)) {
        errors.push(`${where}: 含 Unicode 替换字符 U+FFFD，须重新对照原图辨字，人工确认不能解除`);
        specialReview.push({ taskId: task.id, side, blockIndex: index, reason: 'replacement-character', resolved: false });
      }
      if (/[\u25A1\u25A0]/u.test(text)) {
        const resolved = confirmation.printedSquaresConfirmed === true;
        warnings.push(`${where}: 含方框符号；${resolved ? '人工声明原书确有这些符号，工具未验证原图' : '需对照原图确认真实符号，尚未解除执行阻断'}`);
        specialReview.push({ taskId: task.id, side, blockIndex: index, reason: 'printed-square-symbol', resolved,
          ...(resolved ? { resolution: 'human-review-metadata', sourceVerifiedByTool: false } : {}) });
      }
      if (suspiciousFraction(text)) {
        const resolved = confirmation.fractionLayoutConfirmed === true && confirmation.sourceLayout === 'linear';
        warnings.push(`${where}: 疑似斜杠分式；${resolved ? '人工声明本题所有疑似表达在原书均为线性，工具未验证原图' : '需核对原书几何，尚未解除执行阻断'}；单位斜杠不作不合格依据`);
        specialReview.push({ taskId: task.id, side, blockIndex: index, reason: 'possible-stacked-fraction', resolved,
          ...(resolved ? { resolution: 'human-review-metadata', sourceVerifiedByTool: false } : {}) });
      }
      if (/[\u0323\u0305]/u.test(text)) {
        errors.push(`${where}: 组合加点/横线字符需要专项渲染审校，组合形式未实现原生强调；须使用明确范围的原生标记`);
        specialReview.push({ taskId: task.id, side, blockIndex: index, reason: 'combining-emphasis', resolved: false });
      }
      if (['formula', 'math-tex', 'emphasis'].includes(block.type) || block.latex !== undefined
          || (Array.isArray(block.runs)
            && block.runs.some(run => ['formula', 'math-tex', 'emphasis'].includes(run?.type) || run?.emphasis !== undefined))) {
        errors.push(`${where}: 复杂原生公式/强调超出通用 core 能力，需专项审校和独立执行器`);
        if (!invalidEmphasis) specialReview.push({ taskId: task.id, side, blockIndex: index, reason: 'unsupported-native-format', resolved: false });
      }
    }
  }
}

/** Pure local inspection. Metadata records human decisions, not source truth. */
export function inspectReviewedBatch(manifest, baseDir = process.cwd()) {
  let core;
  try { core = validateNewSystemManifest(manifest, baseDir); }
  catch (error) { core = { valid: false, errors: [`原 core 校验异常：${error.message}`], warnings: [] }; }
  const errors = [...core.errors], warnings = [...core.warnings], specialReview = [];
  const tasks = Array.isArray(manifest?.tasks) ? manifest.tasks : [];
  const byId = new Map();
  for (const [index, task] of tasks.entries()) {
    if (!object(task)) continue;
    const at = `tasks[${index}]`;
    byId.set(task.id, task);
    const requirement = task.answerRequirement;
    if (!object(requirement) || !['question', 'fill-in'].includes(requirement.kind)
        || !nonempty(requirement.evidence) || missingAnswerLabel(requirement.evidence)) {
      errors.push(`${at}: answerRequirement 必须明确具体问题或待填项；缺答备注不能作为入题依据`);
    }
    if (!['provided', 'not-provided'].includes(task.answerStatus)) {
      errors.push(`${at}: answerStatus 必须是 provided/not-provided`);
    } else {
      const answerText = Array.isArray(task.answer?.blocks)
        ? task.answer.blocks.map(textOf).join('\n').trim() : '';
      if (task.answerStatus === 'provided' && missingAnswerLabel(answerText)) {
        errors.push(`${at}: provided 与缺参考答案备注矛盾`);
      }
      if (task.answerStatus === 'not-provided' && answerText !== '原书未提供参考答案') {
        errors.push(`${at}: not-provided 须保留明确备注“原书未提供参考答案”，不能猜答案`);
      }
    }
    if (!object(task.review?.checks) || CHECKS.some(check => typeof task.review.checks[check] !== 'boolean')) {
      errors.push(`${at}: review.checks 必须声明 sourceText/answerMatch/wholeQuestion/format 四项布尔检查`);
    } else if (task.review.status === 'approved' && CHECKS.some(check => task.review.checks[check] !== true)) {
      errors.push(`${at}: approved 的四项 review.checks 必须全部 true`);
    }
    if (task.review?.specialReview !== undefined) {
      const special = task.review.specialReview;
      if (!object(special) || ['fractionLayoutConfirmed', 'printedSquaresConfirmed']
        .some(field => special[field] !== undefined && typeof special[field] !== 'boolean')
        || (special.sourceLayout !== undefined && !['linear', 'stacked'].includes(special.sourceLayout))) {
        errors.push(`${at}: specialReview 确认须为布尔值，sourceLayout 须为 linear/stacked`);
      } else if (special.sourceLayout === 'stacked') {
        errors.push(`${at}: 原书为上下排分式，通用 core 尚未支持；须转专项审校，不可用线性斜杠替代`);
        specialReview.push({ taskId: task.id, reason: 'unsupported-stacked-source-layout', resolved: false });
      }
    }
    taskHints(task, at, errors, warnings, specialReview);
  }

  const pages = manifest?.coverage?.pages;
  const pageIds = new Set(), candidateIds = new Set(), taskPages = new Map();
  let included = 0, excluded = 0, originalPages = 0;
  if (!Array.isArray(pages) || !pages.length) {
    errors.push('coverage.pages 必须逐页登记全部候选及排除理由');
  } else for (const [index, page] of pages.entries()) {
    const at = `coverage.pages[${index}]`;
    if (!object(page) || !positive(page.page) || pageIds.has(page.page)) {
      errors.push(`${at}: 来源页须是唯一正整数`); continue;
    }
    pageIds.add(page.page);
    if (page.imagePath !== undefined) {
      try { renderBlockHtml({ type: 'image', path: page.imagePath, align: 'center' }, baseDir); originalPages++; }
      catch (error) { errors.push(`${at}.imagePath: ${error.message}`); }
    } else warnings.push(`${at}: 未附原始页图，预览不能替代另行对照原图`);
    if (!Array.isArray(page.candidates) || !page.candidates.length) {
      errors.push(`${at}: candidates 不能为空；无题页面也需明确 non-question 说明`); continue;
    }
    for (const [position, candidate] of page.candidates.entries()) {
      const where = `${at}.candidates[${position}]`;
      if (!object(candidate) || !nonempty(candidate.id) || candidateIds.has(candidate.id)
          || !CANDIDATE_TYPES.has(candidate.type)) {
        errors.push(`${where}: 候选 id 必须唯一且 type 明确`); continue;
      }
      candidateIds.add(candidate.id);
      if (candidate.decision === 'exclude') {
        excluded++;
        if (candidate.type !== 'non-question' || !Array.isArray(candidate.taskIds) || candidate.taskIds.length
            || !nonempty(candidate.reason) || !/流程|展示|评价|说明|目标|安排|procedure|display|evaluation|explanation/iu.test(candidate.reason)) {
          errors.push(`${where}: 仅 non-question 可排除，须无 taskIds 且明确纯流程/说明等依据；无题号或无答案不构成依据`);
        }
      } else if (candidate.decision === 'include') {
        included++;
        if (candidate.type === 'non-question' || !Array.isArray(candidate.taskIds)
            || candidate.taskIds.length !== 1 || !byId.has(candidate.taskIds[0])) {
          errors.push(`${where}: 应录候选须映射恰好一条完整任务，知识建构不可漏、完整活动不可任意拆题`);
          continue;
        }
        const id = candidate.taskIds[0], task = byId.get(id);
        if (!Array.isArray(task.source?.pages) || !task.source.pages.includes(page.page)) errors.push(`${where}: 候选来源页不在对应任务 source.pages`);
        if (!taskPages.has(id)) taskPages.set(id, new Set());
        taskPages.get(id).add(page.page);
      } else errors.push(`${where}: decision 必须为 include/exclude；待定候选不能通过覆盖验收`);
    }
  }
  for (const [id, task] of byId) {
    const mapped = taskPages.get(id);
    if (!mapped || !Array.isArray(task.source?.pages) || task.source.pages.some(page => !mapped.has(page))) {
      errors.push(`任务 ${reviewText(id)}: 所有正文 source.pages 都须有逐页候选映射，不能只核题数`);
    }
  }
  const valid = errors.length === 0;
  const unresolvedSpecialReview = specialReview.filter(risk => !risk.resolved);
  const report = {
    schemaVersion: 1, kind: 'reviewed-batch-preflight', valid, errors, warnings,
    coreValid: core.valid, readyForExecution: valid && unresolvedSpecialReview.length === 0
      && tasks.every(task => task?.review?.status === 'approved'),
    requiresSpecialReview: specialReview, unresolvedSpecialReview,
    summary: { tasks: tasks.length, sourcePages: pageIds.size, candidates: candidateIds.size,
      includedCandidates: included, excludedNonQuestions: excluded, originalPagesAvailable: originalPages,
      approvedTasks: tasks.filter(task => task?.review?.status === 'approved').length,
      specialReviewRisks: specialReview.length, unresolvedSpecialReview: unresolvedSpecialReview.length },
    limitations: ['作答要求、原图全文、答案归属和题目边界依赖人工审校；元数据一致不证明语义正确',
      '通用 core 支持文本、上下标、PNG/JPEG 题图及明确范围的原生加点/下划线；复杂公式和其他强调仍需专项通路',
      'specialReview 确认只记录人工声明及冻结题单绑定，不证明工具已核验原图语义',
      '本报告和预览不会批准题单，也不证明平台保存或实际页面渲染'],
  };
  report.diagnostics = buildReviewDiagnostics(manifest, report);
  return report;
}

/** Offline preview with escaped metadata and validated local raster bytes. */
export function renderReviewedBatchPreview(manifest, baseDir = process.cwd(), report = inspectReviewedBatch(manifest, baseDir)) {
  const tasks = Array.isArray(manifest?.tasks) ? manifest.tasks : [];
  const pages = Array.isArray(manifest?.coverage?.pages) ? manifest.coverage.pages : [];
  const diagnostics = Array.isArray(report.diagnostics) ? [...report.diagnostics] : buildReviewDiagnostics(manifest, report);
  const rasterCache = new Map(), sourcePages = resolvePreviewSourcePages(manifest, pages, baseDir, rasterCache);
  if (sourcePages.issue) diagnostics.push({ severity: 'error', code: 'source-index-preview', message: sourcePages.issue,
    location: { scope: 'batch', path: 'preparation.index' }, anchor: 'batch-top', input: 'index.json / mapping.json',
    action: '保留实际原图和历史版本，核对同 job 的引用哈希与原图字节；本预览不修复或批准材料。' });
  const originals = pages.map((page, pageIndex) => !object(page) ? `<article class="original invalid" id="${reviewAnchor({ pageIndex })}"><h3>来源页 ${pageIndex + 1} 结构无效</h3><pre>${escape(JSON.stringify(page))}</pre></article>` : `<article class="original" id="${reviewAnchor({ pageIndex })}"><h3>原书页 ${escape(page.page)}</h3>${page.imagePath
    ? previewBlock({ type: 'image', path: page.imagePath, align: 'center' }, baseDir) : '<p>未附本地原图</p>'}
    <ul>${(Array.isArray(page.candidates) ? page.candidates : []).map((candidate, candidateIndex) => !object(candidate) ? `<li class="invalid" id="${reviewAnchor({ pageIndex, candidateIndex })}">候选结构无效：${escape(JSON.stringify(candidate))}</li>` :
      `<li id="${reviewAnchor({ pageIndex, candidateIndex })}">${escape(candidate.id)} · ${escape(candidate.type)} · ${escape(candidate.decision)} → ${(Array.isArray(candidate.taskIds) ? candidate.taskIds : []).map(id => {
        const taskIndex = tasks.findIndex(task => task?.id === id);
        return taskIndex < 0 ? escape(id) : `<a href="#${reviewAnchor({ taskIndex })}">${escape(id)}</a>`;
      }).join(', ')}${candidate.reason ? `：${escape(candidate.reason)}` : ''}</li>`).join('')}</ul></article>`).join('');
  const taskViews = tasks.map((task, taskIndex) => {
    if (!object(task)) return `<article class="task invalid" id="${reviewAnchor({ taskIndex })}"><h2>任务 ${taskIndex + 1} 结构无效</h2><pre>${escape(JSON.stringify(task))}</pre></article>`;
    const heading = `${reviewText(task.target?.chapterLabel)} / ${reviewText(task.target?.sectionLabel)} / 第${reviewText(task.target?.record ?? '?')}条`;
    const side = (name, label) => `<section class="side" id="${reviewAnchor({ taskIndex, side: name })}"><h3>${label}对照</h3><div class="comparison">${renderTaskSources(task, name, taskIndex, sourcePages.pages, baseDir, rasterCache)}<section class="transcription"><h4>${label}录入内容</h4>${(Array.isArray(task[name]?.blocks) ? task[name].blocks : [])
      .map((block, blockIndex) => `<div class="content-block" id="${reviewAnchor({ taskIndex, side: name, blockIndex })}"><span class="block-label">${name}.blocks[${blockIndex}]</span>${previewBlock(block, baseDir)}</div>`).join('') || '<p class="invalid">缺少内容块</p>'}</section></div></section>`;
    const taskDiagnostics = diagnostics.filter(diagnostic => diagnostic.location?.taskIndex === taskIndex);
    const checkDiagnostics = taskDiagnostics.filter(diagnostic => diagnostic.code === 'review-check-pending');
    const contentDiagnostics = taskDiagnostics.filter(diagnostic => diagnostic.code !== 'review-check-pending');
    const urgent = contentDiagnostics.some(diagnostic => diagnostic.severity === 'error' || diagnostic.severity === 'review');
    const checkLabels = [['sourceText', '原文'], ['answerMatch', '答案归属'], ['wholeQuestion', '整题'], ['format', '格式']];
    return `<article class="task" id="${reviewAnchor({ taskIndex })}"><h2>${escape(heading)}</h2><p class="meta">${escape(task.id)} · 原状态 ${escape(task.review?.status)} · 题页 ${escape(Array.isArray(task.source?.pages) ? task.source.pages.map(reviewText).join(', ') : '')} · 答页 ${escape(Array.isArray(task.source?.answerPages) ? task.source.answerPages.map(reviewText).join(', ') : '')}</p>
      <p>作答依据：${escape(task.answerRequirement?.kind)} — ${escape(task.answerRequirement?.evidence)}；答案状态：${escape(task.answerStatus)}</p>
      <p class="human-checks">人工检查声明：${checkLabels.map(([key, label]) => `${label} ${task.review?.checks?.[key] === true ? '已声明通过' : task.review?.checks?.[key] === false ? '待确认' : '未声明'}`).join(' · ')}（工具未核验原图语义）</p>
      ${taskDiagnostics.length ? `<details class="task-diagnostics"${urgent ? ' open' : ''}><summary>本题问题与定位（${contentDiagnostics.length}）${checkDiagnostics.length ? ` · ${checkDiagnostics.length} 项人工检查待确认` : ''}</summary><ul>${contentDiagnostics.map(renderReviewDiagnostic).join('')}</ul>${checkDiagnostics.length ? `<details class="check-details"><summary>展开人工检查说明（${checkDiagnostics.length}）</summary><ul>${checkDiagnostics.map(renderReviewDiagnostic).join('')}</ul></details>` : ''}</details>` : '<p class="meta">未发现结构或元数据问题；仍须实际读图审校。</p>'}
      <div class="task-sides">${side('stem', '题干')}${side('answer', '答案')}</div><p class="back"><a href="#batch-top">返回批次问题索引</a></p></article>`;
  }).join('');
  const taskNavigation = tasks.map((task, taskIndex) => `<a href="#${reviewAnchor({ taskIndex })}">${taskIndex + 1} · ${escape(task?.id ?? '无效任务')}</a>`).join('');
  const errorCount = diagnostics.filter(diagnostic => diagnostic.severity === 'error').length;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>离线题单审校预览</title><style>body{font:16px/1.65 system-ui,sans-serif;margin:0;background:#f3f5f7;color:#17202b}main{max-width:1480px;margin:auto;padding:24px}h1,h2,h3,h4{line-height:1.3}.notice{padding:16px;background:#fff4d6;border:1px solid #e2c675}.task,.original{background:white;border:1px solid #d7dee5;padding:18px;margin:20px 0;overflow-wrap:anywhere}.comparison{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:24px}.comparison>section{min-width:0;padding:12px;border:1px solid #e0e6ed}.side{margin:24px 0}.comparison p{white-space:pre-wrap}.meta,.block-label{color:#52606d}.block-label{font-size:12px;font-family:ui-monospace,monospace}.content-block{border-bottom:1px solid #e0e6ed;padding:8px 0}img{max-width:100%;height:auto}pre{white-space:pre-wrap}.invalid,.diagnostic.error>a{color:#a01b1b}.diagnostic.review>a{color:#745100}.diagnostic p{margin:3px 0;font-size:14px}.diagnostic{margin:14px 0}.diagnostic-location{color:#52606d}.source-region{margin:12px 0 20px}.source-region figcaption{font-size:13px;color:#52606d;margin-bottom:8px}.region-window{position:relative;overflow:hidden;width:100%;background:#e0e6ed}.region-window img{position:absolute;max-width:none}.full-source summary,.task-diagnostics summary{cursor:pointer}.full-source{margin:10px 0}.original-size{overflow:auto;max-height:720px;background:#edf0f3}.original-size img{display:block;max-width:none}.task-diagnostics{background:#faf6ed;padding:12px}.index-nav,.task-navigation{display:flex;gap:12px;flex-wrap:wrap}.task-navigation{margin:18px 0}.task-navigation a{padding:4px 10px;border:1px solid #ccd8e2;border-radius:4px;background:white}.batch-diagnostics{margin:18px 0;padding:12px;background:white;border:1px solid #d7dee5}.batch-diagnostics summary{cursor:pointer}.check-details{margin-top:10px}a{color:#145b8f}code{overflow-wrap:anywhere}[id]{scroll-margin-top:18px}:target{outline:3px solid #e2a641;outline-offset:4px}.human-checks{font-size:14px}.back{font-size:14px}@media(max-width:760px){main{padding:12px}.comparison{grid-template-columns:1fr}.task,.original{padding:12px}}@media print{body{background:white}.task,.original{break-inside:avoid}.notice{background:white}.back,.full-source{display:none}}</style></head>
<body><main id="batch-top"><h1>离线题单审校预览</h1><p class="notice">只读预览，不自动批准任务。结构校验：${report.valid ? '通过' : '未通过'}；执行准入：${report.readyForExecution ? '元数据检查通过' : '未就绪'}。原图语义与实际平台渲染需独立审校；本页不连接网络、不写平台。</p>
<p>书 ${escape(manifest?.bookId)}；${escape(report.summary.tasks)} 条任务；${escape(report.summary.sourcePages)} 页来源。</p>
<nav class="index-nav"><a href="#task-comparisons">逐题原图与录入对照</a><a href="#page-coverage">逐页覆盖清单</a></nav><details class="batch-diagnostics"${errorCount ? ' open' : ''}><summary>批次问题索引（${diagnostics.length} 项，${errorCount} 个错误）</summary><ul>${diagnostics.map(renderReviewDiagnostic).join('') || '<li>未发现结构或元数据问题。</li>'}</ul></details><nav class="task-navigation" aria-label="题目导航">${taskNavigation}</nav><h2 id="task-comparisons">逐题原图与录入对照</h2><p class="meta">来源区域仅按已声明 bbox 显示原图字节，不产生新裁图或读图证据。可展开整页查看原像素，也可使用浏览器缩放。</p>${taskViews}<h2 id="page-coverage">逐页原图与覆盖清单</h2>${originals}</main></body></html>`;
}

export function reviewedManifestHash(manifestBytes) {
  return createHash('sha256').update(manifestBytes).digest('hex');
}
