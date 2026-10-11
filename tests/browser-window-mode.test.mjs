import test from 'node:test';
import assert from 'node:assert/strict';
import { activateRecorderPage } from '../src/browser-focus.mjs';

function fixture(initial = 'normal', refuse = false) {
  const calls = []; let state = initial;
  const session = {
    async send(method, args) {
      calls.push({ method, args });
      if (method === 'Browser.getWindowForTarget') return { windowId: 17, bounds: { windowState: state } };
      if (method === 'Browser.setWindowBounds') { assert.equal(args.windowId, 17); if (!refuse) state = args.bounds.windowState; return {}; }
      if (method === 'Browser.getWindowBounds') { assert.equal(args.windowId, 17); return { bounds: { windowState: state } }; }
      throw new Error('unexpected protocol call');
    },
    async detach() { calls.push({ method: 'detach' }); },
  };
  const page = {
    context: () => ({ newCDPSession: async target => { assert.equal(target, page); calls.push({ method: 'attach' }); return session; } }),
    async bringToFront() { calls.push({ method: 'bringToFront' }); throw new Error('foreground activation forbidden'); },
  };
  return { page, calls };
}

test('background normal does not attach or activate a browser window', async () => {
  const { page, calls } = fixture(); let guards = 0;
  await activateRecorderPage(page, 'background', { windowMode: 'normal', guard: async () => { guards++; } });
  assert.equal(guards, 1); assert.deepEqual(calls, []);
});

test('background minimizes only the guarded page window and verifies the result', async () => {
  const { page, calls } = fixture();
  await activateRecorderPage(page, 'background', { windowMode: 'minimized' });
  assert.deepEqual(calls.map(c => c.method), ['attach', 'Browser.getWindowForTarget', 'Browser.setWindowBounds', 'Browser.getWindowBounds', 'detach']);
  assert.deepEqual(calls[2].args, { windowId: 17, bounds: { windowState: 'minimized' } });
});

test('a minimized window stays minimized without restoration', async () => {
  const { page, calls } = fixture('minimized');
  await activateRecorderPage(page, 'background', { windowMode: 'minimized' });
  assert.ok(!calls.some(c => c.method === 'Browser.setWindowBounds' || c.method === 'bringToFront'));
});

test('scope changing after window discovery stops before changing window bounds', async () => {
  const { page, calls } = fixture(); let checks = 0;
  await assert.rejects(activateRecorderPage(page, 'background', { windowMode: 'minimized', guard: async () => { if (++checks === 3) throw new Error('scope changed'); } }), /scope changed/);
  assert.ok(!calls.some(c => c.method === 'Browser.setWindowBounds')); assert.equal(calls.at(-1).method, 'detach');
});

test('a refused minimization stops without foreground fallback', async () => {
  const { page, calls } = fixture('normal', true);
  await assert.rejects(activateRecorderPage(page, 'background', { windowMode: 'minimized' }), /未保持最小化/);
  assert.ok(!calls.some(c => c.method === 'bringToFront')); assert.equal(calls.at(-1).method, 'detach');
});

test('foreground minimized is rejected before browser operations', async () => {
  const { page, calls } = fixture();
  await assert.rejects(activateRecorderPage(page, 'foreground', { windowMode: 'minimized' }), /只支持 background/);
  assert.deepEqual(calls, []);
});
