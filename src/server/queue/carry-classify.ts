// carry-classify.ts — per-comp carry classification.
//
// Identifies "bucket carries": units that are reliably the itemized win
// condition for a comp across its collected boards.  Output feeds the merge
// stage, which folds comps together when they share at least one bucket carry.
//
// Criteria (all tunable via env):
//   CARRY_FULL_RATE  – share of boards where the unit has ≥ FULLY_ITEMIZED
//                      completed items.  Primary gate for isBucketCarry.
//   TOP_ITEM_SLOTS   – how many "top itemized" slots per board (typically 2).
//                      topItemizedRate is a secondary signal for the merge
//                      stage, not used in the isBucketCarry flag itself.
//   FULLY_ITEMIZED   – completed-item count that makes a unit "fully itemized"
//                      on a single board (default 3).
//
// Also classifies "hero augments" — an augment that turns an otherwise-support
// tank into a second itemized carry. The eligible-champion list and the
// damage-item pool are PER-SET curated knowledge (set-config.ts); callers
// resolve them for the comp's set and pass them in, so this module stays pure
// classification with no set awareness. A champ only counts as active on a
// board where it is 3-star AND holds >= HERO_AUGMENT_MIN_DAMAGE_ITEMS of the
// set's damage items. See classifyHeroAugments.

import { COMPONENT_ITEMS } from '@/server/item-filters';

const _num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

const FULLY_ITEMIZED  = _num(process.env.CARRY_FULLY_ITEMIZED, 3);
const CARRY_FULL_RATE = _num(process.env.CARRY_FULL_RATE,      0.5);
const TOP_ITEM_SLOTS  = _num(process.env.CARRY_TOP_ITEM_SLOTS, 2);
// Completed items from the set's damage pool needed on a single board for that
// board to count toward a unit's damageItemRate (damage-flavored itemization —
// an itemized TANK holds 0-1 of these, a damage carry 2-3).
const CARRY_DAMAGE_MIN_ITEMS = _num(process.env.CARRY_DAMAGE_MIN_ITEMS, 2);

// Completed-item count (from DAMAGE_ITEMS) needed on a single board for a hero
// augment to count as "active" for that board.
const HERO_AUGMENT_MIN_DAMAGE_ITEMS = _num(process.env.HERO_AUGMENT_MIN_DAMAGE_ITEMS, 2);
// Share of a comp's boards that must clear the threshold above for the comp to
// be treated as a hero-augment comp for that champ. Reuses CARRY_FULL_RATE's
// default — same "reliably, not just once" bar as a normal bucket carry.
const HERO_AUGMENT_RATE = _num(process.env.HERO_AUGMENT_RATE, CARRY_FULL_RATE);

// Component items — excluded when counting "completed" items — are the shared
// COMPONENT_ITEMS set from item-filters.ts (imported above).

// ── Per-set knowledge lives in set-config.ts ──────────────────────────────────
//
// The hero-augment champion list and the damage-item pool are SET-SPECIFIC
// curated knowledge (item apiNames are cross-set but their roles change per
// set). Callers resolve them from `set-config.ts` for the comp's set and pass
// them in — this module stays pure classification with no set awareness.

// ── Public types ──────────────────────────────────────────────────────────────

/**
 * One unit-item record from a single board.
 * Pass every copy of a unit (duplicate-copy augment) as separate rows with the
 * same boardId; the classifier picks the most-itemized copy automatically.
 */
export interface RawUnitItem {
  boardId: number;      // match_participants.id
  characterId: string;
  items: string[];      // all item IDs equipped (may include components)
}

/** Per-unit carry profile for one comp's board collection. */
export interface BucketCarry {
  characterId: string;

  /** Share of the comp's boards where this unit has >= FULLY_ITEMIZED completed
   *  items (primary carry strength metric, 0..1). */
  fullyItemizedRate: number;

  /** Share of boards where this unit ranks in the top TOP_ITEM_SLOTS by completed
   *  item count with at least one completed item (secondary signal, 0..1).
   *  Feeds the merge stage's fallback-carry path for comps that never fully
   *  itemize (dead / missed-hit boards). */
  topItemizedRate: number;

  /** True when fullyItemizedRate >= CARRY_FULL_RATE — the merge stage uses this
   *  as the binary carry gate. */
  isBucketCarry: boolean;

  /** Share of boards where this unit's best copy holds >= CARRY_DAMAGE_MIN_ITEMS
   *  completed DAMAGE_ITEMS (0..1). Separates damage carries from itemized
   *  tanks/supports — the merge stage's carry agreement compares damage carries
   *  so a Sunfire'd Leona can't split two boards that agree on the real carry. */
  damageItemRate: number;

  /** Most common completed-item set among the boards where the unit is fully
   *  itemized — the "signature build".  Empty when never fully itemized.
   *  Items are in display order (the order they first appeared in the modal set). */
  modalItems: string[];
}

// ── Implementation ────────────────────────────────────────────────────────────

function completed(items: string[]): string[] {
  return items.filter((id) => !COMPONENT_ITEMS.has(id));
}

/**
 * Classify the carries for one comp from its per-board unit-item data.
 *
 * @param rows          Flat list of RawUnitItem records (one per board × unit × copy).
 * @param totalBoards   Total boards in the comp's bucket (denominator for rates).
 *                      Should equal the comp's `n` from comp_stats.
 * @param damageItems   The comp's SET's damage-item pool (set-config.damageItems)
 *                      — drives `damageItemRate`. Pass an empty set to disable
 *                      damage classification (unconfigured sets).
 * @returns  Carry profiles, strongest first (fullyItemizedRate desc, then topItemizedRate).
 *           Only units that appear on at least one board are included.
 */
export function classifyCarries(
  rows: RawUnitItem[],
  totalBoards: number,
  damageItems: ReadonlySet<string>,
): BucketCarry[] {
  if (totalBoards === 0 || rows.length === 0) return [];

  // ── Step 1: per board, per unit — keep only the most-itemized copy ──────────

  // bestPerBoard[boardId][characterId] = completed items of the best copy
  const bestPerBoard = new Map<number, Map<string, string[]>>();

  for (const r of rows) {
    const done = completed(r.items);
    let byUnit = bestPerBoard.get(r.boardId);
    if (!byUnit) {
      byUnit = new Map();
      bestPerBoard.set(r.boardId, byUnit);
    }
    const prev = byUnit.get(r.characterId);
    if (!prev || done.length > prev.length) byUnit.set(r.characterId, done);
  }

  // ── Step 2: per unit, accumulate stats across boards ────────────────────────

  interface UnitAcc {
    fullyItemizedBoards: number;
    topItemizedBoards: number;
    damageBoards: number;
    itemSets: Map<string, { count: number; items: string[] }>;
  }

  const byUnit = new Map<string, UnitAcc>();
  const unitAcc = (id: string): UnitAcc => {
    let a = byUnit.get(id);
    if (!a) {
      a = { fullyItemizedBoards: 0, topItemizedBoards: 0, damageBoards: 0, itemSets: new Map() };
      byUnit.set(id, a);
    }
    return a;
  };

  for (const byU of bestPerBoard.values()) {
    // Rank units on this board by completed item count (descending).
    const ranked = [...byU.entries()].sort((a, b) => b[1].length - a[1].length);

    for (let rank = 0; rank < ranked.length; rank++) {
      const [characterId, done] = ranked[rank];
      const a = unitAcc(characterId);

      if (done.length >= FULLY_ITEMIZED) {
        a.fullyItemizedBoards += 1;
        // Track item sets: key on sorted multiset so order doesn't split a build.
        const key = [...done].sort().join('|');
        const s = a.itemSets.get(key);
        if (s) s.count += 1;
        else a.itemSets.set(key, { count: 1, items: done }); // preserve original order
      }

      // A rank slot only counts with at least one completed item — "top
      // itemized" on an itemless board is meaningless noise, and the merge
      // stage uses this rate as a fallback carry signal.
      if (rank < TOP_ITEM_SLOTS && done.length > 0) a.topItemizedBoards += 1;

      // Damage-flavored itemization (see damageItemRate).
      let damageCount = 0;
      for (const id of done) if (damageItems.has(id)) damageCount += 1;
      if (damageCount >= CARRY_DAMAGE_MIN_ITEMS) a.damageBoards += 1;
    }
  }

  // ── Step 3: build output ─────────────────────────────────────────────────────

  const carries: BucketCarry[] = [];

  for (const [characterId, a] of byUnit) {
    const fullyItemizedRate = a.fullyItemizedBoards / totalBoards;
    const topItemizedRate   = a.topItemizedBoards   / totalBoards;
    const damageItemRate    = a.damageBoards        / totalBoards;
    const isBucketCarry     = fullyItemizedRate >= CARRY_FULL_RATE;

    let modalItems: string[] = [];
    let best = 0;
    for (const s of a.itemSets.values()) if (s.count > best) { best = s.count; modalItems = s.items; }

    carries.push({
      characterId,
      fullyItemizedRate,
      topItemizedRate,
      isBucketCarry,
      damageItemRate,
      modalItems,
    });
  }

  return carries.sort(
    (a, b) =>
      b.fullyItemizedRate - a.fullyItemizedRate ||
      b.topItemizedRate   - a.topItemizedRate   ||
      a.characterId.localeCompare(b.characterId),
  );
}

/**
 * Quick helper: extract just the carry character IDs from a classified result.
 * Useful as a merge key.
 */
export function bucketCarryIds(carries: BucketCarry[]): string[] {
  return carries.filter((c) => c.isBucketCarry).map((c) => c.characterId);
}

/** Per-champ hero-augment activity for one comp's board collection. */
export interface HeroAugmentCarry {
  characterId: string;
  /** Share of the comp's boards where this champ holds >=
   *  HERO_AUGMENT_MIN_DAMAGE_ITEMS completed damage items (0..1). */
  damageItemRate: number;
  /** True when damageItemRate >= HERO_AUGMENT_RATE. */
  isHeroAugment: boolean;
}

/**
 * Classify hero-augment activity for one comp, restricted to the champs the
 * caller has already confirmed are 3-star in this comp's signature — being
 * 3-star is comp-wide (part of cluster identity), so that check belongs at
 * the call site, not here. This only measures the per-board, itemization-
 * dependent half of the condition.
 *
 * @param rows        Same raw rows classifyCarries takes.
 * @param totalBoards Total boards in the comp (denominator for rates).
 * @param eligibleIds Champs to check — typically the set's hero-augment champs
 *                    (set-config.heroAugmentChampions) ∩ this comp's 3-stars.
 * @param damageItems The comp's SET's damage-item pool (set-config.damageItems).
 * @returns One entry per eligibleId, strongest damageItemRate first.
 */
export function classifyHeroAugments(
  rows: RawUnitItem[],
  totalBoards: number,
  eligibleIds: ReadonlySet<string>,
  damageItems: ReadonlySet<string>,
): HeroAugmentCarry[] {
  if (totalBoards === 0 || rows.length === 0 || eligibleIds.size === 0) return [];

  // Best (most-itemized) copy per board, per eligible champ only.
  const bestPerBoard = new Map<number, Map<string, string[]>>();
  for (const r of rows) {
    if (!eligibleIds.has(r.characterId)) continue;
    const done = completed(r.items);
    let byUnit = bestPerBoard.get(r.boardId);
    if (!byUnit) { byUnit = new Map(); bestPerBoard.set(r.boardId, byUnit); }
    const prev = byUnit.get(r.characterId);
    if (!prev || done.length > prev.length) byUnit.set(r.characterId, done);
  }

  const activeBoards = new Map<string, number>();
  for (const byUnit of bestPerBoard.values()) {
    for (const [characterId, done] of byUnit) {
      const damageCount = done.filter((id) => damageItems.has(id)).length;
      if (damageCount >= HERO_AUGMENT_MIN_DAMAGE_ITEMS) {
        activeBoards.set(characterId, (activeBoards.get(characterId) ?? 0) + 1);
      }
    }
  }

  const out: HeroAugmentCarry[] = [];
  for (const characterId of eligibleIds) {
    const damageItemRate = (activeBoards.get(characterId) ?? 0) / totalBoards;
    out.push({ characterId, damageItemRate, isHeroAugment: damageItemRate >= HERO_AUGMENT_RATE });
  }

  return out.sort(
    (a, b) => b.damageItemRate - a.damageItemRate || a.characterId.localeCompare(b.characterId),
  );
}
