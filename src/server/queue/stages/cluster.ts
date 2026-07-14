// cluster.ts — Stage 3 (cluster), exact-board rebuild.
//
// Full re-cluster sweep: reduce every stored *ranked* board to its exact-unit
// signature (comp-signature.ts), upsert the distinct comps, and stamp
// match_participants.comp_id. Idempotent on (set_number, signature): re-running
// on the same boards re-finds the same comps. A comp is set-scoped identity;
// per-(patch, region, rank_bucket) performance is the rollup's concern.
//
// Two robustness properties matter here, both learned the hard way:
//   1. CLEAR-FIRST. Every in-scope board's comp_id is nulled at the start of the
//      transaction, then only clusterable boards are re-stamped. So a board that
//      no longer clusters never keeps a stale comp_id, and the comps it used to
//      back become genuinely board-less — instead of a dead comp surviving on a
//      straggler (which is what left old comps in the tier list before).
//   2. FK-SAFE PRUNE. Board-less comps (including every comp from the previous
//      signature format) are removed, deleting their dependent rows first so the
//      prune can't fail whether or not the FKs cascade.

import { pool } from '@/lib/db';
import type { JobContext } from '../job-tracking';
import { buildIdentity, isEmblemItem, type SigUnit } from '../comp-signature';

export interface ClusterJob {
  /** Cluster only this set. Default (undefined) = every set present in the data. */
  setNumber?: number;
}

// TFT Ranked queue id — keep Double Up / Hyper Roll / normals out of the meta.
const RANKED_TFT_QUEUE_ID = 1100;

interface PartRow {
  id: string; // bigint -> string over the wire
  set_number: number;
}
interface UnitRow {
  participant_id: string;
  character_id: string;
  star_tier: number | null;
  item_ids: string[] | null;
}
interface UnitCostRow {
  set_number: number;
  character_id: string;
  cost: number | null;
}

interface CompSeed {
  setNumber: number;
  signature: string;
  coreUnits: string[];
  threeStars: string[];
}

export async function runCluster(job: ClusterJob, ctx: JobContext): Promise<void> {
  const client = await pool.connect();
  try {
    // 1 ─ Participants in scope: standard ranked, set known, optional set filter.
    const partRes = await client.query<PartRow>(
      `SELECT mp.id, m.set_number
         FROM match_participants mp
         JOIN matches m ON m.match_id = mp.match_id
        WHERE m.queue_id = $1
          AND m.set_number IS NOT NULL
          AND ($2::int IS NULL OR m.set_number = $2)`,
      [RANKED_TFT_QUEUE_ID, job.setNumber ?? null],
    );
    const participants = partRes.rows;
    if (participants.length === 0) {
      ctx.setItems(0);
      return;
    }
    const partIds = participants.map((p) => p.id);
    const setsInScope = [...new Set(participants.map((p) => p.set_number))];

    // 2 ─ Units (+ static cost + items, for worn-emblem detection).
    const unitRes = await client.query<UnitRow>(
      `SELECT participant_id, character_id, star_tier, item_ids
         FROM participant_units
        WHERE participant_id = ANY($1::bigint[])`,
      [partIds],
    );
    const costRes = await client.query<UnitCostRow>(
      `SELECT set_number, character_id, cost FROM units`,
    );

    const costMap = new Map<string, number>();
    for (const r of costRes.rows) costMap.set(`${r.set_number}:${r.character_id}`, r.cost ?? 0);

    const unitsByPart = new Map<string, UnitRow[]>();
    for (const u of unitRes.rows) {
      const arr = unitsByPart.get(u.participant_id);
      if (arr) arr.push(u);
      else unitsByPart.set(u.participant_id, [u]);
    }

    // 3 ─ Exact-board signature per board; collect distinct comps. All boards in
    //     a comp share the exact unit set, so the first board's coreUnits /
    //     threeStars are canonical for the whole comp.
    const distinctComps = new Map<string, CompSeed>(); // key: `${set}\0${sig}`
    const partToKey = new Map<string, string>();

    for (const p of participants) {
      const units = unitsByPart.get(p.id);
      if (!units || units.length === 0) continue; // empty board: unclusterable

      const sigUnits: SigUnit[] = units.map((u) => ({
        characterId: u.character_id,
        cost: costMap.get(`${p.set_number}:${u.character_id}`) ?? 0,
        star: u.star_tier ?? 0,
      }));

      // Worn trait emblems on the board (any unit) — part of board identity.
      const emblems: string[] = [];
      for (const u of units) {
        for (const it of u.item_ids ?? []) if (isEmblemItem(it)) emblems.push(it);
      }

      const identity = buildIdentity(sigUnits, emblems);
      if (!identity) continue; // < MIN_BOARD_UNITS real units → no comp_id

      const key = `${p.set_number}\u0000${identity.signature}`;
      partToKey.set(p.id, key);
      if (!distinctComps.has(key)) {
        distinctComps.set(key, {
          setNumber: p.set_number,
          signature: identity.signature,
          coreUnits: identity.coreUnits,
          threeStars: identity.threeStars,
        });
      }
    }

    // 4 ─ Clear in-scope comp_ids, upsert comps, re-stamp, prune — one transaction.
    await client.query('BEGIN');
    try {
      // Clear first (see header): a board that no longer clusters must not keep
      // its old comp_id. After this, only boards re-stamped below carry one.
      await client.query(
        `UPDATE match_participants SET comp_id = NULL WHERE id = ANY($1::bigint[])`,
        [partIds],
      );

      const idByKey = new Map<string, number>();
      for (const [key, c] of distinctComps) {
        // archetype / key_traits are no longer identity (NULL / empty). carries
        // holds the 3-star units purely as a display label (the row renders as
        // "[3star] [3star]"; a board with no 3-star gets no name). RETURNING hands
        // back the id whether the comp was inserted or already existed.
        const carries = c.threeStars.map((character_id) => ({ character_id, items: [] }));
        const res = await client.query<{ id: number }>(
          `INSERT INTO comps (set_number, signature, archetype, key_traits, core_units, carries)
                VALUES ($1, $2, NULL, '[]'::jsonb, $3::jsonb, $4::jsonb)
           ON CONFLICT (set_number, signature)
           DO UPDATE SET core_units = EXCLUDED.core_units, carries = EXCLUDED.carries
             RETURNING id`,
          [c.setNumber, c.signature, JSON.stringify(c.coreUnits), JSON.stringify(carries)],
        );
        const row = res.rows[0];
        if (!row) throw new Error(`comp upsert returned no id for signature ${c.signature}`);
        idByKey.set(key, row.id);
      }

      const ids: string[] = [];
      const compIds: number[] = [];
      for (const [partId, key] of partToKey) {
        const compId = idByKey.get(key);
        if (compId === undefined) continue;
        ids.push(partId);
        compIds.push(compId);
      }
      if (ids.length > 0) {
        await client.query(
          `UPDATE match_participants mp
              SET comp_id = v.comp_id
             FROM unnest($1::bigint[], $2::int[]) AS v(id, comp_id)
            WHERE mp.id = v.id`,
          [ids, compIds],
        );
      }

      // Prune board-less comps in scope (every comp nothing re-stamped, including
      // all of the previous signature format). Delete dependents first so this is
      // safe whether or not comp_stats / comp_stat_trends / tier_list_entries
      // cascade. A board-less comp has no meaningful manual tier override, so
      // dropping its tier rows too is fine.
      const orphanRes = await client.query<{ id: number }>(
        `SELECT c.id FROM comps c
          WHERE c.set_number = ANY($1::int[])
            AND NOT EXISTS (SELECT 1 FROM match_participants mp WHERE mp.comp_id = c.id)`,
        [setsInScope],
      );
      const orphanIds = orphanRes.rows.map((r) => r.id);
      if (orphanIds.length > 0) {
        await client.query(`DELETE FROM tier_list_entries WHERE comp_id = ANY($1::int[])`, [orphanIds]);
        await client.query(`DELETE FROM comp_stat_trends WHERE comp_id = ANY($1::int[])`, [orphanIds]);
        await client.query(`DELETE FROM comp_stats WHERE comp_id = ANY($1::int[])`, [orphanIds]);
        await client.query(`DELETE FROM comps WHERE id = ANY($1::int[])`, [orphanIds]);
      }

      await client.query('COMMIT');
      ctx.setItems(ids.length);
      console.log(
        `[cluster] ${distinctComps.size} exact-board comps, ${ids.length} boards stamped, ${orphanIds.length} stale comps pruned`,
      );
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  } finally {
    client.release();
  }
}