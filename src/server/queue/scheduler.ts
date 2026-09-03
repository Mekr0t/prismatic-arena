// scheduler.ts — repeatable-job plumbing. Registers the two things that need a
// cadence, and nothing else:
//
//   • ladder-crawl — the producer. Independent of the derived stages; it just
//     keeps the frontier draining and matches arriving.
//   • the PIPELINE HEAD (cluster) — everything downstream advances from it via
//     ./chain.ts, on success only.
//
// It used to register cluster, rollup, merge and trend-tier as four independent
// repeatables, on the theory that idempotent full-recompute stages converge on
// their own. They don't: cluster PRUNES board-less comps and deletes their
// comp_stats / tier_list_entries rows, which rollup and trend-tier are
// concurrently rebuilding. Overlapping runs left the read path serving
// comp_stats for comps that no longer existed. Chaining removes the overlap
// rather than guarding it — see the header of ./chain.ts.
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
import { CHAIN_HEAD } from './chain';
import { CRAWL } from '@/config/crawl';
import type { LadderCrawlJob } from './stages/ladder-crawl';
import type { ClusterJob } from './stages/cluster';

const minutes = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// Cadences in minutes (env-overridable). SCHED_PIPELINE_MIN paces the whole
// derived-stats chain; it falls back to the old SCHED_CLUSTER_MIN so an existing
// .env keeps working without edits.
const SCHEDULE = {
  crawlMin: minutes(process.env.SCHED_CRAWL_MIN, 30),
  pipelineMin: minutes(process.env.SCHED_PIPELINE_MIN ?? process.env.SCHED_CLUSTER_MIN, 60),
} as const;

const MIN_MS = 60_000;

// Retention for the REPEATABLE jobs. They set none before, so both their
// completed and their failed sets grew without limit — five platforms every five
// minutes is 60 crawl jobs an hour, and a bug that throws on every pass banks
// them forever: a single afternoon's make_interval fault left 124 dead
// ladder-crawl jobs that nothing would ever have cleared. A COUNT rather than
// `true`, because the recent failures are the diagnostic and only the old ones
// are litter — which is the same choice the per-PUUID match-fetch jobs already
// made with removeOnFail: { count: 500 }.
const RETAIN = {
  removeOnComplete: { count: 50 },
  removeOnFail: { count: 50 },
} as const;

// Stable scheduler ids — re-running upsert updates the cadence in place rather
// than creating a duplicate schedule.
const SCHED_ID = {
  crawl: 'sched:ladder-crawl',
  pipeline: 'sched:cluster', // kept: the head still runs on the cluster queue
} as const;

// Ids registered by the pre-chain scheduler. clearSchedules removes these too so
// upgrading doesn't strand orphan repeatables in Redis that would re-introduce
// exactly the overlap the chain exists to prevent.
const LEGACY = [
  { queue: QUEUE.rollup, id: 'sched:rollup' },
  { queue: QUEUE.merge, id: 'sched:merge' },
  { queue: QUEUE.trendTier, id: 'sched:trend-tier' },
] as const;

/** Register (or update) the crawl + pipeline-head schedules, drop any legacy
 *  per-stage ones, then release the producer connections — the long-running
 *  workers carry the schedule forward. */
export async function registerSchedules(): Promise<void> {
  const crawlQ = makeQueue(QUEUE.ladderCrawl);
  const headQ = makeQueue(CHAIN_HEAD);
  const legacyQs = LEGACY.map((l) => ({ ...l, q: makeQueue(l.queue) }));
  try {
    // ONE SCHEDULER PER PLATFORM. A single job carrying a list would serialise
    // every platform behind one ladder-crawl lock and one shared fetch budget;
    // separate schedulers let each platform's own TFT-LEAGUE-V1 limiter work in
    // parallel, which is the half of the crawl that actually scales per platform
    // (match fetches share their regional route's budget either way).
    for (const platform of CRAWL.platforms) {
      await crawlQ.upsertJobScheduler(
        `${SCHED_ID.crawl}:${platform}`,
        { every: SCHEDULE.crawlMin * MIN_MS },
        { name: 'crawl', data: { platform } satisfies LadderCrawlJob, opts: RETAIN },
      );
    }
    await headQ.upsertJobScheduler(
      SCHED_ID.pipeline,
      { every: SCHEDULE.pipelineMin * MIN_MS },
      { name: 'cluster', data: {} satisfies ClusterJob, opts: RETAIN },
    );

    // The crawl scheduler used to be a single un-suffixed id. Left in Redis it
    // would keep enqueuing the old one-platform job forever alongside the new
    // per-platform ones — the same orphan-repeatable trap the LEGACY list below
    // exists for.
    try {
      await crawlQ.removeJobScheduler(SCHED_ID.crawl);
    } catch {
      // Never registered on this install — nothing to remove.
    }

    // Remove any schedulers left over from the pre-chain layout.
    for (const { q, id } of legacyQs) {
      try {
        await q.removeJobScheduler(id);
      } catch {
        // Never registered on this install — nothing to remove.
      }
    }

    console.log(
      `[scheduler] registered — crawl ${SCHEDULE.crawlMin}m on ${CRAWL.platforms.join(', ')} · ` +
        `pipeline ${SCHEDULE.pipelineMin}m (cluster → rollup → merge → trend-tier)`,
    );
  } finally {
    await Promise.all([crawlQ.close(), headQ.close(), ...legacyQs.map(({ q }) => q.close())]);
  }
}

/** Remove every schedule, current and legacy (the workers then sit idle as consumers). */
export async function clearSchedules(): Promise<void> {
  const crawlQueue = makeQueue(QUEUE.ladderCrawl);
  const entries = [
    // Both shapes: the per-platform ids in use now, and the single id they
    // replaced, so clearing an upgraded install really does leave it idle.
    { q: crawlQueue, id: SCHED_ID.crawl },
    ...CRAWL.platforms.map((platform) => ({ q: crawlQueue, id: `${SCHED_ID.crawl}:${platform}` })),
    { q: makeQueue(CHAIN_HEAD), id: SCHED_ID.pipeline },
    ...LEGACY.map((l) => ({ q: makeQueue(l.queue), id: l.id })),
  ];
  try {
    for (const { q, id } of entries) {
      try {
        await q.removeJobScheduler(id);
      } catch {
        // Already absent.
      }
    }
    console.log('[scheduler] cleared all schedules (including legacy per-stage ones)');
  } finally {
    // Several entries share the crawl queue instance; close each ONCE.
    await Promise.all([...new Set(entries.map(({ q }) => q))].map((q) => q.close()));
  }
}
