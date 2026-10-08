import { deflateSync } from 'node:zlib';

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(kind, bytes) {
  const type = Buffer.from(kind), length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length); crc.writeUInt32BE(crc32(Buffer.concat([type, bytes])));
  return Buffer.concat([length, type, bytes, crc]);
}
/** An authored colored-block diagram, generated without any source-book image. */
export function createDemoDiagram() {
  const width = 240, height = 100, header = Buffer.alloc(13), rows = Buffer.alloc(height * (width * 3 + 1));
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  for (let y = 0; y < height; y++) {
    rows[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const color = y >= 20 && y < 80 && x >= 20 && x < 100 ? [40, 120, 210]
        : y >= 20 && y < 80 && x >= 140 && x < 220 ? [230, 140, 40] : [255, 255, 255];
      rows.set(color, y * (width * 3 + 1) + 1 + x * 3);
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

export function createDemoManifest() {
  const review = () => ({ status: 'approved', issues: [], checks: { sourceText: true, answerMatch: true, wholeQuestion: true, format: true } });
  const common = (id, record, evidence, kind = 'question') => ({
    id, target: { chapterLabel: '合成演练章', sectionLabel: '第1节 录入演练', record },
    source: { pages: [1], answerPages: [2] }, answerRequirement: { kind, evidence }, answerStatus: 'provided', review: review(),
  });
  return {
    schemaVersion: 1, kind: 'new-system-batch', bookId: 100001, source: 'fixture',
    notes: ['完全合成的离线演练样例，不对应真实书籍；fixture 禁止写入生产平台。'],
    tasks: [
      { ...common('demo-diagram', 1, '选择图中左侧色块的颜色'),
        stem: { blocks: [{ type: 'text', text: '1. 图中左侧色块的颜色是（　）' }, { type: 'image', path: 'assets/demo-diagram.png', align: 'center', purpose: 'diagram' }, { type: 'text', text: 'A. 蓝色\nB. 橙色' }] },
        answer: { blocks: [{ type: 'text', text: 'A' }] } },
      { ...common('demo-knowledge', 2, '请填写两处单位换算空白', 'fill-in'),
        stem: { blocks: [{ type: 'text', text: '知识建构：请填写 1 km＝______ m；1 h＝______ min。' }] },
        answer: { blocks: [{ type: 'text', parts: ['1000', '60'] }] } },
      { ...common('demo-whole-activity', 3, '完整活动包含两个需要作答的小问，保留为一题'),
        stem: { blocks: [{ type: 'text', text: '2. 完整活动：比较两个色块。\n（1）左侧是什么颜色？\n（2）右侧是什么颜色？' }] },
        answer: { blocks: [{ type: 'text', parts: ['（1）蓝色', '（2）橙色'] }] } },
      { ...common('demo-open-question', 4, '请提出两条减少用水浪费的具体建议'), answerStatus: 'not-provided',
        stem: { blocks: [{ type: 'text', text: '3. 请提出两条减少用水浪费的具体建议。' }] },
        answer: { blocks: [{ type: 'text', text: '原书未提供参考答案' }] } },
    ],
    coverage: { pages: [{ page: 1, imagePath: 'assets/demo-diagram.png', candidates: [
      { id: 'candidate-diagram', type: 'question', decision: 'include', taskIds: ['demo-diagram'] },
      { id: 'candidate-knowledge', type: 'knowledge-construction', decision: 'include', taskIds: ['demo-knowledge'] },
      { id: 'candidate-activity', type: 'whole-activity', decision: 'include', taskIds: ['demo-whole-activity'] },
      { id: 'candidate-open', type: 'question', decision: 'include', taskIds: ['demo-open-question'] },
      { id: 'candidate-explanation', type: 'non-question', decision: 'exclude', taskIds: [], reason: '仅课堂目标、展示和评价说明，没有独立作答要求' },
    ] }] },
  };
}
