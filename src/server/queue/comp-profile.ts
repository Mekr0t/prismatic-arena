// comp-profile.ts — pure CompProfile construction (no DB).
//
// Bridges carry-classify (per-board itemization evidence) and comp-merge
// (archetype grouping): turns one comp's DB rows into the CompProfile the
// merge algorithm scores. Extracted from stages/merge.ts so tests and the
// merge-eval script exercise the exact production path.
//
// Responsibilities:
//   - copySig            : units fielded 2+ times (duplicate-copy augment class)
//   - carries            : isBucketCarry units, with a top-itemized FALLBACK for
//                          comps that never fully itemize (dead / missed-hit
//                          boards spread items thin) — without it those comps
//                          have no carries and hard-fail the carry guard
//   - carryGrade3        : 3★ units that are also itemized (carry or reliably
//                          top-itemized). Incidental 3★s (augment copies on a
//                          unit nobody items) are excluded — they must neither
//                          split identity nor drag a board into a reroll line
//   - unitWeights        : identity weights for overlap scoring — itemized
//                          carries / 3★ = 1, ordinary core = WEIGHT_CORE,
//                          un-itemized expensive cap/flex slots = WEIGHT_FLEX
//                          (the "survivor effect" fix: late-game cap swaps
//                          shouldn't drag two boards of one line apart)
//   - heroAugmentSig     : active hero-augment champ (see carry-classify.ts)

import {
  classifyCarries,
  bucketCarryIds,
  classifyHeroAugments,
  HERO_AUGMENT_CHAMPIONS,
  type RawUnitItem,
} from './carry-classify';
import type { CompProfile } from './comp-merge';

const _num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

// Fallback carries: when no unit clears the fully-itemized bar, units that
// still rank in the top item slots (with >= 1 completed item) on at least this
// share of boards act as the comp's carries for merge purposes.
const FALLBACK_TOP_RATE = _num(process.env.MERGE_FALLBACK_TOP_RATE, 0.5);
// How many fallback carries at most — mirrors carry-classify's TOP_ITEM_SLOTS.
const FALLBACK_MAX = 2;

// Per-unit identity weights for overlap scoring (consumed by comp-merge).
const WEIGHT_CORE = _num(process.env.MERGE_WEIGHT_CORE, 0.7);
const WEIGHT_FLEX = _num(process.env.MERGE_WEIGHT_FLEX, 0.25);
// A unit is a flex/cap slot when it's expensive (cost >= FLEX_MIN_COST), not
// 3★, and effectively un-itemized across the comp's boards. Unknown costs
// (costOf returns 0) never classify as flex.
const FLEX_MIN_COST      = _num(process.env.MERGE_FLEX_MIN_COST, 4);
const FLEX_MAX_ITEM_RATE = _num(process.env.MERGE_FLEX_MAX_ITEM_RATE, 0.25);

// Duplicate-copy augment detection: only 1–3-cost duplicates count as the
// augment class. Doubling a CHEAP unit is only worth board space when the
// duplicate augment rewards it (the copies can realistically hit 3★); a
// doubled 4/5-cost is a late-game bench copy fielded because nothing better
// exists — a normal board state, not an augment build. Unknown costs (0)
// never classify.
const COPY_MAX_COST = _num(process.env.MERGE_COPY_MAX_COST, 3);

export interface CompRowInput {
  compId: number;
  setNumber: number;
  /** Exact-board unit multiset (comps.core_units) — copies listed repeatedly. */
  coreUnits: string[];
  /** 3★ character ids (from comps.carries, set by cluster.ts as threeStars). */
  threeStars: string[];
  /** Σ comp_stats.n across buckets (0 if the comp has no stats yet). */
  statTotal: number;
  /** Per-board unit+item rows for this comp (one per board × unit × copy). */
  rawRows: RawUnitItem[];
  /** Static unit cost lookup for this comp's set; 0 if unknown. */
  costOf: (characterId: string) => number;
}

// core_units is a MULTISET: the duplicate-copy augment lists a unit more than
// once. The Set of DISTINCT ids is what unit-overlap scoring uses; the
// doubled-unit set (copySig, cost-gated — see COPY_MAX_COST) is a separate
// hard-fail guard in comp-merge.
function splitMultiset(
  coreUnits: string[],
  costOf: (characterId: string) => number,
): { units: Set<string>; copySig: string } {
  const copyCounts = new Map<string, number>();
  for (const u of coreUnits) copyCounts.set(u, (copyCounts.get(u) ?? 0) + 1);
  return {
    units: new Set(copyCounts.keys()),
    copySig: [...copyCounts.entries()]
      .filter(([id, c]) => {
        if (c < 2) return false;
        const cost = costOf(id);
        return cost >= 1 && cost <= COPY_MAX_COST;
      })
      .map(([id]) => id)
      .sort()
      .join('|'),
  };
}

/** Build the merge-ready profile for one comp. Pure — no DB, no env reads
 *  beyond the module-level knobs. */
export function buildCompProfile(input: CompRowInput): CompProfile {
  const { compId, setNumber, coreUnits, threeStars, statTotal, rawRows, costOf } = input;

  const { units, copySig } = splitMultiset(coreUnits, costOf);

  // Distinct raw board count when raw rows exist (more accurate; filtered to
  // the ranked queue upstream), otherwise the stats aggregate.
  const totalBoards = rawRows.length > 0
    ? new Set(rawRows.map((r) => r.boardId)).size
    : statTotal;

  const classified = classifyCarries(rawRows, totalBoards);
  const rates = new Map(classified.map((c) => [c.characterId, c]));

  let carries = new Set(bucketCarryIds(classified));
  if (carries.size === 0) {
    // Missed-hit / dead boards rarely complete 3 items on anyone, but their
    // items still sit on the same units the line always items — keep that
    // identity via the top-itemized secondary signal.
    const fallback = classified
      .filter((c) => c.topItemizedRate >= FALLBACK_TOP_RATE)
      .sort(
        (a, b) =>
          b.topItemizedRate - a.topItemizedRate ||
          b.fullyItemizedRate - a.fullyItemizedRate ||
          a.characterId.localeCompare(b.characterId),
      )
      .slice(0, FALLBACK_MAX);
    carries = new Set(fallback.map((c) => c.characterId));
  }

  // Carry-grade 3★: fielded at 3★ AND itemized. `carries` covers the fallback
  // path; the explicit rate check additionally admits a reliably top-itemized
  // 3★ that didn't make the carry set (e.g. third slot behind two full carries).
  const carryGrade3 = new Set(
    threeStars.filter((id) => {
      if (carries.has(id)) return true;
      const r = rates.get(id);
      return r !== undefined && (r.isBucketCarry || r.topItemizedRate >= FALLBACK_TOP_RATE);
    }),
  );

  const threeStarSet = new Set(threeStars);
  const unitWeights = new Map<string, number>();
  for (const id of units) {
    const r = rates.get(id);
    const fully = r?.fullyItemizedRate ?? 0;
    const top = r?.topItemizedRate ?? 0;
    let w: number;
    if (threeStarSet.has(id) || carries.has(id) || top >= FALLBACK_TOP_RATE) {
      w = 1; // identity: a hit or an itemized win condition
    } else if (costOf(id) >= FLEX_MIN_COST && fully < FLEX_MAX_ITEM_RATE && top < FLEX_MAX_ITEM_RATE) {
      w = WEIGHT_FLEX; // un-itemized expensive unit = interchangeable cap slot
    } else {
      w = WEIGHT_CORE;
    }
    unitWeights.set(id, w);
  }

  // Hero augment: only champs that are BOTH 3-star in this comp's exact
  // signature AND eligible (HERO_AUGMENT_CHAMPIONS) can be running one —
  // being 3-star is comp-wide, so that half of the gate is a set intersection
  // here; classifyHeroAugments checks the per-board itemization half.
  const heroAugmentEligible = new Set(
    threeStars.filter((id) => HERO_AUGMENT_CHAMPIONS.has(id)),
  );
  const heroAugments = classifyHeroAugments(rawRows, totalBoards, heroAugmentEligible);
  const heroAugmentSig = heroAugments.find((h) => h.isHeroAugment)?.characterId ?? '';

  return {
    compId,
    setNumber,
    units,
    unitWeights,
    carries,
    carryGrade3,
    copySig,
    heroAugmentSig,
    boardCount: statTotal > 0 ? statTotal : totalBoards,
  };
}

export interface TailRowInput {
  compId: number;
  setNumber: number;
  /** Exact-board unit multiset (comps.core_units). */
  coreUnits: string[];
  /** 3★ character ids (from comps.carries). */
  threeStars: string[];
  /** Σ comp_stats.n across buckets. */
  statTotal: number;
  /** Static unit cost lookup for this comp's set; 0 if unknown (copySig gate). */
  costOf: (characterId: string) => number;
}

/**
 * Light profile for a sub-floor comp, for assign-only labeling (comp-merge's
 * `assignTail`). Built from the comps table alone — no participant_units, no
 * itemization evidence — so: `carries` is empty (assignTail proxies carry
 * evidence by presence of the archetype's carries on the board), `carryGrade3`
 * is the FULL 3★ set (itemization unknown; the conflict-only rule still
 * applies), `heroAugmentSig` is '' (the tail only joins classic archetypes),
 * and unit weights are neutral (its units are its whole evidence).
 */
export function buildTailProfile(input: TailRowInput): CompProfile {
  const { units, copySig } = splitMultiset(input.coreUnits, input.costOf);
  return {
    compId: input.compId,
    setNumber: input.setNumber,
    units,
    unitWeights: new Map(),
    carries: new Set(),
    carryGrade3: new Set(input.threeStars),
    copySig,
    heroAugmentSig: '',
    boardCount: input.statTotal,
  };
}
