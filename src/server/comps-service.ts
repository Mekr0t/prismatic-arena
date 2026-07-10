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

// The tier floor, applied to the POOLED archetype sample (Σ n across members in
// the selected bucket) — same env knob the trend-tier writer uses per comp.
const TIER_MIN_SAMPLE = (() => {
  const n = Number(process.env.TIER_MIN_SAMPLE);
  return Number.isFinite(n) ? n : 15;
})();

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

interface ParsedLabel {
  carryIds: string[];
  dupIds: string[];
  heroAugmentId: string | null;
}

/** Parse a group key back into its archetype-label parts. Returns null for
 *  unlabeled singleton groups ('c:<id>'). Unknown `##` segments (e.g. the
 *  `##k:` collision disambiguator) are display-irrelevant and skipped. */
function parseLabelKey(gkey: string): ParsedLabel | null {
  if (!gkey.startsWith('m:')) return null;
  const [carryPart, ...tags] = gkey.slice(2).split('##');
  let dupIds: string[] = [];
  let heroAugmentId: string | null = null;
  for (const tag of tags) {
    if (tag.startsWith('dup:')) dupIds = tag.slice(4).split('|').filter(Boolean);
    else if (tag.startsWith('aug:')) heroAugmentId = tag.slice(4) || null;
  }
  return {
    carryIds: carryPart === 'no_carry' ? [] : carryPart.split('|').filter(Boolean),
    dupIds,
    heroAugmentId,
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
 *  representative comp alone. */
function buildArchetypeRow(
  members: CompStatRow[],
  cat: CatalogT,
  bucketTotal: number,
): { row: CompRowVM; repCompId: number; repN: number } {
  const pooled = poolStats(members);

  // Representative = the most complete hit-state with a usable sample: most
  // 3★s (comps.carries length), then highest n, then comp_id for determinism.
  // After pooling, the highest-n member is usually a missed-hit variant — the
  // archetype's face should be the board the line is trying to hit, not its
  // most common failure state. Members below max(5, 5% of pooled n) are only
  // eligible when nothing bigger exists (all-tail archetypes).
  const minRepN = Math.max(5, Math.ceil(pooled.n * 0.05));
  const eligible = members.filter((m) => (m.n ?? 0) >= minRepN);
  const pool = eligible.length > 0 ? eligible : members;
  let rep = pool[0];
  let repStars = asCarries(rep.carries).length;
  for (const m of pool) {
    const stars = asCarries(m.carries).length;
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
    metrics,
    playRate: bucketTotal > 0 ? metrics.n / bucketTotal : 0,
    tier: pinned?.tier ?? scoreToTier(metrics.score),
    rankOrder: null,
    isManual: pinned !== null,
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

  // Bucket total (play-rate denominator) + pooled group keys in parallel. The
  // group key is 'm:<meta_comp>' ('c:<id>' for unlabeled comps), and the tier
  // floor applies to the POOLED n — an archetype whose members are individually
  // tiny still qualifies once the line has enough boards.
  const GKEY_SQL = `COALESCE('m:' || NULLIF(c.meta_comp, ''), 'c:' || c.id::text)`;
  const [totalRows, groupRows] = await Promise.all([
    query<{ total_boards: number }>(
      `SELECT total_boards FROM bucket_totals
        WHERE patch_id = $1 AND region = $2 AND rank_bucket = $3`,
      [patchId, region, rankBucket],
    ),
    query<{ gkey: string; pooled_n: number }>(
      `SELECT ${GKEY_SQL} AS gkey, SUM(cs.n)::int AS pooled_n
         FROM comp_stats cs
         JOIN comps c ON c.id = cs.comp_id
        WHERE cs.patch_id = $1 AND cs.region = $2 AND cs.rank_bucket = $3
        GROUP BY 1`,
      [patchId, region, rankBucket],
    ),
  ]);
  const bucketTotal = totalRows[0]?.total_boards ?? 0;

  const mainGroups = groupRows.filter((g) => g.pooled_n >= TIER_MIN_SAMPLE);
  const nicheGroups = groupRows
    .filter((g) => g.pooled_n < TIER_MIN_SAMPLE)
    .sort((a, b) => b.pooled_n - a.pooled_n)
    .slice(0, NICHE_LIMIT);
  const nicheAvailable = groupRows.length - mainGroups.length;

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

  // Pool each group's sufficient stats into one row. Track each
  // representative's OWN n for its example-board denominator.
  const mainKeySet = new Set(mainGroups.map((g) => g.gkey));
  const repOwnN = new Map<number, number>();
  const archetypeRows: CompRowVM[] = [];
  const nicheRows: CompRowVM[] = [];
  for (const [gkey, members] of groupByKey(memberRows)) {
    const { row, repCompId, repN } = buildArchetypeRow(members, cat, bucketTotal);
    repOwnN.set(repCompId, repN);
    if (mainKeySet.has(gkey)) archetypeRows.push(row);
    else nicheRows.push(row);
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
    const compIds = [...new Set(allRows.map((r) => r.identity.compId))];
    const nByComp = new Map<number, number>();
    for (const r of allRows) {
      // Every row (main + niche) is a pooled group: use the representative's
      // OWN n — its board alone is what's aggregated, so the pooled n would
      // understate per-unit frequencies.
      const own = repOwnN.get(r.identity.compId);
      nByComp.set(r.identity.compId, own ?? r.metrics.n);
    }
    const teams = await loadExampleTeams(compIds, patchId, region, rankBucket, nByComp, cat);
    for (const r of allRows) {
      r.exampleTeam = teams.get(r.identity.compId) ?? EMPTY_TEAM;
      // The clusterer writes no key_traits, so backfill the trait chips from
      // the example team's active traits: highest non-unique style first (the
      // comp's vertical), then unit count. This is what puts the "[trait]"
      // prefix on the display name.
      if (r.identity.keyTraits.length === 0 && r.exampleTeam.traits.length > 0) {
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