import type { Queue } from 'bullmq';
import { makeQueue, QUEUE, type QueueName } from './queues';

// The derived-stats stages are a DEPENDENCY CHAIN, not four independent
// schedules. Each one consumes what the previous one wrote:
//
//   cluster  → stamps match_participants.comp_id, prunes board-less comps
//              (and DELETEs their comp_stats / tier_list_entries rows)
//   rollup   → DELETEs and rebuilds comp_stats + bucket_totals from those stamps
//   merge    → reads comp_stats, writes comps.meta_comp
//   trend-tier → reads comp_stats, writes comp_stat_trends + tier_list_entries
//   elect      → reads boards, writes comp_lines + line_stats + line_id
//
// Running them on separate cadences let them interleave, and two of those
// interleavings corrupt what the read path serves: a rollup that starts mid-
// cluster aggregates half-stamped boards, and a cluster that prunes while
// trend-tier is regenerating leaves tier_list_entries pointing at comps that no
// longer exist. Chaining removes the concurrency instead of guarding it — only
// one stage is ever in flight, and each starts from a settled predecessor.
//
// Only `completed` advances the chain: a failed stage stops it, so a broken
// cluster can't feed garbage forward. The next scheduled head run retries.

const NEXT: Partial<Record<QueueName, QueueName>> = {
  [QUEUE.cluster]: QUEUE.rollup,
  [QUEUE.rollup]: QUEUE.merge,
  [QUEUE.merge]: QUEUE.trendTier,
  // ELECT RUNS LAST, ON PURPOSE, while it is the new and untrusted model. It
  // reads boards and writes only its own tables, so nothing downstream needs it
  // — and putting it at the tail means a failure in it cannot stop the stats the
  // site actually serves from updating. It moves to the front of the chain when
  // it becomes the primary model and rollup starts depending on its stamps.
  [QUEUE.trendTier]: QUEUE.elect,
};

/** The stage the scheduler kicks; everything downstream follows from it. */
export const CHAIN_HEAD: QueueName = QUEUE.cluster;

/** Set PIPELINE_CHAIN=false to debug one stage without dragging the rest along. */
export const CHAIN_ENABLED = process.env.PIPELINE_CHAIN !== 'false';

/** Retries per chained stage, for the transient-deadlock case (see advanceChain). */
const CHAIN_ATTEMPTS = (() => {
  const n = Number(process.env.PIPELINE_CHAIN_ATTEMPTS);
  return Number.isFinite(n) && n > 0 ? n : 3;
})();

// Producer queues are created once and kept for the worker's lifetime — a new
// Queue per completion would leak a Redis connection on every pipeline pass.
const queues = new Map<QueueName, Queue>();
function queueFor(name: QueueName): Queue {
  let q = queues.get(name);
  if (!q) {
    q = makeQueue(name);
    queues.set(name, q);
  }
  return q;
}

/**
 * Enqueue the stage that follows `from`. No-op at the end of the chain, or when
 * chaining is disabled.
 *
 * `setNumber` propagates so a set-scoped cluster produces a set-scoped rollup,
 * merge and trend-tier rather than silently widening to every set.
 *
 * The jobId is stable per stage, so a head that fires again while the chain is
 * still draining DEDUPES instead of queueing a second pass — the stages are full
 * recomputes, and a backlog of them is pure waste. It deliberately avoids ':' —
 * BullMQ only accepts a custom id containing colons when it splits into exactly
 * three parts (see Job.validateOptions), which makes any other colon-bearing
 * format a runtime throw rather than a type error.
 *
 * A stable jobId means RETENTION MUST BE OFF ON BOTH OUTCOMES. `add()` with an
 * existing jobId silently returns the existing job, so one retained terminal job
 * wedges that link of the chain forever — observed 2026-08-18: a single
 * `chain-merge` failed with a Postgres deadlock, stayed in the failed set under
 * its id, and every later rollup completion no-opped against it for hours. The
 * failure is still observable without retention: worker.ts logs the reason from
 * each worker's `failed` event, and withJobTracking records the run in
 * `ingestion_jobs`.
 *
 * `attempts` + backoff target that same deadlock class. The stages take
 * overlapping locks on comps / comp_stats, and a lost tie should retry rather
 * than abandon the pass until the next scheduled head run.
 */
export async function advanceChain(from: QueueName, setNumber?: number): Promise<void> {
  if (!CHAIN_ENABLED) return;
  const next = NEXT[from];
  if (!next) return;
  await queueFor(next).add(
    next,
    { setNumber },
    {
      jobId: `chain-${next}`,
      removeOnComplete: true,
      removeOnFail: true,
      attempts: CHAIN_ATTEMPTS,
      backoff: { type: 'exponential', delay: 5_000 },
    },
  );
  console.log(`[chain] ${from} → ${next}${setNumber ? ` (set ${setNumber})` : ''}`);
}

/**
 * True when any stage of the chain is still in flight.
 *
 * WHY THE CHAIN ALONE IS NOT ENOUGH. Chaining removes concurrency *within* a
 * pass — each stage starts from a settled predecessor — but the SCHEDULER kicks
 * the head on a fixed cadence and knows nothing about whether the previous pass
 * has finished. A repeatable job gets a fresh id every firing, so the stable
 * `chain-<stage>` dedupe does not cover it. While a pass fits inside the
 * interval that is invisible; once it does not, the head starts a second pass
 * and stages from the two passes run side by side.
 *
 * Observed 2026-09-04, after the dataset grew ~2.5x in a day: merge at 1,028 s
 * and cluster at 796 s running SIMULTANEOUSLY, with everything behind them
 * queued on locks — exactly the interleaving this file's header says corrupts
 * what the read path serves (a rollup over half-stamped boards, a prune while
 * trend-tier regenerates).
 */
export async function downstreamBusy(): Promise<boolean> {
  // Cluster is deliberately NOT checked: it is the head, so its own job is
  // always active when this is called, and its concurrency of 1 already makes
  // cluster-on-cluster impossible. What has to be excluded is a head starting
  // while a LATER stage of the previous pass is still working.
  const stages: QueueName[] = [QUEUE.rollup, QUEUE.merge, QUEUE.trendTier, QUEUE.elect];
  for (const name of stages) {
    const counts = await queueFor(name).getJobCounts('active', 'waiting', 'delayed');
    if ((counts.active ?? 0) + (counts.waiting ?? 0) + (counts.delayed ?? 0) > 0) return true;
  }
  return false;
}

/** Close the producer connections (worker shutdown). */
export async function closeChain(): Promise<void> {
  await Promise.all([...queues.values()].map((q) => q.close()));
  queues.clear();
}
