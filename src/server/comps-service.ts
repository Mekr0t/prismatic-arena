// comps-service.ts — read-side entry point for the M5 tier list.
//
// Reads comp_stats + bucket_totals (tier_list_entries only supplies manual
// pins now), resolves each comp's display identity from the comps JSONB via
// the static catalog, and recomputes metrics on read through the SAME
// comp-stats-math the writer used — so a method change there reflects here
// with no re-rollup.
//
// ARCHETYPE COLLAPSE (read-time grouping). Comps are grouped on comps.meta_comp
// (the carry-archetype label written by the merge stage; a comp with no label
// keys on its own id, so it stands alone rather than collapsing into a null
// bucket). Their SUFFICIENT STATISTICS are additive, so we pool them and
// recompute metrics ONCE on the combined sample: intervals tighten with the
// larger n, and the tier is earned on pooled evidence.
//
// THE FLOOR IS POOLED. An archetype qualifies when its POOLED sample reaches
// TIER_MIN_SAMPLE — not when individual members do. Missed-hit boards fragment
// across many exact signatures (partial boards vary more), so a per-member
// floor systematically dropped exactly the unlucky boards, survivorship-tilting
// every line's stats; merge's assign-only tail pass labels them, and this read
// path counts them. tier_list_entries no longer drives row selection — it
// remains the per-comp writer view, and an is_manual row on any member still
// pins the archetype's tier (manual overrides win).
//
// One round of DB reads per page:
//   1) a combos+patches probe that drives the three selectors;
//   2) the bucket total (play-rate denominator) + pooled group keys;
//   3) member rows for the qualifying groups (and the niche groups when the
//      toggle is on).

import { unstable_cache } from 'next/cache';
import { query } from '@/lib/db';
import { GKEY_SQL } from './comp-gkey';
import { getCatalog } from './static-data';
import {
  computeMetrics,
  scoreToTier,
  tierCutoffs,
  tierForScore,
  type SufficientStats,
  type TierCutoffs,
} from './queue/comp-stats-math';
import {
  loadExampleTeams,
  styleAtUnits,
  EMPTY_TEAM,
  EX_POOL_MEMBER_CAP,
  type ExampleGroup,
} from './comps-example-team';
import { emblemsFromSignature } from './queue/comp-signature';
import type {
  CarryPortraitVM,
  KeyTraitChipVM,
  ExampleItemVM,
  ExampleUnitVM,
  ExampleTraitVM,
  ExampleTeamVM,
  CompIdentityVM,
  CompRowVM,
  TierGroupVM,
  PatchOption,
  SelectorOptions,
  TierListSelection,
  TierListVM,
  TierListQuery,
} from './comps-types';

// Re-export all public types so existing component imports stay unchanged.
export type {
  CarryPortraitVM,
  KeyTraitChipVM,
  ExampleItemVM,
  ExampleUnitVM,
  ExampleTraitVM,
  ExampleTeamVM,
  CompIdentityVM,
  CompRowVM,
  TierGroupVM,
  PatchOption,
  SelectorOptions,
  TierListSelection,
  TierListVM,
  TierListQuery,
};

// ── Tunables ─────────────────────────────────────────────────────────────────

const TIER_ORDER = ['S', 'A', 'B', 'C', 'D'] as const;
// Canonical rank-bucket ordering for the selector (best first); anything not
// listed sorts after these, alphabetically.
//
// These are `RankBucket` VALUES, not Riot tier names — the list used to hold
// 'grandmaster'/'master'/'emerald'/etc., none of which are bucket labels, so
// every real bucket except 'challenger' fell through to the alphabetical tail.
// 'apex_mixed' is the pre-R1 unverified population (migration 0018); it sorts
// just below the verified apex buckets, and 'unknown' sorts last.
const BUCKET_ORDER = [
  'challenger',
  'master_plus',
  'apex_mixed',
  'diamond',
  'plat_emerald',
  'iron_gold',
  'all',
  'unknown',
];
const NICHE_LIMIT = 100; // cap the niche list so a thin meta's long tail stays bounded
// A 3★ above this cost is variance, not a win condition, so it never earns a
// board the archetype's representative slot (reroll targets are cost 1–3).
export const REROLL_MAX_COST = 3;

const numEnv = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

/** Hit-shaped line floor: the share of an archetype's games that hit a 3★ on a
 *  label carry before "the hit board" is treated as the line's identity. Shared
 *  with the detail page's default-tab choice (same env knob) so "hit-shaped"
 *  means one thing everywhere. */
export const HITS_DEFAULT_MIN_SHARE = numEnv(process.env.DETAIL_HITS_DEFAULT_MIN_SHARE, 0.35);

// The tier floor, applied to the POOLED archetype sample (Σ n across members in
// the selected bucket) — same env knob the trend-tier writer uses per comp.
const TIER_MIN_SAMPLE = numEnv(process.env.TIER_MIN_SAMPLE, 15);

// Emblem variant families: an emblem variant is kept as a distinct variant only
// when it's *meaningfully better* than the plain line — its avg placement beats
// base by at least MIN_SWING and it has at least MIN_N boards. Otherwise it
// folds into base: a worse/equal emblem is just the line played with a random
// emblem you had to take, and belongs in the base's honest distribution.
// Keep an emblem variant only when its avg-placement edge over base is BOTH:
//  • practically meaningful — swing ≥ EMBLEM_SPLIT_MIN_SWING, and
//  • statistically real — swing ≥ EMBLEM_SPLIT_SIG_K × combined SEM (this is the
//    ADAPTIVE part: a small but well-sampled edge counts, a big but thin/noisy
//    one doesn't — no fixed sample cutoff needed), and
//  • not a lucky micro-sample that could headline — n ≥ minVariantN, itself
//    adaptive: max(FLOOR, FRACTION × family boards) so popular lines need
//    proportionally more (kills double-emblem noise).
const EMBLEM_SPLIT_MIN_SWING = numEnv(process.env.EMBLEM_SPLIT_MIN_SWING, 0.15);
const EMBLEM_SPLIT_SIG_K = numEnv(process.env.EMBLEM_SPLIT_SIG_K, 1.5);
const EMBLEM_SPLIT_MIN_N_FLOOR = numEnv(process.env.EMBLEM_SPLIT_MIN_N_FLOOR, 50);
const EMBLEM_SPLIT_MIN_N_FRAC = numEnv(process.env.EMBLEM_SPLIT_MIN_N_FRAC, 0.05);

// ── Row shapes off the wire ───────────────────────────────────────────────────
// pg returns: bigint → string, numeric → string, int/bool → number/boolean,
// jsonb → already-parsed JS. Parse bigints with Number(); guard jsonb arrays.

interface ComboRow {
  patch_id: number;
  region: string;
  rank_bucket: string;
  boards: number; // SUM(n)::int
}
interface PatchRow {
  id: number;
  patch: string;
  label: string | null;
  is_current: boolean;
}
interface JsonCarry {
  character_id: string;
}
interface JsonKeyTrait {
  trait_id: string;
  min_units: number;
}
/** Member-row shape off the wire — shared with comp-detail-service. */
export interface CompStatRow {
  comp_id: number;
  set_number: number;
  name: string | null;
  archetype: string | null;
  signature: string;
  key_traits: unknown; // jsonb [{trait_id,min_units}]
  carries: unknown; // jsonb [{character_id}]
  gkey: string; // grouping key: 'm:<meta_comp>' or 'c:<comp_id>' (computed in SQL)
  n: number;
  placement_sum: string; // bigint
  placement_sumsq: string; // bigint
  top4_count: number;
  win_count: number;
  // from the LEFT JOIN on tier_list_entries (manual pins):
  tier?: string | null;
  rank_order?: number | null;
  is_manual?: boolean | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function asCarries(v: unknown): JsonCarry[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (c): c is JsonCarry => !!c && typeof (c as JsonCarry).character_id === 'string',
  );
}
function asKeyTraits(v: unknown): JsonKeyTrait[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (t): t is JsonKeyTrait => !!t && typeof (t as JsonKeyTrait).trait_id === 'string',
  );
}

function bucketRank(b: string): number {
  const i = BUCKET_ORDER.indexOf(b);
  return i === -1 ? BUCKET_ORDER.length : i;
}

// Grouping key: 'm:<meta_comp>' (the archetype/family), 'c:<comp_id>' for
// unlabeled singletons. Defined in ./comp-gkey so the trend-tier stage can share
// it without importing this module (which pulls in next/cache); re-exported here
// because every existing call site imports it from comps-service.
export { GKEY_SQL };

/** Per-archetype (gkey) pooled n + score for a bucket — the population dynamic
 *  tier cutoffs are derived from. Shared by the tier list and the detail page so
 *  both tier against the same distribution. */
export async function loadArchetypeScores(
  patchId: number,
  region: string,
  rankBucket: string,
): Promise<{ gkey: string; pooledN: number; score: number }[]> {
  const rows = await query<{
    gkey: string;
    n: number;
    placement_sum: string;
    placement_sumsq: string;
    top4: number;
    win: number;
  }>(
    `SELECT ${GKEY_SQL} AS gkey,
            SUM(cs.n)::int AS n,
            SUM(cs.placement_sum)::bigint AS placement_sum,
            SUM(cs.placement_sumsq)::bigint AS placement_sumsq,
            SUM(cs.top4_count)::int AS top4,
            SUM(cs.win_count)::int AS win
       FROM comp_stats cs
       JOIN comps c ON c.id = cs.comp_id
      WHERE cs.patch_id = $1 AND cs.region = $2 AND cs.rank_bucket = $3
      GROUP BY 1`,
    [patchId, region, rankBucket],
  );
  return rows.map((r) => ({
    gkey: r.gkey,
    pooledN: r.n,
    score: computeMetrics({
      n: r.n,
      placementSum: Number(r.placement_sum),
      placementSumsq: Number(r.placement_sumsq),
      top4Count: r.top4,
      winCount: r.win,
    }).score,
  }));
}

/** Cutoffs for a bucket from the tierable-archetype score distribution. */
export async function bucketTierCutoffs(
  patchId: number,
  region: string,
  rankBucket: string,
): Promise<TierCutoffs | null> {
  const scores = await loadArchetypeScores(patchId, region, rankBucket);
  return tierCutoffs(scores.filter((s) => s.pooledN >= TIER_MIN_SAMPLE).map((s) => s.score));
}

// ── Selector/default resolution ───────────────────────────────────────────────

export async function loadCombos(): Promise<{ combos: ComboRow[]; patches: Map<number, PatchRow> }> {
  const [combos, patchRows] = await Promise.all([
    query<ComboRow>(
      `SELECT patch_id, region, rank_bucket, SUM(n)::int AS boards
         FROM comp_stats
        GROUP BY patch_id, region, rank_bucket`,
    ),
    query<PatchRow>(
      `SELECT id, patch, label, is_current FROM patches`,
    ),
  ]);
  const patches = new Map<number, PatchRow>();
  for (const p of patchRows) patches.set(p.id, p);
  return { combos, patches };
}

export function resolveSelection(
  combos: ComboRow[],
  patches: Map<number, PatchRow>,
  q: TierListQuery,
): { selection: TierListSelection | null; options: SelectorOptions } {
  if (combos.length === 0) {
    return { selection: null, options: { patches: [], regions: [], buckets: [] } };
  }

  // Boards per patch, to order the patch selector (current first, then volume).
  const boardsByPatch = new Map<number, number>();
  for (const c of combos)
    boardsByPatch.set(c.patch_id, (boardsByPatch.get(c.patch_id) ?? 0) + c.boards);

  const patchIds = [...boardsByPatch.keys()].sort((a, b) => {
    const pa = patches.get(a);
    const pb = patches.get(b);
    const ca = pa?.is_current ? 1 : 0;
    const cb = pb?.is_current ? 1 : 0;
    if (ca !== cb) return cb - ca;
    return (boardsByPatch.get(b) ?? 0) - (boardsByPatch.get(a) ?? 0);
  });

  const patchOptions: PatchOption[] = patchIds.map((id) => {
    const p = patches.get(id);
    return {
      patchId: id,
      patch: p?.patch ?? String(id),
      label: p?.label ?? null,
      isCurrent: p?.is_current ?? false,
    };
  });

  const chosenPatch =
    q.patchId !== undefined && patchIds.includes(q.patchId) ? q.patchId : patchIds[0];

  // Regions available within the chosen patch (volume-ordered).
  const regionBoards = new Map<string, number>();
  for (const c of combos)
    if (c.patch_id === chosenPatch)
      regionBoards.set(c.region, (regionBoards.get(c.region) ?? 0) + c.boards);
  const regions = [...regionBoards.keys()].sort(
    (a, b) => (regionBoards.get(b) ?? 0) - (regionBoards.get(a) ?? 0) || a.localeCompare(b),
  );
  const chosenRegion = q.region && regions.includes(q.region) ? q.region : regions[0];

  // Buckets available within chosen patch+region (canonical rank order).
  const buckets = [
    ...new Set(
      combos
        .filter((c) => c.patch_id === chosenPatch && c.region === chosenRegion)
        .map((c) => c.rank_bucket),
    ),
  ].sort((a, b) => bucketRank(a) - bucketRank(b) || a.localeCompare(b));
  const chosenBucket =
    q.rankBucket && buckets.includes(q.rankBucket) ? q.rankBucket : buckets[0];

  const meta = patches.get(chosenPatch);
  return {
    selection: {
      patchId: chosenPatch,
      patch: meta?.patch ?? String(chosenPatch),
      region: chosenRegion,
      rankBucket: chosenBucket,
    },
    options: { patches: patchOptions, regions, buckets },
  };
}

// ── Identity + row mapping ────────────────────────────────────────────────────

type CatalogT = Awaited<ReturnType<typeof getCatalog>>;

interface ParsedLabel {
  carryIds: string[];
  dupIds: string[];
  heroAugmentId: string | null;
  emblemIds: string[];
  /** Augment-gated units (##gate: — e.g. Invader Zed boards). */
  gatedIds: string[];
}

/** Parse a group key back into its archetype-label parts. Returns null for
 *  unlabeled singleton groups ('c:<id>'). Unknown `##` segments (e.g. the
 *  `##k:` collision disambiguator) are display-irrelevant and skipped. */
function parseLabelKey(gkey: string): ParsedLabel | null {
  if (!gkey.startsWith('m:')) return null;
  const [carryPart, ...tags] = gkey.slice(2).split('##');
  let dupIds: string[] = [];
  let heroAugmentId: string | null = null;
  let emblemIds: string[] = [];
  let gatedIds: string[] = [];
  for (const tag of tags) {
    if (tag.startsWith('dup:')) dupIds = tag.slice(4).split('|').filter(Boolean);
    else if (tag.startsWith('aug:')) heroAugmentId = tag.slice(4) || null;
    else if (tag.startsWith('emb:')) emblemIds = tag.slice(4).split('|').filter(Boolean);
    else if (tag.startsWith('gate:')) gatedIds = tag.slice(5).split('|').filter(Boolean);
  }
  return {
    carryIds: carryPart === 'no_carry' ? [] : carryPart.split('|').filter(Boolean),
    dupIds,
    heroAugmentId,
    emblemIds,
    gatedIds,
  };
}

/** "[key trait] [carry1] [carry2]" (trait-first); the stored comps.name wins
 *  when the #3 pass eventually writes a smarter title. */
function computeDisplayName(identity: CompIdentityVM): string | null {
  const topTrait = identity.keyTraits[0]?.name;
  const computed = [topTrait, ...identity.carries.map((c) => c.name)].filter(Boolean).join(' ');
  return identity.name ?? (computed.length > 0 ? computed : null);
}

function buildIdentity(row: CompStatRow, cat: CatalogT, label: ParsedLabel | null): CompIdentityVM {
  // Archetype rows: carries = the merge label's dominant ITEMIZED carries (what
  // the line actually builds around), cost-desc for display. Unlabeled
  // singletons and no-carry archetypes fall back to the rep's 3★ set.
  const carryIds =
    label && label.carryIds.length > 0
      ? label.carryIds
      : asCarries(row.carries).map((c) => c.character_id);
  const carries = carryIds.map((id) => {
    const u = cat.unit(id);
    return { characterId: u.characterId, name: u.name, cost: u.cost, iconUrl: u.iconUrl };
  });
  if (label && label.carryIds.length > 0) {
    carries.sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name));
  }

  const keyTraits = asKeyTraits(row.key_traits).map((t) => {
    const meta = cat.trait(t.trait_id);
    return {
      traitId: meta.traitId,
      name: meta.name,
      iconUrl: meta.iconUrl,
      minUnits: t.min_units,
      style: styleAtUnits(meta.breakpoints, t.min_units),
    };
  });

  const identity: CompIdentityVM = {
    compId: row.comp_id,
    setNumber: row.set_number,
    name: row.name,
    archetype: row.archetype,
    displayName: null,
    signature: row.signature,
    carries,
    keyTraits,
    dupUnits: (label?.dupIds ?? []).map((id) => cat.unit(id).name),
    heroAugmentUnit: label?.heroAugmentId ? cat.unit(label.heroAugmentId).name : null,
    gatedUnits: (label?.gatedIds ?? []).map((id) => cat.unit(id).name),
    emblems: (label?.emblemIds ?? []).map((id) => {
      const it = cat.item(id);
      return { name: it.name, iconUrl: it.iconUrl };
    }),
  };
  identity.displayName = computeDisplayName(identity);
  return identity;
}

// ── Archetype collapse ─────────────────────────────────────────────────────────

/** Group member rows by their SQL-computed grouping key ('m:<label>' or
 *  'c:<comp_id>' for unlabeled singletons). */
function groupByKey(rows: CompStatRow[]): Map<string, CompStatRow[]> {
  const byKey = new Map<string, CompStatRow[]>();
  for (const r of rows) {
    const arr = byKey.get(r.gkey);
    if (arr) arr.push(r);
    else byKey.set(r.gkey, [r]);
  }
  return byKey;
}

/** Sum the sufficient statistics across an archetype's member comps. All five
 *  are additive, so pooling is element-wise addition; metrics + intervals are
 *  then derived once on the combined sample. */
function poolStats(members: CompStatRow[]): SufficientStats {
  let n = 0;
  let placementSum = 0;
  let placementSumsq = 0;
  let top4Count = 0;
  let winCount = 0;
  for (const m of members) {
    n += m.n ?? 0;
    placementSum += Number(m.placement_sum ?? 0);
    placementSumsq += Number(m.placement_sumsq ?? 0);
    top4Count += m.top4_count ?? 0;
    winCount += m.win_count ?? 0;
  }
  return { n, placementSum, placementSumsq, top4Count, winCount };
}

/** Build one archetype row: pooled metrics + tier from the combined sample.
 *  Returns the representative's OWN n separately — that's the correct
 *  denominator for its example board, which is aggregated from the
 *  representative comp alone. Shared with comp-detail-service (the detail
 *  header is exactly this row). */
export function buildArchetypeRow(
  members: CompStatRow[],
  cat: CatalogT,
  bucketTotal: number,
): { row: CompRowVM; repCompId: number; repN: number; pooled: SufficientStats } {
  const pooled = poolStats(members);

  // Representative = the most complete hit-state with a usable sample, where
  // "hit" means a 3★ on a REROLL-COST label carry — a unit the line actually
  // rolls for. Only cost ≤ REROLL_MAX_COST carries count: a 3★ 4/5-cost is a
  // once-in-a-thousand fluke, never the intended win condition, so it must not
  // earn a board the archetype's face (that's how "Dark Star Jhin Karma" ended
  // up showing a 3★ Karma). A lottery 3★ on a fast-8/9 line is likewise luck,
  // not identity; with no reroll-carry hits anywhere this degrades to the
  // most-played board. Members below max(5, 5% of pooled n) are only eligible
  // when nothing bigger exists (all-tail archetypes).
  const labelCarries = new Set(
    (parseLabelKey(members[0].gkey)?.carryIds ?? []).filter((id) => {
      const cost = cat.unit(id).cost;
      return cost >= 1 && cost <= REROLL_MAX_COST;
    }),
  );
  const carryStars = (m: CompStatRow): number =>
    asCarries(m.carries).filter((c) => labelCarries.has(c.character_id)).length;
  // The hit board is the line's face ONLY when hitting is what the line does:
  // 3★s count toward rep selection just for hit-shaped lines (≥ HITS share of
  // pooled games hit a label carry). A 3%-hit line shows its most-played board
  // — a lottery outcome must not be the example the row renders.
  let hitN = 0;
  for (const m of members) if (carryStars(m) > 0) hitN += m.n ?? 0;
  const useStars = pooled.n > 0 && hitN / pooled.n >= HITS_DEFAULT_MIN_SHARE;
  const minRepN = Math.max(5, Math.ceil(pooled.n * 0.05));
  const eligible = members.filter((m) => (m.n ?? 0) >= minRepN);
  const pool = eligible.length > 0 ? eligible : members;
  let rep = pool[0];
  let repStars = useStars ? carryStars(rep) : 0;
  for (const m of pool) {
    const stars = useStars ? carryStars(m) : 0;
    const mn = m.n ?? 0;
    const rn = rep.n ?? 0;
    if (
      stars > repStars ||
      (stars === repStars && (mn > rn || (mn === rn && m.comp_id < rep.comp_id)))
    ) {
      rep = m;
      repStars = stars;
    }
  }

  // Manual pin: an is_manual tier_list_entries row on any member pins the
  // archetype's tier (highest-n pinned member wins) — the "manual overrides
  // win" invariant applied at archetype grain.
  let pinned: CompStatRow | null = null;
  for (const m of members) {
    if (m.is_manual && m.tier && (!pinned || (m.n ?? 0) > (pinned.n ?? 0))) pinned = m;
  }

  const metrics = computeMetrics(pooled);
  const row: CompRowVM = {
    identity: buildIdentity(rep, cat, parseLabelKey(rep.gkey)),
    groupKey: rep.gkey,
    metrics,
    playRate: bucketTotal > 0 ? metrics.n / bucketTotal : 0,
    tier: pinned?.tier ?? scoreToTier(metrics.score),
    rankOrder: null,
    isManual: pinned !== null,
    exampleTeam: EMPTY_TEAM, // filled by loadExampleTeams (representatives only)
    variantCount: 1,
  };
  return { row, repCompId: rep.comp_id, repN: rep.n ?? 0, pooled };
}

// ── Emblem variant families ─────────────────────────────────────────────────

/** One resolved variant of a family: its (possibly folded) members, built row,
 *  and emblem set. Base is emblemKey '' and carries any folded-in members. */
export interface FamilyVariant {
  emblemKey: string; // sorted emblem ids pipe-joined; '' = plain no-emblem build
  emblemIds: string[];
  isEmblem: boolean;
  members: CompStatRow[];
  row: CompRowVM;
  repCompId: number;
  repN: number;
}

export interface ResolvedFamily {
  variants: FamilyVariant[]; // base first, then kept emblem variants (best-score order after)
  representativeKey: string; // emblemKey of the row shown on the tier list
  familyN: number; // total boards across the whole family (all variants)
}

/**
 * Resolve one archetype (family) into its display variants. Split members by
 * worn emblem set; a worse/equal emblem variant folds its members into base
 * (a random emblem you had to play IS part of the line's honest distribution);
 * an emblem variant that's *meaningfully better* (avg place beats base by
 * EMBLEM_SPLIT_MIN_SWING with ≥ EMBLEM_SPLIT_MIN_N boards) stays distinct. The
 * best-scoring surviving variant is the representative (usually the emblem one),
 * so the plain line tucks behind it. Shared by the tier list and detail page.
 */
export function resolveFamily(
  members: CompStatRow[],
  cat: CatalogT,
  bucketTotal: number,
): ResolvedFamily {
  const familyN = members.reduce((s, m) => s + (m.n ?? 0), 0);

  const emblemsOf = (row: CompRowVM['identity']['emblems'], ids: string[]): void => {
    row.length = 0;
    for (const id of ids) {
      const it = cat.item(id);
      row.push({ name: it.name, iconUrl: it.iconUrl });
    }
  };

  // Split by emblem set.
  const byEmblem = new Map<string, CompStatRow[]>();
  for (const m of members) {
    const key = emblemsFromSignature(m.signature).join('|');
    const arr = byEmblem.get(key);
    if (arr) arr.push(m);
    else byEmblem.set(key, [m]);
  }

  const raw = [...byEmblem].map(([emblemKey, sub]) => {
    const built = buildArchetypeRow(sub, cat, bucketTotal);
    return { emblemKey, sub, built };
  });

  // Base = the no-emblem variant, else the most-played.
  let base = raw.find((v) => v.emblemKey === '');
  if (!base) base = raw.reduce((a, b) => (b.built.row.metrics.n > a.built.row.metrics.n ? b : a));

  // Keep meaningfully-better emblem variants; fold the rest into base. The
  // keep-floor scales with the line's total play (adaptive), so a thin variant
  // of a popular line can't headline.
  const minVariantN = Math.max(EMBLEM_SPLIT_MIN_N_FLOOR, Math.ceil(familyN * EMBLEM_SPLIT_MIN_N_FRAC));
  const baseM = base.built.row.metrics;
  const kept: typeof raw = [];
  let baseMembers = [...base.sub];
  for (const v of raw) {
    if (v === base) continue;
    const vm = v.built.row.metrics;
    const swing = baseM.avgPlacement - vm.avgPlacement; // + = emblem better
    const combinedSem = Math.sqrt(baseM.placementSem ** 2 + vm.placementSem ** 2) || Infinity;
    const keep =
      v.emblemKey !== '' &&
      swing >= EMBLEM_SPLIT_MIN_SWING &&
      swing >= EMBLEM_SPLIT_SIG_K * combinedSem &&
      vm.n >= minVariantN;
    if (keep) kept.push(v);
    else baseMembers = baseMembers.concat(v.sub);
  }

  // Build the base row from its OWN comps (base.sub) so the identity, example
  // board, and its denominator (repN) all agree — a no-emblem board on a
  // no-emblem base (a folded-in emblem board must never be the base thumbnail).
  // Then override just the metrics with the folded pool (base + the
  // non-impactful emblems it absorbed). Badge = base's own emblem set (empty for
  // a no-emblem base; the emblem for an emblem-only line).
  const baseBoard = buildArchetypeRow(base.sub, cat, bucketTotal);
  baseBoard.row.metrics = computeMetrics(poolStats(baseMembers));
  if (!baseBoard.row.isManual) baseBoard.row.tier = scoreToTier(baseBoard.row.metrics.score);
  const baseIds = base.emblemKey ? base.emblemKey.split('|') : [];
  emblemsOf(baseBoard.row.identity.emblems, baseIds);
  const variants: FamilyVariant[] = [
    {
      emblemKey: base.emblemKey,
      emblemIds: baseIds,
      isEmblem: base.emblemKey !== '',
      members: baseMembers,
      row: baseBoard.row,
      repCompId: baseBoard.repCompId,
      repN: baseBoard.repN,
    },
  ];
  for (const k of kept) {
    const ids = k.emblemKey.split('|');
    emblemsOf(k.built.row.identity.emblems, ids);
    variants.push({
      emblemKey: k.emblemKey,
      emblemIds: ids,
      isEmblem: true,
      members: k.sub,
      ...k.built,
    });
  }

  let rep = variants[0];
  for (const v of variants) if (v.row.metrics.score > rep.row.metrics.score) rep = v;
  return { variants, representativeKey: rep.emblemKey, familyN };
}

/** Tier-list row for a family: the representative variant, with the family's
 *  total play rate and a variant count for the "+N variants" marker. Also
 *  returns the variant itself — its member set is the row's example scope. */
function foldFamily(
  members: CompStatRow[],
  cat: CatalogT,
  bucketTotal: number,
): { row: CompRowVM; repCompId: number; repN: number; variant: FamilyVariant } {
  const fam = resolveFamily(members, cat, bucketTotal);
  const rep = fam.variants.find((v) => v.emblemKey === fam.representativeKey) ?? fam.variants[0];
  rep.row.variantCount = fam.variants.length;
  rep.row.playRate = bucketTotal > 0 ? fam.familyN / bucketTotal : 0;
  return { row: rep.row, repCompId: rep.repCompId, repN: rep.repN, variant: rep };
}

function collectRows(groups: TierGroupVM[], niche: CompRowVM[] | null): CompRowVM[] {
  const rows: CompRowVM[] = [];
  for (const g of groups) for (const r of g.comps) rows.push(r);
  if (niche) for (const r of niche) rows.push(r);
  return rows;
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function getTierList(q: TierListQuery = {}): Promise<TierListVM> {
  const { combos, patches } = await loadCombos();
  const { selection, options } = resolveSelection(combos, patches, q);

  if (!selection) {
    return {
      selection: null,
      options,
      bucketTotal: 0,
      groups: [],
      ranked: 0,
      niche: q.niche ? [] : null,
      nicheAvailable: 0,
    };
  }

  const { patchId, region, rankBucket } = selection;

  // Bucket total (play-rate denominator) + per-archetype pooled n & score. The
  // group key is 'm:<meta_comp>' ('c:<id>' for unlabeled comps), and the tier
  // floor applies to the POOLED n — an archetype whose members are individually
  // tiny still qualifies once the line has enough boards.
  const [totalRows, archScores] = await Promise.all([
    query<{ total_boards: number }>(
      `SELECT total_boards FROM bucket_totals
        WHERE patch_id = $1 AND region = $2 AND rank_bucket = $3`,
      [patchId, region, rankBucket],
    ),
    loadArchetypeScores(patchId, region, rankBucket),
  ]);
  const bucketTotal = totalRows[0]?.total_boards ?? 0;

  // A merge archetype (gkey) is the emblem "family": emblem and non-emblem
  // comps of one line share it (the emblem-class merge guard is off). The floor
  // applies to the family's pooled n; one row renders per family, and emblem
  // variants are split/folded inside it at read time.
  const mainGroups = archScores.filter((g) => g.pooledN >= TIER_MIN_SAMPLE);
  const nicheGroups = archScores
    .filter((g) => g.pooledN < TIER_MIN_SAMPLE)
    .sort((a, b) => b.pooledN - a.pooledN)
    .slice(0, NICHE_LIMIT);
  const nicheAvailable = archScores.length - mainGroups.length;
  const mainKeySet = new Set(mainGroups.map((g) => g.gkey));
  // Dynamic tier cutoffs from this bucket's archetype score distribution.
  const cutoffs = tierCutoffs(mainGroups.map((g) => g.score));

  // Member rows (stats + identity + manual pins) for every group we'll render.
  const wantedKeys = [
    ...mainGroups.map((g) => g.gkey),
    ...(q.niche ? nicheGroups.map((g) => g.gkey) : []),
  ];
  const memberRows =
    wantedKeys.length === 0
      ? []
      : await query<CompStatRow>(
          `SELECT cs.comp_id, c.set_number, c.name, c.archetype, c.signature, c.key_traits, c.carries,
                  ${GKEY_SQL} AS gkey,
                  cs.n, cs.placement_sum, cs.placement_sumsq, cs.top4_count, cs.win_count,
                  tle.tier, tle.rank_order, tle.is_manual
             FROM comp_stats cs
             JOIN comps c ON c.id = cs.comp_id
             JOIN unnest($4::text[]) AS wanted(gkey) ON wanted.gkey = ${GKEY_SQL}
             LEFT JOIN tier_list_entries tle
               ON tle.comp_id = cs.comp_id AND tle.patch_id = cs.patch_id
              AND tle.region = cs.region AND tle.rank_bucket = cs.rank_bucket
            WHERE cs.patch_id = $1 AND cs.region = $2 AND cs.rank_bucket = $3`,
          [patchId, region, rankBucket, wantedKeys],
        );

  const cat = await getCatalog();

  // Each archetype (gkey) is a family: split its members into emblem variants
  // (by each comp's signature emblems), then fold to one representative row
  // (see foldFamily). Each row's example/identity scope is its representative
  // VARIANT's own members — pooled, so the strip and badges agree with the
  // pooled stats — with folded-in emblem members excluded from the base
  // variant's scope (a folded emblem board must never drive the base
  // thumbnail), mirroring the detail page's build-evidence rule.
  const exampleScope = new Map<number, { compIds: number[]; n: number }>();
  const archetypeRows: CompRowVM[] = [];
  const nicheRows: CompRowVM[] = [];
  for (const [gkey, members] of groupByKey(memberRows)) {
    const { row, variant } = foldFamily(members, cat, bucketTotal);
    const own =
      variant.emblemKey === ''
        ? variant.members.filter((m) => emblemsFromSignature(m.signature).length === 0)
        : variant.members;
    const top = [...own]
      .sort((a, b) => (b.n ?? 0) - (a.n ?? 0) || a.comp_id - b.comp_id)
      .slice(0, EX_POOL_MEMBER_CAP);
    exampleScope.set(row.identity.compId, {
      compIds: top.map((m) => m.comp_id),
      n: top.reduce((s, m) => s + (m.n ?? 0), 0),
    });
    if (mainKeySet.has(gkey)) archetypeRows.push(row);
    else nicheRows.push(row);
  }

  // Apply the bucket's dynamic tier cutoffs (manual pins keep their tier).
  for (const row of archetypeRows) if (!row.isManual) row.tier = tierForScore(row.metrics.score, cutoffs);
  for (const row of nicheRows) if (!row.isManual) row.tier = tierForScore(row.metrics.score, cutoffs);

  // Bucket archetype rows into tiers (recomputed from the pooled score), ordering
  // within each tier by score desc.
  const byTier = new Map<string, CompRowVM[]>();
  for (const row of archetypeRows) {
    const arr = byTier.get(row.tier);
    if (arr) arr.push(row);
    else byTier.set(row.tier, [row]);
  }
  const groups: TierGroupVM[] = [];
  for (const tier of TIER_ORDER) {
    const comps = byTier.get(tier);
    if (comps && comps.length > 0) {
      comps.sort((a, b) => b.metrics.score - a.metrics.score);
      groups.push({ tier, comps });
    }
  }
  const ranked = archetypeRows.length;

  // Niche = below-the-pooled-floor groups (biggest first, NICHE_LIMIT-bounded):
  // lines that exist but haven't accumulated a tierable sample, pooled the same
  // way as main rows. Counted always (so the toggle can advertise how many),
  // fetched only when the toggle is on.
  const niche: CompRowVM[] | null = q.niche
    ? nicheRows.sort((a, b) => b.metrics.score - a.metrics.score)
    : null;

  // Example teams for every displayed row (archetype representatives + niche), in
  // one aggregation pass scoped to the same bucket. Rows are mutated in place.
  const allRows = collectRows(groups, niche);
  if (allRows.length > 0) {
    const exGroups: ExampleGroup[] = allRows.map((r) => {
      const scope = exampleScope.get(r.identity.compId);
      return {
        key: String(r.identity.compId),
        compIds: scope?.compIds ?? [r.identity.compId],
        n: scope?.n ?? r.metrics.n,
        // Reroll-cost label carries render their hit state (see
        // EX_STAR_HIT_MIN_SHARE) — a 3★ 4/5-cost is lottery, never intent.
        hitTargetIds: r.identity.carries
          .filter((c) => c.cost >= 1 && c.cost <= REROLL_MAX_COST)
          .map((c) => c.characterId),
      };
    });
    const teams = await loadExampleTeams(exGroups, patchId, region, rankBucket, cat);
    for (const r of allRows) {
      r.exampleTeam = teams.get(String(r.identity.compId)) ?? EMPTY_TEAM;
      // Trait chips + display name come from the POOLED example traits — the
      // same source the strip renders, so the badge can never promise a trait
      // tier the pooled boards don't actually hit (the "6 Dark Star badge on a
      // 5 Dark Star strip" review class). Stored key_traits (rep-scoped) are
      // only kept when the group has no board data at all.
      if (r.exampleTeam.traits.length > 0) {
        const top = [...r.exampleTeam.traits]
          .sort(
            (a, b) =>
              (a.unique ? 1 : 0) - (b.unique ? 1 : 0) ||
              b.style - a.style ||
              b.numUnits - a.numUnits ||
              b.freq - a.freq,
          )
          .slice(0, 2);
        r.identity.keyTraits = top.map((t) => ({
          traitId: t.traitId,
          name: t.name,
          iconUrl: t.iconUrl,
          minUnits: t.numUnits,
          style: t.style,
        }));
        r.identity.displayName = computeDisplayName(r.identity);
      }
    }
  }

  return { selection, options, bucketTotal, groups, ranked, niche, nicheAvailable };
}
// ── Read cache ────────────────────────────────────────────────────────────────
//
// The tier list is a pure function of the derived tables, and those only change
// when the pipeline runs (every SCHED_PIPELINE_MIN, default 30 min). Recomputing
// it per request cost a measured 0.9-1.6 s — a combos probe, a group-by over
// every comp_stats row in the bucket, a 27 k-row member fetch, and the example
// board aggregation — against a pool of 10 connections, so ~10 concurrent
// visitors saturated it.
//
// TIME-BASED, not tag-based, on purpose: the pipeline runs in a SEPARATE Node
// process (npm run worker), and revalidateTag() only reaches the Next runtime's
// cache from inside it. Wiring push invalidation would mean the worker calling
// an authenticated revalidate route — worth doing later, but a TTL well under
// the pipeline cadence gets almost all of the benefit for none of the moving
// parts. The 'comps' tag is declared anyway so that route can be added without
// touching these call sites.
//
// The uncached functions stay exported: scripts/_tier-smoke.ts and the merge
// tooling want a direct read, and unstable_cache needs a request context.

const COMPS_CACHE_TTL = numEnv(process.env.COMPS_CACHE_TTL_S, 300);

// Arguments are flattened to primitives so the cache key is deterministic —
// passing the query object would key {} and {patchId: undefined} separately.
const cachedTierList = unstable_cache(
  (
    patchId: number | null,
    region: string | null,
    rankBucket: string | null,
    niche: boolean,
  ): Promise<TierListVM> =>
    getTierList({
      patchId: patchId ?? undefined,
      region: region ?? undefined,
      rankBucket: rankBucket ?? undefined,
      niche,
    }),
  ['comps:tier-list'],
  { revalidate: COMPS_CACHE_TTL, tags: ['comps'] },
);

/** Cached `getTierList`. Use this from pages; the uncached one from scripts. */
export function getTierListCached(q: TierListQuery = {}): Promise<TierListVM> {
  return cachedTierList(q.patchId ?? null, q.region ?? null, q.rankBucket ?? null, !!q.niche);
}
