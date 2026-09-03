// variant-resolve.ts — recover a unit variant Riot's match payload does not report.
//
// Set 18 reports every Lux as `DA_Lux18_Base` regardless of which Avatar
// element she chose, so an example board would always render a generic Lux.
// The choice is still in the data, indirectly: Avatar doubles the chosen trait,
// so that trait is over-counted in `participant_traits` relative to what the
// board's units alone explain. One trait over-counted, one answer. Measured
// over 30 Lux boards: exactly one over-counted trait on every board, none
// ambiguous.
//
// DISPLAY ONLY — see `set-config.inferredVariants` for why this never reaches
// comp signatures.
//
// An emblem also inflates a trait, but only by 1, so `minDelta` of 2 cannot be
// tripped by one. A board wearing an emblem for the SAME trait Lux chose reads
// +3, which still resolves to the right variant.

import { query } from '@/lib/db';
import { regionCodesFor } from '@/config/regions';
import { inferredVariants } from './set-config';

export interface VariantScope {
  patchId: number;
  region: string;
  rankBucket: string;
}

/** How many of one comp's boards resolved to one variant. */
export interface VariantTally {
  compId: number;
  /** The id Riot reports — what the tally is an override FOR. */
  base: string;
  variantId: string;
  boards: number;
}

/**
 * Per-comp variant tallies for the given comps. One query per configured family
 * (set 18 has exactly one), skipped entirely for sets with none — so this costs
 * nothing on set 17 and earlier.
 *
 * Returns raw tallies rather than a decision: a displayed row often pools
 * SEVERAL comps, and folding per comp first would let a 3-board comp outvote a
 * 300-board one. `pickVariants` does the fold with the board counts intact.
 */
export async function resolveVariants(
  setNumber: number,
  compIds: number[],
  scope: VariantScope,
): Promise<VariantTally[]> {
  const families = inferredVariants(setNumber);
  if (!families.length || !compIds.length) return [];

  const out: VariantTally[] = [];
  for (const fam of families) {
    const rows = await query<{ comp_id: number; variant_id: string; boards: number }>(
      // `implied` is what the board's own units explain for each trait; the
      // difference against Riot's count is the mechanic's contribution.
      // DISTINCT character_id because a duplicate copy is still one unit for
      // trait purposes — counting rows would inflate `implied` and mask the
      // real over-count.
      `WITH base AS (
         SELECT mp.id AS pid, mp.comp_id
           FROM match_participants mp
           JOIN matches m ON m.match_id = mp.match_id
           JOIN participant_units pu ON pu.participant_id = mp.id
          WHERE mp.comp_id = ANY($1::int[])
            AND m.patch_id = $2 AND m.region = ANY($3::text[]) AND mp.rank_bucket = $4
            AND m.queue_id = 1100
            AND pu.character_id = $5
       ),
       implied AS (
         SELECT b.pid, t AS trait_id, count(DISTINCT pu.character_id)::int AS n
           FROM base b
           JOIN participant_units pu ON pu.participant_id = b.pid
           JOIN units u ON u.set_number = $6 AND u.character_id = pu.character_id
           CROSS JOIN LATERAL unnest(u.trait_ids) AS t
          GROUP BY b.pid, t
       ),
       choice AS (
         SELECT b.comp_id, b.pid, pt.trait_id,
                row_number() OVER (
                  PARTITION BY b.pid
                  ORDER BY pt.num_units - coalesce(i.n, 0) DESC, pt.trait_id
                ) AS rn
           FROM base b
           JOIN participant_traits pt ON pt.participant_id = b.pid
           LEFT JOIN implied i ON i.pid = b.pid AND i.trait_id = pt.trait_id
          WHERE pt.num_units - coalesce(i.n, 0) >= $7
            AND pt.trait_id <> $8
       )
       SELECT c.comp_id, v.character_id AS variant_id, count(*)::int AS boards
         FROM choice c
         JOIN units v ON v.set_number = $6
                     AND v.character_id ~ $9
                     AND c.trait_id = ANY(v.trait_ids)
        WHERE c.rn = 1
        GROUP BY c.comp_id, v.character_id`,
      [
        compIds, scope.patchId, regionCodesFor(scope.region), scope.rankBucket,
        fam.base, setNumber, fam.minDelta, fam.markerTrait, fam.familyPattern,
      ],
    );
    for (const r of rows) {
      out.push({ compId: r.comp_id, base: fam.base, variantId: r.variant_id, boards: r.boards });
    }
  }
  return out;
}

/**
 * Fold tallies for one displayed row into `reported id -> id to display`.
 *
 * Boards are summed across the row's comps before the winner is picked, so a
 * pooled row reflects what its members actually played rather than what its
 * smallest member did. Ties break on the id, so a row does not flicker between
 * equally-played variants from one request to the next.
 *
 * Pure — the SQL above is the only part that needs a database.
 */
export function pickVariants(
  tallies: readonly VariantTally[],
  compIds: Iterable<number>,
): Map<string, string> {
  const wanted = new Set(compIds);
  const totals = new Map<string, Map<string, number>>();
  for (const t of tallies) {
    if (!wanted.has(t.compId)) continue;
    let byVariant = totals.get(t.base);
    if (!byVariant) {
      byVariant = new Map();
      totals.set(t.base, byVariant);
    }
    byVariant.set(t.variantId, (byVariant.get(t.variantId) ?? 0) + t.boards);
  }

  const picked = new Map<string, string>();
  for (const [base, byVariant] of totals) {
    let bestId: string | null = null;
    let bestBoards = 0;
    for (const [id, boards] of byVariant) {
      if (boards > bestBoards || (boards === bestBoards && bestId !== null && id < bestId)) {
        bestId = id;
        bestBoards = boards;
      }
    }
    if (bestId) picked.set(base, bestId);
  }
  return picked;
}
