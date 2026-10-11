import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { createMacFollower } = createRequire(import.meta.url)('../desktop/macos/follow.cjs');

function fixture() {
  const calls = [];
  let time = 0, mode = 'follow-codex', visible = false, manuallyHidden = false, orderFails = false;
  let sample = { ok: true, bound: true, visible: true, hostWindow: 123, overlayWindow: 789,
    spaces: ['1'], bounds: { x: 10, y: 20, width: 480, height: 340 } };
  const host = { hostAlive: true, hostPid: 42, window: '123' };
  const window = {
    isDestroyed: () => false, isVisible: () => visible,
    getNativeWindowHandle: () => Buffer.alloc(8),
    hide() { visible = false; calls.push(['hide']); },
    setBounds(bounds) { calls.push(['bounds', bounds]); },
    moveAbove(id) { calls.push(['above', id]); if (orderFails) throw new Error('window gone'); }
  };
  const follower = createMacFollower({ window, getMode: () => mode, getHost: () => host, now: () => time,
    native: { sync() { calls.push(['sync']); return JSON.stringify(sample); } },
    applyHost(value) { calls.push(['apply', value]); visible = !!value.visible && !manuallyHidden; },
    onError(reason) { calls.push(['error', reason]); }
  });
  return { follower, host, calls, window, patch: value => { sample = { ...sample, ...value }; },
    setTime: value => { time = value; }, setMode: value => { mode = value; },
    setHidden: value => { manuallyHidden = value; }, setOrderFailure: value => { orderFails = value; } };
}

test('macOS follows directly above the verified host after showing, including unchanged bounds', () => {
  const f = fixture(); f.follower.observe(f.host);
  assert.deepEqual(f.calls.map(call => call[0]), ['sync', 'bounds', 'apply', 'above']);
  assert.deepEqual(f.calls.at(-1), ['above', 'window:123:0']);
  f.calls.length = 0; f.follower.tick();
  assert.deepEqual(f.calls.map(call => call[0]), ['sync', 'apply', 'above']);
});

test('macOS thumbnail compatibility keeps the host frame intact and reserves one point only in the companion', () => {
  const f = fixture();
  const bounds = { x: 120, y: 34, width: 1205, height: 890 };
  f.patch({ bounds }); f.follower.observe(f.host);
  const expected = { ...bounds, width: 1204 };
  assert.deepEqual(f.calls.find(call => call[0] === 'bounds')[1], expected);
  assert.deepEqual(f.calls.find(call => call[0] === 'apply')[1].bounds, bounds);
  assert.deepEqual(f.follower.snapshot().hostBounds, bounds);
  assert.deepEqual(f.follower.snapshot().overlayBounds, expected);
  f.calls.length = 0;
  for (let i = 0; i < 10; i++) f.follower.tick();
  assert.equal(f.calls.some(call => call[0] === 'bounds'), false, 'steady ticks must not accumulate the inset');
  f.patch({ bounds: { ...bounds, x: -1000, width: 900 } }); f.follower.tick();
  assert.deepEqual(f.calls.find(call => call[0] === 'bounds')[1], { x: -1000, y: 34, width: 899, height: 890 });
  f.calls.length = 0; f.follower.reset(); f.follower.tick();
  assert.deepEqual(f.calls.find(call => call[0] === 'bounds')[1], { x: -1000, y: 34, width: 899, height: 890 });
});

for (const guard of ['manual-hide', 'host-hidden']) test('macOS ordering respects ' + guard, () => {
  const f = fixture();
  if (guard === 'manual-hide') f.setHidden(true); else f.patch({ visible: false });
  f.follower.observe(f.host);
  assert.equal(f.window.isVisible(), false);
  assert.equal(f.calls.some(call => call[0] === 'above'), false);
});

test('Space animation preserves the last binding without ordering, moving or showing', () => {
  const f = fixture(); f.follower.observe(f.host); f.calls.length = 0;
  f.patch({ animating: true, bounds: { x: 600, y: 20, width: 480, height: 340 } });
  f.follower.tick();
  assert.deepEqual(f.calls, [['sync']]);
  assert.equal(f.follower.snapshot().animating, true);
});

test('standalone mode bypasses native following and relative ordering', () => {
  const f = fixture(); f.setMode('standalone'); f.follower.observe(f.host); f.follower.tick();
  assert.deepEqual(f.calls, []);
});

for (const failure of ['native-failure', 'stale-heartbeat']) test('macOS ordering fails closed on ' + failure, () => {
  const f = fixture(); f.follower.observe(f.host); f.calls.length = 0;
  if (failure === 'native-failure') f.patch({ ok: false, reason: 'host-window-gone' }); else f.setTime(2501);
  f.follower.tick();
  assert.equal(f.window.isVisible(), false);
  assert.equal(f.follower.snapshot().bound, false);
  assert.equal(f.calls.some(call => call[0] === 'above'), false);
});

test('a replacement host is hidden before retargeting and uses the new window ID', () => {
  const f = fixture(); f.follower.observe(f.host); f.calls.length = 0;
  f.patch({ hostWindow: 456 }); f.follower.observe({ ...f.host, window: '456' });
  assert.deepEqual(f.calls.map(call => call[0]), ['sync', 'hide', 'apply', 'above']);
  assert.deepEqual(f.calls.at(-1), ['above', 'window:456:0']);
});

test('ordering failure hides the companion and a fresh valid sample can recover', () => {
  const f = fixture(); f.setOrderFailure(true); f.follower.observe(f.host);
  assert.equal(f.window.isVisible(), false);
  assert.equal(f.follower.snapshot().bound, false);
  f.setOrderFailure(false); f.calls.length = 0; f.follower.tick();
  assert.equal(f.window.isVisible(), true);
  assert.equal(f.follower.snapshot().bound, true);
  assert.deepEqual(f.calls.at(-1), ['above', 'window:123:0']);
});
