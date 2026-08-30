import test from 'node:test';
import assert from 'node:assert/strict';
import { bucketForTier, bucketLabel, tierInScope } from './rank-buckets';

// The rank dimension is the thing the audit found to be fiction once already
// (every board labelled 'challenger' by a column default). These pin the two
// rules that keep it honest: an unrecognised tier is 'unknown', never a named
// bucket; and the crawl scope decides who gets crawled at all.

test('every real Riot tier maps to a bucket', () => {
  assert.equal(bucketForTier('CHALLENGER'), 'challenger');
  assert.equal(bucketForTier('GRANDMASTER'), 'master_plus');
  assert.equal(bucketForTier('MASTER'), 'master_plus');
  assert.equal(bucketForTier('DIAMOND'), 'diamond');
  assert.equal(bucketForTier('EMERALD'), 'plat_emerald');
  assert.equal(bucketForTier('PLATINUM'), 'plat_emerald');
  for (const t of ['GOLD', 'SILVER', 'BRONZE', 'IRON']) {
    assert.equal(bucketForTier(t), 'iron_gold', t);
  }
});

test('tier matching is case-insensitive', () => {
  assert.equal(bucketForTier('challenger'), 'challenger');
  assert.equal(bucketForTier('Master'), 'master_plus');
});

// The regression that made the rank dimension fiction: an absent tier must
// never be folded into a named bucket.
test('an absent or unrecognised tier is "unknown", never a named bucket', () => {
  for (const t of [null, undefined, '', 'UNRANKED', 'PROVISIONAL', 'nonsense']) {
    assert.equal(bucketForTier(t), 'unknown', JSON.stringify(t));
  }
});

test('bucket labels are human-readable, not raw values', () => {
  assert.equal(bucketLabel('master_plus'), 'Master+');
  assert.equal(bucketLabel('apex_mixed'), 'Apex (mixed)');
  assert.equal(bucketLabel('unknown'), 'Unranked sample');
  assert.equal(bucketLabel('something_new'), 'Something_new', 'falls back rather than rendering blank');
});

// ── crawl scope ──────────────────────────────────────────────────────────────

const APEX = ['challenger', 'grandmaster', 'master'];

test('scope matches on the Riot tier name, case-insensitively', () => {
  assert.equal(tierInScope('MASTER', APEX), true);
  assert.equal(tierInScope('master', APEX), true);
  assert.equal(tierInScope('DIAMOND', APEX), false);
});

test('an unresolved tier is OUT of an apex scope', () => {
  assert.equal(tierInScope(null, APEX), false);
  assert.equal(tierInScope(undefined, APEX), false);
});

// These two tokens are what make a crawl possible in the first days of a set,
// when the ladder has reset and there is no Master+ population to gate on.
test('"unranked" admits a candidate with no resolved tier', () => {
  assert.equal(tierInScope(null, ['unranked']), true);
  assert.equal(tierInScope(undefined, [...APEX, 'unranked']), true);
  assert.equal(tierInScope('DIAMOND', [...APEX, 'unranked']), false, 'and only that one');
});

test('"all" removes the gate entirely', () => {
  for (const t of [null, undefined, 'IRON', 'CHALLENGER', 'anything']) {
    assert.equal(tierInScope(t, ['all']), true, JSON.stringify(t));
  }
  assert.equal(tierInScope('IRON', ['ALL']), true, 'and is case-insensitive');
});

test('the new tokens do not change behaviour for an ordinary scope', () => {
  // A scope that names only tiers behaves exactly as before.
  assert.equal(tierInScope(null, APEX), false);
  assert.equal(tierInScope('CHALLENGER', APEX), true);
  assert.equal(tierInScope('IRON', APEX), false);
  assert.equal(tierInScope('IRON', []), false, 'an empty scope admits nothing');
  assert.equal(tierInScope(null, []), false);
});
