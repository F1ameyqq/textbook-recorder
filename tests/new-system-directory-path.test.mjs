import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { NewSystemAdapter } from '../src/new-system-adapter.mjs';
import { establishOwnedHeadlessContext } from '../src/owned-headless-browser.mjs';

const listPath = '/edushop/textbook/detail/shitilist';
const middle = 'Period One Listening and Speaking & Reading and Thinking';
const target = { chapterLabel: 'Unit B > ' + middle, sectionLabel: '基础巩固', record: 1, expectedRecordId: 2201 };
const executable = () => [chromium.executablePath(),
  path.join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
  path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'Microsoft/Edge/Application/msedge.exe')].find(existsSync);
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;');

function treeHtml(mode) {
  const node = (id, name, children = '') => '<div class="el-tree-node" data-node-id="' + id + '">' +
    '<div class="el-tree-node__content"><span class="el-tree-node__expand-icon' + (children ? '' : ' is-leaf') + '"></span>' + escape(name) + '</div>' +
    (children ? '<div class="el-tree-node__children">' + children + '</div>' : '') + '</div>';
  const leaf = id => node(id, '基础巩固');
  const middleNode = id => node(id, middle, leaf(id === 'b-middle' ? '220' : '110') + (mode === 'duplicate-leaf' && id === 'b-middle' ? leaf('221') : ''));
  const bChildren = mode === 'missing-middle' ? node('other-middle', '另一个层级', leaf('230')) : middleNode('b-middle') +
    (mode === 'duplicate-middle' ? middleNode('b-middle-duplicate') : '');
  return '<!doctype html><html><head><meta charset="utf-8"><title>Offline nested directory fixture</title><style>' +
    'body{margin:24px;font:16px sans-serif}.el-tree{width:560px}.el-tree-node__content{padding:8px;min-height:22px;cursor:pointer}' +
    '.el-tree-node__children{display:none;padding-left:24px}.el-tree-node.is-expanded>.el-tree-node__children{display:block}' +
    '.is-current>.el-tree-node__content{background:#dcecff}.editors{display:none}.w-e-text{min-height:32px;padding:12px}' +
    '</style></head><body><div class="el-tree">' + node('a-root', 'Unit A', middleNode('a-middle')) + node('b-root', 'Unit B', bChildren) +
    (mode === 'duplicate-root' ? node('b-root-duplicate', 'Unit B', middleNode('b-middle-other')) : '') +
    '</div><div class="shiti-cont"></div><div class="editors"><div id="contentedit"><div class="w-e-text" contenteditable="true"></div></div>' +
    '<div id="answeredit"><div class="w-e-text" contenteditable="true"></div></div></div><script>' +
    'window.fixtureClicks=[];window.untrustedClicks=0;const mode=' + JSON.stringify(mode) + ';' +
    'if(mode==="remaining-budget"){const root=document.querySelector("[data-node-id=b-root]>.el-tree-node__content");root.style.visibility="hidden";setTimeout(()=>root.style.visibility="visible",200);}' +
    'document.querySelector(".el-tree").addEventListener("click",async event=>{' +
      'const content=event.target.closest(".el-tree-node__content");if(!content)return;' +
      'if(!event.isTrusted){window.untrustedClicks++;return;}const node=content.parentElement;window.fixtureClicks.push(node.dataset.nodeId);' +
      'const children=node.querySelector(":scope>.el-tree-node__children");if(children){' +
        'if(mode==="remaining-budget"&&node.dataset.nodeId==="b-middle"){children.style.display="none";setTimeout(()=>children.style.display="block",900);}' +
        'node.classList.add("is-expanded");return;}' +
      'document.querySelectorAll(".el-tree-node.is-current").forEach(value=>value.classList.remove("is-current"));node.classList.add("is-current");' +
      'const response=await fetch(' + JSON.stringify(listPath) + '+"?textbookID=101&nodeID="+node.dataset.nodeId);const body=await response.json();' +
      'document.querySelector(".shiti-cont").innerHTML=body.data.map(row=>"<div class=shiti-sort>"+row.seqIndex+".</div>").join("");' +
      'document.querySelector("#contentedit .w-e-text").innerHTML=body.data[0].question;document.querySelector("#answeredit .w-e-text").innerHTML=body.data[0].answer;' +
      'document.querySelector(".editors").style.display="block";});</script></body></html>';
}

async function fixture(t) {
  const executablePath = executable();
  if (!executablePath) { t.skip('No installed Chromium/Edge; no download or visible launch attempted'); return; }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'recorder-directory-path-')), profile = path.join(temporary, 'owned-profile');
  await fs.mkdir(profile);
  const requests = [], blocked = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost'); requests.push({ method: request.method, path: url.pathname, nodeID: url.searchParams.get('nodeID') });
    response.setHeader('Cache-Control', 'no-store');
    if (url.pathname === listPath) {
      const nodeID = Number(url.searchParams.get('nodeID'));
      response.writeHead(200, { 'Content-Type': 'application/json' });
      return response.end(JSON.stringify({ errno: 0, errmsg: 'success', data: [{ seqIndex: 1, shitiID: nodeID * 10 + 1, nodeID,
        question: '<p>合成题目</p>', answer: '<p>合成答案</p>', mainPicNum: 1, answerPicNum: 2, haveAnswer: true }] }));
    }
    if (url.pathname === '/favicon.ico') { response.writeHead(204); return response.end(); }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(treeHtml(url.searchParams.get('case') ?? 'normal'));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  let context;
  t.after(async () => {
    await context?.close(); await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir())); assert.ok(path.basename(temporary).startsWith('recorder-directory-path-'));
    await fs.rm(temporary, { recursive: true, force: true });
  });
  context = await chromium.launchPersistentContext(profile, { executablePath, headless: true,
    args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'] });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === origin && request.method() === 'GET' && ['/edu-shop-web/', listPath, '/favicon.ico'].includes(url.pathname)) return route.continue();
    blocked.push({ method: request.method(), path: url.pathname }); return route.abort('blockedbyclient');
  });
  const page = context.pages()[0] ?? await context.newPage();
  await establishOwnedHeadlessContext(page, { profileDir: await fs.realpath(profile), bindingId: randomUUID() });
  const open = async (mode = 'normal', directoryTimeout = 3000) => {
    requests.length = 0;
    await page.goto(origin + '/edu-shop-web/?case=' + mode + '#/content-manager/teaching-content?textbookID=101&textbookType=main');
    const adapter = new NewSystemAdapter({ page, source: 'fixture', origin, inputMode: 'browser-command', focusMode: 'background',
      windowMode: 'headless', timeout: 3000, directoryTimeout }); adapter.bookId = 101;
    return adapter;
  };
  return { page, open, requests, blocked, clicks: () => page.evaluate(() => window.fixtureClicks), lists: () => requests.filter(row => row.path === listPath) };
}

test('real localhost tree isolates breadcrumb paths and keeps original visibility and scope checks', { timeout: 30000 }, async t => {
  const f = await fixture(t); if (!f) return;
  await t.test('repeated middle and leaf labels select only the specified root, middle and leaf', async () => {
    const adapter = await f.open();
    const records = await adapter.list({ target });
    assert.deepEqual(await f.clicks(), ['b-root', 'b-middle', '220']);
    assert.deepEqual(await adapter._selectedScope(), { chapterLabel: target.chapterLabel, sectionLabel: target.sectionLabel });
    assert.equal(await adapter._scopeMatches(target), true);
    assert.equal(await adapter._scopeMatches({ ...target, chapterLabel: 'Unit A > ' + middle }), false);
    assert.equal(await adapter._scopeMatches({ ...target, chapterLabel: middle }), false);
    assert.equal(adapter._nodeID, 220); assert.equal(records[0].recordId, 2201);
    assert.deepEqual(f.lists().map(row => row.nodeID), ['220']);
    assert.equal(await f.page.evaluate(() => window.untrustedClicks), 0);
    await adapter.directory({ target }); assert.equal(f.lists().length, 1, 'full-path cache identity must not cause another LIST');
  });
  for (const [mode, clicks] of [['duplicate-root', []], ['duplicate-middle', ['b-root']], ['duplicate-leaf', ['b-root', 'b-middle']]]) {
    await t.test(mode + ' is rejected before any leaf/list action', async () => {
      const adapter = await f.open(mode);
      await assert.rejects(adapter.directory({ target }), /无法唯一匹配/u);
      assert.deepEqual(await f.clicks(), clicks); assert.deepEqual(f.lists(), []); assert.equal(adapter._nodeID, null);
    });
  }
  await t.test('a missing middle path expires within the original directory budget', async () => {
    const adapter = await f.open('missing-middle', 700), started = Date.now();
    await assert.rejects(adapter.directory({ target }), error => {
      assert.equal(error.code, 'TARGET_VISIBILITY_TIMEOUT'); assert.equal(error.targetRole, 'directory-chapter');
      assert.ok(error.visibilityDiagnostic.timeout < adapter.directoryTimeout); return true;
    });
    assert.ok(Date.now() - started < 1800); assert.deepEqual(await f.clicks(), ['b-root']); assert.deepEqual(f.lists(), []);
  });
  await t.test('root, middle and leaf visibility waits consume one shared remaining budget', async () => {
    const adapter = await f.open('remaining-budget', 800), started = Date.now();
    const stageBudgets = [], directoryNode = adapter._directoryNode.bind(adapter);
    // Observe the real directory deadline at each path wait. The fixture's
    // timer may already have elapsed before directory() starts under load.
    adapter._directoryNode = (chapterLabel, { budget }) => directoryNode(chapterLabel, { budget: (name, role) => {
      const remaining = budget(name, role); stageBudgets.push({ name, remaining }); return remaining;
    } });
    await assert.rejects(adapter.directory({ target }), error => {
      for (const [index, stage] of stageBudgets.entries()) {
        assert.ok(stage.remaining > 0 && stage.remaining < adapter.directoryTimeout);
        if (index > 0) assert.ok(stage.remaining < stageBudgets[index - 1].remaining);
      }
      if (error.code === 'DOCUMENT_READINESS_TIMEOUT') {
        assert.equal(error.documentReadiness.timeoutMs, adapter.directoryTimeout);
        assert.equal(stageBudgets.length, 0, 'unready document must stop before any path wait');
      } else {
        assert.equal(error.code, 'TARGET_VISIBILITY_TIMEOUT');
        assert.ok(['directory-chapter', 'directory-section'].includes(error.targetRole));
        if (error.visibilityDiagnostic.budgetExhausted) {
          assert.equal(error.visibilityDiagnostic.timeout, adapter.directoryTimeout);
        } else {
          assert.ok(error.visibilityDiagnostic.timeout > 0 && error.visibilityDiagnostic.timeout < adapter.directoryTimeout);
          if (stageBudgets.length) assert.ok(error.visibilityDiagnostic.timeout <= stageBudgets.at(-1).remaining);
        }
      }
      return true;
    });
    const clicks = await f.clicks();
    assert.ok(Date.now() - started < 1800); assert.deepEqual(clicks, ['b-root', 'b-middle'].slice(0, clicks.length));
    assert.deepEqual(f.lists(), []); assert.equal(adapter._nodeID, null);
  });
  await t.test('a budget exhausted during the first trusted click cannot start a fresh middle wait', async () => {
    const adapter = await f.open('normal', 120);
    await assert.rejects(adapter.directory({ target }), error => {
      assert.equal(error.code, 'TARGET_VISIBILITY_TIMEOUT'); assert.equal(error.targetRole, 'directory-chapter');
      assert.equal(error.visibilityDiagnostic.budgetExhausted, true); assert.equal(error.visibilityDiagnostic.timeout, 120); return true;
    });
    assert.deepEqual(await f.clicks(), ['b-root']); assert.deepEqual(f.lists(), []);
  });
  assert.ok(f.requests.every(row => row.method === 'GET')); assert.deepEqual(f.blocked, []);
});
