// comps-example-team.ts — aggregate the most-common board per comp.
// Extracted from comps-service.ts so that file stays focused on the
// selector / tier-grouping pipeline.  This module owns every item- and
// board-level detail: DB queries, component/item filtering, star/copy logic.

import { query } from '@/lib/db';
import { getCatalog } from './static-data';
import type {
  ExampleItemVM,
  ExampleUnitVM,
  ExampleTraitVM,
  ExampleTeamVM,
} from './comps-types';

type CatalogT = Awaited<ReturnType<typeof getCatalog>>;

// ── Trait style helpers ───────────────────────────────────────────────────────
// Exported so comps-service.ts can reuse them for key-trait chips in
// buildIdentity without creating a circular dependency.

/** Map Riot's trait style enum (1=bronze, 3=silver, 5=gold, 6=prismatic) to the
 *  UI's 1..4 scale. Values 2/4 are unused in Set 17; thresholds (not a lookup
 *  table) so unforeseen intermediate styles degrade gracefully. */
export function breakpointStyleToTier(style: number): number {
  if (style >= 6) return 4; // prismatic / chromatic
  if (style >= 5) return 3; // gold
  if (style >= 3) return 2; // silver
  if (style >= 1) return 1; // bronze
  return 0;
}

/** UI chip tier (1..4) at a given unit count from ascending breakpoints.
 *  Returns 0 when no breakpoint is met (trait inactive per CDragon data).
 *  Falls back to 2 (silver) only when CDragon has NO breakpoints for the
 *  trait at all — missing static data — so the chip still renders rather
 *  than silently disappearing. */
export function styleAtUnits(
  breakpoints: { minUnits: number; style: number }[],
  units: number,
): number {
  let raw = 0;
  for (const b of breakpoints) if (units >= b.minUnits) raw = b.style;
  if (raw < 1) {
    // Breakpoints exist but none reached → trait is inactive; return 0 so
    // the caller can filter it out. No breakpoints → CDragon data missing,
    // fall back to silver so the trait still renders.
    return breakpoints.length > 0 ? 0 : 2;
  }
  return breakpointStyleToTier(raw);
}

// ── Tunables (env-overridable) ────────────────────────────────────────────────

const num = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const EX_UNIT_MIN_FREQ = num(process.env.EX_UNIT_MIN_FREQ, 0.5);
const EX_TRAIT_MIN_FREQ = num(process.env.EX_TRAIT_MIN_FREQ, 0.5);
const EX_UNIT_CAP = num(process.env.EX_UNIT_CAP, 10);
const EX_TRAIT_CAP = num(process.env.EX_TRAIT_CAP, 10);
// Items: show a unit's items only if it's fully itemized in > this share of the
// comp's games; "fully itemized" = at least EX_ITEM_COMPLETE completed items;
// then show the EX_ITEM_CAP most-played items.
const EX_ITEM_MIN_FREQ = num(process.env.EX_ITEM_MIN_FREQ, 0.5);
const EX_ITEM_COMPLETE = num(process.env.EX_ITEM_COMPLETE, 3);
const EX_ITEM_CAP = num(process.env.EX_ITEM_CAP, 3);

export const EMPTY_TEAM: ExampleTeamVM = { units: [], traits: [] };

// Base components — excluded when counting "completed" items and from the items
// shown. Everything NOT in this set (finished items, radiants, artifacts, trait
// emblems) counts as completed. IDs are set-agnostic (TFT_Item_*).
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

// Thief's Gloves equips 2 random items and occupies all 3 slots — when present
// the other "items" are ephemeral randoms that don't represent a real build.
const THIEVES_GLOVES_ID = 'TFT_Item_ThiefsGloves';

// ── DB row shapes ─────────────────────────────────────────────────────────────

interface UnitAggRow {
  comp_id: number;
  character_id: string;
  copies: number; // copies of this unit on a board (>1 = duplicate-copy augment)
  stars: (number | null)[]; // star tier per copy, descending
  boards: number; // boards with exactly this (copies, stars) shape
}
interface TraitAggRow {
  comp_id: number;
  trait_id: string;
  num_units: number | null;
  active_style: number | null;
  cnt: number;
}
interface ItemAggRow {
  comp_id: number;
  character_id: string;
  item_ids: string[] | null; // items of the most-itemized copy on one board
}

// ── Main export ───────────────────────────────────────────────────────────────

/** Most-common board per comp, scoped to the same (patch, region, bucket) the
 *  stats describe. Set-based: three grouped queries over all comp_ids at once. */
export async function loadExampleTeams(
  compIds: number[],
  patchId: number,
  region: string,
  rankBucket: string,
  nByComp: Map<number, number>,
  cat: CatalogT,
): Promise<Map<number, ExampleTeamVM>> {
  const out = new Map<number, ExampleTeamVM>();
  if (compIds.length === 0) return out;

  const [unitRows, traitRows, itemRows] = await Promise.all([
    query<UnitAggRow>(
      // Per board, a unit can occupy >1 slot (the duplicate-copy augment fields a
      // second copy of a 3-star). Aggregate per board first — copies and the star
      // of each copy — then group identical (copies, stars) shapes, so the example
      // board can render the MODAL number of copies instead of collapsing a
      // twice-fielded unit into a single tile.
      `WITH pb AS (
         SELECT mp.comp_id, pu.character_id, mp.id AS pid,
                count(*)::int AS copies,
                array_agg(pu.star_tier ORDER BY pu.star_tier DESC NULLS LAST) AS stars
           FROM match_participants mp
           JOIN matches m ON m.match_id = mp.match_id
           JOIN participant_units pu ON pu.participant_id = mp.id
          WHERE mp.comp_id = ANY($1::int[])
            AND m.patch_id = $2 AND m.region = $3 AND mp.rank_bucket = $4
            AND m.queue_id = 1100
          GROUP BY mp.comp_id, pu.character_id, mp.id
       )
       SELECT comp_id, character_id, copies, stars, count(*)::int AS boards
         FROM pb
        GROUP BY comp_id, character_id, copies, stars`,
      [compIds, patchId, region, rankBucket],
    ),
    query<TraitAggRow>(
      `SELECT mp.comp_id, pt.trait_id, pt.num_units, pt.active_style, count(*)::int AS cnt
         FROM match_participants mp
         JOIN matches m ON m.match_id = mp.match_id
         JOIN participant_traits pt ON pt.participant_id = mp.id
        WHERE mp.comp_id = ANY($1::int[])
          AND m.patch_id = $2 AND m.region = $3 AND mp.rank_bucket = $4
          AND m.queue_id = 1100
          AND pt.num_units > 0
        GROUP BY mp.comp_id, pt.trait_id, pt.num_units, pt.active_style`,
      [compIds, patchId, region, rankBucket],
    ),
    query<ItemAggRow>(
      // For each (comp, unit, board), take the items of the most-itemized copy —
      // so the duplicate-copy augment's spare (usually item-less) copy doesn't
      // dilute the carry's item stats. One row per board; completion and the
      // top-3 frequency are computed in JS (the component set lives in code, and
      // artifacts/emblems are simply non-components so they count as completed).
      `WITH ub AS (
         SELECT mp.comp_id, pu.character_id, pu.item_ids,
                row_number() OVER (
                  PARTITION BY mp.comp_id, pu.character_id, mp.id
                  ORDER BY coalesce(array_length(pu.item_ids, 1), 0) DESC
                ) AS rn
           FROM match_participants mp
           JOIN matches m ON m.match_id = mp.match_id
           JOIN participant_units pu ON pu.participant_id = mp.id
          WHERE mp.comp_id = ANY($1::int[])
            AND m.patch_id = $2 AND m.region = $3 AND mp.rank_bucket = $4
            AND m.queue_id = 1100
       )
       SELECT comp_id, character_id, item_ids FROM ub WHERE rn = 1`,
      [compIds, patchId, region, rankBucket],
    ),
  ]);

  // Per unit: how many boards contain it (for the freq threshold) and, keyed by
  // copies-per-board, the distribution of star shapes — so we can render the
  // modal copy count with its modal stars (e.g. one 3-star + one 2-star Samira).
  interface StarShape {
    boards: number;
    stars: number[]; // one star tier per copy, descending
  }
  interface CopiesAcc {
    boards: number;
    byStars: Map<string, StarShape>;
  }
  interface UnitAcc {
    boardsWithUnit: number;
    byCopies: Map<number, CopiesAcc>;
  }
  const unitsByComp = new Map<number, Map<string, UnitAcc>>();
  for (const r of unitRows) {
    let perComp = unitsByComp.get(r.comp_id);
    if (!perComp) {
      perComp = new Map();
      unitsByComp.set(r.comp_id, perComp);
    }
    let acc = perComp.get(r.character_id);
    if (!acc) {
      acc = { boardsWithUnit: 0, byCopies: new Map() };
      perComp.set(r.character_id, acc);
    }
    acc.boardsWithUnit += r.boards;
    const stars = r.stars.map((s) => s ?? 0);
    let cp = acc.byCopies.get(r.copies);
    if (!cp) {
      cp = { boards: 0, byStars: new Map() };
      acc.byCopies.set(r.copies, cp);
    }
    cp.boards += r.boards;
    const starsKey = stars.join(',');
    const sh = cp.byStars.get(starsKey);
    if (sh) sh.boards += r.boards;
    else cp.byStars.set(starsKey, { boards: r.boards, stars });
  }

  interface TraitAcc {
    appears: number;
    combo: Map<string, { units: number; style: number; cnt: number }>;
  }
  const traitsByComp = new Map<number, Map<string, TraitAcc>>();
  for (const r of traitRows) {
    let perComp = traitsByComp.get(r.comp_id);
    if (!perComp) {
      perComp = new Map();
      traitsByComp.set(r.comp_id, perComp);
    }
    // Normalize variant IDs to their canonical parent (e.g. TFT17_Stargazer_Wolf →
    // TFT17_Stargazer) so constellation/path variants count toward the same trait.
    const canonId = cat.normalizeTraitId(r.trait_id);
    let acc = perComp.get(canonId);
    if (!acc) {
      acc = { appears: 0, combo: new Map() };
      perComp.set(canonId, acc);
    }
    acc.appears += r.cnt;
    const u = r.num_units ?? 0;
    const s = r.active_style ?? 0;
    const key = `${u}:${s}`;
    const c = acc.combo.get(key);
    if (c) c.cnt += r.cnt;
    else acc.combo.set(key, { units: u, style: s, cnt: r.cnt });
  }

  // Per (comp, unit): how many boards had the unit fully itemized (>= EX_ITEM_COMPLETE
  // completed items) and, among those boards, the frequency of each complete item
  // SET — so we can show the single most-played build, not 3 items that may never be
  // built together. Components are excluded; artifacts/emblems count as completed.
  interface ItemAcc {
    itemizedBoards: number;
    sets: Map<string, { count: number; items: string[] }>; // sorted-key → count + display order
  }
  const itemsByComp = new Map<number, Map<string, ItemAcc>>();
  for (const r of itemRows) {
    const completed = (r.item_ids ?? []).filter((id) => !COMPONENT_ITEMS.has(id));
    let perComp = itemsByComp.get(r.comp_id);
    if (!perComp) {
      perComp = new Map();
      itemsByComp.set(r.comp_id, perComp);
    }
    let acc = perComp.get(r.character_id);
    if (!acc) {
      acc = { itemizedBoards: 0, sets: new Map() };
      perComp.set(r.character_id, acc);
    }
    if (completed.length < EX_ITEM_COMPLETE) continue; // not a full build → no set
    acc.itemizedBoards += 1;
    // Key on the sorted multiset so item order doesn't split a build; keep the
    // first board's original order for display.
    const key = [...completed].sort().join('|');
    const s = acc.sets.get(key);
    if (s) s.count += 1;
    else acc.sets.set(key, { count: 1, items: completed });
  }

  for (const compId of compIds) {
    const n = nByComp.get(compId) ?? 0;
    if (n <= 0) {
      out.set(compId, EMPTY_TEAM);
      continue;
    }

    const unitsAcc = unitsByComp.get(compId);
    const units: ExampleUnitVM[] = [];
    if (unitsAcc) {
      for (const [characterId, acc] of unitsAcc) {
        const freq = acc.boardsWithUnit / n;
        if (freq < EX_UNIT_MIN_FREQ) continue;
        const meta = cat.unit(characterId);
        if (meta.cost > 5) continue; // drop summons (e.g. Bia & Bayin, cost 11)

        // Modal copies-per-board, then the modal star shape within that — so a
        // unit usually fielded twice (duplicate augment) renders two tiles with
        // its typical stars, while a normal unit renders one.
        let modalCopies: CopiesAcc | null = null;
        let bestCopiesBoards = -1;
        for (const cp of acc.byCopies.values())
          if (cp.boards > bestCopiesBoards) {
            bestCopiesBoards = cp.boards;
            modalCopies = cp;
          }
        let stars: number[] = [0];
        if (modalCopies) {
          let bestShapeBoards = -1;
          for (const sh of modalCopies.byStars.values())
            if (sh.boards > bestShapeBoards) {
              bestShapeBoards = sh.boards;
              stars = sh.stars.length > 0 ? sh.stars : [0];
            }
        }

        // Items: only when the unit is fully itemized in > EX_ITEM_MIN_FREQ of the
        // comp's games; then its single most-played complete set, resolved to icons.
        let items: ExampleItemVM[] = [];
        const itemAcc = itemsByComp.get(compId)?.get(characterId);
        if (itemAcc && itemAcc.itemizedBoards / n > EX_ITEM_MIN_FREQ) {
          let best: { count: number; items: string[] } | null = null;
          for (const s of itemAcc.sets.values()) if (!best || s.count > best.count) best = s;
          if (best) {
            // ThievesGloves occupies all 3 slots with random items — only show it.
            const ids = best.items.includes(THIEVES_GLOVES_ID)
              ? [THIEVES_GLOVES_ID]
              : best.items.slice(0, EX_ITEM_CAP);
            items = ids.map((id) => {
              const it = cat.item(id);
              return { itemId: it.itemId, name: it.name, iconUrl: it.iconUrl };
            });
          }
        }

        // One tile per copy (stars already descending, so 3★ renders before 2★).
        // Items belong to the carry copy (the highest star / most-itemized), so
        // only the first tile carries them; a duplicate spare stays item-less.
        for (let i = 0; i < stars.length; i += 1) {
          units.push({
            characterId: meta.characterId,
            name: meta.name,
            cost: meta.cost,
            iconUrl: meta.iconUrl,
            star: stars[i],
            freq,
            items: i === 0 ? items : [],
          });
        }
      }
      // Cap at EX_UNIT_CAP by keeping the most-common tiles (drop lowest frequency
      // beyond the cap), then order the kept board by cost for display. The sort is
      // stable, so a duplicated unit's tiles stay adjacent in descending star order.
      units.sort((a, b) => b.freq - a.freq || b.cost - a.cost || a.name.localeCompare(b.name));
      units.splice(EX_UNIT_CAP);
      units.sort((a, b) => b.cost - a.cost || b.freq - a.freq || a.name.localeCompare(b.name));
    }

    const traitsAcc = traitsByComp.get(compId);
    const traits: ExampleTraitVM[] = [];
    if (traitsAcc) {
      for (const [traitId, acc] of traitsAcc) {
        const freq = acc.appears / n;
        if (freq < EX_TRAIT_MIN_FREQ) continue;
        let mUnits = 0;
        let bestCombo = -1;
        for (const c of acc.combo.values())
          if (c.cnt > bestCombo) {
            bestCombo = c.cnt;
            mUnits = c.units;
          }
        const meta = cat.trait(traitId);
        // Recompute from CDragon breakpoints — the stored active_style is the
        // Riot API's own tier index and can be 0 for traits that don't follow
        // the standard bronze/silver/gold pattern (e.g. Stargazer). Using CDragon
        // breakpoints + modal unit count gives the correct visual tier regardless
        // of what the API reported at ingest time.
        const style = styleAtUnits(meta.breakpoints, mUnits);
        if (style === 0) continue; // inactive per CDragon data — don't render
        traits.push({
          traitId: meta.traitId,
          name: meta.name,
          iconUrl: meta.iconUrl,
          numUnits: mUnits,
          style,
          unique: meta.breakpoints.length === 1,
          freq,
        });
      }
      traits.sort(
        (a, b) => b.numUnits - a.numUnits || b.freq - a.freq || a.name.localeCompare(b.name),
      );
    }

    out.set(compId, { units: units.slice(0, EX_UNIT_CAP), traits: traits.slice(0, EX_TRAIT_CAP) });
  }
  return out;
}
