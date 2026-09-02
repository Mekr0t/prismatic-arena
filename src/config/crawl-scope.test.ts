import test from 'node:test';
import assert from 'node:assert/strict';
import { TIER_ORDER, bucketForTier, inScopeBuckets, tiersAtOrAbove } from '@/config/rank-buckets';
import { isRetryableStatus } from '@/lib/riot/types';

// The queue reconciler decides which QUEUED work survives an env change, so a
// wrong answer here either deletes wanted batches or leaves the unwanted ones
// draining ahead of them — the exact failure it was written to fix.

test('an apex scope admits only the apex buckets', () => {
  const scope = inScopeBuckets(['master', 'grandmaster', 'challenger']);
  assert.ok(scope);
  assert.equal(scope!.has('master_plus'), true);
  assert.equal(scope!.has('challenger'), true);
  assert.equal(scope!.has('iron_gold'), false);
  assert.equal(scope!.has('plat_emerald'), false);
  assert.equal(scope!.has('unknown'), false);
});

test('"all" disables enforcement rather than admitting a bucket list', () => {
  // Null is the escape hatch: with no gate there is nothing to reconcile, and
  // returning a set of every bucket would silently drop any future one.
  assert.equal(inScopeBuckets(['all']), null);
  assert.equal(inScopeBuckets(['master', 'all']), null);
});

test('"unranked" admits the honest unknown bucket', () => {
  // The set-launch case: apex ladders are empty for days, so the scope has to
  // reach players with no resolved tier, whose boards bucket as 'unknown'.
  const scope = inScopeBuckets(['master', 'unranked']);
  assert.ok(scope);
  assert.equal(scope!.has('unknown'), true);
  assert.equal(scope!.has('master_plus'), true);
});

test('scope tokens are case-insensitive, as CRAWL_TIERS is hand-written', () => {
  const scope = inScopeBuckets(['MASTER', 'Challenger']);
  assert.ok(scope);
  assert.equal(scope!.has('master_plus'), true);
  assert.equal(scope!.has('challenger'), true);
});

test('buckets are DERIVED from bucketForTier, never listed separately', () => {
  // Grandmaster and Master share a bucket; a hand-maintained list is exactly
  // where that stops being true.
  for (const tier of ['master', 'grandmaster', 'diamond', 'gold', 'iron']) {
    assert.equal(inScopeBuckets([tier])!.has(bucketForTier(tier)), true);
  }
});

test('an empty scope admits nothing rather than everything', () => {
  assert.equal(inScopeBuckets([])!.size, 0);
});

// ── retry classification ─────────────────────────────────────────────────────

test('infrastructure statuses are retryable', () => {
  // 0 is our own transport failure; 401/403 an expired or revoked key; 429 the
  // rate limiter; 5xx the upstream. None of them says anything about the player,
  // so the batch is worth another attempt and the account must not stay burned.
  for (const s of [0, 401, 403, 429, 500, 502, 503]) {
    assert.equal(isRetryableStatus(s), true, `${s} should be retryable`);
  }
});

test('a bad request is NOT retryable', () => {
  // A malformed or deleted match id fails identically forever; retrying it just
  // re-spends the budget, and releasing the account re-queues the same failure.
  for (const s of [400, 404]) {
    assert.equal(isRetryableStatus(s), false, `${s} should not be retryable`);
  }
});

// ── cumulative tier scopes ───────────────────────────────────────────────────

test('a cumulative scope is every tier at or above the floor', () => {
  assert.deepEqual(tiersAtOrAbove('MASTER'), ['MASTER', 'GRANDMASTER', 'CHALLENGER']);
  assert.deepEqual(tiersAtOrAbove('DIAMOND'), ['DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER']);
});

test('gold+ contains master+, which is the point of the dial', () => {
  // Weaker tiers WIDEN the sample rather than describing a different meta, so
  // every scope must be a superset of the ones above it.
  const gold = new Set(tiersAtOrAbove('gold'));
  for (const t of tiersAtOrAbove('master')) assert.equal(gold.has(t), true, `${t} missing from gold+`);
});

test('the floor is case-insensitive and the weakest floor is the whole ladder', () => {
  assert.deepEqual(tiersAtOrAbove('gold'), tiersAtOrAbove('GOLD'));
  assert.deepEqual(tiersAtOrAbove('iron'), [...TIER_ORDER]);
});

test('an unrecognised floor selects NOTHING rather than the whole ladder', () => {
  // A typo in a scope must show an empty tier list, not silently widen to every
  // rank — that failure would look like working data.
  assert.deepEqual(tiersAtOrAbove('platinium'), []);
  assert.deepEqual(tiersAtOrAbove(''), []);
});

test('every tier in the order maps to a real bucket', () => {
  for (const t of TIER_ORDER) assert.notEqual(bucketForTier(t), 'unknown', `${t} has no bucket`);
});
