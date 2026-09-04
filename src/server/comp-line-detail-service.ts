import { query } from '@/lib/db';
import { getCatalog } from './static-data';
import { styleAtUnits } from './comps-example-team';
import { RANKED_TFT_QUEUE_ID } from '@/config/queue-ids';
import { regionCodesFor } from '@/config/regions';
import { TIER_ORDER, tiersAtOrAbove } from '@/config/rank-buckets';
import { computeMetrics, tierCutoffs, tierForScore } from './queue/comp-stats-math';
import { lineIdFromKey, lineKey } from './comp-lines-service';
import type {
  CompDetailVM,
  DetailBoardVM,
  DetailBuildVM,
  DetailLevelBandVM,
  DetailPlacementVM,
  DetailTrendPointVM,
  DetailUnitVM,
  DetailVariantVM,
  ExampleItemVM,
  TierListQuery,
} from './comps-types';

// comp-line-detail-service.ts — the comp detail page read from the line model.
//
// THE RANK DIAL LIVES HERE AND RECALCULATES EVERYTHING. The tier list has no
// rank picker: lines are elected from master+ and ranked by master+, so there is
// nothing on that page that low-elo placement could corrupt. That is what frees
// this page to answer the question honestly — "how does this line actually
// perform in gold+" is asked explicitly by moving the selector, and it deserves
// a real answer rather than a labelled non-answer. Placement, top-4, win, play,
// games, per-unit stats, hit states, levels, trend, builds and boards all
// recompute for the selected scope.
//
// THE EXAMPLE BOARD IS THE ONE THING THAT DOES NOT MOVE. It is elected with the
// line from master+ and stored on it; a per-scope example would quietly turn
// this page into "here is a different comp" as the reader widens for sample.
//
// Scopes are CUMULATIVE and overlap (gold+ contains master+), so `line_stats`
// stores disjoint tiers and everything here sums the tiers a scope covers.

/** Cumulative scopes offered on the page, strongest first. */
export const SCOPES = ['master+', 'diamond+', 'emerald+', 'platinum+', 'gold+'] as const;

const DEFAULT_SCOPE = `${(process.env.ELECT_TIER_FLOOR ?? 'MASTER').toLowerCase()}+`;

/** Tiers a scope covers. An unrecognised scope falls back to the default rather
 *  than to an empty list — a typo in a URL should show the line, not an empty
 *  page that looks like the line has no data. */
function tiersForScope(scope: string | undefined): { scope: string; tiers: string[] } {
  const wanted = (scope ?? DEFAULT_SCOPE).toLowerCase();
  const floor = wanted.endsWith('+') ? wanted.slice(0, -1) : wanted;
  const tiers = tiersAtOrAbove(floor);
  return tiers.length > 0
    ? { scope: `${floor}+`, tiers }
    : { scope: DEFAULT_SCOPE, tiers: tiersAtOrAbove(DEFAULT_SCOPE.slice(0, -1)) };
}

const numOr = (v: unknown, d = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

interface StatRow {
  n: number;
  placement_sum: string;
  placement_sumsq: string;
  top4_count: number;
  win_count: number;
}

const metricsOf = (r: StatRow | undefined) =>
  computeMetrics({
    n: numOr(r?.n),
    placementSum: numOr(r?.placement_sum),
    placementSumsq: numOr(r?.placement_sumsq),
    top4Count: numOr(r?.top4_count),
    winCount: numOr(r?.win_count),
  });

export async function getLineDetail(
  key: string,
  q: TierListQuery = {},
): Promise<CompDetailVM | null> {
  const lineId = lineIdFromKey(key);
  if (lineId === null) return null;

  const cat = await getCatalog();
  const lines = await query<{
    id: number;
    patch_id: number;
    name: string;
    slug: string;
    carries: string[];
    trait_id: string | null;
    core_units: string[];
    patch: string;
  }>(
    `SELECT cl.id, cl.patch_id, cl.name, cl.slug, cl.carries, cl.trait_id, cl.core_units, p.patch
       FROM comp_lines cl JOIN patches p ON p.id = cl.patch_id
      WHERE cl.id = $1`,
    [lineId],
  );
  if (lines.length === 0) return null;
  const line = lines[0];

  // Region defaults to whichever super-region has the most boards for this line,
  // so a link without one lands somewhere populated rather than on an arbitrary
  // alphabetical first.
  const regions = await query<{ region: string; boards: number }>(
    `SELECT region, SUM(n)::int AS boards FROM line_stats
      WHERE line_id = $1 AND patch_id = $2 GROUP BY 1 ORDER BY 2 DESC`,
    [lineId, line.patch_id],
  );
  if (regions.length === 0) return null;
  const region =
    q.region && regions.some((r) => r.region === q.region) ? q.region : regions[0].region;

  const { scope, tiers } = tiersForScope(q.rankBucket);
  // The board-level queries filter on the expanded platform CODES, so they never
  // reference the super-region name. Their parameter lists must therefore not
  // carry it: a parameter the SQL does not use has no inferrable type and
  // Postgres refuses the statement outright.
  const codes = regionCodesFor(region);
  const scopeArgs = [lineId, line.patch_id, region, tiers] as const;

  const [pooled, allLines, unitRows, starRows, levelRows, placeRows, trendRows, hitRows, buildRows, boardRows] =
    await Promise.all([
      query<StatRow>(
        `SELECT COALESCE(SUM(n),0)::int n, COALESCE(SUM(placement_sum),0)::text placement_sum,
                COALESCE(SUM(placement_sumsq),0)::text placement_sumsq,
                COALESCE(SUM(top4_count),0)::int top4_count, COALESCE(SUM(win_count),0)::int win_count
           FROM line_stats WHERE line_id = $1 AND patch_id = $2 AND region = $3 AND tier = ANY($4::text[])`,
        [...scopeArgs],
      ),
      // Every line in the same scope — the play-rate denominator and the tier
      // cutoffs both need the field, not just this line.
      query<{ line_id: number } & StatRow>(
        `SELECT line_id, SUM(n)::int n, SUM(placement_sum)::text placement_sum,
                SUM(placement_sumsq)::text placement_sumsq,
                SUM(top4_count)::int top4_count, SUM(win_count)::int win_count
           FROM line_stats WHERE patch_id = $1 AND region = $2 AND tier = ANY($3::text[])
          GROUP BY 1`,
        [line.patch_id, region, tiers],
      ),
      // Per-unit performance INSIDE the line. `boards` counts distinct boards, so
      // a duplicate copy does not inflate a unit's sample.
      query<{
        character_id: string; boards: number; placement_sum: string;
        top4: number; wins: number; modal_star: number;
      }>(
        `SELECT pu.character_id,
                COUNT(DISTINCT mp.id)::int boards,
                SUM(mp.placement)::text placement_sum,
                COUNT(DISTINCT mp.id) FILTER (WHERE mp.placement <= 4)::int top4,
                COUNT(DISTINCT mp.id) FILTER (WHERE mp.placement = 1)::int wins,
                MODE() WITHIN GROUP (ORDER BY pu.star_tier)::int modal_star
           FROM match_participants mp
           JOIN matches m ON m.match_id = mp.match_id
           JOIN participant_units pu ON pu.participant_id = mp.id
          WHERE mp.line_id = $1 AND m.patch_id = $2 AND m.region = ANY($4::text[])
            AND mp.tier = ANY($3::text[]) AND m.queue_id = $5
          GROUP BY 1 ORDER BY 2 DESC`,
        [lineId, line.patch_id, tiers, codes, RANKED_TFT_QUEUE_ID],
      ),
      query<{ character_id: string; star_tier: number; boards: number; placement_sum: string }>(
        `SELECT pu.character_id, pu.star_tier,
                COUNT(DISTINCT mp.id)::int boards, SUM(mp.placement)::text placement_sum
           FROM match_participants mp
           JOIN matches m ON m.match_id = mp.match_id
           JOIN participant_units pu ON pu.participant_id = mp.id
          WHERE mp.line_id = $1 AND m.patch_id = $2 AND m.region = ANY($4::text[])
            AND mp.tier = ANY($3::text[]) AND m.queue_id = $5
          GROUP BY 1,2`,
        [lineId, line.patch_id, tiers, codes, RANKED_TFT_QUEUE_ID],
      ),
      query<{ band: string; boards: number; placement_sum: string }>(
        `SELECT CASE WHEN mp.level <= 7 THEN '7-' WHEN mp.level = 8 THEN '8' ELSE '9+' END AS band,
                COUNT(*)::int boards, SUM(mp.placement)::text placement_sum
           FROM match_participants mp JOIN matches m ON m.match_id = mp.match_id
          WHERE mp.line_id = $1 AND m.patch_id = $2 AND m.region = ANY($4::text[])
            AND mp.tier = ANY($3::text[]) AND m.queue_id = $5
          GROUP BY 1`,
        [lineId, line.patch_id, tiers, codes, RANKED_TFT_QUEUE_ID],
      ),
      query<{ placement: number; boards: number }>(
        `SELECT mp.placement, COUNT(*)::int boards
           FROM match_participants mp JOIN matches m ON m.match_id = mp.match_id
          WHERE mp.line_id = $1 AND m.patch_id = $2 AND m.region = ANY($4::text[])
            AND mp.tier = ANY($3::text[]) AND m.queue_id = $5
          GROUP BY 1 ORDER BY 1`,
        [lineId, line.patch_id, tiers, codes, RANKED_TFT_QUEUE_ID],
      ),
      // Trend is computed LIVE from game_datetime rather than from a snapshot
      // table: lines are patch-scoped and re-elected, so a snapshot keyed by a
      // line id would be describing a different line after a re-election.
      query<{ date: string; games: number; placement_sum: string; top4: number }>(
        `SELECT m.game_datetime::date::text AS date, COUNT(*)::int games,
                SUM(mp.placement)::text placement_sum,
                COUNT(*) FILTER (WHERE mp.placement <= 4)::int top4
           FROM match_participants mp JOIN matches m ON m.match_id = mp.match_id
          WHERE mp.line_id = $1 AND m.patch_id = $2 AND m.region = ANY($4::text[])
            AND mp.tier = ANY($3::text[]) AND m.queue_id = $5
          GROUP BY 1 ORDER BY 1`,
        [lineId, line.patch_id, tiers, codes, RANKED_TFT_QUEUE_ID],
      ),
      // HIT STATES. Under the line model a missed hit is a distribution within
      // the line, not a separate comp — which is the whole point: a board that
      // failed to 3-star drags the line's number down instead of spawning a row
      // with a flattering one.
      query<{ hits: string[]; boards: number; placement_sum: string; top4: number; wins: number }>(
        `WITH per_board AS (
           SELECT mp.id, mp.placement,
                  COALESCE(array_agg(DISTINCT pu.character_id)
                    FILTER (WHERE pu.star_tier >= 3), '{}') AS hits
             FROM match_participants mp
             JOIN matches m ON m.match_id = mp.match_id
             JOIN participant_units pu ON pu.participant_id = mp.id
            WHERE mp.line_id = $1 AND m.patch_id = $2 AND m.region = ANY($4::text[])
              AND mp.tier = ANY($3::text[]) AND m.queue_id = $5
            GROUP BY mp.id, mp.placement
         )
         SELECT hits, COUNT(*)::int boards, SUM(placement)::text placement_sum,
                COUNT(*) FILTER (WHERE placement <= 4)::int top4,
                COUNT(*) FILTER (WHERE placement = 1)::int wins
           FROM per_board GROUP BY 1 ORDER BY 2 DESC LIMIT 12`,
        [lineId, line.patch_id, tiers, codes, RANKED_TFT_QUEUE_ID],
      ),
      // BUILDS, for the line's carries only. Item order is normalised so the
      // same three items in a different slot order are one build, not three.
      query<{ character_id: string; items: string[]; boards: number; placement_sum: string }>(
        `SELECT pu.character_id,
                (SELECT array_agg(x ORDER BY x) FROM unnest(pu.item_ids) x) AS items,
                COUNT(*)::int boards, SUM(mp.placement)::text placement_sum
           FROM match_participants mp
           JOIN matches m ON m.match_id = mp.match_id
           JOIN participant_units pu ON pu.participant_id = mp.id
          WHERE mp.line_id = $1 AND m.patch_id = $2 AND m.region = ANY($4::text[])
            AND mp.tier = ANY($3::text[]) AND m.queue_id = $5
            AND pu.character_id = ANY($6::text[])
            AND COALESCE(array_length(pu.item_ids, 1), 0) >= 2
          GROUP BY 1,2 ORDER BY 3 DESC`,
        [lineId, line.patch_id, tiers, codes, RANKED_TFT_QUEUE_ID, line.carries],
      ),
      query<{ units: string[]; boards: number; placement_sum: string }>(
        `WITH per_board AS (
           SELECT mp.id, mp.placement,
                  array_agg(DISTINCT pu.character_id) AS units
             FROM match_participants mp
             JOIN matches m ON m.match_id = mp.match_id
             JOIN participant_units pu ON pu.participant_id = mp.id
            WHERE mp.line_id = $1 AND m.patch_id = $2 AND m.region = ANY($4::text[])
              AND mp.tier = ANY($3::text[]) AND m.queue_id = $5
            GROUP BY mp.id, mp.placement
         )
         SELECT units, COUNT(*)::int boards, SUM(placement)::text placement_sum
           FROM per_board GROUP BY 1 ORDER BY 2 DESC LIMIT 5`,
        [lineId, line.patch_id, tiers, codes, RANKED_TFT_QUEUE_ID],
      ),
    ]);

  const metrics = metricsOf(pooled[0]);
  if (metrics.n === 0) return null;

  const fieldTotal = allLines.reduce((a, r) => a + r.n, 0);
  const cutoffs = tierCutoffs(allLines.filter((r) => r.n > 0).map((r) => metricsOf(r).score));

  // ── Units ────────────────────────────────────────────────────────────────
  const perStar = new Map<string, { star: number; boards: number; avg: number }[]>();
  for (const r of starRows) {
    const arr = perStar.get(r.character_id) ?? [];
    arr.push({ star: r.star_tier, boards: r.boards, avg: numOr(r.placement_sum) / (r.boards || 1) });
    perStar.set(r.character_id, arr);
  }

  const buildsByCarry = new Map<string, ExampleItemVM[][]>();
  const carrySets = new Map<string, { items: string[]; boards: number; avg: number }[]>();
  for (const r of buildRows) {
    const arr = carrySets.get(r.character_id) ?? [];
    arr.push({ items: r.items ?? [], boards: r.boards, avg: numOr(r.placement_sum) / (r.boards || 1) });
    carrySets.set(r.character_id, arr);
  }
  void buildsByCarry;

  const modalItemsFor = (id: string): ExampleItemVM[] => {
    const sets = carrySets.get(id);
    if (!sets || sets.length === 0) return [];
    return sets[0].items.map((it) => {
      const meta = cat.item(it);
      return { itemId: it, name: meta.name, iconUrl: meta.iconUrl };
    });
  };

  const units: DetailUnitVM[] = unitRows.map((r) => {
    const avg = numOr(r.placement_sum) / (r.boards || 1);
    const meta = cat.unit(r.character_id);
    return {
      characterId: meta.characterId,
      name: meta.name,
      cost: meta.cost,
      iconUrl: meta.iconUrl,
      freq: metrics.n > 0 ? r.boards / metrics.n : 0,
      modalStar: r.modal_star ?? 1,
      boards: r.boards,
      avgPlacement: avg,
      // Negative means the line does BETTER with this unit than without — the
      // comparison a reader actually wants from a unit row.
      delta: avg - metrics.avgPlacement,
      top4Rate: r.boards > 0 ? r.top4 / r.boards : 0,
      winRate: r.boards > 0 ? r.wins / r.boards : 0,
      perStar: (perStar.get(r.character_id) ?? [])
        .filter((s) => s.boards >= 5)
        .sort((a, b) => b.star - a.star)
        .map((s) => ({ star: s.star, boards: s.boards, avgPlacement: s.avg })),
      items: line.carries.includes(r.character_id) ? modalItemsFor(r.character_id) : [],
    };
  });

  const CORE_AT = 0.8;
  const FLEX_AT = 0.15;
  const core = units.filter((u) => u.freq >= CORE_AT).sort((a, b) => b.cost - a.cost || b.freq - a.freq);
  const flex = units
    .filter((u) => u.freq < CORE_AT && u.freq >= FLEX_AT)
    .sort((a, b) => b.freq - a.freq);

  // ── Hit states ───────────────────────────────────────────────────────────
  const variants: DetailVariantVM[] = hitRows.map((r) => {
    const hits = (r.hits ?? []).slice().sort();
    return {
      key: hits.join('|'),
      units: hits.map((id) => {
        const u = cat.unit(id);
        return { characterId: u.characterId, name: u.name, cost: u.cost, iconUrl: u.iconUrl };
      }),
      n: r.boards,
      share: metrics.n > 0 ? r.boards / metrics.n : 0,
      avgPlacement: numOr(r.placement_sum) / (r.boards || 1),
      top4Rate: r.boards > 0 ? r.top4 / r.boards : 0,
      winRate: r.boards > 0 ? r.wins / r.boards : 0,
    };
  });
  // Default to the hit-states panel only when hitting is what the line is about:
  // a reroll line's boards nearly all carry a 3★, a fast-8 line's rarely do.
  const withHits = variants.filter((v) => v.key !== '').reduce((a, v) => a + v.n, 0);
  const hitStatesDefault = metrics.n > 0 && withHits / metrics.n >= 0.5;

  // ── The rest ─────────────────────────────────────────────────────────────
  const levelBands: DetailLevelBandVM[] = levelRows
    .map((r) => ({
      band: r.band,
      share: metrics.n > 0 ? r.boards / metrics.n : 0,
      avgPlacement: numOr(r.placement_sum) / (r.boards || 1),
    }))
    .sort((a, b) => a.band.localeCompare(b.band));

  const placeMap = new Map(placeRows.map((r) => [r.placement, r.boards]));
  const placements: DetailPlacementVM[] = Array.from({ length: 8 }, (_, i) => {
    const boards = placeMap.get(i + 1) ?? 0;
    return { placement: i + 1, boards, share: metrics.n > 0 ? boards / metrics.n : 0 };
  });

  const trend: DetailTrendPointVM[] = trendRows.map((r) => ({
    date: r.date,
    games: r.games,
    avgPlacement: numOr(r.placement_sum) / (r.games || 1),
    top4Rate: r.games > 0 ? r.top4 / r.games : 0,
    playRate: fieldTotal > 0 ? r.games / fieldTotal : 0,
  }));

  const builds: DetailBuildVM[] = line.carries.map((id) => {
    const meta = cat.unit(id);
    const sets = carrySets.get(id) ?? [];
    const total = sets.reduce((a, s) => a + s.boards, 0);
    return {
      characterId: meta.characterId,
      name: meta.name,
      cost: meta.cost,
      iconUrl: meta.iconUrl,
      sets: sets.slice(0, 4).map((s) => ({
        items: s.items.map((it) => {
          const m = cat.item(it);
          return { itemId: it, name: m.name, iconUrl: m.iconUrl };
        }),
        boards: s.boards,
        rate: total > 0 ? s.boards / total : 0,
        avgPlacement: s.avg,
      })),
    };
  });

  const unitTraits = new Map(units.map((u) => [u.characterId, u]));
  const topBoards: DetailBoardVM[] = boardRows.map((r, i) => ({
    compId: -(i + 1), // synthetic: these are unit-sets within a line, not comps
    n: r.boards,
    avgPlacement: numOr(r.placement_sum) / (r.boards || 1),
    team: {
      units: (r.units ?? [])
        .map((id) => {
          const u = cat.unit(id);
          const stats = unitTraits.get(id);
          return {
            characterId: u.characterId,
            name: u.name,
            cost: u.cost,
            iconUrl: u.iconUrl,
            star: stats?.modalStar ?? 1,
            freq: stats?.freq ?? 1,
            items: [] as ExampleItemVM[],
          };
        })
        .sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name)),
      traits: [],
    },
  }));

  const keyTraits = line.trait_id
    ? (() => {
        const meta = cat.trait(line.trait_id!);
        const n = core.filter((u) => u.characterId).length;
        return [
          {
            traitId: meta.traitId,
            name: meta.name,
            iconUrl: meta.iconUrl,
            minUnits: n,
            style: styleAtUnits(meta.breakpoints, n),
          },
        ];
      })()
    : [];

  return {
    selection: { patchId: line.patch_id, patch: line.patch, region, rankBucket: scope },
    groupKey: lineKey(line.slug, line.id),
    // Emblem variants are a §10 gate the elect stage does not split on yet, so
    // one option — deliberately present rather than absent, so the page renders
    // the same shape under either model.
    variantOptions: [
      {
        key: '',
        label: 'All boards',
        emblems: [],
        tier: tierForScore(metrics.score, cutoffs),
        avgPlacement: metrics.avgPlacement,
        n: metrics.n,
        selected: true,
      },
    ],
    selectedVariant: '',
    identity: {
      compId: line.id,
      setNumber: cat.setNumber,
      name: line.name,
      archetype: null,
      displayName: line.name,
      signature: line.core_units.join('|'),
      carries: line.carries.map((id) => {
        const u = cat.unit(id);
        return { characterId: u.characterId, name: u.name, cost: u.cost, iconUrl: u.iconUrl };
      }),
      keyTraits,
      dupUnits: [],
      heroAugmentUnit: null,
      gatedUnits: [],
      emblems: [],
    },
    metrics,
    playRate: fieldTotal > 0 ? metrics.n / fieldTotal : 0,
    tier: tierForScore(metrics.score, cutoffs),
    // Boards, not member comps: a line has no members to fold, which is the
    // point of the model.
    memberCount: metrics.n,
    core,
    flex,
    unitsTable: units.filter((u) => u.freq >= FLEX_AT).sort((a, b) => b.freq - a.freq),
    levelBands,
    placements,
    trend,
    variants,
    hitStatesDefault,
    builds,
    topBoards,
  };
}

/** Scopes that actually have boards for this line, for the page's dial. */
export async function getLineScopes(lineId: number, patchId: number, region: string) {
  const rows = await query<{ tier: string | null; n: number }>(
    `SELECT tier, SUM(n)::int n FROM line_stats
      WHERE line_id = $1 AND patch_id = $2 AND region = $3 GROUP BY 1`,
    [lineId, patchId, region],
  );
  const byTier = new Map(rows.map((r) => [r.tier ?? '', r.n]));
  return SCOPES.map((s) => {
    const floor = s.slice(0, -1).toUpperCase();
    const n = TIER_ORDER.slice(TIER_ORDER.indexOf(floor as (typeof TIER_ORDER)[number])).reduce(
      (a, t) => a + (byTier.get(t) ?? 0),
      0,
    );
    return { scope: s, boards: n };
  }).filter((s) => s.boards > 0);
}
