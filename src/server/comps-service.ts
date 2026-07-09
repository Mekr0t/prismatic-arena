// comps-service.ts — read-side entry point for the M5 tier list.
//
// Reads the rollup's outputs (tier_list_entries + comp_stats + bucket_totals),
// resolves each comp's display identity from the comps JSONB via the static
// catalog, and recomputes metrics on read through the SAME comp-stats-math the
// writer used — so a method change there reflects here with no re-rollup.
//
// ARCHETYPE COLLAPSE (read-time grouping). The tiered comps are grouped on
// comps.meta_comp (the carry-archetype label written by the merge stage). Comps
// that merge folded under one label are fragments of the same archetype —
// near-identical boards that clustered as distinct exact-unit comps (the
// 18+22-game / 131+83-game pairs). Their SUFFICIENT STATISTICS are additive, so
// we pool them and recompute metrics ONCE on the combined sample: intervals
// tighten with the larger n, and the tier is earned on pooled evidence. Each
// archetype renders as one row, using its highest-n member as the representative
// for identity + example board. A tiered comp with no label yet (merge hasn't
// caught up to a brand-new comp) keys on its own id, so it stands alone rather
// than collapsing into a null bucket.
//
// One round of DB reads per page:
//   1) a combos+patches probe that drives the three selectors;
//   2) the tier rows for the chosen (patch, region, bucket);
//   3) the bucket total (for play rate);
//   4) (only when the niche toggle is on) the below-threshold comps.

import { query } from '@/lib/db';
import { getCatalog } from './static-data';
import { computeMetrics, scoreToTier, type SufficientStats } from './queue/comp-stats-math';
import { loadExampleTeams, styleAtUnits, EMPTY_TEAM } from './comps-example-team';
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
// Canonical rank-bucket ordering for the selector (best first); unknown buckets
// sort after these, alphabetically. apex-only today, but ready for rank bands.
const BUCKET_ORDER = [
  'challenger',
  'grandmaster',
  'master',
  'diamond',
  'emerald',
  'platinum',
  'gold',
  'silver',
  'bronze',
  'iron',
];
const NICHE_LIMIT = 100; // cap the niche list so a thin meta's long tail stays bounded

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
interface CompStatRow {
  comp_id: number;
  set_number: number;
  name: string | null;
  archetype: string | null;
  signature: string;
  key_traits: unknown; // jsonb [{trait_id,min_units}]
  carries: unknown; // jsonb [{character_id}]
  meta_comp?: string | null; // merge's carry-archetype label (grouping key)
  n: number;
  placement_sum: string; // bigint
  placement_sumsq: string; // bigint
  top4_count: number;
  win_count: number;
  // present only on tier-list rows (LEFT JOIN tier_list_entries):
  tier?: string | null;
  rank_order?: number | null;
  is_manual?: boolean | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function asCarries(v: unknown): JsonCarry[] {
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

// ── Selector/default resolution ───────────────────────────────────────────────

async function loadCombos(): Promise<{ combos: ComboRow[]; patches: Map<number, PatchRow> }> {
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

function resolveSelection(
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

function buildIdentity(row: CompStatRow, cat: CatalogT): CompIdentityVM {
  const carries = asCarries(row.carries).map((c) => {
    const u = cat.unit(c.character_id);
    return { characterId: u.characterId, name: u.name, cost: u.cost, iconUrl: u.iconUrl };
  });
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
  // Computed display name "[key trait] [carry1] [carry2]" (trait-first). The
  // stored comps.name wins when the #3 pass eventually writes a smarter title.
  const topTrait = keyTraits[0]?.name;
  const computed = [topTrait, ...carries.map((c) => c.name)].filter(Boolean).join(' ');
  const displayName = row.name ?? (computed.length > 0 ? computed : null);

  return {
    compId: row.comp_id,
    setNumber: row.set_number,
    name: row.name,
    archetype: row.archetype,
    displayName,
    signature: row.signature,
    carries,
    keyTraits,
  };
}

function toRow(row: CompStatRow, cat: CatalogT, bucketTotal: number, storedTier: boolean): CompRowVM {
  // A manual tier_list_entries row can reference a comp with no comp_stats in
  // this bucket → the LEFT JOIN yields nulls. Coalesce so metrics degrade to the
  // lobby prior (n=0) instead of throwing on formatting.
  const metrics = computeMetrics({
    n: row.n ?? 0,
    placementSum: Number(row.placement_sum ?? 0),
    placementSumsq: Number(row.placement_sumsq ?? 0),
    top4Count: row.top4_count ?? 0,
    winCount: row.win_count ?? 0,
  });
  const tier = storedTier && row.tier ? row.tier : scoreToTier(metrics.score);
  return {
    identity: buildIdentity(row, cat),
    metrics,
    playRate: bucketTotal > 0 ? row.n / bucketTotal : 0,
    tier,
    rankOrder: row.rank_order ?? null,
    isManual: row.is_manual ?? false,
    exampleTeam: EMPTY_TEAM, // filled by loadExampleTeams once comp_ids are known
  };
}

// ── Archetype collapse ─────────────────────────────────────────────────────────

/** Group tiered comp rows by their merge archetype label. Rows sharing a
 *  non-empty meta_comp collapse together; a row without a label keys on its own
 *  comp_id so it stays a singleton archetype (never merged into a null bucket). */
function groupByArchetype(rows: CompStatRow[]): CompStatRow[][] {
  const byLabel = new Map<string, CompStatRow[]>();
  for (const r of rows) {
    const key = r.meta_comp && r.meta_comp.length > 0 ? `m:${r.meta_comp}` : `c:${r.comp_id}`;
    const arr = byLabel.get(key);
    if (arr) arr.push(r);
    else byLabel.set(key, [r]);
  }
  return [...byLabel.values()];
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

/** Build one archetype row: pooled metrics + tier from the combined sample, with
 *  the highest-n member supplying identity and (later) the example board. Returns
 *  the representative's OWN n separately — that's the correct denominator for its
 *  example board, which is aggregated from the representative comp alone. */
function buildArchetypeRow(
  members: CompStatRow[],
  cat: CatalogT,
  bucketTotal: number,
): { row: CompRowVM; repCompId: number; repN: number } {
  // Representative = most-played member (its board is the archetype's canonical
  // form). Ties broken by comp_id for determinism.
  let rep = members[0];
  for (const m of members) {
    const mn = m.n ?? 0;
    const rn = rep.n ?? 0;
    if (mn > rn || (mn === rn && m.comp_id < rep.comp_id)) rep = m;
  }

  const metrics = computeMetrics(poolStats(members));
  const row: CompRowVM = {
    identity: buildIdentity(rep, cat),
    metrics,
    playRate: bucketTotal > 0 ? metrics.n / bucketTotal : 0,
    tier: scoreToTier(metrics.score),
    rankOrder: null,
    isManual: false,
    exampleTeam: EMPTY_TEAM, // filled by loadExampleTeams (representatives only)
  };
  return { row, repCompId: rep.comp_id, repN: rep.n ?? 0 };
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

  // Bucket total (play-rate denominator) + tier rows in parallel.
  const [totalRows, tierRows] = await Promise.all([
    query<{ total_boards: number }>(
      `SELECT total_boards FROM bucket_totals
        WHERE patch_id = $1 AND region = $2 AND rank_bucket = $3`,
      [patchId, region, rankBucket],
    ),
    query<CompStatRow>(
      `SELECT tle.comp_id, c.set_number, c.name, c.archetype, c.signature, c.key_traits, c.carries, c.meta_comp,
              cs.n, cs.placement_sum, cs.placement_sumsq, cs.top4_count, cs.win_count,
              tle.tier, tle.rank_order, tle.is_manual
         FROM tier_list_entries tle
         JOIN comps c ON c.id = tle.comp_id
         LEFT JOIN comp_stats cs
           ON cs.comp_id = tle.comp_id
          AND cs.patch_id = tle.patch_id
          AND cs.region = tle.region
          AND cs.rank_bucket = tle.rank_bucket
        WHERE tle.patch_id = $1 AND tle.region = $2 AND tle.rank_bucket = $3
        ORDER BY tle.rank_order NULLS LAST, cs.n DESC NULLS LAST`,
      [patchId, region, rankBucket],
    ),
  ]);
  const bucketTotal = totalRows[0]?.total_boards ?? 0;

  const cat = await getCatalog();

  // Collapse tiered comps into carry archetypes, pooling sufficient stats. Track
  // each representative's OWN n for its example-board denominator.
  const repOwnN = new Map<number, number>();
  const archetypeRows: CompRowVM[] = [];
  for (const members of groupByArchetype(tierRows)) {
    const { row, repCompId, repN } = buildArchetypeRow(members, cat, bucketTotal);
    archetypeRows.push(row);
    repOwnN.set(repCompId, repN);
  }

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

  // Below-threshold comps: have stats in this bucket, never made the tier list.
  // Counted always (so the toggle can advertise how many), fetched only when on.
  // These are sub-threshold and so unlabeled by merge — shown individually.
  const nicheCountRows = await query<{ c: number }>(
    `SELECT COUNT(*)::int AS c
       FROM comp_stats cs
       LEFT JOIN tier_list_entries tle
         ON tle.comp_id = cs.comp_id AND tle.patch_id = cs.patch_id
        AND tle.region = cs.region AND tle.rank_bucket = cs.rank_bucket
      WHERE cs.patch_id = $1 AND cs.region = $2 AND cs.rank_bucket = $3
        AND tle.comp_id IS NULL`,
    [patchId, region, rankBucket],
  );
  const nicheAvailable = nicheCountRows[0]?.c ?? 0;

  let niche: CompRowVM[] | null = null;
  if (q.niche) {
    const nicheRows = await query<CompStatRow>(
      `SELECT cs.comp_id, c.set_number, c.name, c.archetype, c.signature, c.key_traits, c.carries,
              cs.n, cs.placement_sum, cs.placement_sumsq, cs.top4_count, cs.win_count
         FROM comp_stats cs
         JOIN comps c ON c.id = cs.comp_id
         LEFT JOIN tier_list_entries tle
           ON tle.comp_id = cs.comp_id AND tle.patch_id = cs.patch_id
          AND tle.region = cs.region AND tle.rank_bucket = cs.rank_bucket
        WHERE cs.patch_id = $1 AND cs.region = $2 AND cs.rank_bucket = $3
          AND tle.comp_id IS NULL
        ORDER BY cs.n DESC
        LIMIT $4`,
      [patchId, region, rankBucket, NICHE_LIMIT],
    );
    niche = nicheRows
      .map((r) => toRow(r, cat, bucketTotal, false))
      .sort((a, b) => b.metrics.score - a.metrics.score);
  }

  // Example teams for every displayed row (archetype representatives + niche), in
  // one aggregation pass scoped to the same bucket. Rows are mutated in place.
  const allRows = collectRows(groups, niche);
  if (allRows.length > 0) {
    const compIds = [...new Set(allRows.map((r) => r.identity.compId))];
    const nByComp = new Map<number, number>();
    for (const r of allRows) {
      // Archetype rows: use the representative's OWN n (its board is what's
      // aggregated, so pooled n would understate per-unit frequencies). Niche
      // rows are single comps, so metrics.n already IS their own n.
      const own = repOwnN.get(r.identity.compId);
      nByComp.set(r.identity.compId, own ?? r.metrics.n);
    }
    const teams = await loadExampleTeams(compIds, patchId, region, rankBucket, nByComp, cat);
    for (const r of allRows) r.exampleTeam = teams.get(r.identity.compId) ?? EMPTY_TEAM;
  }

  return { selection, options, bucketTotal, groups, ranked, niche, nicheAvailable };
}