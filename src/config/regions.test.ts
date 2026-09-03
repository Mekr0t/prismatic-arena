import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLATFORMS,
  PLATFORM_TO_REGION,
  PLATFORM_TO_SUPER_REGION,
  isPlatform,
  routeForPlatform,
  superRegionForPlatform,
  superRegionForRegionCode,
} from './regions';

// Two different partitions of the same platforms, and conflating them is the
// trap: RegionalRoute is a rate-limit and host boundary, SuperRegion is the
// competitive one. They deliberately disagree — 'sea' and 'asia' are separate
// routes but one competitive region.

test('every platform has both a route and a super-region', () => {
  for (const p of PLATFORMS) {
    assert.ok(PLATFORM_TO_REGION[p], `${p} has no regional route`);
    assert.ok(PLATFORM_TO_SUPER_REGION[p], `${p} has no super-region`);
  }
});

test('the two maps cover exactly the platform list, with no strays', () => {
  assert.deepEqual(Object.keys(PLATFORM_TO_REGION).sort(), [...PLATFORMS].sort());
  assert.deepEqual(Object.keys(PLATFORM_TO_SUPER_REGION).sort(), [...PLATFORMS].sort());
});

test('every EMEA platform routes through europe', () => {
  // Load-bearing for the crawl's throughput expectations: TFT-MATCH-V1 is keyed
  // per REGIONAL ROUTE, so adding EUNE/TR/RU/ME does not widen the match budget
  // — they all share europe. Only the per-platform league lookups scale.
  const emea = PLATFORMS.filter((p) => superRegionForPlatform(p) === 'EMEA');
  assert.deepEqual(emea.sort(), ['eun1', 'euw1', 'me1', 'ru', 'tr1']);
  for (const p of emea) assert.equal(routeForPlatform(p), 'europe', p);
});

test('APAC spans two regional routes, which is why the partitions differ', () => {
  const apac = PLATFORMS.filter((p) => superRegionForPlatform(p) === 'APAC');
  const routes = new Set(apac.map(routeForPlatform));
  assert.deepEqual([...routes].sort(), ['asia', 'sea']);
});

test('a stored matches.region code maps to its super-region', () => {
  // matches.region is the UPPERCASE platform prefix of a match id, not a
  // Platform literal — "EUW1_7967092353" → "EUW1".
  assert.equal(superRegionForRegionCode('EUW1'), 'EMEA');
  assert.equal(superRegionForRegionCode('EUN1'), 'EMEA');
  assert.equal(superRegionForRegionCode('RU'), 'EMEA');
  assert.equal(superRegionForRegionCode('NA1'), 'AMER');
  assert.equal(superRegionForRegionCode('KR'), 'APAC');
});

test('an unknown region code maps to NULL rather than to a plausible region', () => {
  // The persist check writes synthetic "ZZTEST1" rows; folding those into a real
  // super-region would put test data in the tier list.
  assert.equal(superRegionForRegionCode('ZZTEST1'), null);
  assert.equal(superRegionForRegionCode(''), null);
  assert.equal(superRegionForRegionCode('EMEA'), null);
});

test('mainland China is absent, not present-and-empty', () => {
  // It runs on Tencent's infrastructure and is not served by the public Riot
  // API, so a 'CN' bucket could never fill — an empty selector option that never
  // works is worse than no option.
  const supers = new Set(PLATFORMS.map(superRegionForPlatform));
  assert.deepEqual([...supers].sort(), ['AMER', 'APAC', 'EMEA']);
});

test('me1 is a real platform, so the crawl can be pointed at it', () => {
  assert.ok(isPlatform('me1'));
  assert.equal(routeForPlatform('me1'), 'europe');
});
