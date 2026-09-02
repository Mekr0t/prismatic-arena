import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PATCH_RE,
  comparePatch,
  parsePatch,
  patchFromVersion,
  placeholderPatch,
  UNVERSIONED_LABEL,
} from './patch';

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


// ── hotfix patches ───────────────────────────────────────────────────────────
//
// TFT on Unreal is no longer tied to the League client's release train, so Riot
// ships an out-of-band fix whenever something breaks the meta: 18.1, 18.1a,
// 18.1b, then 18.2. Those are separate metas, so they have to be separate
// patches — and the ordering has to place them correctly, or advanceCurrentPatch
// flags the wrong one and every stat groups under it.

test('a hotfix suffix parses, and a base patch has an empty one', () => {
  assert.deepEqual(parsePatch('18.1'), { major: 18, minor: 1, hotfix: '' });
  assert.deepEqual(parsePatch('18.1a'), { major: 18, minor: 1, hotfix: 'a' });
  assert.deepEqual(parsePatch('16.10b'), { major: 16, minor: 10, hotfix: 'b' });
});

test('a non-patch string parses to null rather than to something plausible', () => {
  for (const bad of ['', '18', '18.', 'a.b', '18.1.2', 'Version 14.11', '18-1']) {
    assert.equal(parsePatch(bad), null, bad);
  }
});

test('the guard regex accepts exactly what parsePatch accepts', () => {
  // advanceCurrentPatch uses the SQL twin of this regex to keep a ::int cast off
  // rows it would throw on, so the two must agree about what a patch looks like.
  for (const good of ['18.1', '18.1a', '16.10b', '1.0']) assert.ok(PATCH_RE.test(good), good);
  for (const bad of ['18', '18.1.2', '18.1A', '']) assert.equal(PATCH_RE.test(bad), false, bad);
});

test('a base patch sorts BEFORE its own hotfixes, and both before the next patch', () => {
  const shuffled = ['18.2', '18.1b', '18.1', '18.1a'];
  assert.deepEqual(shuffled.slice().sort(comparePatch), ['18.1', '18.1a', '18.1b', '18.2']);
});

test('ordering is numeric, not lexical — 16.10 comes after 16.9', () => {
  assert.ok(comparePatch('16.10', '16.9') > 0);
  assert.deepEqual(['16.10', '16.9', '16.2'].sort(comparePatch), ['16.2', '16.9', '16.10']);
});

test('a hotfix on a two-digit minor still sorts correctly', () => {
  // The SQL splits the suffix out of the minor component; "10a" must not be read
  // as 10 or as 1.
  assert.deepEqual(['16.10a', '16.10', '16.9b'].sort(comparePatch), ['16.9b', '16.10', '16.10a']);
});

test('unparseable strings sort before every real patch rather than throwing', () => {
  // The only ones in live data predate the format; they must not be able to win
  // the current-patch flag by sorting last.
  assert.ok(comparePatch('junk', '18.1') < 0);
  assert.deepEqual(['18.1', 'junk'].sort(comparePatch), ['junk', '18.1']);
});

test('the placeholder is a valid patch string, so the new ordering still admits it', () => {
  assert.ok(PATCH_RE.test(placeholderPatch(18)));
  assert.ok(comparePatch(placeholderPatch(18), '18.1') < 0);
});
