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
