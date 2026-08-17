// comps-example-team.ts — aggregate the most-common board per display GROUP.
// Extracted from comps-service.ts so that file stays focused on the
// selector / tier-grouping pipeline.  This module owns every item- and
// board-level detail: DB queries, component/item filtering, star/copy logic.
//
// GROUP-SCOPED (2026-07-17): a group is the set of member comps behind one
// displayed row (an archetype variant's members, or a single exact comp for
// most-played boards). Aggregating over the pooled members — instead of the
// single representative comp — is what keeps the example board, trait badges,
// and star pips consistent with the pooled stats the row shows (the user's
// review found every rep-vs-pool mismatch class: phantom units the line rarely
// plays, 6-trait badges on 5-unit strips, missing hit-state stars).

import { query } from '@/lib/db';
import { getCatalog } from './static-data';
import { COMPONENT_ITEMS, isRngAcquiredItem } from './item-filters';
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
// group's games; "fully itemized" = at least EX_ITEM_COMPLETE completed items;
// then show the single most-played complete SET (capped at EX_ITEM_CAP icons).
const EX_ITEM_MIN_FREQ = num(process.env.EX_ITEM_MIN_FREQ, 0.5);
const EX_ITEM_COMPLETE = num(process.env.EX_ITEM_COMPLETE, 3);
const EX_ITEM_CAP = num(process.env.EX_ITEM_CAP, 3);
// Hit-state stars: a hit-target unit (a label carry at reroll cost) renders 3★
// when it actually hits in at least this share of the boards fielding it. The
// pooled MODAL star of a 40%-hit reroll target is 2★, but the 3★ is the line's
// intent — the thing the row's name promises — so the modal display would
// misread as "this line doesn't 3★ its carry" (user review: "viktor reroll but
// no 3★ viktor?", "ezreal is not 3★").
const EX_STAR_HIT_MIN_SHARE = num(process.env.EX_STAR_HIT_MIN_SHARE, 0.15);
/** Pool scope per row is capped to this many members (biggest first) so the
 *  board queries stay bounded on 4k-member archetypes; the cap covers the
 *  overwhelming share of boards, and the freq denominator is the INCLUDED
 *  members' n so frequencies stay honest. Exported for the two callers. */
export const EX_POOL_MEMBER_CAP = num(process.env.EX_POOL_MEMBER_CAP, 12);

export const EMPTY_TEAM: ExampleTeamVM = { units: [], traits: [] };

// Base components — excluded when counting "completed" items and from the items
// shown — are the shared COMPONENT_ITEMS set from item-filters.ts. Everything
// NOT in it (finished items, radiants, artifacts, trait emblems) counts as
// completed.

// Thief's Gloves equips 2 random items and occupies all 3 slots — when present
// the other "items" are ephemeral randoms that don't represent a real build.
const THIEVES_GLOVES_ID = 'TFT_Item_ThiefsGloves';

// ── Public input shape ────────────────────────────────────────────────────────

/** One display row's aggregation scope. `n` is the pooled board count of the
 *  included compIds in the SAME (patch, region, bucket) scope — the frequency
 *  denominator. `hitTargetIds` are the row's reroll-cost label carries (see
 *  EX_STAR_HIT_MIN_SHARE). */
export interface ExampleGroup {
  key: string;
  compIds: number[];
  n: number;
  hitTargetIds?: string[];
}

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
interface ItemSetRow {
  comp_id: number;
  character_id: string;
  completed: string[] | null; // sorted completed-item multiset of one board's best copy
  boards: number; // boards sharing exactly this completed set
}

// ── Main export ───────────────────────────────────────────────────────────────

/** Most-common board per group, scoped to the same (patch, region, bucket) the
 *  stats describe. Set-based: three grouped queries over all comp_ids at once;
 *  item SETS are grouped SQL-side so pooled groups never ship per-board rows. */
export async function loadExampleTeams(
  groups: ExampleGroup[],
  patchId: number,
  region: string,
  rankBucket: string,
  cat: CatalogT,
): Promise<Map<string, ExampleTeamVM>> {
  const out = new Map<string, ExampleTeamVM>();
  // A comp can back SEVERAL groups at once (the detail page pools it into the
  // variant strip AND shows it as a most-played board), so the index is
  // array-valued and every aggregation row fans out to all containing groups.
  const groupsByComp = new Map<number, ExampleGroup[]>();
  for (const g of groups) {
    for (const id of g.compIds) {
      const arr = groupsByComp.get(id);
      if (arr) arr.push(g);
      else groupsByComp.set(id, [g]);
    }
  }
  const compIds = [...groupsByComp.keys()];
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
    query<ItemSetRow>(
      // For each (comp, unit, board), take the completed items of the most-
      // itemized copy — the duplicate-copy augment's spare (usually item-less)
      // copy must not dilute the carry's item stats — then group identical
      // completed SETS. Components are stripped in SQL (the shared set is
      // passed in); sorting the set makes item order never split a build.
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
       ),
       sets AS (
         SELECT comp_id, character_id,
                (SELECT array_agg(i ORDER BY i)
                   FROM unnest(item_ids) AS i
                  WHERE NOT (i = ANY($5::text[]))) AS completed
           FROM ub
          WHERE rn = 1
       )
       SELECT comp_id, character_id, completed, count(*)::int AS boards
         FROM sets
        GROUP BY comp_id, character_id, completed`,
      [compIds, patchId, region, rankBucket, [...COMPONENT_ITEMS]],
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
  const unitsByGroup = new Map<string, Map<string, UnitAcc>>();
  for (const r of unitRows) {
    for (const g of groupsByComp.get(r.comp_id) ?? []) {
      let perGroup = unitsByGroup.get(g.key);
      if (!perGroup) {
        perGroup = new Map();
        unitsByGroup.set(g.key, perGroup);
      }
      let acc = perGroup.get(r.character_id);
      if (!acc) {
        acc = { boardsWithUnit: 0, byCopies: new Map() };
        perGroup.set(r.character_id, acc);
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
  }

  interface TraitAcc {
    appears: number;
    combo: Map<string, { units: number; style: number; cnt: number }>;
  }
  const traitsByGroup = new Map<string, Map<string, TraitAcc>>();
  for (const r of traitRows) {
    for (const g of groupsByComp.get(r.comp_id) ?? []) {
      let perGroup = traitsByGroup.get(g.key);
      if (!perGroup) {
        perGroup = new Map();
        traitsByGroup.set(g.key, perGroup);
      }
      // Normalize variant IDs to their canonical parent (e.g. TFT17_Stargazer_Wolf →
      // TFT17_Stargazer) so constellation/path variants count toward the same trait.
      const canonId = cat.normalizeTraitId(r.trait_id);
      let acc = perGroup.get(canonId);
      if (!acc) {
        acc = { appears: 0, combo: new Map() };
        perGroup.set(canonId, acc);
      }
      acc.appears += r.cnt;
      const u = r.num_units ?? 0;
      const s = r.active_style ?? 0;
      const key = `${u}:${s}`;
      const c = acc.combo.get(key);
      if (c) c.cnt += r.cnt;
      else acc.combo.set(key, { units: u, style: s, cnt: r.cnt });
    }
  }

  // Per (group, unit): boards fully itemized (>= EX_ITEM_COMPLETE completed) and
  // the frequency of each complete item SET — the single most-played build, not
  // 3 items that may never be built together.
  interface ItemAcc {
    itemizedBoards: number;
    sets: Map<string, { count: number; items: string[] }>;
  }
  const itemsByGroup = new Map<string, Map<string, ItemAcc>>();
  for (const r of itemRows) {
    const completed = r.completed ?? [];
    if (completed.length < EX_ITEM_COMPLETE) continue; // not a full build → no set
    for (const g of groupsByComp.get(r.comp_id) ?? []) {
      let perGroup = itemsByGroup.get(g.key);
      if (!perGroup) {
        perGroup = new Map();
        itemsByGroup.set(g.key, perGroup);
      }
      let acc = perGroup.get(r.character_id);
      if (!acc) {
        acc = { itemizedBoards: 0, sets: new Map() };
        perGroup.set(r.character_id, acc);
      }
      acc.itemizedBoards += r.boards;
      const key = completed.join('|'); // already sorted in SQL
      const s = acc.sets.get(key);
      if (s) s.count += r.boards;
      else acc.sets.set(key, { count: r.boards, items: completed });
    }
  }

  for (const g of groups) {
    if (out.has(g.key)) continue; // duplicate keys: first spec wins
    const n = g.n;
    if (n <= 0) {
      out.set(g.key, EMPTY_TEAM);
      continue;
    }
    const hitTargets = new Set(g.hitTargetIds ?? []);

    const unitsAcc = unitsByGroup.get(g.key);
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

        // Hit-state stars: the line's roll target renders its hit when hitting
        // is a real outcome (share among boards FIELDING the unit), even when
        // the modal board missed — the modal star of a 40%-hit target is 2★,
        // but 3★ is what the row's name promises (see EX_STAR_HIT_MIN_SHARE).
        if (hitTargets.has(characterId) && (stars[0] ?? 0) < 3 && acc.boardsWithUnit > 0) {
          let boards3 = 0;
          for (const cp of acc.byCopies.values())
            for (const sh of cp.byStars.values())
              if ((sh.stars[0] ?? 0) >= 3) boards3 += sh.boards;
          if (boards3 / acc.boardsWithUnit >= EX_STAR_HIT_MIN_SHARE) {
            stars = [3, ...stars.slice(1)];
          }
        }

        // Items: only when the unit is fully itemized in > EX_ITEM_MIN_FREQ of the
        // group's games; then its single most-played complete set, resolved to icons.
        let items: ExampleItemVM[] = [];
        const itemAcc = itemsByGroup.get(g.key)?.get(characterId);
        if (itemAcc && itemAcc.itemizedBoards / n > EX_ITEM_MIN_FREQ) {
          // Prefer the most-played set with NO RNG-acquired item: artifacts,
          // radiants, and set-mechanic specials (anima weapons, the Ekko
          // anomaly) are drops, not a build you can plan for — a lucky Gold
          // Collector or a cashout weapon must not headline the example on an
          // ordinary line. Such a set still shows when the unit has nothing
          // else (the anima-cashout line's carries hold nothing but anima
          // weapons, and those ARE its identity — user ruling 2026-07-17).
          let best: { count: number; items: string[] } | null = null;
          for (const s of itemAcc.sets.values()) {
            if (!best) {
              best = s;
              continue;
            }
            const bestHasRng = best.items.some(isRngAcquiredItem);
            const sHasRng = s.items.some(isRngAcquiredItem);
            if (bestHasRng !== sHasRng ? bestHasRng : s.count > best.count) best = s;
          }
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

    const traitsAcc = traitsByGroup.get(g.key);
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
        // Zero-breakpoint traits are per-unit marker pseudo-traits (e.g. Miss
        // Fortune's "Choose Trait" chooser, TFT17_MissFortuneUndeterminedTrait)
        // — not board traits. Never render them in the strip or let them name
        // a comp; the trait she actually chose is reported separately by the
        // API and counts normally.
        if (meta.breakpoints.length === 0) continue;
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

    out.set(g.key, { units: units.slice(0, EX_UNIT_CAP), traits: traits.slice(0, EX_TRAIT_CAP) });
  }
  return out;
}
