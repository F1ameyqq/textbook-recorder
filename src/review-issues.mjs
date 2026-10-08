const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** JSON objects may shadow toString/valueOf. Never coerce them into markup. */
export function reviewText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (['number', 'boolean', 'bigint'].includes(typeof value)) return String(value);
  try { return JSON.stringify(value) ?? '[无法显示的值]'; }
  catch { return '[无法显示的值]'; }
}
const ISSUE_LABELS = {
  stem_source_images_missing: '正文缺少原图路径', answer_source_images_missing: '答案缺少原图路径',
  stem_source_locations_missing: '正文缺少原像素来源区域', answer_source_locations_missing: '答案缺少原像素来源区域',
  stem_source_pages_unlocated: '正文有来源页尚未定位区域', answer_source_pages_unlocated: '答案有来源页尚未定位区域',
  stem_content_missing: '正文转录内容缺失', answer_missing: '参考答案尚未配对', answer_unknown: '参考答案含待确认内容',
  answer_reused: '同一参考答案被多题重复配对', question_number_unknown: '题号未确认，不能据此自动配对',
  question_group_unknown: '题目栏目未确认，不能据此自动配对', duplicate_question_key: '题目身份键重复',
  multiple_answer_candidates: '有多个参考答案候选，需实际核对归属', declared_answer_scope_mismatch: '正文与答案的章/单元声明不一致',
  answer_status_mismatch: '答案状态与实际配对不一致', unpaired_answer_replacement_forbidden: '未配对答案不能用替换内容补答',
  unsupported_native_format: '内容含本版未支持的原生格式',
};
const RISK_LABELS = { 'replacement-character': 'Unicode 替换字符 U+FFFD', 'printed-square-symbol': '原书方框符号',
  'possible-stacked-fraction': '疑似斜杠分式', 'combining-emphasis': '组合加点/横线字符',
  'unsupported-native-format': '未支持的原生格式', 'unsupported-stacked-source-layout': '未支持的上下排分式' };

/** Anchors use collection indexes only; untrusted IDs never become markup. */
export function reviewAnchor(location = {}) {
  if (Number.isSafeInteger(location.taskIndex) && location.taskIndex >= 0) {
    const root = `task-${location.taskIndex}`;
    if (['stem', 'answer'].includes(location.side)) {
      if (Number.isSafeInteger(location.blockIndex) && location.blockIndex >= 0) return `${root}-${location.side}-block-${location.blockIndex}`;
      return `${root}-${location.side}${location.source ? '-source' : ''}`;
    }
    return root;
  }
  if (Number.isSafeInteger(location.pageIndex) && location.pageIndex >= 0) {
    const root = `coverage-page-${location.pageIndex}`;
    return Number.isSafeInteger(location.candidateIndex) && location.candidateIndex >= 0
      ? `${root}-candidate-${location.candidateIndex}` : root;
  }
  return 'batch-top';
}

function locate(message, tasks) {
  const task = /^tasks\[(\d+)\]((?:\.[A-Za-z][A-Za-z0-9_]*(?:\[\d+\])?)*)/u.exec(message);
  if (task) {
    const taskIndex = Number(task[1]), path = task[0], block = /\.(stem|answer)\.blocks\[(\d+)\]/u.exec(path);
    return { scope: 'task', taskIndex, taskId: tasks[taskIndex]?.id, path,
      ...(block ? { side: block[1], blockIndex: Number(block[2]) } : /\.(stem|answer)(?:\.|$)/u.test(path) ? { side: /\.(stem|answer)/u.exec(path)[1] } : {}) };
  }
  const page = /^coverage\.pages\[(\d+)\](?:\.candidates\[(\d+)\])?/u.exec(message);
  if (page) return { scope: 'coverage', pageIndex: Number(page[1]), path: page[0],
    ...(page[2] !== undefined ? { candidateIndex: Number(page[2]) } : {}) };
  const taskIndex = tasks.findIndex(value => object(value) && message.startsWith(`任务 ${reviewText(value.id)}:`));
  if (taskIndex >= 0) return { scope: 'task', taskIndex, taskId: tasks[taskIndex].id, path: `tasks[${taskIndex}].source.pages` };
  return { scope: 'batch', path: message.startsWith('coverage.') ? 'coverage.pages' : 'manifest' };
}

function repair(location, code, message) {
  if (code === 'review-check-pending' || /review\.checks/u.test(location.path)) return { input: 'review-decisions.json', action: '实际对照原图完成此检查，再填写具体审校证据；不能直接把布尔值改为通过。' };
  if (code === 'special-review' || /分式|方框|复杂|原生|加点|替换字符|U\+FFFD/u.test(message)) return { input: 'records.json / mapping.json / review-decisions.json', action: '先核对原书符号与排版；修正转录或保留待处理。人工专项声明不能解除不支持的上下分式及替换字符。' };
  if (location.scope === 'coverage' || location.path === 'coverage.pages') return { input: 'mapping.json', action: '逐页对照原图，修正候选、整题映射或排除理由；跨页整题的每页都须登记。' };
  if (/source_(?:images|locations)_missing|source_pages_unlocated|content_missing/u.test(code)) return { input: 'records.json', action: '补充实际看图确定的原页路径、原像素区域或转录内容，再重新生成 paired 和 draft。' };
  if (/answer_missing|answer_unknown|answer_reused|answer_candidates|question_(?:number|group)_unknown|duplicate_question_key|scope_mismatch|unpaired_answer/u.test(code)) return { input: 'records.json 的 pairings / mapping.json', action: '核对正文和答案身份、栏目及来源后修正配对；缺答按本次授权处理，不自行猜答案。' };
  if (/\.target|answerRequirement|answerStatus|source\.pages/u.test(location.path) || /answer_status_mismatch/u.test(code)) return { input: 'mapping.json', action: '核对章/节标签、真实序号、作答要求和来源，再修正 mapping 并生成新 draft。' };
  if (/图片|\.path|purpose/u.test(message)) return { input: 'crop-plan.json / mapping.json', action: '核对必要题图的原像素裁剪、purpose 和相对资产路径；不使用整题截图。' };
  if (/review|approved|审校/u.test(location.path + message)) return { input: 'review-decisions.json', action: '查看本题未解决问题，实际审校后记录具体结论；修改草稿后须重新绑定当前字节哈希。' };
  return { input: location.scope === 'task' ? 'records.json / mapping.json' : 'manifest', action: '按定位核对原始输入，另存修订版本并重新生成、审校；本提示不会修复或批准材料。' };
}

/** Supplemental navigation only. It cannot change validity or approval gates. */
export function buildReviewDiagnostics(manifest, report) {
  const tasks = Array.isArray(manifest?.tasks) ? manifest.tasks : [];
  const diagnostics = [];
  const add = (severity, code, message, location, extra = {}) => diagnostics.push({ severity, code, message,
    location, anchor: reviewAnchor(location), ...repair(location, code, message), ...extra });
  for (const severity of ['error', 'warning']) {
    for (const message of report[severity === 'error' ? 'errors' : 'warnings'] ?? []) add(severity, 'validation', message, locate(message, tasks));
  }
  for (const [taskIndex, task] of tasks.entries()) {
    if (!object(task)) continue;
    for (const [index, issue] of (Array.isArray(task.review?.issues) ? task.review.issues : []).entries()) {
      const code = reviewText(issue), side = /^(stem|answer)_/u.exec(code)?.[1];
      add('review', code, Object.hasOwn(ISSUE_LABELS, code) ? `${ISSUE_LABELS[code]}（${code}）` : code, { scope: 'task', taskIndex, taskId: task.id, path: `tasks[${taskIndex}].review.issues[${index}]`,
        ...(side ? { side, source: /source_/u.test(code) } : {}) });
    }
    for (const [check, label] of [['sourceText', '原文'], ['answerMatch', '答案归属'], ['wholeQuestion', '整题'], ['format', '格式']]) {
      if (task.review?.checks?.[check] === false) add('review', 'review-check-pending', `${label}检查未通过人工确认`,
        { scope: 'task', taskIndex, taskId: task.id, path: `tasks[${taskIndex}].review.checks.${check}` });
    }
  }
  for (const risk of report.requiresSpecialReview ?? []) {
    const taskIndex = tasks.findIndex(task => task?.id === risk.taskId);
    const location = taskIndex < 0 ? { scope: 'batch', path: 'manifest' } : { scope: 'task', taskIndex, taskId: risk.taskId,
      path: `tasks[${taskIndex}]${risk.side ? `.${risk.side}` : '.review.specialReview'}${Number.isSafeInteger(risk.blockIndex) ? `.blocks[${risk.blockIndex}]` : ''}`,
      ...(risk.side ? { side: risk.side } : {}), ...(Number.isSafeInteger(risk.blockIndex) ? { blockIndex: risk.blockIndex } : {}) };
    add(risk.resolved ? 'warning' : 'review', 'special-review', `${Object.hasOwn(RISK_LABELS, risk.reason) ? RISK_LABELS[risk.reason] : risk.reason}：${risk.resolved ? '已有人工专项声明，工具未核验原图' : '尚未解除执行阻断'}`, location, { resolved: risk.resolved });
  }
  return diagnostics;
}
