// trend-tier.ts — Stage 5 (trend-tier).
// Two jobs that belong together, both reading the rollup's comp_stats:
//   A) snapshot today's sufficient stats per comp into comp_stat_trends (ALL
//      comps; idempotent per day) — the series patch velocity reads later.
//   B) regenerate the auto tier list: score each comp (>= TIER_MIN_SAMPLE) via
//      comp-stats-math, rank within each (patch, region, rank_bucket), map to
//      S/A/B/C/D, write tier_list_entries — preserving admin manual overrides.
// One transaction. Run after the rollup (it reads comp_stats / bucket_totals).

import { pool } from '@/lib/db';
import type { JobContext } from '../job-tracking';
import { computeMetrics, scoreToTier, type SufficientStats } from '../comp-stats-math';

export interface TrendTierJob {
  /** Reserved for future scoping; the current run is a full regenerate. */
  setNumber?: number;
}

const num = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

// Comps below this sample size are left off the tier list (still in comp_stats /
// the M5 niche toggle). Trend snapshots include every comp regardless.
const TIER_MIN_SAMPLE = num(process.env.TIER_MIN_SAMPLE, 15);

interface StatRow {
  comp_id: number;
  patch_id: number;
  region: string;
  rank_bucket: string;
  n: number;
  placement_sum: string; // bigint -> string
  placement_sumsq: string; // bigint -> string
  top4_count: number;
  win_count: number;
}

export async function runTrendTier(_job: TrendTierJob, ctx: JobContext): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      // A ─ Daily trend snapshot (all comps). Idempotent per day via upsert.
      await client.query(
        `INSERT INTO comp_stat_trends
           (comp_id, patch_id, region, rank_bucket, snapshot_date,
            n, bucket_total, placement_sum, top4_count, win_count)
         SELECT cs.comp_id, cs.patch_id, cs.region, cs.rank_bucket, CURRENT_DATE,
                cs.n, COALESCE(bt.total_boards, 0),
                cs.placement_sum, cs.top4_count, cs.win_count
         FROM comp_stats cs
         LEFT JOIN bucket_totals bt USING (patch_id, region, rank_bucket)
         ON CONFLICT (comp_id, patch_id, region, rank_bucket, snapshot_date)
         DO UPDATE SET
           n = EXCLUDED.n, bucket_total = EXCLUDED.bucket_total,
           placement_sum = EXCLUDED.placement_sum,
           top4_count = EXCLUDED.top4_count, win_count = EXCLUDED.win_count`,
      );

      // B ─ Regenerate auto tiers. Drop only auto rows; manual overrides
      //     (is_manual = true) survive and win on the ON CONFLICT below.
      await client.query(`DELETE FROM tier_list_entries WHERE is_manual = false`);

      const statRes = await client.query<StatRow>(
        `SELECT comp_id, patch_id, region, rank_bucket,
                n, placement_sum, placement_sumsq, top4_count, win_count
         FROM comp_stats
        WHERE n >= $1`,
        [TIER_MIN_SAMPLE],
      );

      // Score every qualifying comp, then rank within each (patch, region, bucket).
      interface Scored {
        compId: number;
        patchId: number;
        region: string;
        rankBucket: string;
        score: number;
        tier: string;
      }
      const byGroup = new Map<string, Scored[]>();
      for (const row of statRes.rows) {
        const stats: SufficientStats = {
          n: row.n,
          placementSum: Number(row.placement_sum),
          placementSumsq: Number(row.placement_sumsq),
          top4Count: row.top4_count,
          winCount: row.win_count,
        };
        const { score } = computeMetrics(stats);
        const scored: Scored = {
          compId: row.comp_id,
          patchId: row.patch_id,
          region: row.region,
          rankBucket: row.rank_bucket,
          score,
          tier: scoreToTier(score),
        };
        const key = `${row.patch_id}\u0000${row.region}\u0000${row.rank_bucket}`;
        const arr = byGroup.get(key);
        if (arr) arr.push(scored);
        else byGroup.set(key, [scored]);
      }

      // Flatten into parallel arrays, assigning rank_order per group (best first).
      const aPatch: number[] = [];
      const aRegion: string[] = [];
      const aBucket: string[] = [];
      const aComp: number[] = [];
      const aTier: string[] = [];
      const aScore: number[] = [];
      const aRank: number[] = [];
      for (const group of byGroup.values()) {
        group.sort((x, y) => y.score - x.score);
        let rank = 0;
        for (const s of group) {
          rank += 1;
          aPatch.push(s.patchId);
          aRegion.push(s.region);
          aBucket.push(s.rankBucket);
          aComp.push(s.compId);
          aTier.push(s.tier);
          aScore.push(s.score);
          aRank.push(rank);
        }
      }

      let written = 0;
      if (aComp.length > 0) {
        const ins = await client.query(
          `INSERT INTO tier_list_entries
             (patch_id, region, rank_bucket, comp_id, tier, score, rank_order, is_manual, computed_at)
           SELECT v.patch_id, v.region, v.rank_bucket, v.comp_id, v.tier, v.score, v.rank_order, false, now()
           FROM unnest($1::int[], $2::text[], $3::text[], $4::int[], $5::text[], $6::numeric[], $7::int[])
                AS v(patch_id, region, rank_bucket, comp_id, tier, score, rank_order)
           ON CONFLICT (patch_id, region, rank_bucket, comp_id) DO NOTHING`,
          [aPatch, aRegion, aBucket, aComp, aTier, aScore, aRank],
        );
        written = ins.rowCount ?? 0;
      }

      await client.query('COMMIT');
      ctx.setItems(written); // auto tier_list_entries written
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  } finally {
    client.release();
  }
}
