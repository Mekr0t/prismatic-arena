import './env'; // MUST be first — loads .env before @/lib/db builds its pool
import { Worker } from 'bullmq';
import { bullConnection } from './connection';
import { makeQueue, QUEUE } from './queues';
import { withJobTracking } from './job-tracking';
import { CRAWL } from '@/config/crawl';
import { runLadderCrawl, type LadderCrawlJob } from './stages/ladder-crawl';
import { runMatchFetch, type MatchFetchJob } from './stages/match-fetch';
import { runCluster, type ClusterJob } from './stages/cluster';
import { runRollup, type RollupJob } from './stages/rollup';
import { runTrendTier, type TrendTierJob } from './stages/trend-tier';
import { runMerge, type MergeJob } from './stages/merge';
import { registerSchedules, clearSchedules } from './scheduler';

// Worker process. Each stage runs here as its own BullMQ worker in one process
// (the "one process, split by stage" shape) so pulling any onto its own machine
// later is just moving a file. ladder-crawl (producer) enqueues per-PUUID
// match-fetch jobs; match-fetch (consumer) drains them and persists boards;
// cluster sweeps boards into comps; rollup aggregates clustered boards into
// per-bucket comp stats; trend-tier snapshots daily trends + regenerates the
// tier list. Every job body runs through withJobTracking, so the admin panel's
// ingestion_jobs section fills with real rows, and any riot.* call auto-logs to
// api_usage via the shared client.
//
// Run modes (all keep the process up as consumers):
//   plain                idle consumer (drains whatever is enqueued)
//   RUN_CRAWL=1          one ladder-crawl pass        (CRAWL.platform)
//   RUN_CLUSTER=1        one cluster sweep            (optional CLUSTER_SET)
//   RUN_ROLLUP=1         one rollup pass
//   RUN_TREND_TIER=1     one trend-tier pass
//   RUN_SCHEDULER=1      register repeatable schedules and self-drive (leave running)
//   SCHED_CLEAR=1        remove the repeatable schedules and exit

// Long-running stages can exceed BullMQ's default 30 s lock duration.
// 5 minutes covers the largest expected sweep; lock is renewed automatically
// at half that interval (2.5 min).
const LONG_LOCK = 5 * 60 * 1000;

const ladderWorker = new Worker<LadderCrawlJob>(
  QUEUE.ladderCrawl,
  (job) =>
    withJobTracking('ladder-crawl', job.data.platform ?? null, (ctx) =>
      runLadderCrawl(job.data, ctx),
    ),
  { connection: bullConnection, concurrency: 1, lockDuration: LONG_LOCK },
);

const matchWorker = new Worker<MatchFetchJob>(
  QUEUE.matchFetch,
  (job) =>
    withJobTracking('match-fetch', job.data.platform ?? null, (ctx) =>
      runMatchFetch(job.data, ctx),
    ),
  // Low concurrency: the Riot client's per-route limiter already spaces calls;
  // this just lets a few PUUID batches drain in parallel without stampeding.
  { connection: bullConnection, concurrency: 3, lockDuration: LONG_LOCK },
);

const clusterWorker = new Worker<ClusterJob>(
  QUEUE.cluster,
  (job) =>
    // Cross-region full sweep over stored boards — region is null (not per-shard).
    withJobTracking('cluster', null, (ctx) => runCluster(job.data, ctx)),
  // Concurrency 1: a single full re-cluster pass; two at once would just contend.
  { connection: bullConnection, concurrency: 1, lockDuration: LONG_LOCK },
);

const rollupWorker = new Worker<RollupJob>(
  QUEUE.rollup,
  (job) =>
    // Cross-region full recompute of comp_stats + bucket_totals — region is null.
    withJobTracking('rollup', null, (ctx) => runRollup(job.data, ctx)),
  // Concurrency 1: full recompute in one transaction; no benefit to parallelism.
  { connection: bullConnection, concurrency: 1, lockDuration: LONG_LOCK },
);

const mergeWorker = new Worker<MergeJob>(
  QUEUE.merge,
  (job) =>
    // Cross-set carry-archetype grouping — region is null (identity is set-scoped).
    withJobTracking('merge', null, (ctx) => runMerge(job.data, ctx)),
  // Concurrency 1: full re-merge of all comps; parallelism would only contend.
  { connection: bullConnection, concurrency: 1, lockDuration: LONG_LOCK },
);

const trendTierWorker = new Worker<TrendTierJob>(
  QUEUE.trendTier,
  (job) =>
    // Cross-region: snapshot trends + regenerate the tier list — region is null.
    withJobTracking('trend-tier', null, (ctx) => runTrendTier(job.data, ctx)),
  // Concurrency 1: one transactional regenerate; parallelism would only contend.
  { connection: bullConnection, concurrency: 1, lockDuration: LONG_LOCK },
);

ladderWorker.on('completed', (job) => console.log(`[ladder-crawl] completed: ${job.id}`));
ladderWorker.on('failed', (job, err) =>
  console.log(`[ladder-crawl] failed: ${job?.id} — ${err.message}`),
);
ladderWorker.on('error', (err) => console.error('[ladder-crawl] error:', err));

matchWorker.on('completed', (job) => console.log(`[match-fetch] completed: ${job.id}`));
matchWorker.on('failed', (job, err) =>
  console.log(`[match-fetch] failed: ${job?.id} — ${err.message}`),
);
matchWorker.on('error', (err) => console.error('[match-fetch] error:', err));

clusterWorker.on('completed', (job) => console.log(`[cluster] completed: ${job.id}`));
clusterWorker.on('failed', (job, err) =>
  console.log(`[cluster] failed: ${job?.id} — ${err.message}`),
);
clusterWorker.on('error', (err) => console.error('[cluster] error:', err));

rollupWorker.on('completed', (job) => console.log(`[rollup] completed: ${job.id}`));
rollupWorker.on('failed', (job, err) =>
  console.log(`[rollup] failed: ${job?.id} — ${err.message}`),
);
rollupWorker.on('error', (err) => console.error('[rollup] error:', err));

mergeWorker.on('completed', (job) => console.log(`[merge] completed: ${job.id}`));
mergeWorker.on('failed', (job, err) =>
  console.log(`[merge] failed: ${job?.id} — ${err.message}`),
);
mergeWorker.on('error', (err) => console.error('[merge] error:', err));

trendTierWorker.on('completed', (job) => console.log(`[trend-tier] completed: ${job.id}`));
trendTierWorker.on('failed', (job, err) =>
  console.log(`[trend-tier] failed: ${job?.id} — ${err.message}`),
);
trendTierWorker.on('error', (err) => console.error('[trend-tier] error:', err));

// Remove the repeatable schedules and exit. Run with: SCHED_CLEAR=1 npm run worker
if (process.env.SCHED_CLEAR === '1') {
  clearSchedules()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('[worker] clear schedules failed:', e);
      process.exit(1);
    });
}

// Self-drive: register repeatable schedules, then leave this process running so
// the workers consume them on cadence. Run with: RUN_SCHEDULER=1 npm run worker
if (process.env.RUN_SCHEDULER === '1') {
  registerSchedules().catch((e) => console.error('[worker] register schedules failed:', e));
}

// Kick a single crawl pass on boot, behind a flag, so the worker can also just
// run idle as a consumer. Run one pass with: RUN_CRAWL=1 npm run worker
if (process.env.RUN_CRAWL === '1') {
  const q = makeQueue(QUEUE.ladderCrawl);
  q.add('crawl', { platform: CRAWL.platform } satisfies LadderCrawlJob)
    .then(() => q.close())
    .then(() => console.log(`[worker] enqueued a ladder-crawl pass for ${CRAWL.platform}`))
    .catch((e) => console.error('[worker] crawl enqueue failed:', e));
}

// Kick a single cluster pass on boot, behind its own flag. All sets by default;
// scope to one with CLUSTER_SET. Run with: RUN_CLUSTER=1 npm run worker
if (process.env.RUN_CLUSTER === '1') {
  const q = makeQueue(QUEUE.cluster);
  const setNumber = process.env.CLUSTER_SET ? Number(process.env.CLUSTER_SET) : undefined;
  q.add('cluster', { setNumber } satisfies ClusterJob)
    .then(() => q.close())
    .then(() =>
      console.log(
        `[worker] enqueued a cluster pass${setNumber ? ` for set ${setNumber}` : ' (all sets)'}`,
      ),
    )
    .catch((e) => console.error('[worker] cluster enqueue failed:', e));
}

// Kick a single rollup pass on boot, behind its own flag. Run cluster first.
// Run with: RUN_ROLLUP=1 npm run worker
if (process.env.RUN_ROLLUP === '1') {
  const q = makeQueue(QUEUE.rollup);
  q.add('rollup', {} satisfies RollupJob)
    .then(() => q.close())
    .then(() => console.log('[worker] enqueued a rollup pass'))
    .catch((e) => console.error('[worker] rollup enqueue failed:', e));
}

// Kick a single trend-tier pass on boot, behind its own flag. Run rollup first.
// Run with: RUN_TREND_TIER=1 npm run worker
if (process.env.RUN_TREND_TIER === '1') {
  const q = makeQueue(QUEUE.trendTier);
  q.add('trend-tier', {} satisfies TrendTierJob)
    .then(() => q.close())
    .then(() => console.log('[worker] enqueued a trend-tier pass'))
    .catch((e) => console.error('[worker] trend-tier enqueue failed:', e));
}

// Kick a single merge pass on boot, behind its own flag. Run cluster first.
// Run with: RUN_MERGE=1 npm run worker
if (process.env.RUN_MERGE === '1') {
  const q = makeQueue(QUEUE.merge);
  const setNumber = process.env.MERGE_SET ? Number(process.env.MERGE_SET) : undefined;
  q.add('merge', { setNumber } satisfies MergeJob)
    .then(() => q.close())
    .then(() =>
      console.log(
        `[worker] enqueued a merge pass${setNumber ? ` for set ${setNumber}` : ' (all sets)'}`,
      ),
    )
    .catch((e) => console.error('[worker] merge enqueue failed:', e));
}

async function shutdown(): Promise<void> {
  await Promise.all([
    ladderWorker.close(),
    matchWorker.close(),
    clusterWorker.close(),
    rollupWorker.close(),
    mergeWorker.close(),
    trendTierWorker.close(),
  ]);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log(
  '[worker] up — ladder-crawl + match-fetch + cluster + rollup + merge + trend-tier workers running',
);