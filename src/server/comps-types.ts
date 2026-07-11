// comps-types.ts — public view-model interfaces for the M5 tier list.
// All types consumed by page/component layers live here so the dependency
// graph stays acyclic: comps-types ← comps-example-team ← comps-service.

import type { CompMetrics } from './queue/comp-stats-math';

export interface CarryPortraitVM {
  characterId: string;
  name: string;
  cost: number; // 1..5 → cost-tier border; 0 if unknown
  iconUrl: string | null;
}

export interface KeyTraitChipVM {
  traitId: string;
  name: string;
  iconUrl: string | null;
  minUnits: number; // representative unit count from clustering
  style: number; // 1..4 chip color, derived from the trait's breakpoints at minUnits
}

// ── Example team (the "how it looks most of the time" board) ─────────────────

export interface ExampleItemVM {
  itemId: string;
  name: string;
  iconUrl: string | null;
}
export interface ExampleUnitVM {
  characterId: string;
  name: string;
  cost: number; // 1..5 → cost border
  iconUrl: string | null;
  star: number; // modal star tier; UI renders a pip only when this is 3
  freq: number; // share of the comp's boards this unit appears on (0..1)
  items: ExampleItemVM[]; // most-played 3-item set, only when itemized >half the games
}

export interface ExampleTraitVM {
  traitId: string;
  name: string;
  iconUrl: string | null;
  numUnits: number; // modal active unit count (the chip's number)
  style: number; // 1..4 chip color
  unique: boolean; // single-breakpoint trait (no bronze/silver/gold/prismatic scaling)
  freq: number; // share of boards where this trait is active (0..1)
}

export interface ExampleTeamVM {
  units: ExampleUnitVM[]; // sorted cost desc, then frequency
  traits: ExampleTraitVM[]; // sorted by modal unit count desc
}

export interface CompIdentityVM {
  compId: number;
  setNumber: number;
  name: string | null; // stored semantic title — null until the #3 identity pass
  archetype: string | null; // 1cost_reroll | 2cost_reroll | 3cost_reroll | fast8 | fast9 | standard
  displayName: string | null; // computed "[trait] [carry1] [carry2]"; stored name wins when set
  signature: string; // raw `a:…|t:…|c:…` — debug tooltip only
  /** Archetype rows: the merge label's dominant itemized carries (cost desc).
   *  Unlabeled singletons / no-carry archetypes: the rep's 3★ set. */
  carries: CarryPortraitVM[];
  keyTraits: KeyTraitChipVM[]; // most-invested first (backfilled from the example team)
  dupUnits: string[]; // duplicate-copy augment units (label ##dup:), resolved names
  heroAugmentUnit: string | null; // hero-augment carry name (label ##aug:)
}

export interface CompRowVM {
  identity: CompIdentityVM;
  /** Grouping key ('m:<label>' or 'c:<comp_id>') — the detail-page URL key. */
  groupKey: string;
  metrics: CompMetrics; // n, avgPlacement, top4Rate, winRate, intervals, score, lowSample
  playRate: number; // n / bucket_total (0 if the bucket total is 0)
  tier: string; // S/A/B/C/D — stored (override-aware) for tier rows; computed for niche
  rankOrder: number | null; // stored rank order (unused in UI; reserved for admin override display)
  isManual: boolean; // whether tier was set by admin override (reserved for admin UI)
  exampleTeam: ExampleTeamVM; // most-common board for this comp (may be empty)
}

export interface TierGroupVM {
  tier: string; // 'S' | 'A' | 'B' | 'C' | 'D'
  comps: CompRowVM[];
}

export interface PatchOption {
  patchId: number;
  patch: string; // e.g. "16.13"
  label: string | null;
  isCurrent: boolean;
}

export interface SelectorOptions {
  patches: PatchOption[];
  regions: string[];
  buckets: string[];
}

export interface TierListSelection {
  patchId: number;
  patch: string;
  region: string;
  rankBucket: string;
}

export interface TierListVM {
  /** Null when there is no clustered/rolled-up data at all yet. */
  selection: TierListSelection | null;
  options: SelectorOptions;
  bucketTotal: number; // boards in the chosen bucket (play-rate denominator)
  groups: TierGroupVM[]; // tier list, S→D, each in rank_order
  ranked: number; // comps on the tier list (sum of groups)
  niche: CompRowVM[] | null; // below-threshold comps, only when requested
  nicheAvailable: number; // count of below-threshold comps (shown even if niche off)
}

export interface TierListQuery {
  patchId?: number;
  region?: string;
  rankBucket?: string;
  niche?: boolean;
}

// ── Comp detail page (archetype drill-down) ───────────────────────────────────

export interface DetailStarLineVM {
  star: number; // 1..3 (capped)
  boards: number;
  avgPlacement: number;
}

export interface DetailUnitVM {
  characterId: string;
  name: string;
  cost: number;
  iconUrl: string | null;
  freq: number; // share of the archetype's boards fielding the unit (0..1)
  modalStar: number; // most common star tier (3 renders a pip)
  boards: number;
  avgPlacement: number;
  /** avgPlacement − archetype average; negative = the unit improves the comp. */
  delta: number;
  top4Rate: number;
  winRate: number;
  perStar: DetailStarLineVM[]; // star tiers with a usable sample, star desc
  items: ExampleItemVM[]; // modal completed set (label carries only)
}

export interface DetailBuildSetVM {
  items: ExampleItemVM[];
  boards: number;
  rate: number; // share of the carry's itemized boards running this set
  avgPlacement: number;
}

export interface DetailBuildVM {
  characterId: string;
  name: string;
  cost: number;
  iconUrl: string | null;
  sets: DetailBuildSetVM[]; // most-played first
}

export interface DetailVariantVM {
  /** Sorted 3★ ids, pipe-joined; '' = the no-hit state. */
  key: string;
  units: CarryPortraitVM[]; // the hit units (empty for the no-hit state)
  n: number;
  share: number; // n / archetype games
  avgPlacement: number;
  top4Rate: number;
  winRate: number;
}

export interface DetailLevelBandVM {
  band: string; // '7-' | '8' | '9+'
  share: number;
  avgPlacement: number;
}

export interface DetailPlacementVM {
  placement: number; // 1..8
  boards: number;
  share: number; // boards / archetype boards
}

/** One trend period: the games added between two consecutive daily snapshots
 *  (the first snapshot counts from patch start). */
export interface DetailTrendPointVM {
  date: string; // snapshot date (YYYY-MM-DD)
  games: number; // boards added in this period
  avgPlacement: number; // average placement of those boards
  top4Rate: number;
  playRate: number; // period boards / period bucket boards
}

export interface DetailBoardVM {
  compId: number;
  n: number;
  avgPlacement: number;
  team: ExampleTeamVM;
}

export interface CompDetailVM {
  selection: TierListSelection;
  groupKey: string;
  identity: CompIdentityVM;
  metrics: CompMetrics; // pooled across members
  playRate: number;
  tier: string;
  memberCount: number; // exact-board comps folded into this archetype (in-bucket)
  core: DetailUnitVM[]; // freq >= core threshold, cost desc
  flex: DetailUnitVM[]; // mid-frequency units, freq desc
  unitsTable: DetailUnitVM[]; // every unit above the sample floor, freq desc
  levelBands: DetailLevelBandVM[];
  placements: DetailPlacementVM[]; // 1st..8th histogram (always 8 entries)
  trend: DetailTrendPointVM[]; // daily-snapshot deltas, oldest first
  variants: DetailVariantVM[]; // hit-state groups, n desc (capped + 'other')
  /** Whether the hit-states tab should be the default panel: true for
   *  hit-shaped lines (rerolls), false when hits are incidental. */
  hitStatesDefault: boolean;
  builds: DetailBuildVM[]; // per label carry, modal item sets
  topBoards: DetailBoardVM[]; // most-played exact boards with example strips
}
