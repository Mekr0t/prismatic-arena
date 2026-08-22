import test from 'node:test';
import assert from 'node:assert/strict';
import { SlidingWindowQueue, DEV_APP_WINDOWS } from './rate-limiter';

// Real timers, deliberately: the queue's drain loop sleeps on setTimeout and
// stamps Date.now(), so faking either would test the mock instead of the
// limiter. Windows are kept tiny (tens of ms) so the whole file runs in well
// under a second, and assertions are one-sided (>= the floor) so a slow CI box
// makes them pass harder, never flake.
const elapsed = async (fn: () => Promise<unknown>): Promise<number> => {
  const t0 = Date.now();
  await fn();
  return Date.now() - t0;
};

test('the first `limit` acquires are immediate', async () => {
  const q = new SlidingWindowQueue([{ limit: 3, intervalMs: 200 }]);
  const ms = await elapsed(() => Promise.all([q.acquire(), q.acquire(), q.acquire()]));
  assert.ok(ms < 50, `expected no waiting, waited ${ms}ms`);
});

test('the (limit+1)-th acquire waits for the window to slide', async () => {
  const q = new SlidingWindowQueue([{ limit: 2, intervalMs: 120 }]);
  await q.acquire();
  await q.acquire();
  const ms = await elapsed(() => q.acquire());
  assert.ok(ms >= 100, `expected to wait ~120ms for a slot, waited ${ms}ms`);
});

test('throughput resumes once old hits age out of the window', async () => {
  const q = new SlidingWindowQueue([{ limit: 2, intervalMs: 80 }]);
  await q.acquire();
  await q.acquire();
  await q.acquire(); // pays the wait; the first two have now expired
  const ms = await elapsed(() => q.acquire());
  assert.ok(ms < 60, `a freed slot should be immediate, waited ${ms}ms`);
});

test('EVERY window is enforced, not just the tightest', async () => {
  // 5/s would allow four in a row; 3 per 150ms must still hold them back.
  const q = new SlidingWindowQueue([
    { limit: 5, intervalMs: 1_000 },
    { limit: 3, intervalMs: 150 },
  ]);
  await Promise.all([q.acquire(), q.acquire(), q.acquire()]);
  const ms = await elapsed(() => q.acquire());
  assert.ok(ms >= 120, `the narrower window should bind, waited ${ms}ms`);
});

test('higher priority jumps the queue', async () => {
  const q = new SlidingWindowQueue([{ limit: 1, intervalMs: 60 }]);
  await q.acquire(); // consume the only slot; everything below must queue
  const order: string[] = [];
  const batch = Promise.all([
    q.acquire(0).then(() => order.push('batch-1')),
    q.acquire(0).then(() => order.push('batch-2')),
    q.acquire(10).then(() => order.push('user')),
  ]);
  await batch;
  assert.equal(order[0], 'user', `USER-priority should run first, got ${order.join(',')}`);
});

test('FIFO within one priority level', async () => {
  const q = new SlidingWindowQueue([{ limit: 1, intervalMs: 40 }]);
  await q.acquire();
  const order: number[] = [];
  await Promise.all([
    q.acquire(0).then(() => order.push(1)),
    q.acquire(0).then(() => order.push(2)),
    q.acquire(0).then(() => order.push(3)),
  ]);
  assert.deepEqual(order, [1, 2, 3]);
});

test('DEV_APP_WINDOWS matches the documented dev-key ceiling', () => {
  assert.deepEqual(DEV_APP_WINDOWS, [
    { limit: 20, intervalMs: 1_000 },
    { limit: 100, intervalMs: 120_000 },
  ]);
});

// This one pins a KNOWN LIMITATION rather than a guarantee, so nobody reads the
// priority queue above and assumes it protects interactive traffic globally.
// Two instances keep separate budgets — which is exactly what happens in
// production, where the worker and the Next server each construct their own and
// together exceed one Riot key (audit §4, "One key, two budgets").
test('two instances do NOT share a budget (single-process by design)', async () => {
  const a = new SlidingWindowQueue([{ limit: 1, intervalMs: 200 }]);
  const b = new SlidingWindowQueue([{ limit: 1, intervalMs: 200 }]);
  await a.acquire();
  const ms = await elapsed(() => b.acquire());
  assert.ok(ms < 50, 'a second instance spends its own budget — see audit §4');
});
