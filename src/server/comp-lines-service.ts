import { query } from '@/lib/db';
import { getCatalog } from './static-data';
import { styleAtUnits } from './comps-example-team';
import { tiersAtOrAbove } from '@/config/rank-buckets';
import { computeMetrics, tierCutoffs, tierForScore } from './queue/comp-stats-math';
import type {
  CompRowVM,
  ExampleTeamVM,
  ExampleUnitVM,
  PatchOption,
  TierGroupVM,
  TierListQuery,
  TierListVM,
} from './comps-types';

// comp-lines-service.ts — the tier list read from the presence-profile model.
//
// Produces the SAME TierListVM the legacy path does, so the page and every
// component below it are untouched and the two models can be swapped with a flag
// rather than a rewrite. `comps-service.getTierListCached` dispatches on
// COMPS_MODEL.
//
// TWO THINGS DIFFER FROM THE LEGACY PATH, both deliberate:
//
//   NO RANK PICKER. Lines are elected from master+ and the list is always the
//   master+ verdict. A board that wins in Iron and loses in Master is not a
//   different meta — Iron is less punishing, so it tolerates plays that do not
//   work — and the way to stop low-elo placement deciding which comps are S-tier
//   is to have no dial on the page that produces the verdict, rather than to
//   label around one. The dial belongs on the detail page, where it recalculates
//   a line's numbers for a scope the reader asked for explicitly.
//
//   A COVERAGE TARGET, NOT A SAMPLE FLOOR. The legacy list shows every comp over
//   a fixed board count, which lists 20 lines on day one of a patch and 200 by
//   the end of it. Lines are listed until they account for LIST_COVERAGE of the
//   boards that found a line, which keys on the shape of the distribution rather
//   than on counts and so stays about the same length as a patch fills.

const num = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** Share of homed boards the listed lines should account for. The denominator is
 *  the homed population, not every board: off-meta boards are not a line, so
 *  counting them would make the target unreachable and quietly turn the rule
 *  back into "list everything". */
const LIST_COVERAGE = num(process.env.CENTROID_LIST_COVERAGE, 0.8);
/** Safety floor under the coverage target, so a near-empty early-patch scope
 *  does not list lines with three boards just because they are the biggest. */
const LIST_MIN_BOARDS = num(process.env.CENTROID_LIST_MIN_BOARDS, 20);

/** The scope the tier list is always computed at. */
const VERDICT_FLOOR = process.env.ELECT_TIER_FLOOR ?? 'MASTER';

interface LineRow {
  id: number;
  name: string;
  slug: string;
  carries: string[];
  trait_id: string | null;
  core_units: string[];
  example_board: unknown;
  elected_boards: number;
  n: number;
  placement_sum: string;
  placement_sumsq: string;
  top4_count: number;
  win_count: number;
}

interface ExampleUnitRow {
  characterId: string;
  rate: number;
  star: number;
  items: string[];
}

/** `<slug>-<id>`: the slug is cosmetic and may change when a naming collision
 *  resolves, the id is what resolves the route. A rename therefore never 404s a
 *  shared link — the failure the old `##k:` anchor caused every time membership
 *  was rebuilt. */
export const lineKey = (slug: string, id: number): string => `${slug}-${id}`;

/** Parse a `<slug>-<id>` key back to its id. Returns null when there is no
 *  trailing id, so a hand-typed or truncated URL 404s rather than resolving to
 *  something arbitrary. */
export function lineIdFromKey(key: string): number | null {
  const m = /-(\d+)$/.exec(key);
  return m ? Number(m[1]) : null;
}

/** unit → trait ids for the live set. The catalog's `unit()` does not carry
 *  them, and the example board's trait chips have to be derived from the board
 *  itself rather than stored: the board is the authority on what a line fields,
 *  and a stored trait list could disagree with it after a re-election. ~90 rows. */
export async function unitTraitMap(setNumber: number): Promise<Map<string, string[]>> {
  const rows = await query<{ character_id: string; trait_ids: string[] | null }>(
    `SELECT character_id, trait_ids FROM units WHERE set_number = $1`,
    [setNumber],
  );
  return new Map(rows.map((r) => [r.character_id, r.trait_ids ?? []]));
}

export function buildExampleTeam(
  raw: unknown,
  cat: Awaited<ReturnType<typeof getCatalog>>,
  unitTraits: Map<string, string[]>,
): ExampleTeamVM {
  const rows = Array.isArray(raw) ? (raw as ExampleUnitRow[]) : [];
  const units: ExampleUnitVM[] = rows.map((u) => {
    const meta = cat.unit(u.characterId);
    return {
      characterId: meta.characterId,
      name: meta.name,
      cost: meta.cost,
      iconUrl: meta.iconUrl,
      star: u.star,
      freq: u.rate,
      items: (u.items ?? []).map((id) => {
        const it = cat.item(id);
        return { itemId: id, name: it.name, iconUrl: it.iconUrl };
      }),
    };
  });
  units.sort((a, b) => b.cost - a.cost || b.freq - a.freq || a.name.localeCompare(b.name));

  // Traits are DERIVED from the board rather than stored: the board is the
  // authority on what this line fields, and a stored trait list could disagree
  // with it after a re-election.
  const counts = new Map<string, number>();
  for (const u of units) {
    for (const t of unitTraits.get(u.characterId) ?? []) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  const traits = [...counts.entries()]
    .map(([traitId, n]) => {
      const meta = cat.trait(traitId);
      return {
        traitId,
        name: meta.name,
        iconUrl: meta.iconUrl,
        numUnits: n,
        style: styleAtUnits(meta.breakpoints, n),
        unique: (meta.breakpoints?.length ?? 0) <= 1,
        freq: 1,
      };
    })
    .filter((t) => t.style > 0)
    .sort((a, b) => b.style - a.style || b.numUnits - a.numUnits || a.name.localeCompare(b.name));

  return { units, traits };
}

export async function getLineTierList(q: TierListQuery = {}): Promise<TierListVM> {
  const cat = await getCatalog();
  const unitTraits = await unitTraitMap(cat.setNumber);
  const empty: TierListVM = {
    selection: null,
    options: { patches: [], regions: [], buckets: [] },
    bucketTotal: 0,
    groups: [],
    ranked: 0,
    niche: null,
    nicheAvailable: 0,
  };

  // Scopes that actually have elected lines behind them.
  const scopes = await query<{ patch_id: number; patch: string; label: string | null; is_current: boolean; region: string; boards: number }>(
    `SELECT p.id AS patch_id, p.patch, p.label, p.is_current, ls.region, SUM(ls.n)::int AS boards
       FROM line_stats ls
       JOIN patches p ON p.id = ls.patch_id
      GROUP BY 1,2,3,4,5
      ORDER BY 6 DESC`,
  );
  if (scopes.length === 0) return empty;

  const patchMap = new Map<number, PatchOption>();
  for (const s of scopes) {
    if (!patchMap.has(s.patch_id)) {
      patchMap.set(s.patch_id, {
        patchId: s.patch_id,
        patch: s.patch,
        label: s.label,
        isCurrent: s.is_current,
      });
    }
  }
  const patches = [...patchMap.values()].sort(
    (a, b) => Number(b.isCurrent) - Number(a.isCurrent) || b.patchId - a.patchId,
  );
  const chosenPatch = q.patchId && patchMap.has(q.patchId) ? q.patchId : patches[0].patchId;

  const regionBoards = new Map<string, number>();
  for (const s of scopes) {
    if (s.patch_id !== chosenPatch) continue;
    regionBoards.set(s.region, (regionBoards.get(s.region) ?? 0) + s.boards);
  }
  const regions = [...regionBoards.keys()].sort(
    (a, b) => (regionBoards.get(b) ?? 0) - (regionBoards.get(a) ?? 0) || a.localeCompare(b),
  );
  if (regions.length === 0) return empty;
  const chosenRegion = q.region && regions.includes(q.region) ? q.region : regions[0];

  // The verdict is always the electing scope. Tiers are stored DISJOINT and
  // summed here, because the cumulative scopes overlap and storing them directly
  // would double-count every board.
  const verdictTiers = tiersAtOrAbove(VERDICT_FLOOR);
  const rows = await query<LineRow>(
    `SELECT cl.id, cl.name, cl.slug, cl.carries, cl.trait_id, cl.core_units,
            cl.example_board, cl.elected_boards,
            COALESCE(SUM(ls.n), 0)::int AS n,
            COALESCE(SUM(ls.placement_sum), 0)::text AS placement_sum,
            COALESCE(SUM(ls.placement_sumsq), 0)::text AS placement_sumsq,
            COALESCE(SUM(ls.top4_count), 0)::int AS top4_count,
            COALESCE(SUM(ls.win_count), 0)::int AS win_count
       FROM comp_lines cl
       LEFT JOIN line_stats ls
         ON ls.line_id = cl.id AND ls.patch_id = cl.patch_id
        AND ls.region = $2 AND ls.tier = ANY($3::text[])
      WHERE cl.patch_id = $1
      GROUP BY cl.id
      ORDER BY n DESC, cl.id`,
    [chosenPatch, chosenRegion, verdictTiers],
  );

  const withBoards = rows.filter((r) => r.n > 0);
  const homedTotal = withBoards.reduce((a, r) => a + r.n, 0);
  if (homedTotal === 0) return empty;

  // Coverage target, with the absolute floor as a backstop.
  const target = homedTotal * LIST_COVERAGE;
  const listed: LineRow[] = [];
  let acc = 0;
  for (const r of withBoards) {
    if (r.n < LIST_MIN_BOARDS) break;
    listed.push(r);
    acc += r.n;
    if (acc >= target) break;
  }
  const listedIds = new Set(listed.map((r) => r.id));
  const below = withBoards.filter((r) => !listedIds.has(r.id));

  const toRow = (r: LineRow, cutoffs: ReturnType<typeof tierCutoffs>): CompRowVM => {
    const metrics = computeMetrics({
      n: r.n,
      placementSum: Number(r.placement_sum),
      placementSumsq: Number(r.placement_sumsq),
      top4Count: r.top4_count,
      winCount: r.win_count,
    });
    const carries = r.carries.map((id) => {
      const u = cat.unit(id);
      return { characterId: u.characterId, name: u.name, cost: u.cost, iconUrl: u.iconUrl };
    });
    const keyTraits = r.trait_id
      ? [
          (() => {
            const meta = cat.trait(r.trait_id!);
            const n = r.core_units.filter((u) =>
              (unitTraits.get(u) ?? []).includes(r.trait_id!),
            ).length;
            return {
              traitId: meta.traitId,
              name: meta.name,
              iconUrl: meta.iconUrl,
              minUnits: n,
              style: styleAtUnits(meta.breakpoints, n),
            };
          })(),
        ]
      : [];

    return {
      identity: {
        compId: r.id,
        setNumber: cat.setNumber,
        name: r.name,
        archetype: null,
        displayName: r.name,
        signature: r.core_units.join('|'),
        carries,
        keyTraits,
        dupUnits: [],
        heroAugmentUnit: null,
        gatedUnits: [],
        emblems: [],
      },
      groupKey: lineKey(r.slug, r.id),
      metrics,
      playRate: homedTotal > 0 ? r.n / homedTotal : 0,
      tier: tierForScore(metrics.score, cutoffs),
      rankOrder: null,
      isManual: false,
      exampleTeam: buildExampleTeam(r.example_board, cat, unitTraits),
      variantCount: 1,
    };
  };

  const cutoffs = tierCutoffs(
    listed.map((r) =>
      computeMetrics({
        n: r.n,
        placementSum: Number(r.placement_sum),
        placementSumsq: Number(r.placement_sumsq),
        top4Count: r.top4_count,
        winCount: r.win_count,
      }).score,
    ),
  );

  const listedRows = listed.map((r) => toRow(r, cutoffs));
  const byTier = new Map<string, CompRowVM[]>();
  for (const row of listedRows) {
    const arr = byTier.get(row.tier);
    if (arr) arr.push(row);
    else byTier.set(row.tier, [row]);
  }
  const groups: TierGroupVM[] = ['S', 'A', 'B', 'C', 'D']
    .filter((t) => byTier.has(t))
    .map((tier) => ({
      tier,
      comps: (byTier.get(tier) ?? []).sort((a, b) => b.metrics.score - a.metrics.score),
    }));

  return {
    selection: {
      patchId: chosenPatch,
      patch: patchMap.get(chosenPatch)!.patch,
      region: chosenRegion,
      // Labelled so the page states the verdict's scope rather than implying the
      // reader chose it — there is no picker for it here by design.
      rankBucket: `${VERDICT_FLOOR.toLowerCase()}+`,
    },
    options: { patches, regions, buckets: [] },
    bucketTotal: homedTotal,
    groups,
    ranked: listedRows.length,
    niche: q.niche ? below.map((r) => toRow(r, cutoffs)) : null,
    nicheAvailable: below.length,
  };
}
