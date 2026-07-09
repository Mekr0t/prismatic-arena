// scheduler.ts — repeatable-job plumbing. Registers one BullMQ job scheduler per
// stage so the pipeline self-drives on a cadence instead of four manual RUN_*
// triggers. The stages stay independent (each idempotent: full recompute), so
// they run on their own intervals and converge — no strict chaining needed.
//
// IMPORTANT — this is SUPERVISED plumbing, not an unattended production firehose.
// The dev Riot key expires every 24h and caps ~20 rps / 100 per 2 min, so the
// "crawl continuously" the roadmap envisions needs a production key. Leave the
// worker process running to accumulate data over a session; the conservative
// default cadences keep it within dev limits.
//
// Schedulers persist in Redis (idempotent by id, survive restart) and keep firing
// as long as a worker process is alive to consume them. To stop them, remove the
// schedulers with SCHED_CLEAR=1 (re-running RUN_SCHEDULER only updates cadences).

import { makeQueue, QUEUE } from './queues';
import { CRAWL } from '@/config/crawl';
import type { LadderCrawlJob } from './stages/ladder-crawl';
import type { ClusterJob } from './stages/cluster';
import type { RollupJob } from './stages/rollup';
import type { TrendTierJob } from './stages/trend-tier';
import type { MergeJob } from './stages/merge';

const minutes = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// Cadences in minutes (env-overridable). Conservative defaults: crawl often
// enough to catch new games, cluster + rollup hourly, retier daily (the trend
// snapshot is one datapoint per day, deduped on date).
const SCHEDULE = {
  crawlMin: minutes(process.env.SCHED_CRAWL_MIN, 30),
  clusterMin: minutes(process.env.SCHED_CLUSTER_MIN, 60),
  rollupMin: minutes(process.env.SCHED_ROLLUP_MIN, 60),
  mergeMin: minutes(process.env.SCHED_MERGE_MIN, 60),
  trendTierMin: minutes(process.env.SCHED_TREND_TIER_MIN, 1440),
} as const;

const MIN_MS = 60_000;

// Stable scheduler ids — re-running upsert updates the cadence in place rather
// than creating a duplicate schedule.
const SCHED_ID = {
  crawl: 'sched:ladder-crawl',
  cluster: 'sched:cluster',
  rollup: 'sched:rollup',
  merge: 'sched:merge',
  trendTier: 'sched:trend-tier',
} as const;

/** Register (or update) every stage's repeatable schedule, then release the
 *  producer connections — the long-running workers carry the schedule forward. */
export async function registerSchedules(): Promise<void> {
  const crawlQ     = makeQueue(QUEUE.ladderCrawl);
  const clusterQ   = makeQueue(QUEUE.cluster);
  const rollupQ    = makeQueue(QUEUE.rollup);
  const mergeQ     = makeQueue(QUEUE.merge);
  const trendTierQ = makeQueue(QUEUE.trendTier);
  try {
    await crawlQ.upsertJobScheduler(
      SCHED_ID.crawl,
      { every: SCHEDULE.crawlMin * MIN_MS },
      { name: 'crawl', data: { platform: CRAWL.platform } satisfies LadderCrawlJob },
    );
    await clusterQ.upsertJobScheduler(
      SCHED_ID.cluster,
      { every: SCHEDULE.clusterMin * MIN_MS },
      { name: 'cluster', data: {} satisfies ClusterJob },
    );
    await rollupQ.upsertJobScheduler(
      SCHED_ID.rollup,
      { every: SCHEDULE.rollupMin * MIN_MS },
      { name: 'rollup', data: {} satisfies RollupJob },
    );
    await mergeQ.upsertJobScheduler(
      SCHED_ID.merge,
      { every: SCHEDULE.mergeMin * MIN_MS },
      { name: 'merge', data: {} satisfies MergeJob },
    );
    await trendTierQ.upsertJobScheduler(
      SCHED_ID.trendTier,
      { every: SCHEDULE.trendTierMin * MIN_MS },
      { name: 'trend-tier', data: {} satisfies TrendTierJob },
    );
    console.log(
      `[scheduler] registered — crawl ${SCHEDULE.crawlMin}m · cluster ${SCHEDULE.clusterMin}m · ` +
        `rollup ${SCHEDULE.rollupMin}m · merge ${SCHEDULE.mergeMin}m · trend-tier ${SCHEDULE.trendTierMin}m`,
    );
  } finally {
    await Promise.all([crawlQ.close(), clusterQ.close(), rollupQ.close(), mergeQ.close(), trendTierQ.close()]);
  }
}

/** Remove every stage schedule (the workers will then sit idle as consumers). */
export async function clearSchedules(): Promise<void> {
  const entries = [
    { q: makeQueue(QUEUE.ladderCrawl), id: SCHED_ID.crawl },
    { q: makeQueue(QUEUE.cluster), id: SCHED_ID.cluster },
    { q: makeQueue(QUEUE.rollup), id: SCHED_ID.rollup },
    { q: makeQueue(QUEUE.merge), id: SCHED_ID.merge },
    { q: makeQueue(QUEUE.trendTier), id: SCHED_ID.trendTier },
  ];
  try {
    for (const { q, id } of entries) await q.removeJobScheduler(id);
    console.log('[scheduler] cleared all stage schedules');
  } finally {
    await Promise.all(entries.map(({ q }) => q.close()));
  }
}
