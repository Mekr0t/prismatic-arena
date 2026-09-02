import type { Queue } from 'bullmq';
import { makeQueue, QUEUE } from './queues';
import { CRAWL } from '@/config/crawl';
import { inScopeBuckets, type RankBucket } from '@/config/rank-buckets';
import type { MatchFetchJob } from './stages/match-fetch';

// scope-reconcile.ts — make the match-fetch queue agree with CRAWL_TIERS.
//
// The rank gate only decides what gets ENQUEUED. Narrowing the scope therefore
// does nothing to work already in the queue, and BullMQ is FIFO, so the old
// wide-scope jobs drain first while the ones you actually want wait behind them.
// Measured 2026-09-02, hours after the scope was narrowed to master+: 355 jobs
// waiting, of which 226 were iron_gold / unknown / plat_emerald from before the
// change, sitting in front of 126 apex batches. Every board landing that minute
// was low-elo, and master_plus had been flat for a day — with the gate working
// perfectly the whole time.
//
// So the scope has to be enforced where the work is, not only where it is
// created. This runs at worker boot, which is exactly when an env change takes
// effect, and it is the same shape as reconcileStuckJobs: advisory, bounded,
// and safe to run on every start.
//
// Failed jobs are reconciled in the same pass, because the two problems have the
// same root — an in-scope batch that failed for reasons that say nothing about
// the player is work we still want, and leaving it in the failed set is how a
// dead-key window silently costs a day of apex sample.

/** Jobs inspected per state. Far above the observed queue depth; the cap exists
 *  so a runaway queue cannot turn boot into a long scan. */
const SCAN_LIMIT = 5_000;

export interface ScopeReconcileResult {
  droppedWaiting: number;
  droppedFailed: number;
  retriedFailed: number;
  /** Null when the scope admits everything, i.e. nothing was enforced. */
  inScopeBuckets: RankBucket[] | null;
}

async function scan(queue: Queue, state: 'waiting' | 'delayed' | 'failed') {
  const jobs = await queue.getJobs([state], 0, SCAN_LIMIT - 1);
  return jobs;
}

/**
 * Drop queued match-fetch work that the current scope no longer wants, and
 * re-offer failed work that it still does.
 *
 * Returns counts for logging. Never throws on an individual job — a job that
 * vanished between the scan and the action (drained by a worker in the same
 * moment) is a normal race, not a failure.
 */
export async function reconcileCrawlScope(): Promise<ScopeReconcileResult> {
  const scope = inScopeBuckets(CRAWL.tiers);
  const result: ScopeReconcileResult = {
    droppedWaiting: 0,
    droppedFailed: 0,
    retriedFailed: 0,
    inScopeBuckets: scope ? [...scope] : null,
  };

  const queue = makeQueue(QUEUE.matchFetch);
  try {
    for (const state of ['waiting', 'delayed'] as const) {
      if (!scope) break;
      for (const job of await scan(queue, state)) {
        const bucket = (job.data as MatchFetchJob).bucket;
        if (bucket && scope.has(bucket)) continue;
        try {
          await job.remove();
          result.droppedWaiting += 1;
        } catch {
          // Already gone — a worker picked it up mid-scan.
        }
      }
    }

    for (const job of await scan(queue, 'failed')) {
      const bucket = (job.data as MatchFetchJob).bucket;
      const wanted = !scope || (bucket ? scope.has(bucket) : false);
      try {
        if (wanted) {
          // Back to the WAITING list, behind whatever is already queued — a
          // re-offered batch must not jump ahead of fresh work.
          await job.retry();
          result.retriedFailed += 1;
        } else {
          await job.remove();
          result.droppedFailed += 1;
        }
      } catch {
        // Same race as above, or a job whose state moved under us.
      }
    }
  } finally {
    await queue.close();
  }

  return result;
}
