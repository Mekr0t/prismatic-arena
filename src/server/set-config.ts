// set-config.ts — the ONE place per-set curated game knowledge lives.
//
// Everything else in the pipeline is set-agnostic (signatures, merge guards,
// trait frames, display) or set-versioned in the DB (units/traits/items via
// load-static-data). What remains is knowledge that cannot be derived from
// static data — which items count as "damage", which champs can take a hero
// augment, which units are augment-gated, which item ids are set-mechanic
// specials — and THAT is what this registry holds, keyed by set number.
//
// SET ROLLOVER: add a new `SET_CONFIGS[n]` block (template below) — the old
// blocks stay forever, so historic sets keep classifying exactly as they did
// (comps, merges, and displays are all set-scoped). A set with no block
// degrades gracefully: no hero-augment detection, no gated units, no damage
// purity (carry agreement falls back to full carry sets) — the pipeline still
// runs, it just knows less. A one-time console warning flags the gap.
//
// Data sourcing: character/item ids are apiNames verified against the DB
// (`units` / `items` tables for the set), never guessed from display names —
// several items are thematic renames per set (set 17: Void Staff plays as
// TFT_Item_StatikkShiv, Kraken's Fury as TFT_Item_RunaansHurricane).

import type { StatIconKey } from '@/lib/stat-icons';

export interface SetConfig {
  setNumber: number;
  /** Champs that can take a hero augment (turns a support/tank into a second
   *  itemized carry). Empty = the set has no such mechanic (##aug no-ops). */
  heroAugmentChampions: readonly string[];
  /** Completed items that count as DAMAGE itemization — drives damage-carry
   *  purity (comp-profile.damageCarries) and hero-augment detection. Item ids
   *  are mostly cross-set `TFT_Item_*` names whose ROLE changes between sets,
   *  so this list is per-set on purpose (never union it across sets). */
  damageItems: readonly string[];
  /** Units that only enter a game through an augment (set 17: Invader Zed).
   *  A board fielding one is a distinct game class (##gate: labels). */
  augmentGatedUnits: readonly string[];
  /** Id patterns for set-mechanic special items (cashout weapons, anomalies).
   *  They stay COUNTED as completed items (they are real power and identify
   *  the boards that use them); the class only steers display preference away
   *  from headlining them as plannable builds. Ids are set-prefixed, so the
   *  runtime predicate unions all sets safely. */
  mechanicItemPatterns: readonly RegExp[];
  /** Id prefixes for THIS set's own items, beyond the cross-set `TFT_Item_`
   *  pool. The `items` table holds CDragon's whole global catalog under the
   *  live set number, so a prefix is what separates "this set's items" from
   *  every other set's — it is not cosmetic. Sets 1-17 all used `TFT{n}_Item_`;
   *  set 18 ships as `DA_18_`, which is why this stopped being derivable and
   *  became config. Empty falls back to `TFT{n}_Item_`. */
  itemIdPrefixes: readonly string[];
  /** Units that contribute MORE THAN ONE to a trait's unit count.
   *
   *  Not derivable from CDragon: the multiplier lives in the trait's prose, not
   *  in any field. Set 18 has two cases, both verified against Riot's own
   *  per-board `participant_traits` counts:
   *    - Elder Dragon counts twice for Riftbeast (35/40 sampled boards showed
   *      Riot's count at exactly naive+1).
   *    - Avatar (Lux) counts twice for her CHOSEN trait — "An Avatar's chosen
   *      Trait is counted twice", per the trait description.
   *  `traits` lists the trait ids that multiply; `'*'` means every trait the
   *  unit has EXCEPT those in `exceptTraits` (how Avatar is expressed, since
   *  each Lux variant carries Avatar plus the one element she chose). */
  traitMultipliers: readonly TraitMultiplier[];
  /** Units whose real identity is a VARIANT that Riot's match payload does not
   *  report. Set 18 reports every Lux as `DA_Lux18_Base` no matter which Avatar
   *  element she chose — 231 boards, zero variant ids — so the displayed board
   *  would always show a generic Lux.
   *
   *  The choice is still recoverable: Avatar doubles the chosen trait, so that
   *  trait is over-counted in Riot's own `participant_traits` relative to what
   *  the board's units explain. Measured over 30 Lux boards, exactly one trait
   *  was over-counted on every single one — no ambiguous boards, no misses.
   *
   *  DISPLAY ONLY. This deliberately does NOT reach comp signatures: which Lux
   *  you hit is mostly luck rather than a planned line, and she clears several
   *  breakpoints alone, so splitting comps on it would fragment the data for a
   *  distinction players do not plan around. */
  inferredVariants: readonly InferredVariant[];
  /**
   * Stat glyphs for trait VALUE rows whose text does not name the stat.
   *
   * Some traits publish a bare number — Defender's row is literally
   * `(@MinUnits@) @DefenderDefenseGain@` — because the game draws the stat icon
   * itself from the trait's type. Read alone, "25" says nothing.
   *
   * One GROUP per slot, where the slots are the gaps CDragon leaves (a run of
   * two or more spaces, which is where the client draws an icon) in order,
   * followed by the end of the row. Grouping is needed because placement really
   * does differ per trait:
   *
   *   Adaptor  "@ADAPGain*100@%  OR"        [['ad'], ['ap']]  -> "25% [AD] OR [AP]"
   *   Fae      "@ADAP@%  and @Heal@% Heal." [['ad','ap']]     -> "5% [AD][AP] and 2% Heal."
   *   Defender "@DefenderDefenseGain@"      [['armor','mr']]  -> "25 [Armor][MR]"  (no gap, so end)
   *
   * CURATED, NOT INFERRED, and the difference matters: inferring the stats from
   * the trait's intro prose was measured and gets Ravager ("gain 10% Omnivamp"
   * → rows about Bonus Damage) wrong. A wrong icon reads as fact.
   */
  traitValueIcons: Readonly<Record<string, readonly (readonly StatIconKey[])[]>>;
}

export interface InferredVariant {
  /** The id Riot reports for every member of the family. */
  base: string;
  /** POSIX pattern (Postgres `~`) matching the family's real ids. Set 18
   *  spells them two ways, `DA_18_Lux_*` and `DA_Lux18_*`. */
  familyPattern: string;
  /** The trait every variant shares, which therefore never identifies one. */
  markerTrait: string;
  /** Over-count that marks the chosen trait. 2 for a doubling mechanic; an
   *  emblem only ever adds 1, so it cannot produce a false positive. */
  minDelta: number;
}

export interface TraitMultiplier {
  /** Matches character_id. A pattern, because variant families (the ten Lux
   *  ids) share a rule but not a prefix — set 18 spells them both
   *  `DA_18_Lux_*` and `DA_Lux18_*`. */
  unit: RegExp;
  traits: readonly string[] | '*';
  exceptTraits?: readonly string[];
  /** How many the unit counts as. 2 = "counts twice". */
  count: number;
}

export const SET_CONFIGS: Record<number, SetConfig> = {
  17: {
    setNumber: 17,
    heroAugmentChampions: [
      'TFT17_Poppy',
      'TFT17_Jax',
      'TFT17_Aatrox',
      'TFT17_Gragas',
      'TFT17_Mordekaiser',
      'TFT17_Nasus',
      'TFT17_Leona',
      'TFT17_IvernMinion', // Meepsie
    ],
    damageItems: [
      'TFT_Item_AdaptiveHelm',
      'TFT_Item_ArchangelsStaff',
      'TFT_Item_Bloodthirster',
      'TFT_Item_BlueBuff',
      'TFT_Item_Deathblade',
      'TFT_Item_GuardianAngel', // Edge of Night
      'TFT_Item_MadredsBloodrazor', // Giant Slayer
      'TFT_Item_GuinsoosRageblade',
      'TFT_Item_UnstableConcoction', // Hand Of Justice
      'TFT_Item_HextechGunblade',
      'TFT_Item_InfinityEdge',
      'TFT_Item_RunaansHurricane', // Kraken's Fury
      'TFT_Item_JeweledGauntlet',
      'TFT_Item_LastWhisper',
      'TFT_Item_Morellonomicon',
      'TFT_Item_Leviathan', // Nashor's Tooth
      'TFT_Item_Quicksilver',
      'TFT_Item_RabadonsDeathcap',
      'TFT_Item_RapidFireCannon', // Red Buff
      'TFT_Item_SpearOfShojin',
      'TFT_Item_SteraksGage',
      'TFT_Item_PowerGauntlet', // Striker's Flail
      'TFT_Item_TitansResolve',
      'TFT_Item_StatikkShiv', // Void Staff
    ],
    augmentGatedUnits: ['TFT17_Zed'], // Invader Zed — augment-only unit
    mechanicItemPatterns: [/AnimaSquadItem_Tier/i, /EkkoOffering_Anomaly/i],
    itemIdPrefixes: ['TFT17_Item_'],
    traitMultipliers: [], // set 17 has no unit that counts more than once
    // Set 17's equivalent (Miss Fortune's Choose Trait) needs no inference —
    // Riot reports the chosen trait directly.
    inferredVariants: [],
    traitValueIcons: {},
  },

  // ── Set 18 ─────────────────────────────────────────────────────────────────
  // Ids verified against the loaded `units` / `items` tables, not display names.
  // heroAugment / damage / gated classification is still unfilled: those need
  // patch-note reading and a meaningful sample, and an empty array no-ops
  // cleanly rather than guessing wrong.
  18: {
    setNumber: 18,
    heroAugmentChampions: [],
    damageItems: [],
    augmentGatedUnits: [],
    mechanicItemPatterns: [],
    // Set 18 breaks the TFT{n}_ convention: its own items ship as DA_18_*
    // (DA_18_EmblemCoven, …). 156 emblem rows were invisible to the library and
    // the planner until this was configurable.
    itemIdPrefixes: ['DA_18_', 'TFT18_Item_'],
    traitMultipliers: [
      { unit: /^DA_18_ElderDragon$/, traits: ['DA_Riftbeast18'], count: 2 },
      // Every Lux variant is Avatar + the one trait she chose; the chosen trait
      // is the one that doubles, so match on '*' minus Avatar itself. Base Lux
      // (DA_Lux18_Base) carries only Avatar and correctly doubles nothing.
      { unit: /^DA_(18_Lux_|Lux18_)/, traits: '*', exceptTraits: ['DA_18_LuxUniqueTrait'], count: 2 },
    ],
    inferredVariants: [
      {
        base: 'DA_Lux18_Base',
        familyPattern: '^DA_(18_Lux_|Lux18_)',
        markerTrait: 'DA_18_LuxUniqueTrait',
        minDelta: 2,
      },
    ],
    traitValueIcons: {
      // Split around the "OR": AD fills the gap, AP lands at the end.
      DA_18_Adaptor: [['ad'], ['ap']],
      // Both together in the gap — the row continues "and 2% Heal." after them.
      DA_18_Fae: [['ad', 'ap']],
      // No gap in the row at all, so the pair goes to the end.
      DA_18_Defender: [['armor', 'mr']],
    },
  },
};

// ── Accessors (memoized Sets; warn once per unknown set) ─────────────────────

const EMPTY_SET: ReadonlySet<string> = new Set();
const warned = new Set<number>();

function config(setNumber: number): SetConfig | undefined {
  const cfg = SET_CONFIGS[setNumber];
  if (!cfg && !warned.has(setNumber)) {
    warned.add(setNumber);
    console.warn(
      `[set-config] no config for set ${setNumber} — hero-augment/gated/damage ` +
        `classification will no-op for its comps (add a SET_CONFIGS block)`,
    );
  }
  return cfg;
}

const setCache = new Map<string, ReadonlySet<string>>();
function memoSet(key: string, build: () => ReadonlySet<string>): ReadonlySet<string> {
  let s = setCache.get(key);
  if (!s) {
    s = build();
    setCache.set(key, s);
  }
  return s;
}

/** Damage-item pool for the set; empty for unconfigured sets. */
export function damageItems(setNumber: number): ReadonlySet<string> {
  const cfg = config(setNumber);
  if (!cfg) return EMPTY_SET;
  return memoSet(`dmg:${setNumber}`, () => new Set(cfg.damageItems));
}

/** Hero-augment-eligible champs for the set; empty for unconfigured sets. */
export function heroAugmentChampions(setNumber: number): ReadonlySet<string> {
  const cfg = config(setNumber);
  if (!cfg) return EMPTY_SET;
  return memoSet(`hero:${setNumber}`, () => new Set(cfg.heroAugmentChampions));
}

/** Augment-gated units for the set, plus any MERGE_GATED_UNITS env extras
 *  (debug override, applies to every set — unit ids are set-prefixed so an
 *  extra can only ever match its own set's data). */
export function augmentGatedUnits(setNumber: number): ReadonlySet<string> {
  const cfg = config(setNumber);
  return memoSet(`gate:${setNumber}`, () => {
    const s = new Set(cfg?.augmentGatedUnits ?? []);
    for (const extra of (process.env.MERGE_GATED_UNITS ?? '').split(',')) {
      const id = extra.trim();
      if (id) s.add(id);
    }
    return s;
  });
}

/** Id prefixes marking an item as belonging to `setNumber`, beyond the
 *  cross-set `TFT_Item_` pool. Falls back to the pre-set-18 convention so an
 *  unconfigured set behaves exactly as it did before this existed. */
export function itemIdPrefixes(setNumber: number): readonly string[] {
  const cfg = config(setNumber);
  const prefixes = cfg?.itemIdPrefixes ?? [];
  return prefixes.length ? prefixes : [`TFT${setNumber}_Item_`];
}

/** True when `itemId` belongs to this set (or the cross-set item pool). */
export function isSetItem(setNumber: number, itemId: string): boolean {
  if (itemId.startsWith('TFT_Item_')) return true;
  return itemIdPrefixes(setNumber).some((p) => itemId.startsWith(p));
}

/** How many `unit` counts as toward `trait`. 1 unless the set says otherwise. */
export function traitContribution(setNumber: number, unitId: string, traitId: string): number {
  const cfg = config(setNumber);
  if (!cfg) return 1;
  for (const m of cfg.traitMultipliers) {
    if (!m.unit.test(unitId)) continue;
    if (m.exceptTraits?.includes(traitId)) continue;
    if (m.traits === '*' || m.traits.includes(traitId)) return m.count;
  }
  return 1;
}

/** Stat glyphs to inject into a trait's value rows; empty when it needs none. */
export function traitValueIcons(
  setNumber: number,
  traitId: string,
): readonly (readonly StatIconKey[])[] {
  return config(setNumber)?.traitValueIcons?.[traitId] ?? [];
}

/** Families whose displayed variant must be inferred; empty for most sets. */
export function inferredVariants(setNumber: number): readonly InferredVariant[] {
  return config(setNumber)?.inferredVariants ?? [];
}

/** Set-mechanic special item? Union across all configured sets — item ids are
 *  set-prefixed, so a set-17 pattern can never match set-18 data. */
export function isMechanicItem(itemId: string): boolean {
  for (const cfg of Object.values(SET_CONFIGS)) {
    for (const re of cfg.mechanicItemPatterns) if (re.test(itemId)) return true;
  }
  return false;
}
