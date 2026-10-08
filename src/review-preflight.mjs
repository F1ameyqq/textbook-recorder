import { createHash } from 'node:crypto';
import { validateNewSystemManifest, renderBlockHtml } from './new-system-core.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const positive = value => Number.isSafeInteger(value) && value > 0;
const CHECKS = ['sourceText', 'answerMatch', 'wholeQuestion', 'format'];
const CANDIDATE_TYPES = new Set(['question', 'knowledge-construction', 'whole-activity', 'non-question']);
const escape = value => String(value ?? '').replace(/&/gu, '&amp;').replace(/</gu, '&lt;')
  .replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&#39;');
const textOf = block => Array.isArray(block?.parts) ? block.parts.join('\u00a0'.repeat(8))
  : Array.isArray(block?.runs) ? block.runs.map(run => String(run?.text ?? '')).join('')
    : String(block?.text ?? '');
const missingAnswerLabel = value => /^(?:原书未提供参考答案|无(?:官方)?(?:参考)?答案|未提供(?:参考)?答案|没有(?:参考)?答案)[。.!！]?$/u.test(String(value).trim());

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
      if (block.type === 'image') {
        if (!['diagram', 'table'].includes(block.purpose)) {
          errors.push(`${where}: 图片 purpose 必须是 diagram/table；whole-question 整题截图禁止`);
        }
        continue;
      }
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
        errors.push(`${where}: 组合加点/横线字符需要专项渲染审校，通用输入未实现原生强调`);
        specialReview.push({ taskId: task.id, side, blockIndex: index, reason: 'combining-emphasis', resolved: false });
      }
      if (['formula', 'math-tex', 'emphasis'].includes(block.type) || block.latex !== undefined
          || block.emphasis !== undefined || (Array.isArray(block.runs)
            && block.runs.some(run => ['formula', 'math-tex', 'emphasis'].includes(run?.type)))) {
        errors.push(`${where}: 复杂原生公式/强调超出通用 core 能力，需专项审校和独立执行器`);
        specialReview.push({ taskId: task.id, side, blockIndex: index, reason: 'unsupported-native-format', resolved: false });
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
      errors.push(`任务 ${String(id)}: 所有正文 source.pages 都须有逐页候选映射，不能只核题数`);
    }
  }
  const valid = errors.length === 0;
  const unresolvedSpecialReview = specialReview.filter(risk => !risk.resolved);
  return {
    schemaVersion: 1, kind: 'reviewed-batch-preflight', valid, errors, warnings,
    coreValid: core.valid, readyForExecution: valid && unresolvedSpecialReview.length === 0
      && tasks.every(task => task?.review?.status === 'approved'),
    requiresSpecialReview: specialReview, unresolvedSpecialReview,
    summary: { tasks: tasks.length, sourcePages: pageIds.size, candidates: candidateIds.size,
      includedCandidates: included, excludedNonQuestions: excluded, originalPagesAvailable: originalPages,
      approvedTasks: tasks.filter(task => task?.review?.status === 'approved').length,
      specialReviewRisks: specialReview.length, unresolvedSpecialReview: unresolvedSpecialReview.length },
    limitations: ['作答要求、原图全文、答案归属和题目边界依赖人工审校；元数据一致不证明语义正确',
      '通用 core 只支持文本、上下标和 PNG/JPEG 题图；复杂原生公式/强调需要专项通路',
      'specialReview 确认只记录人工声明及冻结题单绑定，不证明工具已核验原图语义',
      '本报告和预览不会批准题单，也不证明平台保存或实际页面渲染'],
  };
}

function previewBlock(block, baseDir) {
  try { return renderBlockHtml(block, baseDir); }
  catch (error) {
    // Invalid and unsupported material remains inert text, never raw HTML.
    return `<p class="invalid">${escape(error.message)}</p><pre>${escape(JSON.stringify(block))}</pre>`;
  }
}

/** Offline preview with escaped metadata and validated local raster bytes. */
export function renderReviewedBatchPreview(manifest, baseDir = process.cwd(), report = inspectReviewedBatch(manifest, baseDir)) {
  const tasks = Array.isArray(manifest?.tasks) ? manifest.tasks : [];
  const pages = Array.isArray(manifest?.coverage?.pages) ? manifest.coverage.pages : [];
  const issues = [...report.errors.map(value => `错误：${value}`), ...report.warnings.map(value => `提示：${value}`)];
  const originals = pages.filter(object).map(page => `<article class="original"><h3>原书页 ${escape(page.page)}</h3>${page.imagePath
    ? previewBlock({ type: 'image', path: page.imagePath, align: 'center' }, baseDir) : '<p>未附本地原图</p>'}
    <ul>${(Array.isArray(page.candidates) ? page.candidates : []).filter(object).map(candidate =>
      `<li>${escape(candidate.id)} · ${escape(candidate.type)} · ${escape(candidate.decision)} → ${escape((Array.isArray(candidate.taskIds) ? candidate.taskIds : []).join(', '))}${candidate.reason ? `：${escape(candidate.reason)}` : ''}</li>`).join('')}</ul></article>`).join('');
  const taskViews = tasks.filter(object).map(task => {
    const heading = `${task.target?.chapterLabel ?? ''} / ${task.target?.sectionLabel ?? ''} / 第${task.target?.record ?? '?'}条`;
    const side = (name, label) => `<section><h3>${label}</h3>${(Array.isArray(task[name]?.blocks) ? task[name].blocks : [])
      .map(block => previewBlock(block, baseDir)).join('')}</section>`;
    return `<article class="task"><h2>${escape(heading)}</h2><p class="meta">${escape(task.id)} · 原状态 ${escape(task.review?.status)} · 题页 ${escape(Array.isArray(task.source?.pages) ? task.source.pages.join(', ') : '')} · 答页 ${escape(Array.isArray(task.source?.answerPages) ? task.source.answerPages.join(', ') : '')}</p>
      <p>作答依据：${escape(task.answerRequirement?.kind)} — ${escape(task.answerRequirement?.evidence)}；答案状态：${escape(task.answerStatus)}</p>
      <div class="columns">${side('stem', '题干')}${side('answer', '答案')}</div></article>`;
  }).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>离线题单审校预览</title><style>body{font:16px/1.65 system-ui,sans-serif;margin:0;background:#f3f5f7;color:#17202b}main{max-width:1280px;margin:auto;padding:24px}h1,h2,h3{line-height:1.3}.notice{padding:16px;background:#fff4d6;border:1px solid #e2c675}.task,.original{background:white;border:1px solid #d7dee5;padding:18px;margin:20px 0;overflow-wrap:anywhere}.columns{display:grid;grid-template-columns:1fr 1fr;gap:24px}.columns section{min-width:0;padding:12px;border:1px solid #e0e6ed}.columns p{white-space:pre-wrap}.meta{color:#52606d}img{max-width:100%;height:auto}pre{white-space:pre-wrap}.invalid{color:#a01b1b}@media(max-width:760px){.columns{grid-template-columns:1fr}}@media print{body{background:white}.task,.original{break-inside:avoid}.notice{background:white}}</style></head>
<body><main><h1>离线题单审校预览</h1><p class="notice">只读预览，不自动批准任务。结构校验：${report.valid ? '通过' : '未通过'}；执行准入：${report.readyForExecution ? '元数据检查通过' : '未就绪'}。原图语义与实际平台渲染需独立审校；本页不连接网络、不写平台。</p>
<p>书 ${escape(manifest?.bookId)}；${escape(report.summary.tasks)} 条任务；${escape(report.summary.sourcePages)} 页来源。</p>
<ul>${issues.map(value => `<li>${escape(value)}</li>`).join('')}</ul><h2>逐页原图与覆盖清单</h2>${originals}<h2>题答对照</h2>${taskViews}</main></body></html>`;
}

export function reviewedManifestHash(manifestBytes) {
  return createHash('sha256').update(manifestBytes).digest('hex');
}
