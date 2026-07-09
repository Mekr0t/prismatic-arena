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
// tank into a second itemized carry. Set-scoped (TFT17): only the champions in
// HERO_AUGMENT_CHAMPIONS can take one, and only counts as active on a board
// where the champ is 3-star AND holds >= HERO_AUGMENT_MIN_DAMAGE_ITEMS of the
// DAMAGE_ITEMS set. See classifyHeroAugments.

const _num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

const FULLY_ITEMIZED  = _num(process.env.CARRY_FULLY_ITEMIZED, 3);
const CARRY_FULL_RATE = _num(process.env.CARRY_FULL_RATE,      0.5);
const TOP_ITEM_SLOTS  = _num(process.env.CARRY_TOP_ITEM_SLOTS, 2);

// Completed-item count (from DAMAGE_ITEMS) needed on a single board for a hero
// augment to count as "active" for that board.
const HERO_AUGMENT_MIN_DAMAGE_ITEMS = _num(process.env.HERO_AUGMENT_MIN_DAMAGE_ITEMS, 2);
// Share of a comp's boards that must clear the threshold above for the comp to
// be treated as a hero-augment comp for that champ. Reuses CARRY_FULL_RATE's
// default — same "reliably, not just once" bar as a normal bucket carry.
const HERO_AUGMENT_RATE = _num(process.env.HERO_AUGMENT_RATE, CARRY_FULL_RATE);

// ── Component items — excluded when counting "completed" items ────────────────

const COMPONENT_ITEMS = new Set<string>([
  'TFT_Item_BFSword',
  'TFT_Item_RecurveBow',
  'TFT_Item_NeedlesslyLargeRod',
  'TFT_Item_TearOfTheGoddess',
  'TFT_Item_ChainVest',
  'TFT_Item_NegatronCloak',
  'TFT_Item_GiantsBelt',
  'TFT_Item_SparringGloves',
  'TFT_Item_Spatula',
  'TFT_Item_FryingPan',
  'TFT_Item_EmptyBag',
]);

// ── Hero augments (set 17) ─────────────────────────────────────────────────────
//
// Champions that can take a hero augment (turns a support/tank into a second
// itemized carry). Character IDs verified against the current set's `units`
// table, not guessed from display names — several damage items below are
// thematic set-17 renames of the base LoL item (e.g. Void Staff → Statikk
// Shiv, Kraken's Fury → Runaan's Hurricane), so their apiNames don't match the
// display name pattern.

export const HERO_AUGMENT_CHAMPIONS = new Set<string>([
  'TFT17_Poppy',
  'TFT17_Jax',
  'TFT17_Aatrox',
  'TFT17_Gragas',
  'TFT17_Mordekaiser',
  'TFT17_Nasus',
  'TFT17_Leona',
  'TFT17_IvernMinion', // Meepsie
]);

// "Damage items" — completed items that count toward a hero-augment carry's
// itemization threshold. IDs are this set's apiNames, resolved from the DB
// (`items` table), not derived from display names.
export const DAMAGE_ITEMS = new Set<string>([
  'TFT_Item_AdaptiveHelm',
  'TFT_Item_ArchangelsStaff',
  'TFT_Item_Bloodthirster',
  'TFT_Item_BlueBuff',
  'TFT_Item_Deathblade',
  'TFT_Item_GuardianAngel',      // Edge of Night
  'TFT_Item_MadredsBloodrazor',  // Giant Slayer
  'TFT_Item_GuinsoosRageblade',
  'TFT_Item_UnstableConcoction', // Hand Of Justice
  'TFT_Item_HextechGunblade',
  'TFT_Item_InfinityEdge',
  'TFT_Item_RunaansHurricane',   // Kraken's Fury
  'TFT_Item_JeweledGauntlet',
  'TFT_Item_LastWhisper',
  'TFT_Item_Morellonomicon',
  'TFT_Item_Leviathan',          // Nashor's Tooth
  'TFT_Item_Quicksilver',
  'TFT_Item_RabadonsDeathcap',
  'TFT_Item_RapidFireCannon',    // Red Buff
  'TFT_Item_SpearOfShojin',
  'TFT_Item_SteraksGage',
  'TFT_Item_PowerGauntlet',      // Striker's Flail
  'TFT_Item_TitansResolve',
  'TFT_Item_StatikkShiv',        // Void Staff
]);

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
   *  item count (secondary signal, 0..1). */
  topItemizedRate: number;

  /** True when fullyItemizedRate >= CARRY_FULL_RATE — the merge stage uses this
   *  as the binary carry gate. */
  isBucketCarry: boolean;

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
 * @returns  Carry profiles, strongest first (fullyItemizedRate desc, then topItemizedRate).
 *           Only units that appear on at least one board are included.
 */
export function classifyCarries(rows: RawUnitItem[], totalBoards: number): BucketCarry[] {
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
    itemSets: Map<string, { count: number; items: string[] }>;
  }

  const byUnit = new Map<string, UnitAcc>();
  const unitAcc = (id: string): UnitAcc => {
    let a = byUnit.get(id);
    if (!a) {
      a = { fullyItemizedBoards: 0, topItemizedBoards: 0, itemSets: new Map() };
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

      if (rank < TOP_ITEM_SLOTS) a.topItemizedBoards += 1;
    }
  }

  // ── Step 3: build output ─────────────────────────────────────────────────────

  const carries: BucketCarry[] = [];

  for (const [characterId, a] of byUnit) {
    const fullyItemizedRate = a.fullyItemizedBoards / totalBoards;
    const topItemizedRate   = a.topItemizedBoards   / totalBoards;
    const isBucketCarry     = fullyItemizedRate >= CARRY_FULL_RATE;

    let modalItems: string[] = [];
    let best = 0;
    for (const s of a.itemSets.values()) if (s.count > best) { best = s.count; modalItems = s.items; }

    carries.push({ characterId, fullyItemizedRate, topItemizedRate, isBucketCarry, modalItems });
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
 * @param eligibleIds Champs to check — typically HERO_AUGMENT_CHAMPIONS ∩
 *                    (this comp's 3-star units).
 * @returns One entry per eligibleId, strongest damageItemRate first.
 */
export function classifyHeroAugments(
  rows: RawUnitItem[],
  totalBoards: number,
  eligibleIds: ReadonlySet<string>,
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
      const damageCount = done.filter((id) => DAMAGE_ITEMS.has(id)).length;
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
