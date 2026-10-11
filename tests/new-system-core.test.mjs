import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  validateNewSystemManifest, renderBlockHtml, renderEditorHtml, expectedEditor,
  compareNewSystemReadback, verifyNewSystemSave, createNewSystemRun, runNewSystemBatch,
  ANSWER_PART_SPACE_COUNT,
} from '../src/new-system-core.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR9cAAAAASUVORK5CYII=', 'base64');
function fixture(t, count = 1) {
  const baseDir = mkdtempSync(path.join(os.tmpdir(), 'recorder-new-core-'));
  t.after(() => rmSync(baseDir, { recursive: true, force: true }));
  writeFileSync(path.join(baseDir, 'figure.png'), png);
  const tasks = Array.from({ length: count }, (_, index) => ({
    id: `q${index + 1}`, target: { chapterLabel: '第十三章 内能', sectionLabel: '第2节 分子动理论的初步知识', record: index + 1 },
    source: { pages: [15], answerPages: [243] },
    stem: { blocks: [{ type: 'text', text: `【典题${index + 1}】 A < B & C？` }, { type: 'image', path: 'figure.png', align: 'center' }, { type: 'text', text: 'A. 分子\nB. 原子' }] },
    answer: { blocks: [{ type: 'text', text: 'B' }] }, review: { status: 'approved', issues: [] },
  }));
  return { baseDir, manifest: { schemaVersion: 1, kind: 'new-system-batch', bookId: 100001, source: 'fixture', tasks }, task: tasks[0] };
}
function readback(task, baseDir, recordId = 1001) {
  const editor = side => {
    const expected = expectedEditor(task[side], baseDir);
    return { ...expected, html: renderEditorHtml(task[side], baseDir), images: expected.images.map(image => ({ ...image, complete: true, width: 1, height: 1, align: 'center' })) };
  };
  return { status: 'found', bookId: 100001, target: { ...task.target }, source: structuredClone(task.source), recordId, stem: editor('stem'), answer: editor('answer') };
}
function receipt(task, recordId = 1001) {
  return { bookId: 100001, seqIndex: task.target.record, shitiID: recordId, mainPicNum: task.source.pages[0], answerPicNum: task.source.answerPages[0],
    request: { bookId: 100001, seqIndex: task.target.record, mainPicNum: task.source.pages[0], answerPicNum: task.source.answerPages[0] },
    response: { status: 200, body: { errno: 0, errmsg: 'success', data: { seqIndex: task.target.record, shitiID: recordId, haveAnswer: true } } } };
}
function adapterFor(baseDir, options = {}) {
  const records = new Map();
  let calls = 0;
  const adapter = {
    source: 'fixture', bookId: 100001, records, get appendCalls() { return calls; },
    async read(task, { refresh } = {}) {
      assert.equal(refresh, true, 'all acceptance reads must refresh');
      return records.get(task.target.record) ?? { status: 'missing', bookId: 100001, target: { ...task.target }, count: records.size };
    },
    async append(task, context) {
      calls += 1;
      const ack = receipt(task, 1000 + task.target.record);
      if (options.beforeWrite) return options.beforeWrite(task, context, ack);
      records.set(task.target.record, readback(task, baseDir, ack.shitiID));
      if (options.afterWrite) return options.afterWrite(task, context, ack);
      await context.checkpoint(ack);
      return ack;
    },
  };
  return adapter;
}

test('new autosave may omit its ID; response must acquire a positive ID', t => {
  const { task } = fixture(t);
  assert.equal(verifyNewSystemSave(task, receipt(task), { bookId: 100001 }).ok, true);
  const bad = receipt(task); bad.shitiID = 0; bad.response.body.data.shitiID = 0;
  assert.equal(verifyNewSystemSave(task, bad, { bookId: 100001 }).ok, false);
  assert.equal(verifyNewSystemSave(task, receipt(task), { bookId: 100001, existingRecordId: 1001 }).ok, false);
  const update = receipt(task); update.request.shitiID = 1001;
  assert.equal(verifyNewSystemSave(task, update, { bookId: 100001, existingRecordId: 1001 }).ok, true);
});

test('mixed subscript answer groups require exactly eight half-width spaces when strictSpacing is set', t => {
  const {task,manifest,baseDir}=fixture(t);
  task.answer.blocks=[{type:'text',strictSpacing:true,runs:[{type:'text',text:'S'},{type:'sub',text:'2'},{type:'text',text:'\u00a0'.repeat(8)+'S'},{type:'sub',text:'1'}]}];
  assert.equal(validateNewSystemManifest(manifest,baseDir).valid,true);
  assert.equal(compareNewSystemReadback(task,readback(task,baseDir),{baseDir,bookId:100001}).ok,true);
  for(const gap of ['  ','\u00a0'.repeat(7),'\u00a0'.repeat(9),'\u3000'.repeat(8)]) {
    const actual=readback(task,baseDir);
    actual.answer.paragraphs[0].text=actual.answer.paragraphs[0].text.replace('\u00a0'.repeat(8),gap);
    actual.answer.text=actual.answer.paragraphs[0].text;
    assert.equal(compareNewSystemReadback(task,actual,{baseDir,bookId:100001}).ok,false);
  }
  task.answer.blocks[0].strictSpacing='true';
  assert.equal(validateNewSystemManifest(manifest,baseDir).valid,false);
});

test('explicit strict spacing on either editor renders indentation, gaps and choice blanks as NBSP', t => {
  const { task, manifest, baseDir } = fixture(t);
  const text = '   首段（        ）\nA. 甲        乙';
  const expectedContents = '&nbsp;&nbsp;&nbsp;首段（' + '&nbsp;'.repeat(8) + '）<br>A.&nbsp;甲' + '&nbsp;'.repeat(8) + '乙';
  for (const side of ['stem', 'answer']) {
    task[side].blocks = [{ type: 'text', text, strictSpacing: true }];
    assert.equal(validateNewSystemManifest(manifest, baseDir).valid, true);
    assert.equal(renderEditorHtml(task[side], baseDir), `<p style="text-align:left;direction:ltr" dir="ltr" align="left">${expectedContents}</p>`);
    assert.equal(expectedEditor(task[side], baseDir).text, text, 'authoring text retains its original code-point offsets');
    task[side].blocks[0].strictSpacing = false;
    assert.doesNotMatch(renderEditorHtml(task[side], baseDir), /&nbsp;/u, 'ordinary text retains existing whitespace semantics');
    task[side].blocks[0].strictSpacing = true;
  }
});

test('strict paragraph readback rejects collapsed, shortened or removed spaces without trimming indentation', t => {
  const { task, baseDir } = fixture(t);
  const text = '   段首（        ）\n   A. 甲        乙 ';
  const changes = [
    text => text.replace(/ {8}/gu, ' '),
    text => text.replace(/ {8}/u, ' '.repeat(7)),
    text => text.slice(1),
    text => text.trimStart(),
    text => text.replace('\n   ', '\n'),
    text => text.trimEnd(),
  ];
  for (const side of ['stem', 'answer']) {
    task[side].blocks = [{ type: 'text', text, strictSpacing: true }];
    const independentParagraph = { text: text.replace(/ /gu, '\u00a0'), imageCount: 0, align: 'left', direction: 'ltr' };
    const good = readback(task, baseDir);
    good[side].paragraphs = [independentParagraph];
    assert.equal(compareNewSystemReadback(task, good, { baseDir }).ok, true);
    for (const mutate of changes) {
      const actual = readback(task, baseDir);
      // Full-editor text intentionally stays unchanged: paragraph evidence must
      // independently detect the missing spaces, including at either edge.
      actual[side].paragraphs = [{ ...independentParagraph, text: mutate(text) }];
      const comparison = compareNewSystemReadback(task, actual, { baseDir });
      assert.equal(comparison.ok, false, `${side}: ${JSON.stringify(actual[side].paragraphs[0].text)}`);
      assert.match(comparison.errors.join('; '), /严格空格间隔或段首空格/u);
    }
  }
});

test('strictSpacing rejects nonboolean values and nontext blocks rather than silently ignoring them', t => {
  const { task, manifest, baseDir } = fixture(t);
  for (const block of [{ type: 'text', text: '正文', strictSpacing: 'true' }, { type: 'sup', text: '2', strictSpacing: true }]) {
    task.stem.blocks = [block];
    assert.equal(validateNewSystemManifest(manifest, baseDir).valid, false);
    assert.throws(() => renderEditorHtml(task.stem, baseDir), /strictSpacing/u);
  }
});

test('HTTP 200 with platform errno or missing answer is rejected', t => {
  const { task } = fixture(t);
  for (const edit of [ack => { ack.response.body.errno = 300006; }, ack => { ack.response.body.data.haveAnswer = false; }, ack => { ack.response.body.errmsg = 'ok'; }]) {
    const ack = receipt(task); edit(ack);
    assert.equal(verifyNewSystemSave(task, ack, { bookId: 100001 }).ok, false);
  }
});

test('wrong book, sequence, persisted ID and source page cannot confirm a save', t => {
  const { task } = fixture(t);
  for (const edit of [ack => { ack.request.bookId += 1; }, ack => { ack.request.seqIndex += 1; }, ack => { ack.request.mainPicNum += 1; }, ack => { ack.request.answerPicNum += 1; }, ack => { ack.response.body.data.shitiID += 1; }]) {
    const ack = receipt(task); edit(ack);
    assert.equal(verifyNewSystemSave(task, ack, { bookId: 100001 }).ok, false);
  }
});

test('each image paragraph closes before a left-aligned option paragraph', t => {
  const { task, baseDir } = fixture(t);
  const html = renderEditorHtml(task.stem, baseDir);
  assert.match(html, /A &lt; B &amp; C/);
  assert.equal((html.match(/<p /gu) ?? []).length, 3);
  assert.match(html, /text-align:center[^]*?<img[^]*?<\/p><p style="text-align:left;direction:ltr" dir="ltr" align="left">A\. 分子/);
  const styleFiltered = html.replace(/\sstyle="[^"]*"/gu, '');
  assert.match(styleFiltered, /<p dir="ltr" align="center"><img/);
  assert.match(styleFiltered, /<\/p><p dir="ltr" align="left">A\. 分子/);
  const centerParagraph = [...html.matchAll(/<p\b[^>]*>[\s\S]*?<\/p>/gu)].map(match => match[0]).find(paragraph => paragraph.includes('text-align:center'));
  assert.doesNotMatch(centerParagraph, /A\. 分子/u);
  const rb = readback(task, baseDir);
  assert.equal(compareNewSystemReadback(task, rb, { baseDir, bookId: 100001 }).ok, true);
  rb.stem.paragraphs[2].align = 'center';
  assert.equal(compareNewSystemReadback(task, rb, { baseDir, bookId: 100001 }).ok, false);
});

test('full-width layout spaces collapse without ignoring numbers or word boundaries', t => {
  const { task, baseDir } = fixture(t);
  task.stem.blocks[0].text = '选择（　） 10 kg';
  const rb = readback(task, baseDir);
  rb.stem.text = rb.stem.text.replace('（　）', '（　　）');
  rb.stem.paragraphs[0].text = rb.stem.paragraphs[0].text.replace('（　）', '（　　）');
  assert.equal(compareNewSystemReadback(task, rb, { baseDir }).ok, true);
  rb.stem.text = rb.stem.text.replace('10 kg', '100 kg');
  assert.equal(compareNewSystemReadback(task, rb, { baseDir }).ok, false);
  rb.stem.text = expectedEditor(task.stem, baseDir).text.replace('10 kg', '10kg');
  assert.equal(compareNewSystemReadback(task, rb, { baseDir }).ok, false);
});

test('explicit answer parts preserve exactly eight half-width spaces without guessing word boundaries', t => {
  const { task, manifest, baseDir } = fixture(t);
  task.answer.blocks = [{ type: 'text', parts: ['降低', '减小', '热传递'] }];
  assert.equal(validateNewSystemManifest(manifest, baseDir).valid, true);
  assert.equal(ANSWER_PART_SPACE_COUNT, 8);
  const html = renderEditorHtml(task.answer, baseDir);
  assert.equal((html.match(/&nbsp;/gu) ?? []).length, 16);
  assert.equal(expectedEditor(task.answer, baseDir).text, `降低${'\u00a0'.repeat(8)}减小${'\u00a0'.repeat(8)}热传递`);
  const rb = readback(task, baseDir);
  rb.answer.text = rb.answer.text.replace(/\u00a0/gu, ' ');
  rb.answer.paragraphs[0].text = rb.answer.paragraphs[0].text.replace(/\u00a0/gu, ' ');
  assert.equal(compareNewSystemReadback(task, rb, { baseDir }).ok, true, 'eight ordinary half-width spaces and NBSP are equivalent');

  task.answer.blocks = [{ type: 'text', parts: ['New York', "do one's homework", 'A < B & C'] }];
  const english = renderEditorHtml(task.answer, baseDir);
  assert.match(english, /New York(?:&nbsp;){8}do one&#39;s homework(?:&nbsp;){8}A &lt; B &amp; C/u);
  assert.equal(compareNewSystemReadback(task, readback(task, baseDir), { baseDir }).ok, true);
  task.answer.blocks = [{ type: 'text', text: 'New York do homework' }];
  assert.doesNotMatch(renderEditorHtml(task.answer, baseDir), /&nbsp;/u, 'existing plain text is not split into answers');
});

test('answer part gaps must survive both full-editor and paragraph readback', t => {
  const { task, baseDir } = fixture(t);
  task.answer.blocks = [{ type: 'text', parts: ['降低', '减小', '热传递'] }];
  for (const gap of ['', ' ', ' '.repeat(7), ' '.repeat(9), '\u3000'.repeat(8), '\t'.repeat(8)]) {
    for (const scope of ['text', 'paragraph', 'both']) {
      const rb = readback(task, baseDir);
      if (scope !== 'paragraph') rb.answer.text = rb.answer.text.replace(/\u00a0{8}/gu, gap);
      if (scope !== 'text') rb.answer.paragraphs[0].text = rb.answer.paragraphs[0].text.replace(/\u00a0{8}/gu, gap);
      const comparison = compareNewSystemReadback(task, rb, { baseDir });
      assert.equal(comparison.ok, false, `${JSON.stringify(gap)} in ${scope} must not be accepted`);
      assert.match(comparison.errors.join('; '), /8个半角空格间隔/u);
    }
  }
});

test('answer parts require explicit nonempty boundaries and cannot collide with text, runs or stem', t => {
  const { task, manifest, baseDir } = fixture(t);
  for (const block of [
    { type: 'text', parts: ['B'] },
    { type: 'text', parts: ['降低', ''] },
    { type: 'text', parts: ['降低', ' 减小'] },
    { type: 'text', parts: ['降低', '减小\n热传递'] },
    { type: 'text', parts: ['降低', '减小'], text: '降低 减小' },
    { type: 'text', parts: ['降低', '减小'], runs: [{ type: 'text', text: '降低' }] },
    { type: 'sup', text: '2', parts: ['降低', '减小'] },
  ]) {
    task.answer.blocks = [block];
    assert.equal(validateNewSystemManifest(manifest, baseDir).valid, false);
    assert.throws(() => renderEditorHtml(task.answer, baseDir), /parts/u);
  }
  task.answer.blocks = [{ type: 'text', text: 'B' }];
  task.stem.blocks = [{ type: 'text', parts: ['降低', '减小'] }];
  assert.equal(validateNewSystemManifest(manifest, baseDir).valid, false);
});

test('an existing answer with the wrong gap is neither skipped nor overwritten', async t => {
  const { task, manifest, baseDir } = fixture(t);
  task.answer.blocks = [{ type: 'text', parts: ['降低', '减小', '热传递'] }];
  const adapter = adapterFor(baseDir);
  const rb = readback(task, baseDir);
  rb.answer.text = rb.answer.text.replace(/\u00a0{8}/gu, ' ');
  rb.answer.paragraphs[0].text = rb.answer.text;
  adapter.records.set(1, rb);
  const state = await runNewSystemBatch({ manifest, adapter, baseDir });
  assert.equal(state.status, 'failed');
  assert.match(state.tasks[0].lastError, /拒绝覆盖/u);
  assert.equal(adapter.appendCalls, 0);
});

test('image identity, order, load and isolated centered paragraphs are required', t => {
  const { task, baseDir } = fixture(t);
  for (const edit of [rb => { rb.stem.images[0].sha256 = 'bad'; }, rb => { rb.stem.images[0].complete = false; }, rb => { rb.stem.images[0].width = 0; }, rb => { rb.stem.images[0].align = 'left'; }, rb => { rb.stem.paragraphs[1].text = 'B. 原子'; }, rb => { rb.stem.paragraphs[2].direction = 'rtl'; }, rb => { rb.source.answerPages = [244]; }]) {
    const rb = readback(task, baseDir); edit(rb);
    assert.equal(compareNewSystemReadback(task, rb, { baseDir, bookId: 100001 }).ok, false);
  }
  task.stem.blocks.splice(2, 0, { type: 'image', path: 'figure.png', align: 'center' });
  const rb = readback(task, baseDir); rb.stem.images[1].sha256 = 'different';
  rb.stem.images.reverse();
  assert.equal(compareNewSystemReadback(task, rb, { baseDir, bookId: 100001 }).ok, false);
});

test('sup/sub are escaped, retained and checked; complex formulas are explicitly rejected', t => {
  const { manifest, task, baseDir } = fixture(t);
  task.answer.blocks = [{ type: 'text', runs: [{ type: 'text', text: '10' }, { type: 'sup', text: '-10' }, { type: 'text', text: ' m & H' }, { type: 'sub', text: '2' }] }];
  assert.match(renderEditorHtml(task.answer, baseDir), /10<sup>-10<\/sup> m &amp; H<sub>2<\/sub>/u);
  const rb = readback(task, baseDir);
  assert.equal(compareNewSystemReadback(task, rb, { baseDir }).ok, true);
  rb.answer.html = rb.answer.html.replace(/<sup>|<\/sup>/gu, '');
  assert.equal(compareNewSystemReadback(task, rb, { baseDir }).ok, false);
  task.answer.blocks = [{ type: 'text', text: '10-10' }];
  const addedSup = readback(task, baseDir);
  addedSup.answer.html = '<p style="text-align:left">10<sup>-10</sup></p>';
  assert.equal(compareNewSystemReadback(task, addedSup, { baseDir }).ok, false, 'unexpected exponent changes meaning despite matching plain text');
  task.answer.blocks = [{ type: 'latex', latex: '\\frac12' }];
  assert.equal(validateNewSystemManifest(manifest, baseDir).valid, false);
  assert.throws(() => renderEditorHtml(task.answer, baseDir), /复杂公式/u);
});

test('assets cannot escape the manifest directory or lie about their image format', t => {
  const { manifest, task, baseDir } = fixture(t);
  assert.equal(validateNewSystemManifest(manifest, baseDir).valid, true);
  for (const filename of ['../figure.png', path.join(baseDir, 'figure.png'), 'missing.png', 'file.svg']) {
    task.stem.blocks[1].path = filename;
    assert.equal(validateNewSystemManifest(manifest, baseDir).valid, false);
  }
  writeFileSync(path.join(baseDir, 'not-image.png'), 'not a PNG');
  task.stem.blocks[1].path = 'not-image.png';
  assert.equal(validateNewSystemManifest(manifest, baseDir).valid, false);
});

test('asset symlink is constrained by real path', t => {
  const { manifest, task, baseDir } = fixture(t);
  const outside = mkdtempSync(path.join(os.tmpdir(), 'recorder-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(path.join(outside, 'other.png'), png);
  try { symlinkSync(path.join(outside, 'other.png'), path.join(baseDir, 'link.png')); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Windows symbolic links are unavailable'); return; } throw error; }
  task.stem.blocks[1].path = 'link.png';
  assert.equal(validateNewSystemManifest(manifest, baseDir).valid, false);
});

test('batch checkpoints ID before next task and accepts only fresh readback', async t => {
  const { manifest, baseDir } = fixture(t, 3);
  const adapter = adapterFor(baseDir);
  const history = [];
  const state = await runNewSystemBatch({ manifest, adapter, baseDir, persist: async snapshot => { history.push(snapshot); } });
  assert.equal(state.status, 'completed');
  assert.equal(adapter.appendCalls, 3);
  assert.equal(state.tasks.every(entry => entry.status === 'completed' && entry.receipt.shitiID > 0), true);
  assert.equal(history.some(snapshot => snapshot.tasks[0].status === 'writing' && snapshot.tasks[0].receipt === null), true);
  assert.equal(history.some(snapshot => snapshot.tasks[0].status === 'verifying' && snapshot.tasks[0].receipt?.shitiID === 1001), true);
  await runNewSystemBatch({ manifest, adapter, state, baseDir });
  assert.equal(adapter.appendCalls, 3, 'resume must not create completed records again');
});

test('same sequence with different existing content is never overwritten', async t => {
  const { manifest, task, baseDir } = fixture(t);
  const adapter = adapterFor(baseDir);
  const rb = readback(task, baseDir); rb.answer.text = 'A';
  adapter.records.set(1, rb);
  const state = await runNewSystemBatch({ manifest, adapter, baseDir });
  assert.equal(state.status, 'failed');
  assert.match(state.tasks[0].lastError, /拒绝覆盖/u);
  assert.equal(adapter.appendCalls, 0);
});

test('equal existing content is skipped and verifyOnly never creates missing records', async t => {
  const { manifest, task, baseDir } = fixture(t);
  const adapter = adapterFor(baseDir);
  adapter.records.set(1, readback(task, baseDir));
  const state = await runNewSystemBatch({ manifest, adapter, baseDir, verifyOnly: true });
  assert.equal(state.tasks[0].status, 'skipped_existing');
  assert.equal(adapter.appendCalls, 0);
  adapter.records.clear();
  const missing = await runNewSystemBatch({ manifest, adapter, baseDir, verifyOnly: true });
  assert.equal(missing.status, 'failed');
  assert.equal(adapter.appendCalls, 0);
});

test('append permits only count + 1 in the exact directory', async t => {
  const { manifest, task, baseDir } = fixture(t);
  const adapter = adapterFor(baseDir);
  adapter.read = async () => ({ status: 'missing', bookId: 100001, target: { ...task.target }, count: 4 });
  const state = await runNewSystemBatch({ manifest, adapter, baseDir });
  assert.equal(state.status, 'failed');
  assert.equal(adapter.appendCalls, 0);
});

test('after interrupted write with durable ACK, recovery reads rather than appends', async t => {
  const { manifest, baseDir } = fixture(t);
  const adapter = adapterFor(baseDir, { afterWrite: async (task, context, ack) => { await context.checkpoint(ack); throw new Error('simulated disconnect'); } });
  const state = await runNewSystemBatch({ manifest, adapter, baseDir });
  assert.equal(state.status, 'failed');
  assert.equal(state.tasks[0].recoveryRequired, true);
  await runNewSystemBatch({ manifest, adapter, state, baseDir });
  assert.equal(state.status, 'completed');
  assert.equal(adapter.appendCalls, 1);
});

test('interrupted write without durable ACK needs confirmation and never repeats create', async t => {
  const { manifest, baseDir } = fixture(t);
  const adapter = adapterFor(baseDir, { afterWrite: async () => { throw new Error('disconnect before checkpoint'); } });
  const state = await runNewSystemBatch({ manifest, adapter, baseDir });
  await runNewSystemBatch({ manifest, adapter, state, baseDir });
  assert.equal(state.status, 'failed');
  assert.match(state.tasks[0].lastError, /缺少保存回执/u);
  assert.equal(adapter.appendCalls, 1);
});

test('missing during uncertain write recovery halts permanently instead of retrying create', async t => {
  const { manifest, baseDir } = fixture(t);
  const adapter = adapterFor(baseDir, { beforeWrite: async () => { throw new Error('lost connection'); } });
  const state = await runNewSystemBatch({ manifest, adapter, baseDir });
  await runNewSystemBatch({ manifest, adapter, state, baseDir });
  assert.match(state.tasks[0].lastError, /禁止重复新增/u);
  assert.equal(adapter.appendCalls, 1);
});

test('limit resumes past already verified records; pending review blocks all writes', async t => {
  const { manifest, baseDir } = fixture(t, 3);
  const adapter = adapterFor(baseDir);
  const state = await runNewSystemBatch({ manifest, adapter, baseDir, limit: 1 });
  assert.equal(state.status, 'stopped');
  assert.equal(adapter.appendCalls, 1);
  await runNewSystemBatch({ manifest, adapter, state, baseDir, limit: 1 });
  assert.equal(adapter.appendCalls, 2);
  manifest.tasks[2].review.status = 'pending';
  await runNewSystemBatch({ manifest, adapter, state, baseDir });
  assert.equal(state.status, 'review_required');
  assert.equal(adapter.appendCalls, 2);
});

test('changed asset bytes invalidate a saved run even with an unchanged path', async t => {
  const { manifest, baseDir } = fixture(t);
  const state = createNewSystemRun(manifest, { baseDir });
  writeFileSync(path.join(baseDir, 'figure.png'), Buffer.concat([png, Buffer.from('changed')]));
  await assert.rejects(runNewSystemBatch({ manifest, adapter: adapterFor(baseDir), state, baseDir }), /资产字节不一致/u);
});

test('production requires a durable state callback; expected ID prevents substituting missing records', async t => {
  const { manifest, task, baseDir } = fixture(t);
  task.target.expectedRecordId = 1001;
  const adapter = adapterFor(baseDir);
  const state = await runNewSystemBatch({ manifest, adapter, baseDir });
  assert.equal(state.status, 'failed');
  assert.equal(adapter.appendCalls, 0);
  manifest.source = 'production'; adapter.source = 'production';
  await assert.rejects(runNewSystemBatch({ manifest, adapter, baseDir }), /持久化/u);
});

function reloadProof(task, ack, rb) {
  return { schemaVersion:1, kind:'new-system-reload-readback', taskId:task.id,
    bookId:100001, recordId:ack.shitiID, checkedAt:new Date().toISOString(),
    readback:{...rb,count:task.target.record} };
}

test('this append reload proof preserves the early receipt checkpoint and avoids a second saved-record read', async t => {
  const {manifest,baseDir}=fixture(t);
  const snapshots=[],readStages=[];
  let stage='before';
  const adapter=adapterFor(baseDir,{afterWrite:async(task,context,ack)=>{
    await context.checkpoint(ack);
    assert.equal(snapshots.at(-1).tasks[0].status,'verifying');
    assert.equal(snapshots.at(-1).tasks[0].receipt.shitiID,ack.shitiID);
    assert.equal(Object.hasOwn(snapshots.at(-1).tasks[0].receipt,'reloadReadback'),false,
      'The server ID must be durably stored before the actual saved-record reload');
    stage='append-reload';
    const rb=await adapter.read(task,{refresh:true});
    ack.reloadReadback=reloadProof(task,ack,rb);
    stage='returned';
    return ack;
  }});
  const originalRead=adapter.read.bind(adapter);
  adapter.read=async(...args)=>{readStages.push(stage);return originalRead(...args);};
  const state=await runNewSystemBatch({manifest,adapter,baseDir,persist:async snapshot=>snapshots.push(snapshot)});
  assert.equal(state.status,'completed');
  assert.equal(state.tasks[0].recoveryRequired,false);
  assert.deepEqual(readStages,['before','append-reload']);
  assert.equal(adapter.appendCalls,1);
  const proofCheckpoint=snapshots.findIndex(snapshot=>snapshot.tasks[0].status==='verifying'
    && snapshot.tasks[0].receipt?.reloadReadback?.kind==='new-system-reload-readback');
  const completed=snapshots.findIndex(snapshot=>snapshot.tasks[0].status==='completed');
  assert.ok(proofCheckpoint>=0 && completed>proofCheckpoint,
    'The returned reload proof must be checkpointed before completing the task');
});

test('a present invalid reload proof halts with recovery required and never falls back to another read', async t => {
  const edit=fn=>proof=>{fn(proof);return proof;};
  const mutations={
    undefined:()=>undefined,
    null:()=>null,
    false:()=>false,
    array:()=>[],
    emptyObject:()=>({}),
    missingVersion:edit(proof=>{delete proof.schemaVersion;}),
    wrongVersion:edit(proof=>{proof.schemaVersion=2;}),
    wrongKind:edit(proof=>{proof.kind='cached-readback';}),
    wrongTask:edit(proof=>{proof.taskId='another-task';}),
    wrongBook:edit(proof=>{proof.bookId=146005;}),
    missingRecordID:edit(proof=>{delete proof.recordId;}),
    stringRecordID:edit(proof=>{proof.recordId=String(proof.recordId);}),
    wrongRecordID:edit(proof=>{proof.recordId+=1;}),
    missingCheckedAt:edit(proof=>{delete proof.checkedAt;}),
    emptyCheckedAt:edit(proof=>{proof.checkedAt='';}),
    missingReadback:edit(proof=>{delete proof.readback;}),
    nullReadback:edit(proof=>{proof.readback=null;}),
    notFound:edit(proof=>{proof.readback.status='missing';}),
    readbackBook:edit(proof=>{proof.readback.bookId=146005;}),
    readbackID:edit(proof=>{proof.readback.recordId+=1;}),
    missingCount:edit(proof=>{delete proof.readback.count;}),
    wrongCount:edit(proof=>{proof.readback.count+=1;}),
    stringCount:edit(proof=>{proof.readback.count=String(proof.readback.count);}),
    targetRecord:edit(proof=>{proof.readback.target.record+=1;}),
    targetSection:edit(proof=>{proof.readback.target.sectionLabel='其他节';}),
    sourcePage:edit(proof=>{proof.readback.source.pages=[999];}),
    answerPage:edit(proof=>{proof.readback.source.answerPages=[999];}),
    stemContent:edit(proof=>{proof.readback.stem.text+='错误';}),
    answerContent:edit(proof=>{proof.readback.answer.text+='错误';}),
    imageHash:edit(proof=>{proof.readback.stem.images[0].sha256='wrong';}),
    unloadedImage:edit(proof=>{proof.readback.stem.images[0].complete=false;}),
    imageAlignment:edit(proof=>{proof.readback.stem.images[0].align='left';}),
    paragraphAlignment:edit(proof=>{proof.readback.stem.paragraphs[0].align='center';}),
    subscript:edit(proof=>{proof.readback.answer.html=proof.readback.answer.html.replace('<sub>1</sub>','<sub>2</sub>');}),
    superscript:edit(proof=>{proof.readback.answer.html=proof.readback.answer.html.replace('<sup>-4</sup>','<sup>-3</sup>');}),
    strictSpacing:edit(proof=>{
      proof.readback.answer.text=proof.readback.answer.text.replace('\u00a0'.repeat(8),'\u00a0'.repeat(7));
      proof.readback.answer.paragraphs[0].text=proof.readback.answer.text;
    }),
  };
  for(const [name,mutate] of Object.entries(mutations)) await t.test(name,async child=>{
    const {manifest,task,baseDir}=fixture(child);
    task.answer.blocks=[{type:'text',strictSpacing:true,runs:[
      {type:'text',text:'S'},{type:'sub',text:'1'},
      {type:'text',text:'\u00a0'.repeat(8)+'10'},{type:'sup',text:'-4'},
    ]}];
    let reads=0;
    const adapter=adapterFor(baseDir,{afterWrite:async(task,context,ack)=>{
      await context.checkpoint(ack);
      const rb=await adapter.read(task,{refresh:true});
      ack.reloadReadback=mutate(reloadProof(task,ack,rb));
      return ack;
    }});
    const originalRead=adapter.read.bind(adapter);
    adapter.read=async(...args)=>{reads++;return originalRead(...args);};
    const state=await runNewSystemBatch({manifest,adapter,baseDir});
    assert.equal(state.status,'failed');
    assert.equal(state.tasks[0].recoveryRequired,true);
    assert.equal(state.tasks[0].attempts,1);
    assert.equal(state.tasks[0].receipt.shitiID,1001);
    assert.equal(adapter.appendCalls,1);
    assert.equal(reads,2,'Invalid proof must not be concealed by a fallback read');
    assert.match(state.tasks[0].lastError,/写入未完成确认/u);
  });
});

test('an adapter without reload proof retains the legacy fresh saved-record read', async t => {
  const {manifest,baseDir}=fixture(t);
  const readStages=[];
  let stage='before';
  const adapter=adapterFor(baseDir,{afterWrite:async(_task,context,ack)=>{
    await context.checkpoint(ack);
    stage='after-return';
    return ack;
  }});
  const originalRead=adapter.read.bind(adapter);
  adapter.read=async(...args)=>{readStages.push(stage);return originalRead(...args);};
  const state=await runNewSystemBatch({manifest,adapter,baseDir});
  assert.equal(state.status,'completed');
  assert.deepEqual(readStages,['before','after-return']);
  assert.equal(Object.hasOwn(state.tasks[0].receipt,'reloadReadback'),false);
});

test('resuming with a stored reload proof always reads current server state and never trusts the old proof', async t => {
  for(const mutation of ['missing','changed-content','changed-record-id']) await t.test(mutation,async child=>{
    const {manifest,baseDir}=fixture(child);
    let reads=0;
    const adapter=adapterFor(baseDir,{afterWrite:async(task,context,ack)=>{
      await context.checkpoint(ack);
      ack.reloadReadback=reloadProof(task,ack,await adapter.read(task,{refresh:true}));
      return ack;
    }});
    const originalRead=adapter.read.bind(adapter);
    adapter.read=async(...args)=>{reads++;return originalRead(...args);};
    const state=await runNewSystemBatch({manifest,adapter,baseDir});
    assert.equal(state.status,'completed');
    assert.equal(state.tasks[0].receipt.reloadReadback.readback.recordId,1001);
    // Simulate interruption before final promotion with the old proof intact.
    state.tasks[0].status='verifying';state.tasks[0].recoveryRequired=true;state.status='verifying';
    if(mutation==='missing') adapter.records.clear();
    else if(mutation==='changed-content') adapter.records.get(1).answer.text='另一答案';
    else adapter.records.get(1).recordId=9999;
    assert.equal(state.tasks[0].receipt.reloadReadback.readback.recordId,1001);
    assert.equal(state.tasks[0].receipt.reloadReadback.readback.answer.text,'B',
      'The stale stored proof stays valid while current server state changes');
    reads=0;
    await runNewSystemBatch({manifest,adapter,state,baseDir});
    assert.equal(state.status,'failed');
    assert.equal(state.tasks[0].recoveryRequired,true);
    assert.equal(reads,1,'Resume must perform a new fresh read even when the receipt carries an old proof');
    assert.equal(adapter.appendCalls,1,'Resume must never recreate an already attempted record');
  });
});
