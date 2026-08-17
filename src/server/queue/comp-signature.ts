// comp-signature.ts — exact-board identity (rebuild).
//
// A comp IS its exact unit multiset, with star collapsed to two buckets: 3-star
// is its own identity (for reroll-cost units only — see SIG_STAR_MAX_COST),
// 1-star and 2-star are the same. No archetype, no carry detection, no traits,
// no families, no shells, no fallback, no merging — two boards cluster together
// iff they fielded the identical units at the identical star bucket. This is
// deliberately the simplest rule that can exist; the knobs are the minimum
// board size (drops surrenders / sell-outs / DCs) and the 3★ cost gate.
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

/** 3★ splits identity only for units at or below this cost. A 3★ 4/5-cost is
 *  never the plan — it's a lottery hit or a set mechanic (the Arbiter "print"
 *  hands out a free unit, 7-piece Meeple duplicates one) landing on a fast-8/9
 *  board. It changes the board's placement, not what the comp IS, so it must
 *  not cluster that board away from the same comp without the hit. */
export const SIG_STAR_MAX_COST = num(process.env.SIG_STAR_MAX_COST, 3);

export interface SigUnit {
  characterId: string;
  cost: number; // static cost; summons (>5) and unknowns (0) are filtered out
  star: number; // 1 | 2 | 3
}

export interface CompIdentity {
  signature: string;
  coreUnits: string[]; // the exact unit multiset, sorted (display / reference)
  threeStars: string[]; // character_ids fielded at 3-star, sorted (display label)
  emblems: string[]; // worn trait-emblem item ids, deduped + sorted (identity)
}

/** A trait emblem is a Spatula/Frying-Pan item that grants its wearer an extra
 *  trait; its item id always contains "Emblem" (e.g. TFT17_Item_DarkStarEmblemItem).
 *  A worn emblem changes what a board IS (it can cross a trait breakpoint), so it
 *  belongs in the exact-board identity. */
export function isEmblemItem(itemId: string): boolean {
  return /Emblem/i.test(itemId);
}

/** Parse the worn-emblem item ids back out of a signature (`emb:<id>` tokens),
 *  sorted. Lives here — next to the code that writes the token format — so the
 *  read side (comps-service) and the merge stage can't drift apart. */
export function emblemsFromSignature(signature: string | null | undefined): string[] {
  if (!signature) return [];
  const out: string[] = [];
  for (const tok of signature.split('|')) if (tok.startsWith('emb:')) out.push(tok.slice(4));
  return out.sort();
}

// 1★ and 2★ collapse to "lo"; 3★ is its own bucket — the only star distinction
// that splits identity, and only for reroll-cost units (see SIG_STAR_MAX_COST).
function starBucket(u: SigUnit): string {
  return u.star >= 3 && u.cost <= SIG_STAR_MAX_COST ? '3' : 'lo';
}

/**
 * Exact-board identity, or null if the board is unclusterable (< MIN_BOARD_UNITS
 * real units). Summons (cost > 5) and unknown (cost 0) units are excluded from
 * everything. The signature is the sorted multiset of `characterId:bucket`
 * tokens — unit order never matters, and a duplicate-copy board (two of the same
 * unit) stays distinct from a single-copy one because tokens aren't deduped.
 */
export function buildIdentity(units: SigUnit[], emblems: string[] = []): CompIdentity | null {
  const real = units.filter((u) => u.cost >= 1 && u.cost <= 5);
  if (real.length < MIN_BOARD_UNITS) return null;

  const unitTokens = real.map((u) => `${u.characterId}:${starBucket(u)}`).sort();
  // Worn emblems are appended as `emb:<itemId>` tokens (sorted, deduped) so a
  // board that runs a trait emblem clusters apart from the same units without
  // it. Character ids never start with "emb:", so the two token kinds are
  // unambiguous when the signature is parsed downstream.
  const embSet = [...new Set(emblems)].sort();
  const embTokens = embSet.map((e) => `emb:${e}`);
  const signature = [...unitTokens, ...embTokens].join('|');

  const coreUnits = real.map((u) => u.characterId).sort(compareIds);
  // Same cost gate as the signature: a lottery/print/duplicate 3★ 4/5-cost is
  // not a "hit" — keeping it out here keeps comps.carries deterministic (all
  // boards of one signature agree on the 3★ set) and keeps it out of hit
  // states, labels, and the grade3 merge guard.
  const threeStars = real
    .filter((u) => u.star >= 3 && u.cost <= SIG_STAR_MAX_COST)
    .map((u) => u.characterId)
    .sort(compareIds);

  return { signature, coreUnits, threeStars, emblems: embSet };
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}