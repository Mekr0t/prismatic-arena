// comp-inspector.ts — admin/debug read model for the merge stage.
//
// Merge folds exact-board comps that share a carry archetype into one meta_comp
// label (comps-service groups the tier list on it). This is the debug counterpart:
// it lists every archetype and, for each, the individual comps that merge grouped
// into it, so the grouping can be eyeballed.
//
//   Over-merge  (two genuinely different comps under one label) → an out-of-place
//               member INSIDE an archetype's member list.
//   Under-merge (fragments that should have merged but didn't) → two near-identical
//               archetypes side by side in the list. That's why each archetype
//               carries its representative board's units — so the list is scannable
//               for duplicate-looking rows.
//
// Set-scoped, because merge identity is set-scoped. Stats are summed across every
// (patch, region, rank_bucket) row for each comp: for judging the grouping, unit
// and carry composition matters more than any single bucket's numbers.
//
// FLOORED to merge's input floor. The inspector shows only comps whose best
// single-bucket sample reaches the floor — the same set merge currently labels
// (~tier-list-sized). Without this it renders the entire historical long tail,
// INCLUDING stale labels left in meta_comp from before merge was filtered, which
// is what hung the page.

import { query } from '@/lib/db';
import { getCatalog } from './static-data';

const _num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

// Same floor as the merge stage (MERGE_MIN_SAMPLE, defaulting to TIER_MIN_SAMPLE)
// so the inspector and merge agree on which comps are in play.
const INSPECTOR_MIN_SAMPLE = _num(process.env.MERGE_MIN_SAMPLE ?? process.env.TIER_MIN_SAMPLE, 15);

export interface InspectorUnitVM {
  characterId: string;
  name: string;
  cost: number; // 1..5; 0 if unknown
  iconUrl: string | null;
  isThreeStar: boolean; // from comps.carries (cluster's 3-star set)
  isHeroAugment: boolean; // this unit is the archetype's hero-augment carry
}

export interface InspectorMemberVM {
  compId: number;
  signature: string; // raw exact-board signature (tooltip / diff aid)
  units: InspectorUnitVM[]; // cost desc
  boards: number; // Σ comp_stats.n across all buckets
  avgPlacement: number;
  top4Rate: number;
  winRate: number;
}

export interface InspectorArchetypeVM {
  label: string; // meta_comp: '<carryIds>[##dup:<doubledIds>][##aug:<champId>]'
  carryNames: string[]; // carry section of the label, resolved to unit names
  dupUnits: string[]; // units doubled via the copy augment ([] for a classic build)
  heroAugmentUnit: string | null; // hero-augment carry name, null for a non-augment build
  setNumber: number;
  memberCount: number;
  totalBoards: number;
  avgPlacement: number; // pooled across members
  top4Rate: number;
  winRate: number;
  repCompId: number; // highest-n member (the archetype's canonical form)
  repUnits: InspectorUnitVM[]; // representative board's units (scan for under-merge)
  members: InspectorMemberVM[]; // boards desc
}

export interface InspectorVM {
  setNumber: number | null;
  archetypes: InspectorArchetypeVM[]; // totalBoards desc
}

type CatalogT = Awaited<ReturnType<typeof getCatalog>>;

interface Row {
  id: number;
  set_number: number;
  signature: string;
  core_units: string[]; // jsonb → string[]
  carries: { character_id: string }[]; // jsonb [{character_id, items}]
  meta_comp: string; // guaranteed non-null by the WHERE clause
  boards: string; // bigint/numeric → string
  placement_sum: string;
  top4_count: string;
  win_count: string;
}

const rate = (num: number, den: number): number => (den > 0 ? num / den : 0);

function resolveUnits(
  coreUnits: string[],
  threeStars: Set<string>,
  heroAugmentId: string | null,
  cat: CatalogT,
): InspectorUnitVM[] {
  return coreUnits
    .map((id) => {
      const u = cat.unit(id);
      return {
        characterId: u.characterId,
        name: u.name,
        cost: u.cost,
        iconUrl: u.iconUrl,
        isThreeStar: threeStars.has(id),
        isHeroAugment: heroAugmentId === id,
      };
    })
    .sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name));
}

/**
 * Load every merge archetype with its member comps for the admin inspector.
 *
 * @param setNumber  Scope to one set; default (undefined) = every set with labels.
 */
export async function loadArchetypeInspector(setNumber?: number): Promise<InspectorVM> {
  // One pass: every labeled comp AT OR ABOVE the merge floor, with its stats
  // summed across all buckets. The HAVING is what bounds the result to the comps
  // merge actually considers — and excludes stale sub-threshold labels.
  const rows = await query<Row>(
    `SELECT c.id, c.set_number, c.signature, c.core_units, c.carries, c.meta_comp,
            COALESCE(SUM(cs.n), 0)             AS boards,
            COALESCE(SUM(cs.placement_sum), 0) AS placement_sum,
            COALESCE(SUM(cs.top4_count), 0)    AS top4_count,
            COALESCE(SUM(cs.win_count), 0)     AS win_count
       FROM comps c
       LEFT JOIN comp_stats cs ON cs.comp_id = c.id
      WHERE c.meta_comp IS NOT NULL
        AND ($1::int IS NULL OR c.set_number = $1)
      GROUP BY c.id
     HAVING MAX(cs.n) >= $2::int`,
    [setNumber ?? null, INSPECTOR_MIN_SAMPLE],
  );

  const cat = await getCatalog();

  const byLabel = new Map<string, Row[]>();
  for (const r of rows) {
    const arr = byLabel.get(r.meta_comp);
    if (arr) arr.push(r);
    else byLabel.set(r.meta_comp, [r]);
  }

  const archetypes: InspectorArchetypeVM[] = [];

  for (const [label, group] of byLabel) {
    // Label is "<carryIds>[##dup:<doubledIds>][##aug:<champId>]". Split the
    // tag segments off before resolving carry names — each becomes a badge —
    // and the raw hero-augment champ id is needed up front to tag units below.
    const [carryPart, ...tags] = label.split('##');
    let dupPart: string | undefined;
    let heroAugmentId: string | null = null;
    for (const tag of tags) {
      if (tag.startsWith('dup:')) dupPart = tag.slice(4);
      else if (tag.startsWith('aug:')) heroAugmentId = tag.slice(4);
    }
    const carryNames =
      carryPart === 'no_carry' ? [] : carryPart.split('|').map((id) => cat.unit(id).name);
    const dupUnits = dupPart ? dupPart.split('|').map((id) => cat.unit(id).name) : [];
    const heroAugmentUnit = heroAugmentId ? cat.unit(heroAugmentId).name : null;

    const members: InspectorMemberVM[] = group.map((r) => {
      const threeStars = new Set(r.carries.map((c) => c.character_id));
      const boards = Number(r.boards);
      return {
        compId: r.id,
        signature: r.signature,
        units: resolveUnits(r.core_units, threeStars, heroAugmentId, cat),
        boards,
        avgPlacement: rate(Number(r.placement_sum), boards),
        top4Rate: rate(Number(r.top4_count), boards),
        winRate: rate(Number(r.win_count), boards),
      };
    });
    members.sort((a, b) => b.boards - a.boards || a.compId - b.compId);

    let boards = 0;
    let placementSum = 0;
    let top4 = 0;
    let win = 0;
    for (const r of group) {
      boards += Number(r.boards);
      placementSum += Number(r.placement_sum);
      top4 += Number(r.top4_count);
      win += Number(r.win_count);
    }

    const rep = members[0];

    archetypes.push({
      label,
      carryNames,
      dupUnits,
      heroAugmentUnit,
      setNumber: group[0].set_number,
      memberCount: group.length,
      totalBoards: boards,
      avgPlacement: rate(placementSum, boards),
      top4Rate: rate(top4, boards),
      winRate: rate(win, boards),
      repCompId: rep?.compId ?? group[0].id,
      repUnits: rep?.units ?? [],
      members,
    });
  }

  archetypes.sort((a, b) => b.totalBoards - a.totalBoards || a.label.localeCompare(b.label));

  return { setNumber: setNumber ?? null, archetypes };
}