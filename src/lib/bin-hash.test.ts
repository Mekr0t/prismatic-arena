import test from 'node:test';
import assert from 'node:assert/strict';
import { fnv1a32, binHashKey, lookupBinField } from './bin-hash';

// These three pairs were verified against live CDragon data before the hash was
// relied on: each name appears in a set-18 trait description as @Name@, and the
// matching value is published under the hashed key. If the hash ever changes,
// every set-18 trait number silently disappears again.

test('the hash matches keys CDragon actually publishes', () => {
  assert.equal(fnv1a32('capstonead'), '1b76cfed', 'DA_Riftbeast18');
  assert.equal(fnv1a32('teamdurability'), 'f8c73243', 'DA_Juggernaut18');
  assert.equal(fnv1a32('essenceperdeath'), '7a9d7f0e', 'DA_18_Coven');
});

test('the hash is FNV-1a 32-bit, per its published test vectors', () => {
  assert.equal(fnv1a32(''), '811c9dc5', 'the offset basis');
  assert.equal(fnv1a32('a'), 'e40c292c');
  assert.equal(fnv1a32('foobar'), 'bf9cf968');
});

test('output is always 8 hex digits, zero-padded', () => {
  for (const s of ['a', 'bb', 'ccc', 'teamsize', 'x'.repeat(200)]) {
    assert.match(fnv1a32(s), /^[0-9a-f]{8}$/, `bad shape for ${JSON.stringify(s)}`);
  }
});

test('32-bit overflow is preserved', () => {
  // A plain `*` instead of Math.imul goes through float64 and diverges once the
  // product passes 2^53 — silently, and only for some inputs.
  assert.equal(fnv1a32('capstonemanaregen').length, 8);
  assert.notEqual(fnv1a32('capstonead'), fnv1a32('capstoneap'), 'near-identical names must differ');
});

test('the key is the hash in braces, lowercased first', () => {
  assert.equal(binHashKey('CapstoneAD'), '{1b76cfed}');
  assert.equal(binHashKey('capstonead'), '{1b76cfed}');
  assert.equal(binHashKey('CAPSTONEAD'), '{1b76cfed}');
});

test('lookup prefers the readable name over the hash', () => {
  const fields = { TeamSize: 9, '{1b76cfed}': 42 };
  assert.equal(lookupBinField(fields, 'TeamSize'), 9);
  assert.equal(lookupBinField(fields, 'teamsize'), 9, 'case-insensitive');
});

test('lookup falls back to the hashed key', () => {
  // The case the whole module exists for: the description says @CapstoneAD@ and
  // the only thing published is {1b76cfed}.
  const fields = { '{1b76cfed}': 42 };
  assert.equal(lookupBinField(fields, 'CapstoneAD'), 42);
});

test('a genuinely absent field is undefined, not zero', () => {
  // Must be distinguishable from a real 0, which is a legitimate value.
  assert.equal(lookupBinField({ '{1b76cfed}': 0 }, 'CapstoneAD'), 0);
  assert.equal(lookupBinField({}, 'CapstoneAD'), undefined);
  assert.equal(lookupBinField({ Other: 1 }, 'CapstoneAD'), undefined);
});
