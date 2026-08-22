// trend-tier.ts — Stage 5 (trend-tier).
// Two jobs that belong together, both reading the rollup's comp_stats:
//   A) snapshot today's sufficient stats into comp_stat_trends, ONE ROW PER
//      ARCHETYPE (idempotent per day) — the series patch velocity reads later.
//   B) regenerate the auto tier list: score each comp (>= TIER_MIN_SAMPLE) via
//      comp-stats-math, rank within each (patch, region, rank_bucket), map to
//      S/A/B/C/D, write tier_list_entries — preserving admin manual overrides.
// One transaction. Run after the rollup (it reads comp_stats / bucket_totals).

import { pool } from '@/lib/db';
import { GKEY_SQL } from '@/server/comp-gkey';
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

// Trend snapshots are bounded by the same POOLED floor the read path groups on,
// set lower than TIER_MIN_SAMPLE so the niche list (groups just under the tier
// floor, biggest first, capped at 100) still has a chart. Measured 2026-08-21:
// 66,327 groups exist, 1,214 clear 15 and 2,558 clear 3 — so a floor of 3 keeps
// everything reachable with wide margin. A group below it renders nowhere, so
// nothing ever reads its series.
const TREND_MIN_SAMPLE = num(process.env.TREND_MIN_SAMPLE, 3);

// Snapshots older than this are pruned. Bounds the table at roughly
// (groups × days) rows instead of growing forever.
const TREND_RETENTION_DAYS = num(process.env.TREND_RETENTION_DAYS, 90);

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
      // A ─ Daily trend snapshot: ONE AGGREGATE ROW PER ARCHETYPE.
      //
      // This used to insert every comp_stats row verbatim — all 257,053 of them,
      // every pass, forever. comp_stat_trends reached 2.26 M rows / 577 MB in 19
      // days and was the fastest-growing table in the database, to serve a chart
      // that reads one archetype's series at a time.
      //
      // The obvious fix — only snapshot comps clearing the tier floor — is WRONG,
      // and measurably so: the floor is POOLED across an archetype's members, and
      // a rendering archetype averages ~152 members of which only a handful clear
      // 15 on their own. A per-comp floor keeps just 29.2% of a rendered
      // archetype's boards, so every chart would silently under-report by ~70%.
      //
      // So we aggregate instead of filtering: sum the members exactly as the
      // reader does (comp-detail-service sums n / placement_sum / top4_count over
      // the archetype's member ids) and store ONE row. 257,053 rows/day becomes
      // ~2,558 — a 100× reduction — with the chart's values unchanged.
      //
      // The aggregate is anchored on min(comp_id) of the group. That keeps the
      // existing primary key, the FK and the reader's `comp_id = ANY(members)`
      // predicate working untouched: the anchor is itself a member, so the
      // reader finds the row and its SUM over one row is the group total.
      // HISTORICAL ROWS STAY CORRECT TOO — older dates hold per-comp rows and the
      // same SUM re-derives the same group total from them, so the series is
      // continuous across the changeover.
      //
      // CAVEAT worth knowing: a row's comp_id now means "the series for the
      // archetype anchored here", not "this comp's own stats". Nothing else reads
      // this table, but a future direct reader must not assume per-comp meaning.
      //
      // The per-day DELETE is what makes the changeover safe: today may already
      // hold per-comp rows written by the previous build, and leaving them beside
      // a new aggregate row would make the reader's SUM double-count that date.
      // It also makes the snapshot idempotent per day without an upsert.
      await client.query(`DELETE FROM comp_stat_trends WHERE snapshot_date = CURRENT_DATE`);

      const snap = await client.query(
        `INSERT INTO comp_stat_trends
           (comp_id, patch_id, region, rank_bucket, snapshot_date,
            n, bucket_total, placement_sum, top4_count, win_count)
         SELECT min(cs.comp_id), cs.patch_id, cs.region, cs.rank_bucket, CURRENT_DATE,
                sum(cs.n)::int, COALESCE(max(bt.total_boards), 0),
                sum(cs.placement_sum), sum(cs.top4_count)::int, sum(cs.win_count)::int
           FROM comp_stats cs
           JOIN comps c ON c.id = cs.comp_id
           LEFT JOIN bucket_totals bt
                  ON bt.patch_id = cs.patch_id
                 AND bt.region = cs.region
                 AND bt.rank_bucket = cs.rank_bucket
          GROUP BY ${GKEY_SQL}, cs.patch_id, cs.region, cs.rank_bucket
         HAVING sum(cs.n) >= $1`,
        [TREND_MIN_SAMPLE],
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
      console.log(
        `[trend-tier] snapshot ${snap.rowCount ?? 0} archetype rows ` +
          `(pooled n >= ${TREND_MIN_SAMPLE}) — ${written} auto tier entries`,
      );
      ctx.setItems(written); // auto tier_list_entries written
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  } finally {
    client.release();
  }

  // Retention, AFTER the commit and outside that transaction on purpose: the
  // write transaction above holds locks on tier_list_entries, and a prune can be
  // large the first time a retention window is applied (or shortened). Keeping
  // it separate is the same lesson the is_current deadlock taught — housekeeping
  // does not belong inside a transaction that holds pipeline locks.
  //
  // A failure here is logged and swallowed rather than failing the job: the
  // snapshot and the tier list are the job's real output and they are already
  // committed. The next pass retries the prune.
  try {
    const pruned = await pool.query(
      `DELETE FROM comp_stat_trends WHERE snapshot_date < CURRENT_DATE - $1::int`,
      [TREND_RETENTION_DAYS],
    );
    if (pruned.rowCount) {
      console.log(
        `[trend-tier] pruned ${pruned.rowCount} snapshot rows older than ${TREND_RETENTION_DAYS}d`,
      );
    }
  } catch (e) {
    console.error(`[trend-tier] retention prune failed (snapshot committed):`, (e as Error).message);
  }
}
