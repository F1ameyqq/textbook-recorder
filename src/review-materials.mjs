import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { sha256 } from './preparation-files.mjs';
import { rasterDimensions } from './draft-batch.mjs';
import { createReviewDecisionsTemplate } from './review-decisions-template.mjs';
import { preparePairedBatch } from './paired-batch.mjs';
import { compareReviewedBatches } from './review-diff.mjs';
import { buildReviewDiagnostics } from './review-issues.mjs';
import { escapeReviewHtml as escape } from './review-preview.mjs';
import { renderBlockHtml } from './new-system-core.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hashString = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
// Invalid coverage stays in the packet verbatim. These views only make
// navigation tolerant; they never fill missing candidates or task mappings.
const coveragePagesOf = draft => Array.isArray(draft.coverage?.pages) ? draft.coverage.pages : [];
const candidatesOf = page => Array.isArray(page?.candidates) ? page.candidates : [];
const declaresTask = (candidate, id) => Array.isArray(candidate?.taskIds) && candidate.taskIds.includes(id);
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};

function localBytes(baseDir, filename) {
  if (typeof filename !== 'string' || !filename || filename.includes('\0') || path.isAbsolute(filename)) throw new Error('材料来源须为同 job 内相对文件');
  const root = fs.realpathSync(baseDir), file = path.resolve(root, filename);
  if (!inside(root, file)) throw new Error('材料来源路径越出同 job');
  const real = fs.realpathSync(file);
  if (!inside(root, real) || !fs.statSync(real).isFile()) throw new Error('材料来源软链接越出同 job 或不是文件');
  return fs.readFileSync(real);
}

function referencedJson(baseDir, reference, label) {
  if (!object(reference) || !hashString(reference.sha256)) throw new Error(`${label} 缺少冻结 SHA256`);
  const bytes = localBytes(baseDir, reference.path);
  if (sha256(bytes) !== reference.sha256) throw new Error(`${label} SHA256 已变化`);
  return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, ''));
}

function candidateRecords(paired, baseDir) {
  if (paired.preparation?.input !== undefined) {
    const input = referencedJson(baseDir, paired.preparation.input, '配对原始 input');
    const rebuilt = preparePairedBatch(input);
    rebuilt.preparation = { kind: 'deterministic-local-pairing', input: paired.preparation.input,
      unmatchedAnswers: input.answers.filter(record => rebuilt.unmatchedAnswerIds.includes(record.id)), automaticallyApproved: false };
    if (!isDeepStrictEqual(rebuilt, paired)) throw new Error('paired 与冻结原始 input 不一致，不能导出候选材料');
    return new Map(input.answers.map(record => [record.id, record]));
  }
  // Programmatic drafts may retain all candidates directly in paired. Never
  // manufacture an absent record from an ID or a matching question number.
  const records = new Map();
  for (const record of [...paired.tasks.map(task => task.answer).filter(Boolean), ...(paired.preparation?.unmatchedAnswers ?? [])]) {
    if (records.has(record.id) && !isDeepStrictEqual(records.get(record.id), record)) throw new Error(`候选 ${record.id} 有互相冲突的完整记录`);
    records.set(record.id, record);
  }
  return records;
}

function selectionOf(draft, draftSha256, options, diagnostics) {
  const modes = [options.taskIds !== undefined, options.diagnosticSeverity !== undefined, options.diff !== undefined];
  if (modes.filter(Boolean).length !== 1) throw new Error('恰选 tasks、diagnostics 或 diff 一种定位方式');
  const known = new Set(draft.tasks.map(task => task.id)), selected = new Set(), contextPages = new Set();
  let selection, removedTaskIds = [], fullBatchReviewRequired = false;
  if (options.taskIds !== undefined) {
    if (!Array.isArray(options.taskIds) || !options.taskIds.length || new Set(options.taskIds).size !== options.taskIds.length
        || options.taskIds.some(id => typeof id !== 'string' || !known.has(id))) throw new Error('tasks 须为当前完整草稿中不重复的 taskId');
    options.taskIds.forEach(id => selected.add(id));
    selection = { mode: 'tasks', requestedTaskIds: structuredClone(options.taskIds) };
  } else if (options.diagnosticSeverity !== undefined) {
    const severity = options.diagnosticSeverity;
    if (!['error', 'warning', 'review', 'all'].includes(severity)) throw new Error('diagnostics 只允许 error、warning、review、all');
    const chosen = diagnostics.filter(item => severity === 'all' || item.severity === severity);
    for (const item of chosen) {
      if (item.location.scope === 'task') selected.add(item.location.taskId);
      else if (item.location.scope === 'coverage') {
        const page = draft.coverage?.pages?.[item.location.pageIndex];
        if (!page) throw new Error('当前诊断定位的覆盖页不存在');
        contextPages.add(page.page);
      } else fullBatchReviewRequired = true;
    }
    if (fullBatchReviewRequired) draft.tasks.forEach(task => selected.add(task.id));
    selection = { mode: 'diagnostics', severity, diagnostics: structuredClone(chosen), computedFromCurrentManifest: true };
  } else {
    const { report, before, beforeSha256, path: reportPath, sha256: reportSha256 } = options.diff;
    if (!object(report) || !hashString(beforeSha256) || !hashString(reportSha256)
        || report.afterSha256 !== draftSha256 || report.afterPath !== options.manifestPath
        || report.beforeSha256 !== beforeSha256 || typeof report.beforePath !== 'string'
        || path.basename(report.beforePath) !== report.beforePath) throw new Error('diff 须绑定当前完整草稿的 afterPath/原字节 SHA256 和同 job 的 before');
    const rebuilt = compareReviewedBatches(before, draft, { beforeSha256, afterSha256: draftSha256 });
    for (const [key, value] of Object.entries(rebuilt)) {
      if (!isDeepStrictEqual(report[key], value)) throw new Error(`diff 与冻结前后版本重算结果不一致：${key}`);
    }
    for (const id of rebuilt.affectedTaskIds) known.has(id) ? selected.add(id) : removedTaskIds.push(id);
    rebuilt.coverageChanges.forEach(change => contextPages.add(change.page));
    fullBatchReviewRequired = removedTaskIds.length > 0;
    selection = { mode: 'diff', path: reportPath, sha256: reportSha256, beforePath: report.beforePath,
      beforeSha256, afterPath: report.afterPath, afterSha256: draftSha256,
      affectedTaskIds: structuredClone(rebuilt.affectedTaskIds), coverageChanges: structuredClone(rebuilt.coverageChanges) };
  }
  // A page-level problem also needs its complete questions, including regions
  // on every other page. Never truncate those questions to the affected page.
  for (const task of draft.tasks) {
    if ([...task.source.pages, ...task.source.answerPages].some(page => contextPages.has(page))) selected.add(task.id);
    if (coveragePagesOf(draft).some(page => contextPages.has(page.page) && candidatesOf(page).some(candidate => declaresTask(candidate, task.id)))) selected.add(task.id);
  }
  return { selection, selectedTaskIds: draft.tasks.filter(task => selected.has(task.id)).map(task => task.id),
    removedTaskIds, contextPages, fullBatchReviewRequired };
}

/** Locate review work; the complete input is verified before any selection. */
export function createReviewMaterials(draft, draftSha256, baseDir, options) {
  const { report } = createReviewDecisionsTemplate(draft, draftSha256, baseDir);
  if (typeof options?.manifestPath !== 'string' || path.basename(options.manifestPath) !== options.manifestPath) throw new Error('manifestPath 须为同 job 草稿文件名');
  const diagnostics = buildReviewDiagnostics(draft, report), chosen = selectionOf(draft, draftSha256, options, diagnostics);
  const index = referencedJson(baseDir, draft.preparation.index, 'index');
  const paired = referencedJson(baseDir, draft.preparation.paired, 'paired');
  const candidates = candidateRecords(paired, baseDir), byPage = new Map(index.pages.map(page => [page.systemPage, page]));
  const byPath = new Map(), imagesByHash = new Map(), regionsByKey = new Map(), sourceImages = [], regions = [];
  const rasterFor = (page, image) => {
    const entry = byPage.get(page);
    if (!entry || entry.file !== image) throw new Error('材料原页与冻结 index 路径不一致');
    if (!byPath.has(image)) {
      const bytes = localBytes(baseDir, image), actual = rasterDimensions(bytes), actualSha256 = sha256(bytes);
      const ext = path.extname(image).toLowerCase();
      if (actualSha256 !== entry.sha256 || actual.width !== entry.width || actual.height !== entry.height
          || entry.bytes !== undefined && entry.bytes !== bytes.length || entry.mimeType !== undefined && entry.mimeType !== actual.mimeType
          || (actual.mimeType === 'image/png' ? ext !== '.png' : !['.jpg', '.jpeg'].includes(ext))) throw new Error('材料原图 SHA256/实际尺寸/字节/MIME 与 index 不一致');
      let raster = imagesByHash.get(actualSha256);
      if (!raster) {
        raster = { id: `image-${sourceImages.length + 1}`, sha256: actualSha256, ...actual, bytes: bytes.length, origins: [] };
        sourceImages.push(raster); imagesByHash.set(actualSha256, raster);
      }
      if (!raster.origins.some(origin => origin.page === page && origin.image === image)) raster.origins.push({ page, image });
      byPath.set(image, { raster, url: `data:${actual.mimeType};base64,${bytes.toString('base64')}` });
    }
    return byPath.get(image);
  };
  const referenceFor = (page, image, bbox = null) => {
    const { raster } = rasterFor(page, image), box = bbox ?? [0, 0, raster.width, raster.height];
    if (!Array.isArray(box) || box.length !== 4 || box.some(value => !Number.isSafeInteger(value) || value < 0)
        || box[2] <= box[0] || box[3] <= box[1] || box[2] > raster.width || box[3] > raster.height) throw new Error('材料 bbox 须为实际原像素范围，不能越界');
    const key = `${raster.sha256}:${box.join(',')}`;
    let region = regionsByKey.get(key);
    if (!region) {
      region = { id: `region-${regions.length + 1}`, imageId: raster.id, imageSha256: raster.sha256,
        bbox: structuredClone(box), referenceOnly: true, origins: [] };
      regionsByKey.set(key, region); regions.push(region);
    }
    if (!region.origins.some(origin => origin.page === page && origin.image === image)) region.origins.push({ page, image });
    return { regionId: region.id, imageId: raster.id, page, image, imageSha256: raster.sha256,
      bbox: bbox === null ? null : structuredClone(bbox), located: bbox !== null, referenceOnly: true };
  };
  const recordSources = record => {
    const source = record.source, references = [];
    if (!object(source) || !Array.isArray(source.pages) || !source.pages.length
        || source.pages.some(page => !Number.isSafeInteger(page) || page < 1) || new Set(source.pages).size !== source.pages.length
        || source.images !== undefined && !Array.isArray(source.images)
        || source.regions !== undefined && !Array.isArray(source.regions)) throw new Error(`记录 ${record.id} 的来源结构无效`);
    for (const image of source.images ?? []) {
      const page = source.pages.find(page => byPage.get(page)?.file === image);
      if (page === undefined) throw new Error(`记录 ${record.id} 的原图未在声明页 index 中`);
      rasterFor(page, image);
    }
    for (const region of source.regions ?? []) {
      if (!object(region) || !source.pages.includes(region.page) || !source.images?.includes(region.image)
          || !Array.isArray(region.bbox)) throw new Error(`记录 ${record.id} 的区域不属于声明来源或缺少 bbox`);
      references.push(referenceFor(region.page, region.image, region.bbox));
    }
    for (const page of source.pages) if (!references.some(reference => reference.page === page)) {
      const original = byPage.get(page);
      if (!original) throw new Error(`记录 ${record.id} 有来源页未在 index 中`);
      references.push(referenceFor(page, original.file));
    }
    return references;
  };
  const tasks = draft.tasks.filter(task => chosen.selectedTaskIds.includes(task.id)).map(task => {
    const records = task.preparation.records;
    const answerCandidates = task.preparation.originalPairing.candidateIds.map(id => {
      const record = candidates.get(id);
      if (!record) throw new Error(`答案候选 ${id} 缺少完整冻结记录；请从 workflow:pair 原始 input 重生成`);
      return { record: structuredClone(record), sourceReferences: recordSources(record) };
    });
    const searchedAnswerSources = !records.answer ? task.source.answerPages.map(page => {
      const original = byPage.get(page);
      if (!original) throw new Error('缺答查验页未在 index 中');
      return referenceFor(page, original.file);
    }) : [];
    return { taskId: task.id, target: structuredClone(task.target), source: structuredClone(task.source),
      stem: structuredClone(task.stem), answer: structuredClone(task.answer),
      answerRequirement: structuredClone(task.answerRequirement), answerStatus: task.answerStatus,
      records: structuredClone(records), pairing: structuredClone(task.preparation.originalPairing), answerCandidates,
      sourceReferences: { stem: recordSources(records.stem), answer: records.answer ? recordSources(records.answer) : [], searchedAnswer: searchedAnswerSources },
      pendingIssues: structuredClone(task.review.issues), diagnostics: diagnostics.filter(item => item.location.taskId === task.id),
      coverageCandidates: coveragePagesOf(draft).flatMap(page => candidatesOf(page).filter(candidate => declaresTask(candidate, task.id))
        .map(candidate => ({ page: page.page, candidate: structuredClone(candidate) }))) };
  });
  const neededPages = new Set([...chosen.contextPages, ...tasks.flatMap(task => [...task.source.pages, ...task.source.answerPages,
    ...task.answerCandidates.flatMap(candidate => candidate.record.source.pages)])]);
  const coverageContext = coveragePagesOf(draft).filter(page => neededPages.has(page.page)).map(page => ({
    ...structuredClone(page), referenceOnly: true, originalImage: referenceFor(page.page, page.imagePath) }));
  // Changed pages removed from the current coverage declaration still retain a
  // current indexed original, when available. A removed page is never invented.
  const additionalPageSources = [...chosen.contextPages].filter(page => !coverageContext.some(item => item.page === page)).map(page => {
    const original = byPage.get(page);
    return original ? { page, originalImage: referenceFor(page, original.file), currentCoverageMissing: true }
      : { page, currentOriginalMissing: true, referenceOnly: true };
  });
  const coverageDiagnostics = diagnostics.filter(item => item.location.path === 'coverage.pages'
    || item.location.scope === 'coverage' && neededPages.has(coveragePagesOf(draft)[item.location.pageIndex]?.page));
  const packet = { schemaVersion: 1, kind: 'local-review-materials', bookId: draft.bookId, source: draft.source,
    manifest: { path: options.manifestPath, sha256: draftSha256 }, selection: chosen.selection,
    selectedTaskIds: chosen.selectedTaskIds, removedTaskIds: chosen.removedTaskIds,
    tasks, coverageContext, coverageDiagnostics, additionalPageSources, sourceImages, regions,
    referenceOnly: true, automaticApproval: false, coverageChecked: false, sourceSemanticsVerifiedByTool: false,
    platformWritePerformed: false, readyForExecution: false, fullBatchReviewRequired: chosen.fullBatchReviewRequired,
    firstFullCoverageReviewStillRequired: true,
    limitations: ['定向材料仅定位当前草稿的审校重点，未审校题目不能用缓存替代读图',
      '完整跨页正文、答案和候选来源保留；区域共用不表示答案归属已确认',
      '首次逐页覆盖仍须检查完整题单；本材料不继承旧检查、专项声明或批准',
      '没有已声明区域的整页仅供查找，不能证明题目边界；原像素 CSS 显示不生成新裁图证据'] };
  const urls = new Map([...byPath.values()].map(item => [item.raster.id, item.url]));
  return { packet, html: renderReviewMaterials(packet, baseDir, urls), summary: { selectedTasks: tasks.length,
    totalTasks: draft.tasks.length, sourceImages: sourceImages.length, uniqueRegions: regions.length,
    removedTasks: chosen.removedTaskIds.length, draftValid: report.valid } };
}

function safeBlocks(editor, baseDir) {
  return (editor?.blocks ?? []).map(block => {
    try {
      if (!['text', 'sup', 'sub', 'image'].includes(block?.type)) throw new Error('此原生格式仍需人工处理');
      const html = renderBlockHtml(block, baseDir);
      if (/\b(?:src|href)\s*=\s*["'](?!data:|#)/iu.test(html)) throw new Error('材料不允许联网资源');
      return html;
    } catch (error) { return `<p class="invalid">${escape(error.message)}</p><pre>${escape(JSON.stringify(block, null, 2))}</pre>`; }
  }).join('');
}

function renderReviewMaterials(packet, baseDir, urls) {
  const sourceLinks = references => references.map(reference => `<li><a href="#${reference.regionId}">第 ${reference.page} 页 · ${escape(reference.image)} · ${reference.located ? `bbox [${reference.bbox.join(', ')}]` : '未定位区域，整页仅供查找'}</a><small>SHA256 ${reference.imageSha256}</small></li>`).join('');
  const tasks = packet.tasks.map((task, position) => `<article id="task-${position}"><h2>${escape(task.taskId)}</h2><p>${escape(JSON.stringify(task.target))}</p>
<div class="columns"><section><h3>完整正文</h3>${safeBlocks(task.stem, baseDir)}<h4>正文原始来源（全部跨页区域）</h4><ul>${sourceLinks(task.sourceReferences.stem)}</ul><details><summary>原始正文记录</summary><pre>${escape(JSON.stringify(task.records.stem, null, 2))}</pre></details></section>
<section><h3>完整答案 · ${escape(task.answerStatus)}</h3>${safeBlocks(task.answer, baseDir)}<h4>答案原始来源</h4><ul>${sourceLinks(task.sourceReferences.answer)}</ul>${task.sourceReferences.searchedAnswer.length ? `<p>答案未配对；以下查验页未生成答案区域。</p><ul>${sourceLinks(task.sourceReferences.searchedAnswer)}</ul>` : ''}<details><summary>原始答案记录</summary><pre>${escape(JSON.stringify(task.records.answer, null, 2))}</pre></details></section></div>
<p>作答要求：${escape(JSON.stringify(task.answerRequirement))}</p><p>待处理：${task.pendingIssues.map(escape).join('、') || '仍须实际审校'}</p>
<h3>完整答案候选（归属待实际核对）</h3>${task.answerCandidates.map(candidate => `<section class="candidate"><h4>${escape(candidate.record.id)}</h4>${safeBlocks(candidate.record.blocks ? candidate.record : { blocks: [{ type: 'text', text: candidate.record.rawOcr }] }, baseDir)}<ul>${sourceLinks(candidate.sourceReferences)}</ul><details><summary>完整候选记录</summary><pre>${escape(JSON.stringify(candidate.record, null, 2))}</pre></details></section>`).join('') || '<p>无已登记候选。不能据此认定原书缺答。</p>'}
<details><summary>本题覆盖候选与当前诊断</summary><pre>${escape(JSON.stringify({ coverageCandidates: task.coverageCandidates, diagnostics: task.diagnostics }, null, 2))}</pre></details></article>`).join('');
  const regions = packet.regions.map(region => {
    const raster = packet.sourceImages.find(image => image.id === region.imageId), [left, top, right, bottom] = region.bbox;
    const width = right - left, height = bottom - top;
    return `<figure id="${region.id}"><figcaption>${region.id} · ${escape(region.origins.map(origin => `第 ${origin.page} 页 ${origin.image}`).join('；'))} · bbox [${region.bbox.join(', ')}]<small>实际原图 SHA256 ${region.imageSha256} · <a href="#${region.imageId}">查看完整原像素页</a></small></figcaption><div class="region-window" style="aspect-ratio:${width}/${height}"><img src="${urls.get(region.imageId)}" alt="来源区域 ${region.id}" style="width:${raster.width / width * 100}%;height:${raster.height / height * 100}%;left:${-left / width * 100}%;top:${-top / height * 100}%"></div></figure>`;
  }).join('');
  const originals = packet.sourceImages.map(image => `<details id="${image.id}"><summary>${image.id} 完整原像素页 · ${escape(image.origins.map(origin => `第 ${origin.page} 页 ${origin.image}`).join('；'))}</summary><small>SHA256 ${image.sha256} · ${image.width} × ${image.height} · ${image.bytes} 字节</small><div class="original-size"><img src="${urls.get(image.id)}" alt="完整原图 ${image.id}" width="${image.width}" height="${image.height}" style="width:${image.width}px;max-width:none"></div></details>`).join('')
    + `<h2>当前覆盖诊断（问题未被修复或清除）</h2><pre>${escape(JSON.stringify(packet.coverageDiagnostics, null, 2))}</pre>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>定向审校材料</title><style>body{font:16px/1.65 system-ui,sans-serif;background:#f3f5f7;color:#17202b;margin:0}main{max-width:1280px;margin:auto;padding:24px}article,figure,details{padding:18px;background:white;border:1px solid #d7dee5;margin:18px 0}.notice{padding:16px;background:#fff4d6}pre{white-space:pre-wrap;overflow-wrap:anywhere}.columns{display:grid;grid-template-columns:1fr 1fr;gap:20px}.columns>*{min-width:0}img{max-width:100%;height:auto}small{display:block;overflow-wrap:anywhere}.region-window{position:relative;overflow:hidden;width:100%}.region-window img{position:absolute;max-width:none}.original-size{overflow:auto;max-height:85vh}.invalid{color:#a01b1b}a{color:#175e9b}summary{cursor:pointer}@media(max-width:760px){.columns{grid-template-columns:1fr}}</style></head><body><main><h1>定向审校材料</h1><p class="notice">仅定位，未审校、未批准；首次逐页覆盖仍须全量检查。区域显示直接嵌入原字节，不生成裁图或新证据。</p><p>书 ${packet.bookId} · ${escape(packet.source)} · 完整草稿 ${escape(packet.manifest.path)} · SHA256 ${packet.manifest.sha256}</p><p>定位方式：${escape(packet.selection.mode)} · 当前选中 ${packet.tasks.length} 题；移除项：${packet.removedTaskIds.map(escape).join('、') || '无'}</p>${packet.fullBatchReviewRequired ? '<p class="notice">存在批级或移除问题，仍需重新核对完整覆盖。</p>' : ''}<nav>${packet.tasks.map((task, position) => `<a href="#task-${position}">${escape(task.taskId)}</a>`).join(' · ')}</nav>${tasks || '<p>此条件没有定位到当前题目；不表示整批免审。</p>'}<h2>共用原图区域</h2>${regions}<h2>完整原像素页</h2>${originals}<h2>完整页面上下文（仅供定位）</h2><pre>${escape(JSON.stringify({ coverageContext: packet.coverageContext, additionalPageSources: packet.additionalPageSources }, null, 2))}</pre><ul>${packet.limitations.map(value => `<li>${escape(value)}</li>`).join('')}</ul></main></body></html>`;
}
