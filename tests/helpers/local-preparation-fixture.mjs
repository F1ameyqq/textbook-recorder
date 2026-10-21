import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createDemoDiagram } from '../../src/demo-batch.mjs';
import { sha256 } from '../../src/preparation-files.mjs';

export async function localFixture(t, { source = 'fixture', conflicting = false } = {}) {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'recorder-local-prep-'));
  t.after(async () => {
    const target = await fs.realpath(project), temporary = await fs.realpath(os.tmpdir());
    const relative = path.relative(temporary, target);
    assert.ok(!path.isAbsolute(relative) && !relative.startsWith('..') && relative.startsWith('recorder-local-prep-'));
    await fs.rm(target, { recursive: true, force: true });
  });
  const job = path.join(project, 'data', 'jobs', 'synthetic');
  await fs.mkdir(path.join(job, 'images'), { recursive: true });
  const write = async (name, value) => {
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
    const file = path.join(job, name);
    await fs.writeFile(file, bytes, { flag: 'wx' });
    return { file, path: name, sha256: sha256(bytes), value };
  };
  const bytes = createDemoDiagram(), pages = [];
  for (let page = 1; page <= 3; page++) {
    const file = `images/page-${page}.png`;
    await fs.writeFile(path.join(job, file), bytes);
    pages.push({ systemPage: page, file, sha256: sha256(bytes), width: 240, height: 100 });
  }
  const origin = selected => ({ pages: selected, images: selected.map(page => pages[page - 1].file),
    regions: selected.map(page => ({ page, image: pages[page - 1].file, bbox: [0, 0, 240, 100] })) });
  const record = (id, text, selected, questionNumber) => ({ id, chapter: '合成章', unit: '合成节', group: '基础', questionNumber,
    rawOcr: '', blocks: [{ type: 'text', text, strictSpacing: true }], source: origin(selected) });
  const recordsValue = { schemaVersion: 1, bookId: 900001,
    questions: [record('q1', '1. 合成跨页题？', [1, 2], '1'), record('q2', '2. 合成第二题？', [2], '2')],
    answers: [record('a1', '合成答案甲', [3], '1'), record('a2', '合成答案乙', [3], '2'),
      ...(conflicting ? [record('a1b', '合成候选答案', [3], '1')] : [])] };
  const plan = await write('plan.json', { schemaVersion: 1, kind: 'local-workflow-plan', bookId: 900001, source,
    scope: { pages: [1, 2, 3], sections: [{ chapterLabel: '合成章', sectionLabel: '合成节', startRecord: 1, recordLimit: 20 }] } });
  const index = await write('index.json', { schemaVersion: 1, bookId: 900001, pages });
  const records = await write('records.json', recordsValue);
  const order = await write('order.json', { schemaVersion: 1, kind: 'confirmed-question-order', bookId: 900001, confirmed: true,
    sections: [{ chapterLabel: '合成章', sectionLabel: '合成节', questionIds: ['q1', 'q2'] }] });
  const mapping = await write('mapping.checked.json', { schemaVersion: 1, kind: 'new-system-draft-mapping', bookId: 900001, source,
    sourceBinding: { plan: plan.sha256, records: records.sha256, index: index.sha256, order: order.sha256 },
    index: { path: index.path, sha256: index.sha256 }, placements: recordsValue.questions.map((question, position) => ({
      questionId: question.id, target: { chapterLabel: '合成章', sectionLabel: '合成节', record: position + 1 },
      answerRequirement: { kind: 'question', evidence: question.blocks[0].text }, answerStatus: 'provided' })),
    coverage: { pages: [1, 2].map(page => ({ page, imagePath: pages[page - 1].file,
      candidates: recordsValue.questions.filter(question => question.source.pages.includes(page)).map(question => ({
        id: `candidate-${question.id}-${page}`, type: 'question', decision: 'include', taskIds: [question.id] })) })) } });
  const argv = ['plan', 'records', 'index', 'order'].map(role => `--${role}=${({ plan, records, index, order })[role].file}`);
  return { project, job, write, argv, plan, index, records, order, mapping };
}
