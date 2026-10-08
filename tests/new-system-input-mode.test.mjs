import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { NewSystemAdapter } from '../src/new-system-adapter.mjs';

const bookUrl = 'https://easylearn.baidu.com/edu-shop-web/#/content-manager/teaching-content?textbookID=100001&textbookType=main';
const stemSelector = '#contentedit .w-e-text';
const answerSelector = '#answeredit .w-e-text';

// Run the adapter's actual browser callbacks against a small document double.
// Every clipboard/permission entry point fails if touched, including property
// reads: this checks the command preflight's independence from either clipboard.
function mockPage({ focus = true, stemEditable = true, answerEditable = true, commandSupported = true, stemCount = 1, answerCount = 1 } = {}) {
  const calls = { front: 0, visibleEditors: [], forbidden: [] };
  const forbidden = name => {
    calls.forbidden.push(name);
    throw new Error(`Forbidden capability: ${name}`);
  };
  const stem = { isContentEditable: stemEditable, getClientRects: () => [{}] };
  const answer = { isContentEditable: answerEditable, getClientRects: () => [{}] };
  const elements = selector => selector === stemSelector ? Array(stemCount).fill(stem)
    : selector === answerSelector ? Array(answerCount).fill(answer) : [];
  const document = {
    hasFocus: () => focus,
    querySelectorAll: elements,
    querySelector: selector => elements(selector)[0] ?? null,
    queryCommandSupported: command => command === 'insertHTML' && commandSupported,
    execCommand: () => forbidden('editor mutation during preflight'),
  };
  const navigator = {};
  Object.defineProperties(navigator, {
    clipboard: { get: () => forbidden('navigator.clipboard') },
    permissions: { get: () => forbidden('navigator.permissions') },
  });
  const environment = vm.createContext({ document, navigator, window: { getSelection: () => null }, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) });
  const context = {
    grantPermissions: () => forbidden('context.grantPermissions'),
    clearPermissions: () => forbidden('context.clearPermissions'),
  };
  const page = {
    context: () => context,
    on: () => {},
    isClosed: () => false,
    url: () => bookUrl,
    bringToFront: async () => { calls.front++; },
    locator: selector => ({
      evaluateAll: async fn => {
        calls.visibleEditors.push(selector);
        environment.__nodes = elements(selector);
        return vm.runInContext(`(${fn.toString()})(__nodes)`, environment);
      },
    }),
    evaluate: async (fn, arg) => {
      environment.__arg = arg;
      return await vm.runInContext(`(${fn.toString()})(__arg)`, environment);
    },
  };
  return { page, calls, forbidden };
}

function commandAdapter(options = {}) {
  const mock = mockPage(options);
  const adapter = new NewSystemAdapter({ page: mock.page, inputMode: 'browser-command' });
  adapter.bookId = 100001;
  adapter._writeSystemClipboard = async () => mock.forbidden('Windows clipboard helper');
  return { adapter, ...mock };
}

test('omitted input mode preserves native-paste behavior for existing callers', () => {
  const { page } = mockPage();
  const implicit = new NewSystemAdapter({ page });
  const explicit = new NewSystemAdapter({ page, inputMode: 'native-paste' });
  assert.equal(implicit.inputMode, 'native-paste');
  assert.equal(implicit.usesSystemClipboard, explicit.usesSystemClipboard);
  assert.equal(implicit.usesSystemClipboard, process.platform === 'win32');
});

test('unknown input modes are rejected before they can select an input path', () => {
  for (const inputMode of ['', 'clipboard', 'browser_command', null]) {
    assert.throws(() => new NewSystemAdapter({ inputMode }));
  }
});

test('browser-command preflight validates both editors without clipboard reads, writes or permission effects', async () => {
  const { adapter, calls } = commandAdapter();
  assert.equal(adapter.usesSystemClipboard, false);
  await adapter._clipboardPreflight('<p>已审核题干</p>');
  assert.ok(calls.front > 0, 'the target page must be activated before checking focus');
  assert.deepEqual(calls.visibleEditors, [stemSelector, answerSelector]);
  assert.deepEqual(calls.forbidden, []);
});

test('browser-command rejects a page without document focus before any editor mutation', async () => {
  const { adapter, calls } = commandAdapter({ focus: false });
  await assert.rejects(adapter._clipboardPreflight('<p>已审核题干</p>'), /焦点|focus/iu);
  assert.deepEqual(calls.forbidden, []);
});

test('browser-command requires both the question and answer to be editable', async t => {
  for (const [name, options] of [
    ['question editor', { stemEditable: false }],
    ['answer editor', { answerEditable: false }],
  ]) {
    await t.test(name, async () => {
      const { adapter, calls } = commandAdapter(options);
      await assert.rejects(adapter._clipboardPreflight('<p>已审核题干</p>'));
      assert.deepEqual(calls.forbidden, []);
    });
  }
});

test('missing or ambiguous editor targets reject command preflight', async t => {
  for (const [name, options] of [
    ['missing question editor', { stemCount: 0 }],
    ['duplicate answer editors', { answerCount: 2 }],
  ]) {
    await t.test(name, async () => {
      const { adapter, calls } = commandAdapter(options);
      await assert.rejects(adapter._clipboardPreflight('<p>已审核题干</p>'));
      assert.deepEqual(calls.forbidden, []);
    });
  }
});

test('unsupported HTML insertion rejects command preflight without falling back to clipboard', async () => {
  const { adapter, calls } = commandAdapter({ commandSupported: false });
  await assert.rejects(adapter._clipboardPreflight('<p>已审核题干</p>'));
  assert.deepEqual(calls.forbidden, []);
});

test('browser-command forbids accidental calls to the native clipboard writer', async () => {
  const { adapter, calls } = commandAdapter();
  await assert.rejects(adapter._writeClipboard('<p>已审核题干</p>'));
  assert.deepEqual(calls.forbidden, []);
});
