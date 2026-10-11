import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { insertReviewedEditorHtml } from '../src/browser-editor-command.mjs';
import { NewSystemAdapter } from '../src/new-system-adapter.mjs';

const workerFlag = '--headless-background-worker';
const resultPrefix = 'HEADLESS_BACKGROUND_RESULT:';
const tracePrefix = 'HEADLESS_BACKGROUND_TRACE:';
const executableForTest = () => [chromium.executablePath(),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(filename => existsSync(filename));

function protocolSegment(stderr, name) {
  const start = `${tracePrefix}begin:${name}`, end = `${tracePrefix}end:${name}`;
  assert.equal(stderr.split(start).length, 2, `missing or duplicated CDP trace start: ${name}`);
  assert.equal(stderr.split(end).length, 2, `missing or duplicated CDP trace end: ${name}`);
  return stderr.slice(stderr.indexOf(start) + start.length, stderr.indexOf(end));
}

async function trace(name, action) {
  console.error(`${tracePrefix}begin:${name}`);
  try { return await action(); }
  finally { console.error(`${tracePrefix}end:${name}`); }
}

async function browserWorker(executablePath) {
  // launch(), never launchPersistentContext()/connectOverCDP(): Playwright makes
  // a fresh disposable profile. Headless stays mandatory even on Windows Edge.
  const browser = await chromium.launch({ executablePath, headless: true,
    args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run',
      '--disable-default-apps', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost',
      '--proxy-server=http://127.0.0.1:9'] });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1100, height: 800 } });
    const networkRequests = [];
    await context.route('**/*', async route => { networkRequests.push(route.request().url()); await route.abort('blockedbyclient'); });
    const fixturePage = async name => {
      const page = await context.newPage();
      await page.setContent(`<!doctype html><html><head><title>local ${name}</title><style>
body{margin:40px;font:16px sans-serif}.editor{width:700px;min-height:90px;padding:12px;border:2px solid #333;margin-bottom:30px}
</style></head><body data-local-fixture="${name}"><div id="target" class="editor" contenteditable="true"></div>
<div id="sentinel" class="editor" contenteditable="true">unchanged ${name}</div></body></html>`);
      await page.evaluate(() => {
        window.fixtureCounters = { commands: 0, clipboard: 0 };
        const original = document.execCommand.bind(document);
        document.execCommand = (...args) => { window.fixtureCounters.commands++; return original(...args); };
        const forbidden = () => { window.fixtureCounters.clipboard++; throw new Error('Local fixture forbids clipboard/permissions'); };
        Object.defineProperty(navigator, 'clipboard', { configurable: true, get: forbidden });
        Object.defineProperty(navigator, 'permissions', { configurable: true, get: forbidden });
      });
      return page;
    };
    const guard = page => async () => {
      assert.equal(page.url(), 'about:blank', 'no network platform navigation is allowed');
      assert.equal(await page.locator('body[data-local-fixture]').count(), 1);
      assert.equal(await page.locator('#target').count(), 1);
    };
    const snapshot = page => page.evaluate(() => {
      const selection = window.getSelection();
      return { target: document.querySelector('#target').innerHTML, sentinel: document.querySelector('#sentinel').innerHTML,
        active: document.activeElement.id, selection: selection ? { anchor: selection.anchorNode?.textContent,
          anchorOffset: selection.anchorOffset, focus: selection.focusNode?.textContent, focusOffset: selection.focusOffset,
          collapsed: selection.isCollapsed } : null };
    });

    const a = await fixturePage('A'), b = await fixturePage('B');
    await b.locator('#sentinel').focus();
    const headlessDocumentStates = await Promise.all([a, b].map(page => page.evaluate(() => ({ visible: document.visibilityState, focused: document.hasFocus() }))));
    const bBefore = await snapshot(b);
    const adapter = new NewSystemAdapter({ page: a, source: 'fixture', inputMode: 'browser-command', focusMode: 'background' });
    adapter.guard = guard(a); // The fixture is deliberately about:blank, never a platform page.
    const first = await trace('background-A', async () => {
      await adapter._activate();
      await adapter._requireDocumentFocus('local fixture');
      return insertReviewedEditorHtml(a, '#target', '<p>reviewed A <sub>2</sub></p>', { focusMode: 'background', timeoutMs: 3000, guard: guard(a) });
    });
    assert.deepEqual(await snapshot(b), bBefore, 'input to A must preserve B content, active element and selection');
    assert.equal(await a.locator('#target').innerText(), 'reviewed A 2');
    const aBefore = await snapshot(a);
    const second = await trace('background-B', () => insertReviewedEditorHtml(b, '#target', '<p>reviewed B <sup>3</sup></p>',
      { focusMode: 'background', timeoutMs: 3000, guard: guard(b) }));
    assert.deepEqual(await snapshot(a), aBefore, 'input to B must preserve A content, active element and selection');
    assert.equal(await b.locator('#target').innerText(), 'reviewed B 3');
    assert.equal(await a.locator('#target sub').innerText(), '2'); assert.equal(await b.locator('#target sup').innerText(), '3');
    const counters = await Promise.all([a, b].map(page => page.evaluate(() => window.fixtureCounters)));
    assert.ok(counters.every(value => value.commands === 1 && value.clipboard === 0));

    const positive = await fixturePage('foreground-control');
    const foreground = await trace('foreground-control', () => insertReviewedEditorHtml(positive, '#target', '<p>foreground control</p>',
      { timeoutMs: 3000, guard: guard(positive) }));
    assert.equal(await positive.locator('#target').innerText(), 'foreground control');

    const rejected = [];
    const rejectCase = async (name, { before, afterPress, errorPattern }) => {
      const page = await fixturePage(name), sentinelBefore = await page.locator('#sentinel').innerHTML();
      if (before) await before(page);
      if (afterPress) {
        // Test-only wrapper: the real browser press happens first. Changes are
        // local fixture DOM faults, never editor repair or production actions.
        const locator = page.locator.bind(page);
        page.locator = (...args) => {
          const target = locator(...args), press = target.press.bind(target);
          target.press = async (...pressArgs) => { await press(...pressArgs); await afterPress(page); };
          return target;
        };
      }
      let error;
      await trace(name, async () => {
        try { await insertReviewedEditorHtml(page, '#target', '<p>must not be inserted</p>', { focusMode: 'background', timeoutMs: 3000, guard: guard(page) }); }
        catch (value) { error = value; }
      });
      assert.ok(error, `${name} must reject rather than activate the page or write`);
      assert.match(error.message, errorPattern);
      const state = await page.evaluate(() => ({ ...window.fixtureCounters, target: document.querySelector('#target').innerHTML }));
      assert.equal(state.commands, 0, `${name} must make zero insertHTML calls`); assert.equal(state.target, ''); assert.equal(state.clipboard, 0);
      assert.equal(await page.locator('#sentinel').innerHTML(), sentinelBefore);
      rejected.push({ name, error: error.message, commands: state.commands });
      await page.close();
    };
    const cover = page => page.evaluate(() => {
      const cover = document.createElement('div'); cover.id = 'local-cover';
      cover.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#fff'; document.body.append(cover);
    });
    await rejectCase('covered-before-click', { before: cover, errorPattern: /covered/u });
    await rejectCase('hidden-element-before-click', { before: page => page.evaluate(() => { document.querySelector('#target').style.display = 'none'; }), errorPattern: /not visible/u });
    await rejectCase('covered-after-press', { afterPress: cover, errorPattern: /covered before insertion/u });
    await rejectCase('selection-outside-after-press', { afterPress: page => page.evaluate(() => { document.querySelector('#sentinel').focus(); }), errorPattern: /selection is not confined/u });
    await rejectCase('hidden-document-after-press', { afterPress: page => page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    }), errorPattern: /document is hidden/u });
    await rejectCase('lost-active-editor-after-press', { afterPress: page => page.evaluate(() => { document.body.tabIndex=-1;document.body.focus(); }), errorPattern: /selection is not confined/u });
    await rejectCase('noneditable-after-press', { afterPress: page => page.evaluate(() => { document.querySelector('#target').contentEditable = 'false'; }), errorPattern: /selection is not confined/u });
    assert.equal(networkRequests.length, 0, 'about:blank fixtures must make no page network requests');
    return { first, second, foreground, rejected, headlessDocumentStates, networkRequests, browserVersion: browser.version(),
      limits: ['Headless pages may both remain visible/focused; this does not prove Windows foreground containment.',
        'Document-hidden and active-editor loss after press are explicit local fixture fault injections.',
        'No logged-in profile, platform route, native clipboard, native analysis menu or production save was used.'] };
  } finally { await browser.close(); }
}

async function runWorker(executablePath) {
  const environment = { ...process.env, DEBUG: 'pw:protocol' };
  delete environment.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), workerFlag, executablePath], {
    env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
  const exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(exitCode, 0, `local headless worker failed: ${stderr.slice(-8000)}`);
  const line = stdout.split(/\r?\n/u).find(value => value.startsWith(resultPrefix));
  assert.ok(line, 'headless worker must return its actual browser results');
  return { result: JSON.parse(line.slice(resultPrefix.length)), stderr };
}

if (process.argv[2] === workerFlag) {
  try { console.log(resultPrefix + JSON.stringify(await browserWorker(process.argv[3]))); }
  catch (error) { console.error(error.stack); process.exitCode = 1; }
} else {
  test('actual headless browser isolates page-scoped background input and rejects unsafe documents without activation', { timeout: 60000 }, async t => {
    const executablePath = executableForTest();
    if (!executablePath) { t.skip('No existing Playwright Chromium or Windows Edge executable; no download or visible launch attempted'); return; }
    const { result, stderr } = await runWorker(executablePath);
    await t.test('two independent real pages preserve the other page and use trusted browser editing events', () => {
      for (const value of [result.first, result.second]) {
        assert.equal(value.succeeded, true); assert.equal(value.selectionVerified, true); assert.equal(value.paragraphCount, 1);
        assert.ok(value.inputEvents.some(event => event.type === 'input' && event.isTrusted === true));
      }
      assert.equal(result.networkRequests.length, 0);
    });
    await t.test('real CDP input occurs without Page.bringToFront in both background operations', () => {
      for (const name of ['background-A', 'background-B']) {
        const protocol = protocolSegment(stderr, name);
        assert.match(protocol, /"method":"Input\.dispatchMouseEvent"/u);
        assert.match(protocol, /"method":"Input\.dispatchKeyEvent"/u);
        assert.doesNotMatch(protocol, /"method":"Page\.bringToFront"/u);
      }
    });
    await t.test('foreground positive control proves the CDP activation detector is live', () => {
      assert.equal(result.foreground.succeeded, true);
      assert.match(protocolSegment(stderr, 'foreground-control'), /"method":"Page\.bringToFront"/u);
    });
    for (const rejected of result.rejected) {
      await t.test(`${rejected.name} makes zero insertHTML calls and has no foreground fallback`, () => {
        assert.equal(rejected.commands, 0);
        assert.doesNotMatch(protocolSegment(stderr, rejected.name), /"method":"Page\.bringToFront"/u);
      });
    }
  });
}
