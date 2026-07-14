// comp-detail-service.ts — read model for the comp-detail page (M6): one
// archetype drilled down. The header row is exactly comps-service's
// buildArchetypeRow (pooled stats, label identity, rep board); this module adds
// the board-level aggregations the tier list doesn't need:
//
//   - core / flex unit strips (unit frequency across the archetype's boards)
//   - a per-unit table with star split and a placement DELTA vs the archetype
//     average (negative = the unit improves the comp)
//   - final-level distribution (7- / 8 / 9+) — the fast-8 vs fast-9 signature
//   - HIT-STATE VARIANTS: members grouped by their exact 3★ set, pooled — the
//     honest "when you hit vs when you don't" numbers (and the data the
//     variant-split decision will be made on)
//   - carry item builds (modal completed sets with rates + avg placement)
//   - the most-played exact boards, rendered with the example-team machinery
//
// All aggregations are scoped to the same (patch, region, bucket) as the stats
// and to the ranked queue. Everything is derived on read; no new tables.

import { query } from '@/lib/db';
import { getCatalog } from './static-data';
import { loadExampleTeams } from './comps-example-team';
import {
  loadCombos,
  resolveSelection,
  resolveFamily,
  bucketTierCutoffs,
  asCarries,
  type CompStatRow,
} from './comps-service';
import { tierForScore } from './queue/comp-stats-math';
import type {
  CompDetailVM,
  DetailVariantOptionVM,
  DetailUnitVM,
  DetailStarLineVM,
  DetailVariantVM,
  DetailLevelBandVM,
  DetailPlacementVM,
  DetailTrendPointVM,
  DetailBuildVM,
  DetailBuildSetVM,
  DetailBoardVM,
  ExampleItemVM,
  TierListQuery,
} from './comps-types';

export type { CompDetailVM } from './comps-types';

const num = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

// Unit-strip thresholds: core = the units the line always fields; flex = the
// units it fields often enough to plan around.
const CORE_MIN_FREQ = num(process.env.DETAIL_CORE_MIN_FREQ, 0.75);
const FLEX_MIN_FREQ = num(process.env.DETAIL_FLEX_MIN_FREQ, 0.25);
const FLEX_CAP = 8;
// Per-unit / per-star rows below this board count are noise, not signal.
const UNIT_MIN_BOARDS = 10;
const VARIANT_CAP = 8; // hit-state rows shown before pooling into 'other'
// Hit states are the default panel only for hit-shaped lines: at least this
// share of the archetype's games hit SOME 3★. Below it (fast-8/9 lines where
// 3★s are incidental) the placement distribution is the default instead.
const HITS_DEFAULT_MIN_SHARE = num(process.env.DETAIL_HITS_DEFAULT_MIN_SHARE, 0.35);
const TOP_BOARDS = 3; // most-played exact boards rendered as strips
const BUILD_SET_CAP = 3; // item sets shown per carry
const BUILD_SET_MIN_BOARDS = 5;
const BUILD_COMPLETE_ITEMS = 3; // completed items that make a board "itemized"

// Base components — excluded when counting completed items (same set the
// example-team and carry-classify paths use).
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

type CatalogT = Awaited<ReturnType<typeof getCatalog>>;

const GKEY_SQL = `COALESCE('m:' || NULLIF(c.meta_comp, ''), 'c:' || c.id::text)`;

interface UnitStarRow {
  character_id: string;
  star: number;
  boards: number;
  avg_placement: number;
  top4: number;
  wins: number;
}
interface LevelRow {
  band: string;
  boards: number;
  avg_placement: number;
}
interface PlacementRow {
  placement: number;
  boards: number;
}
interface TrendRow {
  date: string;
  n: number;
  placement_sum: number;
  top4: number;
  bucket_total: number;
}
interface CarryItemRow {
  board_id: string; // bigint
  placement: number;
  character_id: string;
  item_ids: string[] | null;
}

const rate = (n: number, d: number): number => (d > 0 ? n / d : 0);

/**
 * Load the full detail view for one archetype group key ('m:<label>' or
 * 'c:<comp_id>'). Returns null when the group has no boards in the resolved
 * (patch, region, bucket).
 */
export async function getCompDetail(
  groupKey: string,
  q: TierListQuery = {},
): Promise<CompDetailVM | null> {
  const { combos, patches } = await loadCombos();
  const { selection } = resolveSelection(combos, patches, q);
  if (!selection) return null;
  const { patchId, region, rankBucket } = selection;

  // ── Members of this group (family) in the selected bucket. ──────────────────
  const familyMembers = await query<CompStatRow>(
    `SELECT cs.comp_id, c.set_number, c.name, c.archetype, c.signature, c.key_traits, c.carries,
            ${GKEY_SQL} AS gkey,
            cs.n, cs.placement_sum, cs.placement_sumsq, cs.top4_count, cs.win_count,
            tle.tier, tle.rank_order, tle.is_manual
       FROM comp_stats cs
       JOIN comps c ON c.id = cs.comp_id
       LEFT JOIN tier_list_entries tle
         ON tle.comp_id = cs.comp_id AND tle.patch_id = cs.patch_id
        AND tle.region = cs.region AND tle.rank_bucket = cs.rank_bucket
      WHERE cs.patch_id = $1 AND cs.region = $2 AND cs.rank_bucket = $3
        AND ${GKEY_SQL} = $4`,
    [patchId, region, rankBucket, groupKey],
  );
  if (familyMembers.length === 0) return null;

  const [totalRows, cat] = await Promise.all([
    query<{ total_boards: number }>(
      `SELECT total_boards FROM bucket_totals
        WHERE patch_id = $1 AND region = $2 AND rank_bucket = $3`,
      [patchId, region, rankBucket],
    ),
    getCatalog(),
  ]);
  const bucketTotal = totalRows[0]?.total_boards ?? 0;

  // Resolve the emblem-variant family; show the chosen variant (or the
  // representative). All the aggregations below scope to that variant's members.
  const fam = resolveFamily(familyMembers, cat, bucketTotal);
  // Dynamic tiers from the same bucket distribution the tier list uses.
  const cutoffs = await bucketTierCutoffs(patchId, region, rankBucket);
  for (const v of fam.variants) if (!v.row.isManual) v.row.tier = tierForScore(v.row.metrics.score, cutoffs);
  const selected =
    fam.variants.find((v) => v.emblemKey === (q.variant ?? fam.representativeKey)) ??
    fam.variants.find((v) => v.emblemKey === fam.representativeKey) ??
    fam.variants[0];
  const variantOptions: DetailVariantOptionVM[] = fam.variants.map((v) => ({
    key: v.emblemKey,
    label: v.isEmblem ? v.row.identity.emblems.map((e) => e.name).join(', ') : 'No emblem',
    emblems: v.row.identity.emblems,
    tier: v.row.tier,
    avgPlacement: v.row.metrics.avgPlacement,
    n: v.row.metrics.n,
    selected: v.emblemKey === selected.emblemKey,
  }));

  const header = selected.row;
  const repCompId = selected.repCompId;
  const repN = selected.repN;
  const members = selected.members;

  const memberIds = members.map((m) => m.comp_id);
  const carryIds = header.identity.carries.map((c) => c.characterId);
  const scope = [memberIds, patchId, region, rankBucket] as const;

  // ── Board-level aggregations (SQL-side, small results). ─────────────────────
  const [unitStarRows, levelRows, placementRows, trendRows, carryItemRows] = await Promise.all([
    query<UnitStarRow>(
      `WITH b AS (
         SELECT mp.id, mp.placement
           FROM match_participants mp
           JOIN matches m ON m.match_id = mp.match_id
          WHERE mp.comp_id = ANY($1::int[])
            AND m.patch_id = $2 AND m.region = $3 AND mp.rank_bucket = $4
            AND m.queue_id = 1100
       ),
       bu AS (
         SELECT b.id, b.placement, pu.character_id,
                LEAST(COALESCE(MAX(pu.star_tier), 1), 3) AS star
           FROM b
           JOIN participant_units pu ON pu.participant_id = b.id
          GROUP BY b.id, b.placement, pu.character_id
       )
       SELECT character_id, star,
              COUNT(*)::int AS boards,
              AVG(placement)::float8 AS avg_placement,
              COUNT(*) FILTER (WHERE placement <= 4)::int AS top4,
              COUNT(*) FILTER (WHERE placement = 1)::int AS wins
         FROM bu
        GROUP BY character_id, star`,
      [...scope],
    ),
    query<LevelRow>(
      `SELECT CASE WHEN COALESCE(mp.level, 0) >= 9 THEN '9+'
                   WHEN mp.level = 8 THEN '8'
                   ELSE '7-' END AS band,
              COUNT(*)::int AS boards,
              AVG(mp.placement)::float8 AS avg_placement
         FROM match_participants mp
         JOIN matches m ON m.match_id = mp.match_id
        WHERE mp.comp_id = ANY($1::int[])
          AND m.patch_id = $2 AND m.region = $3 AND mp.rank_bucket = $4
          AND m.queue_id = 1100
        GROUP BY 1`,
      [...scope],
    ),
    query<PlacementRow>(
      `SELECT mp.placement, COUNT(*)::int AS boards
         FROM match_participants mp
         JOIN matches m ON m.match_id = mp.match_id
        WHERE mp.comp_id = ANY($1::int[])
          AND m.patch_id = $2 AND m.region = $3 AND mp.rank_bucket = $4
          AND m.queue_id = 1100
        GROUP BY mp.placement`,
      [...scope],
    ),
    // Daily snapshots (comp_stat_trends stores CUMULATIVE sufficient stats per
    // day; deltas between consecutive dates are computed below). bucket_total
    // is identical on every row of a (patch, region, bucket, date) — MAX picks it.
    query<TrendRow>(
      `SELECT snapshot_date::text AS date,
              SUM(n)::int AS n,
              SUM(placement_sum)::float8 AS placement_sum,
              SUM(top4_count)::int AS top4,
              MAX(bucket_total)::int AS bucket_total
         FROM comp_stat_trends
        WHERE comp_id = ANY($1::int[])
          AND patch_id = $2 AND region = $3 AND rank_bucket = $4
        GROUP BY snapshot_date
        ORDER BY snapshot_date`,
      [...scope],
    ),
    carryIds.length === 0
      ? Promise.resolve([] as CarryItemRow[])
      : query<CarryItemRow>(
          `SELECT mp.id AS board_id, mp.placement, pu.character_id, pu.item_ids
             FROM match_participants mp
             JOIN matches m ON m.match_id = mp.match_id
             JOIN participant_units pu ON pu.participant_id = mp.id
            WHERE mp.comp_id = ANY($1::int[])
              AND m.patch_id = $2 AND m.region = $3 AND mp.rank_bucket = $4
              AND m.queue_id = 1100
              AND pu.character_id = ANY($5::text[])`,
          [...scope, carryIds],
        ),
  ]);

  const totalBoards = levelRows.reduce((s, r) => s + r.boards, 0);
  const archetypeAvg = header.metrics.avgPlacement;

  // ── Units: per-unit rollup across star tiers. ───────────────────────────────
  interface UnitAcc {
    boards: number;
    placementSum: number;
    top4: number;
    wins: number;
    stars: DetailStarLineVM[];
  }
  const unitAccs = new Map<string, UnitAcc>();
  for (const r of unitStarRows) {
    let acc = unitAccs.get(r.character_id);
    if (!acc) {
      acc = { boards: 0, placementSum: 0, top4: 0, wins: 0, stars: [] };
      unitAccs.set(r.character_id, acc);
    }
    acc.boards += r.boards;
    acc.placementSum += r.avg_placement * r.boards;
    acc.top4 += r.top4;
    acc.wins += r.wins;
    acc.stars.push({ star: r.star, boards: r.boards, avgPlacement: r.avg_placement });
  }

  // ── Carry builds (modal completed item sets). ───────────────────────────────
  // Most-itemized copy per (board, carry) so the dup augment's spare copy
  // doesn't dilute; then modal sets among itemized boards.
  const bestCopy = new Map<string, { completed: string[]; placement: number }>();
  for (const r of carryItemRows) {
    const completed = (r.item_ids ?? []).filter((id) => !COMPONENT_ITEMS.has(id));
    const key = `${r.board_id}:${r.character_id}`;
    const prev = bestCopy.get(key);
    if (!prev || completed.length > prev.completed.length) {
      bestCopy.set(key, { completed, placement: r.placement });
    }
  }
  interface SetAcc {
    boards: number;
    placementSum: number;
    items: string[];
  }
  const buildAccs = new Map<string, { itemized: number; sets: Map<string, SetAcc> }>();
  for (const [key, v] of bestCopy) {
    if (v.completed.length < BUILD_COMPLETE_ITEMS) continue;
    const characterId = key.slice(key.indexOf(':') + 1);
    let acc = buildAccs.get(characterId);
    if (!acc) {
      acc = { itemized: 0, sets: new Map() };
      buildAccs.set(characterId, acc);
    }
    acc.itemized += 1;
    const setKey = [...v.completed].sort().join('|');
    const s = acc.sets.get(setKey);
    if (s) {
      s.boards += 1;
      s.placementSum += v.placement;
    } else {
      acc.sets.set(setKey, { boards: 1, placementSum: v.placement, items: v.completed });
    }
  }

  const toItems = (ids: string[]): ExampleItemVM[] =>
    ids.map((id) => {
      const it = cat.item(id);
      return { itemId: it.itemId, name: it.name, iconUrl: it.iconUrl };
    });

  const builds: DetailBuildVM[] = [];
  for (const c of header.identity.carries) {
    const acc = buildAccs.get(c.characterId);
    if (!acc || acc.itemized === 0) continue;
    const sets: DetailBuildSetVM[] = [...acc.sets.values()]
      .filter((s) => s.boards >= BUILD_SET_MIN_BOARDS)
      .sort((a, b) => b.boards - a.boards)
      .slice(0, BUILD_SET_CAP)
      .map((s) => ({
        items: toItems(s.items),
        boards: s.boards,
        rate: rate(s.boards, acc.itemized),
        avgPlacement: s.placementSum / s.boards,
      }));
    if (sets.length > 0) {
      builds.push({
        characterId: c.characterId,
        name: c.name,
        cost: c.cost,
        iconUrl: c.iconUrl,
        sets,
      });
    }
  }

  // ── Unit VMs. ───────────────────────────────────────────────────────────────
  const units: DetailUnitVM[] = [];
  for (const [characterId, acc] of unitAccs) {
    if (acc.boards < UNIT_MIN_BOARDS) continue;
    const meta = cat.unit(characterId);
    if (meta.cost > 5) continue; // summons hold items but aren't board slots
    let modal = acc.stars[0];
    for (const s of acc.stars) if (s.boards > modal.boards) modal = s;
    const avgPlacement = acc.placementSum / acc.boards;
    units.push({
      characterId: meta.characterId,
      name: meta.name,
      cost: meta.cost,
      iconUrl: meta.iconUrl,
      freq: rate(acc.boards, totalBoards),
      modalStar: modal.star,
      boards: acc.boards,
      avgPlacement,
      delta: avgPlacement - archetypeAvg,
      top4Rate: rate(acc.top4, acc.boards),
      winRate: rate(acc.wins, acc.boards),
      perStar: acc.stars
        .filter((s) => s.boards >= UNIT_MIN_BOARDS)
        .sort((a, b) => b.star - a.star),
      items: builds.find((b) => b.characterId === characterId)?.sets[0]?.items ?? [],
    });
  }
  units.sort((a, b) => b.freq - a.freq || a.name.localeCompare(b.name));

  const core = units
    .filter((u) => u.freq >= CORE_MIN_FREQ)
    .sort((a, b) => b.cost - a.cost || b.freq - a.freq);
  const coreIds = new Set(core.map((u) => u.characterId));
  const flex = units
    .filter((u) => !coreIds.has(u.characterId) && u.freq >= FLEX_MIN_FREQ)
    .slice(0, FLEX_CAP);

  // ── Hit-state variants (members grouped by exact 3★ set). ───────────────────
  interface VarAcc {
    n: number;
    placementSum: number;
    top4: number;
    wins: number;
  }
  const varAccs = new Map<string, VarAcc>();
  for (const m of members) {
    const key = asCarries(m.carries)
      .map((c) => c.character_id)
      .sort()
      .join('|');
    let acc = varAccs.get(key);
    if (!acc) {
      acc = { n: 0, placementSum: 0, top4: 0, wins: 0 };
      varAccs.set(key, acc);
    }
    acc.n += m.n ?? 0;
    acc.placementSum += Number(m.placement_sum ?? 0);
    acc.top4 += m.top4_count ?? 0;
    acc.wins += m.win_count ?? 0;
  }
  const toVariant = (key: string, acc: VarAcc): DetailVariantVM => ({
    key,
    units:
      key === ''
        ? []
        : key.split('|').map((id) => {
            const u = cat.unit(id);
            return { characterId: u.characterId, name: u.name, cost: u.cost, iconUrl: u.iconUrl };
          }),
    n: acc.n,
    share: rate(acc.n, header.metrics.n),
    avgPlacement: acc.n > 0 ? acc.placementSum / acc.n : 0,
    top4Rate: rate(acc.top4, acc.n),
    winRate: rate(acc.wins, acc.n),
  });
  const sortedVars = [...varAccs.entries()].sort((a, b) => b[1].n - a[1].n);
  const variants: DetailVariantVM[] = sortedVars
    .slice(0, VARIANT_CAP)
    .map(([k, acc]) => toVariant(k, acc));
  if (sortedVars.length > VARIANT_CAP) {
    const other: VarAcc = { n: 0, placementSum: 0, top4: 0, wins: 0 };
    for (const [, acc] of sortedVars.slice(VARIANT_CAP)) {
      other.n += acc.n;
      other.placementSum += acc.placementSum;
      other.top4 += acc.top4;
      other.wins += acc.wins;
    }
    const row = toVariant('__other__', other);
    row.units = [];
    variants.push(row);
  }

  // ── Level bands. ────────────────────────────────────────────────────────────
  const BAND_ORDER = ['7-', '8', '9+'];
  const levelBands: DetailLevelBandVM[] = BAND_ORDER.map((band) => {
    const r = levelRows.find((x) => x.band === band);
    return {
      band,
      share: rate(r?.boards ?? 0, totalBoards),
      avgPlacement: r?.avg_placement ?? 0,
    };
  });

  // ── Placement histogram (1st..8th, zero-filled). ────────────────────────────
  const placementTotal = placementRows.reduce((s, r) => s + r.boards, 0);
  const placements: DetailPlacementVM[] = Array.from({ length: 8 }, (_, i) => {
    const p = i + 1;
    const row = placementRows.find((r) => r.placement === p);
    return {
      placement: p,
      boards: row?.boards ?? 0,
      share: rate(row?.boards ?? 0, placementTotal),
    };
  });

  // Hit-shaped line? (drives which tab the detail panel opens on)
  const noHitN = varAccs.get('')?.n ?? 0;
  const hitStatesDefault = 1 - rate(noHitN, header.metrics.n) >= HITS_DEFAULT_MIN_SHARE;

  // ── Trend: deltas between consecutive daily snapshots. ──────────────────────
  // The first snapshot counts from patch start; periods where nothing was
  // crawled (dn <= 0, e.g. identical back-to-back snapshots) are skipped.
  const trend: DetailTrendPointVM[] = [];
  let prev: TrendRow | null = null;
  for (const row of trendRows) {
    const dn = row.n - (prev?.n ?? 0);
    if (dn > 0) {
      const dPlacement = row.placement_sum - (prev?.placement_sum ?? 0);
      const dTop4 = row.top4 - (prev?.top4 ?? 0);
      const dBucket = row.bucket_total - (prev?.bucket_total ?? 0);
      trend.push({
        date: row.date,
        games: dn,
        avgPlacement: dPlacement / dn,
        top4Rate: rate(dTop4, dn),
        playRate: dBucket > 0 ? dn / dBucket : 0,
      });
    }
    prev = row;
  }

  // ── Most-played exact boards, with example strips. ──────────────────────────
  const topMembers = [...members]
    .sort((a, b) => (b.n ?? 0) - (a.n ?? 0) || a.comp_id - b.comp_id)
    .slice(0, TOP_BOARDS);
  const teamIds = [...new Set([repCompId, ...topMembers.map((m) => m.comp_id)])];
  const nByComp = new Map<number, number>();
  nByComp.set(repCompId, repN);
  for (const m of topMembers) nByComp.set(m.comp_id, m.n ?? 0);
  const teams = await loadExampleTeams(teamIds, patchId, region, rankBucket, nByComp, cat);

  const topBoards: DetailBoardVM[] = topMembers.map((m) => ({
    compId: m.comp_id,
    n: m.n ?? 0,
    avgPlacement: (m.n ?? 0) > 0 ? Number(m.placement_sum ?? 0) / (m.n ?? 0) : 0,
    team: teams.get(m.comp_id) ?? { units: [], traits: [] },
  }));

  // Backfill the header's trait chips + display name from the rep's example
  // team, exactly like the tier list does.
  const repTeam = teams.get(repCompId);
  if (header.identity.keyTraits.length === 0 && repTeam && repTeam.traits.length > 0) {
    const top = [...repTeam.traits]
      .sort(
        (a, b) =>
          (a.unique ? 1 : 0) - (b.unique ? 1 : 0) ||
          b.style - a.style ||
          b.numUnits - a.numUnits ||
          b.freq - a.freq,
      )
      .slice(0, 2);
    header.identity.keyTraits = top.map((t) => ({
      traitId: t.traitId,
      name: t.name,
      iconUrl: t.iconUrl,
      minUnits: t.numUnits,
      style: t.style,
    }));
    const topTrait = header.identity.keyTraits[0]?.name;
    const computed = [topTrait, ...header.identity.carries.map((c) => c.name)]
      .filter(Boolean)
      .join(' ');
    header.identity.displayName =
      header.identity.name ?? (computed.length > 0 ? computed : null);
  }

  return {
    selection,
    groupKey,
    variantOptions,
    selectedVariant: selected.emblemKey,
    identity: header.identity,
    metrics: header.metrics,
    playRate: header.playRate,
    tier: header.tier,
    memberCount: members.length,
    core,
    flex,
    unitsTable: units,
    levelBands,
    placements,
    trend,
    variants,
    hitStatesDefault,
    builds,
    topBoards,
  };
}
