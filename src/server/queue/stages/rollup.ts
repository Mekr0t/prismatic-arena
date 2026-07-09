// rollup.ts — Stage 4 (rollup).
// Aggregate clustered boards into per-(comp, patch, region, rank_bucket) stats.
// Stores SUFFICIENT STATISTICS (n, sum-placement, sum-placement-squared,
// top4_count, win_count) — never derived rates or interval bounds — so avg
// placement, top-4/win rate, and Wilson/SEM intervals are all computed on read,
// and the interval method can change without a re-rollup. Also maintains
// bucket_totals (the play-rate denominator). Full recompute in one transaction:
// readers see the old stats or the new, never an empty table.
//
// Scope matches the clusterer: standard ranked boards that clustered (comp_id)
// and resolved to a patch (patch_id). Needs 0009 (match_participants.rank_bucket).

import { pool } from '@/lib/db';
import type { JobContext } from '../job-tracking';

export interface RollupJob {
  /** Reserved for future patch/region scoping; the current rollup is a full recompute. */
  setNumber?: number;
}

// Standard-ranked filter — same as the clusterer, so denominators line up.
const RANKED_TFT_QUEUE_ID = 1100;

export async function runRollup(_job: RollupJob, ctx: JobContext): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      // comp_stats — full rebuild. Sufficient stats per (comp, patch, region,
      // rank_bucket); rates and intervals are derived on read.
      await client.query('DELETE FROM comp_stats');
      const statsRes = await client.query(
        `INSERT INTO comp_stats
           (comp_id, patch_id, region, rank_bucket,
            n, placement_sum, placement_sumsq, top4_count, win_count, computed_at)
         SELECT
           mp.comp_id,
           m.patch_id,
           m.region,
           mp.rank_bucket,
           count(*),
           sum(mp.placement),
           sum(mp.placement::bigint * mp.placement),
           count(*) FILTER (WHERE mp.placement <= 4),
           count(*) FILTER (WHERE mp.placement = 1),
           now()
         FROM match_participants mp
         JOIN matches m ON m.match_id = mp.match_id
        WHERE mp.comp_id IS NOT NULL
          AND m.patch_id IS NOT NULL
          AND m.queue_id = $1
        GROUP BY mp.comp_id, m.patch_id, m.region, mp.rank_bucket`,
        [RANKED_TFT_QUEUE_ID],
      );

      // bucket_totals — play-rate denominator. Clustered ranked boards only, so
      // the sum of comp_stats.n over a bucket equals its total and play rates
      // sum to 1.
      await client.query('DELETE FROM bucket_totals');
      await client.query(
        `INSERT INTO bucket_totals (patch_id, region, rank_bucket, total_boards, computed_at)
         SELECT m.patch_id, m.region, mp.rank_bucket, count(*), now()
         FROM match_participants mp
         JOIN matches m ON m.match_id = mp.match_id
        WHERE mp.comp_id IS NOT NULL
          AND m.patch_id IS NOT NULL
          AND m.queue_id = $1
        GROUP BY m.patch_id, m.region, mp.rank_bucket`,
        [RANKED_TFT_QUEUE_ID],
      );

      await client.query('COMMIT');
      ctx.setItems(statsRes.rowCount ?? 0); // comp_stats rows written
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  } finally {
    client.release();
  }
}
