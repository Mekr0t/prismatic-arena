// bin-hash.ts — resolving CommunityDragon's obfuscated field names.
//
// Riot's .bin game data keys every field by a HASH of its name, not the name
// itself. CDragon reverses that against a community wordlist, so most fields
// arrive readable — but a name missing from the list is emitted as the raw hash
// in braces: `{7a9d7f0e}`.
//
// Set 18 hit this hard. Its trait descriptions say `@EssencePerDeath@` while the
// matching value is published under `{7a9d7f0e}`, so a name lookup finds
// nothing and `resolveDesc` drops the number — which is why Invoker's rows read
// "(2) 1 |" with the second value simply gone. Measured across set 18: 58 of the
// 83 unmatched variable names are recoverable this way, and the rest are
// `MinUnits`, which the loader already supplies from the breakpoint itself.
//
// The hash is FNV-1a 32-bit over the LOWERCASED name, printed as 8 hex digits.
// Verified against live data before being relied on:
//   fnv1a32('capstonead')      -> 1b76cfed   (published by DA_Riftbeast18)
//   fnv1a32('teamdurability')  -> f8c73243   (published by DA_Juggernaut18)
//   fnv1a32('essenceperdeath') -> 7a9d7f0e   (published by DA_18_Coven)

/** FNV-1a 32-bit, as 8 lowercase hex digits. */
export function fnv1a32(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // Math.imul keeps the 32-bit overflow semantics the hash depends on; a
    // plain `*` would silently go through float64 and diverge past 2^53.
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** The `{hex}` key CDragon publishes for a field name it could not reverse. */
export function binHashKey(fieldName: string): string {
  return `{${fnv1a32(fieldName.toLowerCase())}}`;
}

/**
 * Look up `name` in a CDragon-derived map, falling back to its hashed key.
 *
 * Case-insensitive on the direct match because CDragon's casing is not stable
 * across sets, and the hash is computed on the lowercased name because that is
 * what Riot hashes.
 */
export function lookupBinField<T>(
  fields: Record<string, T>,
  name: string,
): T | undefined {
  for (const [k, v] of Object.entries(fields)) {
    if (k.toLowerCase() === name.toLowerCase()) return v;
  }
  return fields[binHashKey(name)];
}
