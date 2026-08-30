import test from 'node:test';
import assert from 'node:assert/strict';
import { patchFromVersion, placeholderPatch, UNVERSIONED_LABEL } from './patch';

// patch derivation is the one dimension every rollup groups by, so a change
// here silently re-buckets every stat. The DB-touching half (resolvePatchId,
// advanceCurrentPatch) is covered by scripts/_patch-check.ts against live data.

test('a normal Riot game_version yields major.minor', () => {
  assert.equal(
    patchFromVersion('Linux Version 16.16.804.9184 (Aug 10 2026/16:13:14) [PUBLIC] <Releases/16.16>'),
    '16.16',
  );
  assert.equal(patchFromVersion('Version 14.11.633.5272 (Nov 05 2023)'), '14.11');
});

// Set 18 shipped on Unreal with the version string blanked out. This is the
// exact string observed in live match data on 2026-08-27.
test('the Unreal placeholder version parses to null, not to garbage', () => {
  assert.equal(patchFromVersion('TFT Unreal Version ?.?.?.?'), null);
  assert.equal(patchFromVersion(''), null);
  assert.equal(patchFromVersion('no digits at all'), null);
});

test('parsing takes the FIRST version-looking token', () => {
  // The build number that follows must not win.
  assert.equal(patchFromVersion('Linux Version 16.16.804.9184'), '16.16');
});

test('the placeholder is set-scoped and numerically sortable', () => {
  assert.equal(placeholderPatch(18), '18.0');
  assert.equal(placeholderPatch(17), '17.0');
  // advanceCurrentPatch casts both halves with split_part(...)::int, so the
  // placeholder must survive that without throwing.
  for (const set of [1, 17, 18, 99]) {
    const p = placeholderPatch(set);
    assert.match(p, /^[0-9]+\.[0-9]+$/, p);
  }
});

test('the placeholder is distinguishable from a real patch', () => {
  // The trap this guards: set 18's real client version is 16.x, which is
  // numerically BELOW "18.0". Ordering on the number alone would let the
  // placeholder outrank the real patches that replace it, pinning the
  // current-patch flag to it forever. advanceCurrentPatch therefore compares
  // against this exact string rather than trusting the sort.
  assert.notEqual(placeholderPatch(18), '16.17');
  assert.ok(Number(placeholderPatch(18).split('.')[0]) > Number('16.17'.split('.')[0]));
  assert.equal(UNVERSIONED_LABEL, 'Unversioned');
});
