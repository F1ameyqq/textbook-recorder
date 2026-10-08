import { renderBlockHtml } from './new-system-core.mjs';
import { resolveAssetPath } from './core.mjs';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { reviewAnchor, reviewText } from './review-issues.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
export const escapeReviewHtml = value => reviewText(value).replace(/&/gu, '&amp;').replace(/</gu, '&lt;')
  .replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&#39;');

export function previewBlock(block, baseDir) {
  try { return renderBlockHtml(block, baseDir); }
  catch (error) {
    return `<p class="invalid">${escapeReviewHtml(error.message)}</p><pre>${escapeReviewHtml(JSON.stringify(block))}</pre>`;
  }
}

function dimensions(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString('ascii', 12, 16) === 'IHDR') {
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (positive(width) && positive(height)) return { width, height };
  }
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset < bytes.length) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 217 || marker === 218) break;
      if (marker === 0 || marker === 216 || marker >= 208 && marker <= 215 || marker === 1) continue;
      if (offset + 2 > bytes.length) break;
      const size = bytes.readUInt16BE(offset);
      if (size < 2 || offset + size > bytes.length) break;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && size >= 8) {
        const height = bytes.readUInt16BE(offset + 3), width = bytes.readUInt16BE(offset + 5);
        if (positive(width) && positive(height)) return { width, height };
      }
      offset += size;
    }
  }
  throw new Error('原图缺少有效 PNG/JPEG 像素尺寸，不能显示区域');
}

function safeRaster(filename, baseDir, cache) {
  if (cache.has(filename)) return cache.get(filename);
  // This established renderer validates relative and real paths, file type and
  // raster signature. Only its validated data URL is reused, never raw paths.
  const html = renderBlockHtml({ type: 'image', path: filename, align: 'center' }, baseDir);
  const url = /src="(data:image\/(?:png|jpeg);base64,([A-Za-z0-9+/=]+))"/u.exec(html);
  if (!url) throw new Error('原图未产生受支持的本地栅格');
  const bytes = Buffer.from(url[2], 'base64');
  const raster = { url: url[1], ...dimensions(bytes), sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length, mimeType: url[1].startsWith('data:image/png;') ? 'image/png' : 'image/jpeg' };
  cache.set(filename, raster);
  return raster;
}

/** Supplement only missing page images from byte-bound local index evidence. */
export function resolvePreviewSourcePages(manifest, coveragePages, baseDir, cache = new Map()) {
  const reference = manifest?.preparation?.index;
  if (reference === undefined) return { pages: coveragePages, issue: null };
  try {
    if (!object(reference) || typeof reference.path !== 'string' || !/^[a-f0-9]{64}$/u.test(reference.sha256 ?? '')) throw new Error('index 引用须为相对路径和精确 SHA256');
    const root = realpathSync(baseDir), entry = resolveAssetPath(reference.path, root), real = realpathSync(entry), relative = path.relative(root, real);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || !statSync(real).isFile()) throw new Error('index 来源路径或软链接越出同 job');
    const bytes = readFileSync(real);
    if (createHash('sha256').update(bytes).digest('hex') !== reference.sha256) throw new Error('index 引用 SHA256 已变化');
    const index = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, ''));
    if (!object(index) || index.schemaVersion !== 1 || index.bookId !== manifest.bookId || !Array.isArray(index.pages) || !index.pages.length) throw new Error('index 版本、bookId 或 pages 无效');
    const pageIds = new Set(), filenames = new Set(), result = [...coveragePages];
    const needed = new Set((Array.isArray(manifest.tasks) ? manifest.tasks : []).flatMap(task => ['pages', 'answerPages']
      .flatMap(field => Array.isArray(task?.source?.[field]) ? task.source[field].filter(positive) : [])));
    for (const page of index.pages) {
      if (!object(page) || !positive(page.systemPage) || pageIds.has(page.systemPage) || typeof page.file !== 'string'
          || filenames.has(page.file) || !/^[a-f0-9]{64}$/u.test(page.sha256 ?? '') || !positive(page.width) || !positive(page.height)) throw new Error('index 页号、路径、SHA256 或尺寸无效/重复');
      pageIds.add(page.systemPage); filenames.add(page.file);
      if (!needed.has(page.systemPage)) continue;
      const existing = result.find(original => original?.page === page.systemPage);
      if (existing?.imagePath !== undefined) {
        if (existing.imagePath !== page.file) throw new Error('index 与覆盖清单的原页路径不一致');
        continue;
      }
      const raster = safeRaster(page.file, baseDir, cache);
      if (raster.sha256 !== page.sha256 || raster.width !== page.width || raster.height !== page.height
          || page.bytes !== undefined && raster.bytes !== page.bytes || page.mimeType !== undefined && raster.mimeType !== page.mimeType) throw new Error(`index 原图 ${page.systemPage} 的字节、SHA256 或尺寸不一致`);
      if (existing) result[result.indexOf(existing)] = { ...existing, imagePath: page.file };
      else result.push({ page: page.systemPage, imagePath: page.file });
    }
    return { pages: result, issue: null };
  } catch (error) { return { pages: coveragePages, issue: `原图 index 无法用于来源补全：${error.message}` }; }
}

function fullPage(raster, caption) {
  return `<details class="full-source"><summary>查看整页（原像素，可滚动）</summary><p class="meta">${escapeReviewHtml(caption)}</p><div class="original-size"><img src="${raster.url}" alt="${escapeReviewHtml(caption)}" width="${raster.width}" height="${raster.height}" style="width:${raster.width}px;max-width:none"></div></details>`;
}

function regionView(region, source, expectedPages, pages, baseDir, cache, position) {
  try {
    if (!object(region) || !positive(region.page) || typeof region.image !== 'string'
        || !Array.isArray(expectedPages) || !expectedPages.includes(region.page)
        || !Array.isArray(source.pages) || !source.pages.includes(region.page)) throw new Error('区域 page/image 与本题声明来源页不一致');
    if (Array.isArray(source.images) && !source.images.includes(region.image)) throw new Error('区域 image 不在本题声明的 source.images');
    const original = pages.find(page => page?.page === region.page);
    if (original?.imagePath !== undefined && original.imagePath !== region.image) throw new Error('区域 image 与覆盖清单的原页图不一致');
    const raster = safeRaster(region.image, baseDir, cache), box = region.bbox;
    if (!Array.isArray(box) || box.length !== 4 || box.some(value => !Number.isSafeInteger(value) || value < 0)
        || box[2] <= box[0] || box[3] <= box[1] || box[2] > raster.width || box[3] > raster.height) throw new Error('bbox 须为原像素有效范围 [left,top,right,bottom]，且不能越出实际原图');
    const [left, top, right, bottom] = box, width = right - left, height = bottom - top;
    const caption = `来源区域 ${position + 1} · 原书页 ${region.page} · bbox [${box.join(', ')}] · ${region.image}`;
    return `<figure class="source-region"><figcaption>${escapeReviewHtml(caption)}</figcaption><div class="region-window" style="aspect-ratio:${width}/${height}"><img src="${raster.url}" alt="${escapeReviewHtml(caption)}" style="width:${raster.width / width * 100}%;height:${raster.height / height * 100}%;left:${-left / width * 100}%;top:${-top / height * 100}%"></div>${fullPage(raster, caption)}</figure>`;
  } catch (error) {
    return `<div class="invalid source-region">来源区域 ${position + 1} 无法显示：${escapeReviewHtml(error.message)}<pre>${escapeReviewHtml(JSON.stringify(region))}</pre></div>`;
  }
}

/** CSS windows show existing original bytes; no new crop or evidence is made. */
export function renderTaskSources(task, side, taskIndex, pages, baseDir, cache = new Map()) {
  const source = task.preparation?.records?.[side]?.source;
  const expectedPages = task.source?.[side === 'stem' ? 'pages' : 'answerPages'];
  const anchor = reviewAnchor({ taskIndex, side, source: true });
  const label = side === 'stem' ? '正文原图' : '答案原图';
  const heading = `<section class="source-side" id="${anchor}"><h4>${label}</h4>`;
  if (object(source) && Array.isArray(source.regions) && source.regions.length) {
    return `${heading}${source.regions.map((region, index) => regionView(region, source, expectedPages, pages, baseDir, cache, index)).join('')}</section>`;
  }
  const malformed = source?.regions !== undefined && !Array.isArray(source.regions);
  let originals = [];
  if (Array.isArray(source?.images) && source.images.length) originals = source.images.map(image => ({ image, caption: `声明来源页 ${(Array.isArray(source.pages) ? source.pages : []).map(reviewText).join(', ')} · ${reviewText(image)}（未声明区域）` }));
  else if (Array.isArray(expectedPages)) originals = expectedPages.map(page => ({ image: pages.find(original => original?.page === page)?.imagePath, caption: `原书页 ${reviewText(page)}（未声明区域）` }));
  const views = originals.map(original => {
    if (original.image === undefined) return `<p class="missing-source">${escapeReviewHtml(original.caption)}：未附本地原图</p>`;
    try {
      const raster = safeRaster(original.image, baseDir, cache);
      return `<figure class="source-region"><figcaption>${escapeReviewHtml(original.caption)}</figcaption><img src="${raster.url}" alt="${escapeReviewHtml(original.caption)}">${fullPage(raster, original.caption)}</figure>`;
    } catch (error) { return `<p class="invalid">${escapeReviewHtml(original.caption)}：${escapeReviewHtml(error.message)}</p>`; }
  }).join('');
  return `${heading}<p class="${malformed ? 'invalid' : 'meta'}">${malformed ? 'regions 格式无效。' : '未声明原像素区域。'}下面整页仅供寻找来源，不能证明题目边界或审校完成。</p>${views || '<p class="missing-source">未附本地原图</p>'}</section>`;
}

export function renderReviewDiagnostic(diagnostic) {
  const labels = { error: '错误', warning: '提示', review: '待审' };
  return `<li class="diagnostic ${escapeReviewHtml(diagnostic.severity)}"><a href="#${escapeReviewHtml(diagnostic.anchor)}">${labels[diagnostic.severity] ?? '问题'}：${escapeReviewHtml(diagnostic.message)}</a><p class="diagnostic-location">定位：<code>${escapeReviewHtml(diagnostic.location?.path)}</code> · 建议输入：<code>${escapeReviewHtml(diagnostic.input)}</code></p><p>${escapeReviewHtml(diagnostic.action)}</p></li>`;
}
