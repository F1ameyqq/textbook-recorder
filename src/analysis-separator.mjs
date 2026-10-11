// The platform's native “添加解析” control inserts this one fixed PNG.
// This is editor chrome, not a textbook figure or a caller-supplied URL.
export const ANALYSIS_SEPARATOR = Object.freeze({
  src: 'https://edu-public.cdn.bcebos.com/cms_data/2024-8/1724736856755/2bacbb368ba0.png',
  sha256: '683a4ad5512dde627078e9f5612a50d4028bc207974aadb1cf5df59fc810776c',
  width: 1028,
  height: 40,
  displayWidth: 500,
});

export const isAnalysisSeparator = block => block?.type === 'analysis-separator';

export function assertAnalysisSeparator(block) {
  if (!block || typeof block !== 'object' || Array.isArray(block)
      || !isAnalysisSeparator(block) || Object.keys(block).some(key => key !== 'type')) {
    throw new Error('analysis-separator 仅允许 type 字段，不能指定网址、图片、文字或样式');
  }
}

export function renderAnalysisSeparator(block) {
  assertAnalysisSeparator(block);
  return `<p><img style="display: block; width: ${ANALYSIS_SEPARATOR.displayWidth}px" src="${ANALYSIS_SEPARATOR.src}"></p>`;
}

// Only the existing platform image is permitted. HTML attributes are read for
// verification; they are never executed or accepted as rendering instructions.
function attribute(tag, name) {
  if (typeof tag !== 'string') return null;
  const pattern = /(?:^|\s)([a-z][a-z0-9_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/giu;
  const values = [...tag.matchAll(pattern)].filter(match => match[1].toLowerCase() === name)
    .map(match => match[2] ?? match[3] ?? match[4]);
  return values.length === 1 ? values[0] : null;
}

export function compareAnalysisSeparatorImage(image, htmlTag) {
  const errors = [];
  if (image?.src !== ANALYSIS_SEPARATOR.src || attribute(htmlTag, 'src') !== ANALYSIS_SEPARATOR.src) errors.push('解析分隔线必须使用平台固定原生图片网址');
  if (image?.sha256 !== ANALYSIS_SEPARATOR.sha256) errors.push('解析分隔线图片字节与平台固定图片不一致');
  if (image?.width !== ANALYSIS_SEPARATOR.width || image?.height !== ANALYSIS_SEPARATOR.height) errors.push('解析分隔线原生图片尺寸必须为1028×40');
  if (!['left', 'start'].includes(image?.align)) errors.push('解析分隔线必须左对齐');
  const styles = (attribute(htmlTag, 'style') ?? '').split(';').map(item => item.trim()).filter(Boolean);
  const property = name => styles.filter(item => item.split(':')[0]?.trim().toLowerCase() === name)
    .map(item => item.slice(item.indexOf(':') + 1).trim().toLowerCase());
  const widths = property('width'), displays = property('display');
  if (widths.length !== 1 || !/^500(?:\.0+)?px$/u.test(widths[0]) || displays.length !== 1 || displays[0] !== 'block') errors.push('解析分隔线必须保持原生display:block及500px宽度');
  return errors;
}
