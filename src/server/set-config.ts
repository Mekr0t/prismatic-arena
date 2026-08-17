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
  },

  // ── Set 18 (PBE ~2026-08) — fill from CDragon/patch notes when public. ──────
  // Copy the shape above with TFT18_* ids. Leave arrays empty for mechanics the
  // set doesn't have (empty = that feature no-ops for set-18 data; set 17 keeps
  // its own block untouched). Verify every id against the loaded `units` /
  // `items` tables — display names lie, apiNames don't.
  //
  // 18: {
  //   setNumber: 18,
  //   heroAugmentChampions: [],
  //   damageItems: [],
  //   augmentGatedUnits: [],
  //   mechanicItemPatterns: [],
  // },
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

/** Set-mechanic special item? Union across all configured sets — item ids are
 *  set-prefixed, so a set-17 pattern can never match set-18 data. */
export function isMechanicItem(itemId: string): boolean {
  for (const cfg of Object.values(SET_CONFIGS)) {
    for (const re of cfg.mechanicItemPatterns) if (re.test(itemId)) return true;
  }
  return false;
}
