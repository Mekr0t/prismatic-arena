// comp-signature.ts — exact-board identity (rebuild).
//
// A comp IS its exact unit multiset, with star collapsed to two buckets: 3-star
// is its own identity, 1-star and 2-star are the same. No archetype, no carry
// detection, no traits, no families, no shells, no fallback, no merging — two
// boards cluster together iff they fielded the identical units at the identical
// star bucket. This is deliberately the simplest rule that can exist; the only
// knob is the minimum board size (which drops surrenders / sell-outs / DCs).
//
// `threeStars` is surfaced ONLY for display labelling: it's the hit the player
// explicitly went for, which the bucket split already treats as identity. It is
// not a carry pick — there is no carry concept here anymore.

const num = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** A board with fewer real (cost 1–5) units than this is dropped from
 *  clustering: it means a surrender / sell-out / disconnect, not a comp. */
export const MIN_BOARD_UNITS = num(process.env.SIG_MIN_BOARD_UNITS, 6);

export interface SigUnit {
  characterId: string;
  cost: number; // static cost; summons (>5) and unknowns (0) are filtered out
  star: number; // 1 | 2 | 3
}

export interface CompIdentity {
  signature: string;
  coreUnits: string[]; // the exact unit multiset, sorted (display / reference)
  threeStars: string[]; // character_ids fielded at 3-star, sorted (display label)
}

// 1★ and 2★ collapse to "lo"; 3★ is its own bucket — the only star distinction
// that splits identity.
function starBucket(star: number): string {
  return star >= 3 ? '3' : 'lo';
}

/**
 * Exact-board identity, or null if the board is unclusterable (< MIN_BOARD_UNITS
 * real units). Summons (cost > 5) and unknown (cost 0) units are excluded from
 * everything. The signature is the sorted multiset of `characterId:bucket`
 * tokens — unit order never matters, and a duplicate-copy board (two of the same
 * unit) stays distinct from a single-copy one because tokens aren't deduped.
 */
export function buildIdentity(units: SigUnit[]): CompIdentity | null {
  const real = units.filter((u) => u.cost >= 1 && u.cost <= 5);
  if (real.length < MIN_BOARD_UNITS) return null;

  const tokens = real.map((u) => `${u.characterId}:${starBucket(u.star)}`).sort();
  const signature = tokens.join('|');

  const coreUnits = real.map((u) => u.characterId).sort(compareIds);
  const threeStars = real
    .filter((u) => u.star >= 3)
    .map((u) => u.characterId)
    .sort(compareIds);

  return { signature, coreUnits, threeStars };
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}