// cluster.ts — Stage 3 (cluster), exact-board rebuild.
//
// Full re-cluster sweep: reduce every stored *ranked* board to its exact-unit
// signature (comp-signature.ts), upsert the distinct comps, and stamp
// match_participants.comp_id. Idempotent on (set_number, signature): re-running
// on the same boards re-finds the same comps. A comp is set-scoped identity;
// per-(patch, region, rank_bucket) performance is the rollup's concern.
//
// Three robustness properties matter here, all learned the hard way:
//   1. CLEAR-FIRST. Every in-scope board's comp_id is nulled at the start of the
//      transaction, then only clusterable boards are re-stamped. So a board that
//      no longer clusters never keeps a stale comp_id, and the comps it used to
//      back become genuinely board-less — instead of a dead comp surviving on a
//      straggler (which is what left old comps in the tier list before).
//   2. FK-SAFE PRUNE. Board-less comps (including every comp from the previous
//      signature format) are removed, deleting their dependent rows first so the
//      prune can't fail whether or not the FKs cascade.
//   3. BOUNDED MEMORY. The scan is CHUNKED. The original version loaded every
//      in-scope board and every one of their participant_units rows into Node at
//      once — measured at ~2.2 GB of heap for the unit array alone at 5.6 M rows,
//      which is at or over the default old-space limit. Units are now read one
//      chunk of boards at a time and reduced to a signature immediately, so the
//      only things that survive a chunk are the distinct comp seeds (~180 k) and
//      one integer pair per board. Peak heap is a few hundred MB and grows with
//      DISTINCT COMPS, not with total unit rows.
//
// Writes still happen in ONE transaction, so readers see the old clustering or
// the new one and never a half-stamped mix. What changed is that the statements
// inside it are batched: the per-comp INSERT loop (one round-trip per distinct
// comp — 175 k of them, minutes of pure latency inside an open transaction) is
// now a handful of multi-row upserts, and the clear step is set-based instead of
// shipping a 647 k-element id array.

import { pool } from '@/lib/db';
import type { PoolClient } from 'pg';
import type { JobContext } from '../job-tracking';
import { buildIdentity, isEmblemItem, type SigUnit } from '../comp-signature';
import { RANKED_TFT_QUEUE_ID } from '@/config/queue-ids';

export interface ClusterJob {
  /** Cluster only this set. Default (undefined) = every set present in the data. */
  setNumber?: number;
}

// TFT Ranked queue id — keep Double Up / Hyper Roll / normals out of the meta.
// Re-exported from config so the writer (match-persist) and every reader agree.

const envInt = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// Boards per scan chunk. At ~8.6 unit rows per board this is ~215 k unit rows in
// flight — a few tens of MB, released before the next chunk is fetched.
const SCAN_CHUNK = envInt(process.env.CLUSTER_SCAN_CHUNK, 25_000);
// Rows per multi-row write statement. Large enough that the round-trip count is
// negligible, small enough to keep any single statement's parameter arrays sane.
const WRITE_CHUNK = envInt(process.env.CLUSTER_WRITE_CHUNK, 5_000);

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

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Static unit costs, keyed `${set}:${characterId}`. Small — loaded once. */
async function loadCosts(client: PoolClient): Promise<Map<string, number>> {
  const res = await client.query<UnitCostRow>(`SELECT set_number, character_id, cost FROM units`);
  const costs = new Map<string, number>();
  for (const r of res.rows) costs.set(`${r.set_number}:${r.character_id}`, r.cost ?? 0);
  return costs;
}

/**
 * Result of the chunked scan. Deliberately holds NO per-board unit data:
 * `seeds` is one entry per DISTINCT comp, and the two stamp arrays are one
 * primitive each per clusterable board.
 */
interface ScanResult {
  seeds: CompSeed[];
  /** Parallel arrays: board id → index into `seeds`. */
  stampBoardIds: number[];
  stampSeedIdx: number[];
  setsInScope: number[];
  boardsScanned: number;
}

async function scanBoards(
  client: PoolClient,
  setNumber: number | undefined,
  ctx: JobContext,
): Promise<ScanResult> {
  const costs = await loadCosts(client);

  // character_id strings repeat across millions of rows but arrive as fresh
  // allocations per row from the driver. Interning them lets the ~180 k seed
  // unit arrays share one string instance per champion instead of holding
  // hundreds of thousands of duplicates.
  const intern = new Map<string, string>();
  const keep = (s: string): string => {
    const hit = intern.get(s);
    if (hit !== undefined) return hit;
    intern.set(s, s);
    return s;
  };

  const seedIdxByKey = new Map<string, number>();
  const seeds: CompSeed[] = [];
  const stampBoardIds: number[] = [];
  const stampSeedIdx: number[] = [];
  const setsInScope = new Set<number>();

  let cursor = '0';
  let boardsScanned = 0;

  // SELF-HEALING player_count. The scan below takes only `player_count = 8`,
  // so any match whose count is NULL is invisible to the meta. Migration 0020
  // backfilled every match that existed when it ran, but that leaves a gap: a
  // worker running a build older than 0020 keeps ingesting matches WITHOUT
  // writing the column, and those matches would be excluded permanently even
  // after the worker is upgraded. Observed immediately after the migration —
  // 36 freshly-ingested ranked matches already had real boards and a NULL count.
  //
  // Deriving it here instead of trusting the writer closes that gap for good,
  // including any future window where a writer forgets. Scoped to NULLs, so it
  // is a no-op once caught up. An all-bot lobby correctly resolves to 0, not
  // NULL, which is more honest than leaving it unknown.
  const healed = await client.query(
    `UPDATE matches m
        SET player_count = c.n
       FROM (
         SELECT mp.match_id,
                count(*) FILTER (WHERE mp.puuid <> 'BOT')::int AS n
           FROM match_participants mp
           JOIN matches mm ON mm.match_id = mp.match_id
          WHERE mm.player_count IS NULL
          GROUP BY mp.match_id
       ) c
      WHERE c.match_id = m.match_id
        AND m.player_count IS NULL`,
  );
  if (healed.rowCount) {
    console.log(`[cluster] derived player_count for ${healed.rowCount} match(es) the writer had not stamped`);
  }

  for (;;) {
    // Keyset pagination on the primary key — stable, index-driven, and immune to
    // the offset drift a LIMIT/OFFSET scan would suffer as the crawler inserts.
    const partRes = await client.query<PartRow>(
      `SELECT mp.id, m.set_number
         FROM match_participants mp
         JOIN matches m ON m.match_id = mp.match_id
        WHERE m.queue_id = $1
          AND m.set_number IS NOT NULL
          AND ($2::int IS NULL OR m.set_number = $2)
          AND m.player_count = 8
          AND mp.id > $3::bigint
        ORDER BY mp.id
        LIMIT $4`,
      [RANKED_TFT_QUEUE_ID, setNumber ?? null, cursor, SCAN_CHUNK],
    );
    const participants = partRes.rows;
    if (participants.length === 0) break;

    const ids = participants.map((p) => p.id);
    const unitRes = await client.query<UnitRow>(
      `SELECT participant_id, character_id, star_tier, item_ids
         FROM participant_units
        WHERE participant_id = ANY($1::bigint[])`,
      [ids],
    );

    const unitsByPart = new Map<string, UnitRow[]>();
    for (const u of unitRes.rows) {
      const arr = unitsByPart.get(u.participant_id);
      if (arr) arr.push(u);
      else unitsByPart.set(u.participant_id, [u]);
    }

    for (const p of participants) {
      setsInScope.add(p.set_number);
      const units = unitsByPart.get(p.id);
      if (!units || units.length === 0) continue; // empty board: unclusterable

      const sigUnits: SigUnit[] = units.map((u) => ({
        characterId: keep(u.character_id),
        cost: costs.get(`${p.set_number}:${u.character_id}`) ?? 0,
        star: u.star_tier ?? 0,
      }));

      // Worn trait emblems on the board (any unit) — part of board identity.
      const emblems: string[] = [];
      for (const u of units) {
        for (const it of u.item_ids ?? []) if (isEmblemItem(it)) emblems.push(keep(it));
      }

      const identity = buildIdentity(sigUnits, emblems);
      if (!identity) continue; // < MIN_BOARD_UNITS real units → no comp_id

      const key = `${p.set_number}\0${identity.signature}`;
      let idx = seedIdxByKey.get(key);
      if (idx === undefined) {
        idx = seeds.length;
        seedIdxByKey.set(key, idx);
        // All boards in a comp share the exact unit set, so the first board's
        // coreUnits / threeStars are canonical for the whole comp.
        seeds.push({
          setNumber: p.set_number,
          signature: identity.signature,
          coreUnits: identity.coreUnits,
          threeStars: identity.threeStars,
        });
      }
      stampBoardIds.push(Number(p.id));
      stampSeedIdx.push(idx);
    }

    boardsScanned += participants.length;
    cursor = ids[ids.length - 1];
    ctx.setItems(stampBoardIds.length);
    // Release the chunk's unit rows and let the worker renew its BullMQ lock.
    await yieldToEventLoop();
  }

  return {
    seeds,
    stampBoardIds,
    stampSeedIdx,
    setsInScope: [...setsInScope],
    boardsScanned,
  };
}

/** Multi-row upsert of the distinct comps; returns seed index → comps.id. */
async function upsertComps(client: PoolClient, seeds: CompSeed[]): Promise<number[]> {
  const idBySeedIdx = new Array<number>(seeds.length);
  const idByKey = new Map<string, number>();

  for (let start = 0; start < seeds.length; start += WRITE_CHUNK) {
    const batch = seeds.slice(start, start + WRITE_CHUNK);
    // archetype / key_traits are no longer identity (NULL / empty). carries
    // holds the 3-star units purely as a display label (the row renders as
    // "[3star] [3star]"; a board with no 3-star gets no name). jsonb columns go
    // over as text[] and are cast per element — a jsonb[] parameter would need
    // the driver to escape braces and quotes inside each document.
    const res = await client.query<{ id: number; set_number: number; signature: string }>(
      `INSERT INTO comps (set_number, signature, archetype, key_traits, core_units, carries)
       SELECT v.set_number, v.signature, NULL, '[]'::jsonb, v.core_units::jsonb, v.carries::jsonb
         FROM unnest($1::int[], $2::text[], $3::text[], $4::text[])
              AS v(set_number, signature, core_units, carries)
       ON CONFLICT (set_number, signature)
       DO UPDATE SET core_units = EXCLUDED.core_units, carries = EXCLUDED.carries
       RETURNING id, set_number, signature`,
      [
        batch.map((c) => c.setNumber),
        batch.map((c) => c.signature),
        batch.map((c) => JSON.stringify(c.coreUnits)),
        batch.map((c) =>
          JSON.stringify(c.threeStars.map((character_id) => ({ character_id, items: [] }))),
        ),
      ],
    );
    for (const row of res.rows) idByKey.set(`${row.set_number}\0${row.signature}`, row.id);
  }

  for (let i = 0; i < seeds.length; i++) {
    const id = idByKey.get(`${seeds[i].setNumber}\0${seeds[i].signature}`);
    if (id === undefined) {
      throw new Error(`comp upsert returned no id for signature ${seeds[i].signature}`);
    }
    idBySeedIdx[i] = id;
  }
  return idBySeedIdx;
}

export async function runCluster(job: ClusterJob, ctx: JobContext): Promise<void> {
  const client = await pool.connect();
  try {
    // 1 ─ Chunked scan: signature every in-scope board, keeping only distinct
    //     comp seeds and one (boardId, seedIdx) pair per clusterable board.
    const scan = await scanBoards(client, job.setNumber, ctx);
    if (scan.boardsScanned === 0) {
      ctx.setItems(0);
      return;
    }

    // 2 ─ Clear, upsert, stamp, prune — one transaction, batched statements.
    await client.query('BEGIN');
    try {
      // Clear first (see header). Set-based rather than an id array, and
      // `comp_id IS NOT NULL` keeps it from rewriting rows that are already
      // clear.
      //
      // DELIBERATELY BROADER THAN THE SCAN. The scan takes only
      // `player_count = 8`; this clear does not. That asymmetry is the point: a
      // board that is no longer in scope must LOSE its comp_id, and if the clear
      // shared the scan's predicate those boards would keep a stale stamp
      // forever. It is what un-clusters the 1,825 bot boards that had been
      // stamped into 1,161 real comps, and the bot-lobby human boards with them.
      // Clearing more than we re-stamp is always the safe direction here.
      await client.query(
        `UPDATE match_participants mp
            SET comp_id = NULL
           FROM matches m
          WHERE m.match_id = mp.match_id
            AND m.queue_id = $1
            AND m.set_number IS NOT NULL
            AND ($2::int IS NULL OR m.set_number = $2)
            AND mp.comp_id IS NOT NULL`,
        [RANKED_TFT_QUEUE_ID, job.setNumber ?? null],
      );

      const compIdBySeed = await upsertComps(client, scan.seeds);

      for (let start = 0; start < scan.stampBoardIds.length; start += WRITE_CHUNK) {
        const idsChunk = scan.stampBoardIds.slice(start, start + WRITE_CHUNK);
        const compsChunk = scan.stampSeedIdx
          .slice(start, start + WRITE_CHUNK)
          .map((seedIdx) => compIdBySeed[seedIdx]);
        await client.query(
          `UPDATE match_participants mp
              SET comp_id = v.comp_id
             FROM unnest($1::bigint[], $2::int[]) AS v(id, comp_id)
            WHERE mp.id = v.id`,
          [idsChunk, compsChunk],
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
        [scan.setsInScope],
      );
      const orphanIds = orphanRes.rows.map((r) => r.id);
      if (orphanIds.length > 0) {
        await client.query(`DELETE FROM tier_list_entries WHERE comp_id = ANY($1::int[])`, [orphanIds]);
        await client.query(`DELETE FROM comp_stat_trends WHERE comp_id = ANY($1::int[])`, [orphanIds]);
        await client.query(`DELETE FROM comp_stats WHERE comp_id = ANY($1::int[])`, [orphanIds]);
        await client.query(`DELETE FROM comps WHERE id = ANY($1::int[])`, [orphanIds]);
      }

      await client.query('COMMIT');
      ctx.setItems(scan.stampBoardIds.length);
      console.log(
        `[cluster] ${scan.seeds.length} exact-board comps, ${scan.stampBoardIds.length} boards stamped ` +
          `(${scan.boardsScanned} scanned), ${orphanIds.length} stale comps pruned`,
      );
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  } finally {
    client.release();
  }
}
