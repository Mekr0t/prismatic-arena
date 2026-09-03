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
  regionCodesFor,
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

// ── expanding a selection back to platforms ──────────────────────────────────
//
// The derived tables are keyed by super-region; matches.region still holds the
// platform. Any query reading raw boards for a selection has to expand one into
// the other, and getting this wrong is SILENT: comparing 'EMEA' against
// matches.region matches nothing, so every example board renders as "no board
// data" while the tier list above it looks fine. Measured when it happened —
// 0 boards against 211,788.

test('a super-region expands to the platform codes it covers', () => {
  assert.deepEqual(regionCodesFor('EMEA').sort(), ['EUN1', 'EUW1', 'ME1', 'RU', 'TR1']);
  assert.deepEqual(regionCodesFor('AMER').sort(), ['BR1', 'LA1', 'LA2', 'NA1']);
});

test('the expansion is UPPERCASE, because matches.region is', () => {
  // matches.region comes from the match id prefix ("EUW1_7967092353"), so a
  // lowercase Platform literal would match nothing.
  for (const code of regionCodesFor('EMEA')) assert.equal(code, code.toUpperCase());
});

test('every expanded code maps back to the super-region it came from', () => {
  for (const region of ['AMER', 'EMEA', 'APAC']) {
    for (const code of regionCodesFor(region)) {
      assert.equal(superRegionForRegionCode(code), region, code);
    }
  }
});

test('a platform code or unknown value passes through as itself', () => {
  // Legacy rows, a directly-selected platform, and the persist check's synthetic
  // region all have to keep resolving.
  assert.deepEqual(regionCodesFor('EUW1'), ['EUW1']);
  assert.deepEqual(regionCodesFor('ZZTEST1'), ['ZZTEST1']);
});

test('the selection is case-insensitive on the super-region name', () => {
  assert.deepEqual(regionCodesFor('emea').sort(), regionCodesFor('EMEA').sort());
});
