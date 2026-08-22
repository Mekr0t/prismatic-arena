import './env'; // MUST be first — loads .env AND validates it (see that file)
import { Worker } from 'bullmq';
import { bullConnection } from './connection';
import { makeQueue, QUEUE } from './queues';
import { withJobTracking, reconcileStuckJobs } from './job-tracking';
import { CRAWL } from '@/config/crawl';
import { runLadderCrawl, type LadderCrawlJob } from './stages/ladder-crawl';
import { runMatchFetch, type MatchFetchJob } from './stages/match-fetch';
import { runCluster, type ClusterJob } from './stages/cluster';
import { runRollup, type RollupJob } from './stages/rollup';
import { runTrendTier, type TrendTierJob } from './stages/trend-tier';
import { runMerge, type MergeJob } from './stages/merge';
import { registerSchedules, clearSchedules } from './scheduler';
import { advanceChain, closeChain, CHAIN_ENABLED } from './chain';

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
//
// PIPELINE CHAIN: cluster → rollup → merge → trend-tier advance automatically on
// success (see ./chain.ts), so the scheduler only kicks the head. A RUN_CLUSTER=1
// trigger therefore runs the whole derived-stats pipeline too. Set
// PIPELINE_CHAIN=false to isolate a single stage while debugging.

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

clusterWorker.on('completed', (job) => {
  console.log(`[cluster] completed: ${job.id}`);
  void advanceChain(QUEUE.cluster, job.data?.setNumber);
});
clusterWorker.on('failed', (job, err) =>
  console.log(`[cluster] failed: ${job?.id} — ${err.message}`),
);
clusterWorker.on('error', (err) => console.error('[cluster] error:', err));

rollupWorker.on('completed', (job) => {
  console.log(`[rollup] completed: ${job.id}`);
  void advanceChain(QUEUE.rollup, job.data?.setNumber);
});
rollupWorker.on('failed', (job, err) =>
  console.log(`[rollup] failed: ${job?.id} — ${err.message}`),
);
rollupWorker.on('error', (err) => console.error('[rollup] error:', err));

mergeWorker.on('completed', (job) => {
  console.log(`[merge] completed: ${job.id}`);
  void advanceChain(QUEUE.merge, job.data?.setNumber);
});
mergeWorker.on('failed', (job, err) =>
  console.log(`[merge] failed: ${job?.id} — ${err.message}`),
);
mergeWorker.on('error', (err) => console.error('[merge] error:', err));

trendTierWorker.on('completed', (job) => console.log(`[trend-tier] completed: ${job.id}`));
trendTierWorker.on('failed', (job, err) =>
  console.log(`[trend-tier] failed: ${job?.id} — ${err.message}`),
);
trendTierWorker.on('error', (err) => console.error('[trend-tier] error:', err));

// The derived stages advance from cluster on their own (./chain.ts), so booting
// with RUN_ROLLUP / RUN_MERGE / RUN_TREND_TIER while chaining is enabled starts
// EXTRA passes mid-pipeline that run concurrently with the real one — which is
// the stage overlap the chain exists to remove (observed 2026-08-18: cluster,
// rollup, merge and trend-tier all starting in the same second at boot, because
// all four flags were set). Downstream triggers are therefore ignored unless
// chaining is off, and every boot trigger uses a stable jobId so repeated
// restarts can't stack passes.
const DOWNSTREAM_FLAGS = ['RUN_ROLLUP', 'RUN_MERGE', 'RUN_TREND_TIER'] as const;
const activeDownstream = DOWNSTREAM_FLAGS.filter((f) => process.env[f] === '1');
if (CHAIN_ENABLED && activeDownstream.length > 0) {
  console.warn(
    `[worker] ignoring ${activeDownstream.join(', ')} — the chain advances these from cluster. ` +
      'Use RUN_SCHEDULER=1 alone, or set PIPELINE_CHAIN=false to drive a single stage.',
  );
}
/** True when a mid-pipeline stage may be kicked directly (i.e. chaining is off). */
const allowDownstreamBoot = !CHAIN_ENABLED;

// Reconcile ingestion_jobs rows orphaned by a previous worker's death, before
// anything new is enqueued, so the admin panel's job list reflects reality from
// the moment this process is up. Advisory and self-correcting — see
// reconcileStuckJobs. Fire-and-forget: a failure here must not stop the worker
// from doing its actual job.
const STUCK_JOB_MINUTES = (() => {
  const n = Number(process.env.JOB_STUCK_MINUTES);
  return Number.isFinite(n) && n > 0 ? n : 30;
})();
reconcileStuckJobs(STUCK_JOB_MINUTES)
  .then((n) => {
    if (n > 0) console.log(`[worker] reconciled ${n} stuck 'running' job row(s) from a previous run`);
  })
  .catch((e) => console.error('[worker] stuck-job reconcile failed:', e));

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
  q.add('crawl', { platform: CRAWL.platform } satisfies LadderCrawlJob, {
    jobId: 'boot-crawl',
    removeOnComplete: true,
  })
    .then(() => q.close())
    .then(() => console.log(`[worker] enqueued a ladder-crawl pass for ${CRAWL.platform}`))
    .catch((e) => console.error('[worker] crawl enqueue failed:', e));
}

// Kick a single cluster pass on boot, behind its own flag. All sets by default;
// scope to one with CLUSTER_SET. Run with: RUN_CLUSTER=1 npm run worker
//
// REDUNDANT WITH RUN_SCHEDULER: registering the scheduler fires its first run
// immediately, so booting with both flags enqueues TWO cluster jobs at the same
// instant — and now that cluster is the head of a chain, that starts two
// overlapping pipeline passes (pass B's rollup running against pass A's
// half-finished cluster, which is the interleaving the chain exists to remove).
// The stable jobId makes the boot trigger idempotent so repeated boots can't
// stack passes; it still cannot dedupe against the scheduler's own `repeat:` id,
// so prefer RUN_SCHEDULER alone for normal operation and RUN_CLUSTER only for a
// one-off pass on a worker with no schedules registered.
if (process.env.RUN_CLUSTER === '1') {
  const q = makeQueue(QUEUE.cluster);
  const setNumber = process.env.CLUSTER_SET ? Number(process.env.CLUSTER_SET) : undefined;
  q.add('cluster', { setNumber } satisfies ClusterJob, {
    jobId: 'boot-cluster',
    removeOnComplete: true,
  })
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
if (process.env.RUN_ROLLUP === '1' && allowDownstreamBoot) {
  const q = makeQueue(QUEUE.rollup);
  q.add('rollup', {} satisfies RollupJob, { jobId: 'boot-rollup', removeOnComplete: true })
    .then(() => q.close())
    .then(() => console.log('[worker] enqueued a rollup pass'))
    .catch((e) => console.error('[worker] rollup enqueue failed:', e));
}

// Kick a single trend-tier pass on boot, behind its own flag. Run rollup first.
// Run with: RUN_TREND_TIER=1 npm run worker
if (process.env.RUN_TREND_TIER === '1' && allowDownstreamBoot) {
  const q = makeQueue(QUEUE.trendTier);
  q.add('trend-tier', {} satisfies TrendTierJob, { jobId: 'boot-trend-tier', removeOnComplete: true })
    .then(() => q.close())
    .then(() => console.log('[worker] enqueued a trend-tier pass'))
    .catch((e) => console.error('[worker] trend-tier enqueue failed:', e));
}

// Kick a single merge pass on boot, behind its own flag. Run cluster first.
// Run with: RUN_MERGE=1 npm run worker
if (process.env.RUN_MERGE === '1' && allowDownstreamBoot) {
  const q = makeQueue(QUEUE.merge);
  const setNumber = process.env.MERGE_SET ? Number(process.env.MERGE_SET) : undefined;
  q.add('merge', { setNumber } satisfies MergeJob, { jobId: 'boot-merge', removeOnComplete: true })
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
  await closeChain();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log(
  '[worker] up — ladder-crawl + match-fetch + cluster + rollup + merge + trend-tier workers running' +
    (CHAIN_ENABLED
      ? ' · chain: cluster → rollup → merge → trend-tier'
      : ' · chain DISABLED (PIPELINE_CHAIN=false)'),
);