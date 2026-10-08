import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDemoDiagram, createDemoManifest } from '../src/demo-batch.mjs';
import { inspectReviewedBatch, renderReviewedBatchPreview } from '../src/review-preflight.mjs';
import { expectedEditor, renderEditorHtml, createNewSystemRun, runNewSystemBatch } from '../src/new-system-core.mjs';
import { writableWorkspacePath } from '../src/recorder-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = await writableWorkspacePath(root, 'data/demo');
await fs.mkdir(path.join(directory, 'assets'), { recursive: true });
await writableWorkspacePath(root, 'data/demo/assets');
await fs.writeFile(path.join(directory, 'assets/demo-diagram.png'), createDemoDiagram());
const manifest = createDemoManifest();
const preflight = inspectReviewedBatch(manifest, directory);
if (!preflight.readyForExecution) throw new Error('合成演练题单未通过前置质检');
const records = new Map(); let appendCalls = 0;
const side = editor => {
  const expected = expectedEditor(editor, directory);
  return { ...expected, html: renderEditorHtml(editor, directory), images: expected.images.map(image => ({ ...image, complete: true, width: 240, height: 100, align: 'center' })) };
};
const adapter = {
  source: 'fixture', bookId: manifest.bookId,
  async read(task, { refresh }) {
    if (refresh !== true) throw new Error('演练回读必须显式 fresh');
    return records.get(task.id) ?? { status: 'missing', bookId: manifest.bookId, target: task.target, count: records.size };
  },
  async append(task, { checkpoint }) {
    appendCalls++;
    const recordId = 1000 + task.target.record;
    const receipt = { bookId: manifest.bookId, seqIndex: task.target.record, shitiID: recordId, mainPicNum: task.source.pages[0], answerPicNum: task.source.answerPages[0],
      request: { bookId: manifest.bookId, seqIndex: task.target.record, mainPicNum: task.source.pages[0], answerPicNum: task.source.answerPages[0] },
      response: { status: 200, body: { errno: 0, errmsg: 'success', data: { seqIndex: task.target.record, shitiID: recordId, haveAnswer: true } } } };
    records.set(task.id, { status: 'found', bookId: manifest.bookId, target: task.target, source: task.source, recordId, count: records.size + 1, stem: side(task.stem), answer: side(task.answer) });
    await checkpoint(receipt);
    return receipt;
  },
};
const first = await runNewSystemBatch({ manifest, adapter, baseDir: directory, state: createNewSystemRun(manifest, { baseDir: directory }), limit: 20 });
const second = await runNewSystemBatch({ manifest, adapter, baseDir: directory, state: first, limit: 20 });
if (first.status !== 'completed' || second.status !== 'completed' || appendCalls !== manifest.tasks.length) throw new Error('演练失败：重复运行不得重复新增');
for (const [filename, value] of [['batch.json', manifest], ['preflight.json', preflight], ['progress.json', second]]) {
  await writableWorkspacePath(root, `data/demo/${filename}`);
  await fs.writeFile(path.join(directory, filename), JSON.stringify(value, null, 2) + '\n');
}
await writableWorkspacePath(root, 'data/demo/preview.html');
await fs.writeFile(path.join(directory, 'preview.html'), renderReviewedBatchPreview(manifest, directory, preflight));
console.log(JSON.stringify({ status: 'passed', mode: 'synthetic-offline', tasks: manifest.tasks.length, firstAppendCalls: appendCalls, duplicateAppendCalls: 0, platformRequests: 0, modelCalls: 0, preview: 'data/demo/preview.html', limitations: '本地合成回读，不代表真实平台或其他电脑验收' }, null, 2));
