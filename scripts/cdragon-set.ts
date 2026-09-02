// cdragon-set.ts — the ROSTER GATE, in one place.
//
// Shared by the loader (load-static-data.ts) and the readiness checker
// (_set-readiness.ts). It lives here rather than in either of them because the
// loader self-runs on import, so nothing can import from it — and a checker
// that carried its own copy of the threshold would eventually disagree with the
// loader it exists to predict, which is the one thing it must never do.
//
// Types are deliberately LOOSE (structural, optional fields): the loader has
// richer CDragon interfaces of its own and they stay assignable to these.

export interface CDragonChampionLite {
  apiName?: string;
  cost?: number;
  traits?: string[];
}

export interface CDragonSetLite {
  number?: number;
  mutator?: string;
  name?: string;
  champions?: CDragonChampionLite[];
  traits?: unknown[];
  augments?: string[];
}

/**
 * Champions that are both playable (cost 1-5) and carry at least one trait.
 *
 * The cost filter alone is not enough: CDragon's pre-launch stub for a set ships
 * jungle camps (Krug, Murk Wolf, Razorbeak, Elder Dragon) WITH costs attached,
 * and item anvils at cost 8-11. Requiring a trait is what separates a roster
 * from set dressing — measured 2026-08-22, TFTSet18 scored 2 by this rule while
 * TFTSet17 scored 63.
 */
export function rosterSize(s: CDragonSetLite | undefined): number {
  return (s?.champions ?? []).filter(
    (c) => (c.cost ?? 0) >= 1 && (c.cost ?? 0) <= 5 && (c.traits?.length ?? 0) > 0,
  ).length;
}

/** Below this, a set is treated as not yet published. Real sets land 60-100. */
export const MIN_REAL_ROSTER = 20;

/**
 * The canonical entry for a set number. CDragon publishes several mutators per
 * set (TFTSet17_PVEMODE, TFTSet17_PAIRS, TFTSetEvent5YR) with near-identical
 * rosters but different augment pools; the bare "TFTSet{n}" is the ranked one.
 */
export function canonicalEntry(
  entries: CDragonSetLite[],
  n: number,
): CDragonSetLite | undefined {
  const same = entries.filter((s) => s.number === n);
  return same.find((s) => s.mutator === `TFTSet${n}`) ?? same[0];
}
