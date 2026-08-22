import { query } from '@/lib/db';

// Wraps a unit of pipeline work in an ingestion_jobs lifecycle row so the admin
// panel sees every run: insert `running` up front, flip to `success` or
// `failed` (incrementing error_count) at the end. The callback receives a small
// context to report progress (items_done). This is the single seam every stage
// runs through — and where Riot calls live in 2b, auto-logged to api_usage via
// the shared client.

export interface JobContext {
  /** Report how many items this run processed (surfaced as items_done). */
  setItems(n: number): void;
}

export async function withJobTracking<T>(
  jobType: string,
  region: string | null,
  fn: (ctx: JobContext) => Promise<T>,
): Promise<T> {
  const rows = await query<{ id: string }>(
    `INSERT INTO ingestion_jobs (job_type, region, status, started_at)
     VALUES ($1, $2, 'running', now())
     RETURNING id`,
    [jobType, region],
  );
  const id = rows[0]?.id;

  let items = 0;
  const ctx: JobContext = {
    setItems: (n: number) => {
      items = n;
    },
  };

  try {
    const result = await fn(ctx);
    if (id) {
      await query(
        `UPDATE ingestion_jobs
         SET status = 'success', finished_at = now(), items_done = $2
         WHERE id = $1`,
        [id, items],
      );
    }
    return result;
  } catch (err) {
    if (id) {
      await query(
        `UPDATE ingestion_jobs
         SET status = 'failed', finished_at = now(),
             items_done = $2, error_count = error_count + 1
         WHERE id = $1`,
        [id, items],
      );
    }
    throw err; // rethrow so BullMQ also records the job as failed
  }
}


/**
 * Mark orphaned `running` rows as failed. Called once at worker boot.
 *
 * withJobTracking writes `running` up front and only reconciles when the callback
 * settles, so ANY worker killed mid-job (Ctrl-C, crash, machine sleep, OOM)
 * leaves its row `running` forever. Measured 2026-08-21: 60 such rows across six
 * job types, the oldest from 2026-07-01 — they sit in the admin panel's job list
 * and make "is the pipeline healthy?" unanswerable at a glance. scripts/
 * drain-active.ts cleans them but is manual and had clearly not kept up.
 *
 * SAFE AGAINST FALSE POSITIVES, two ways. The threshold is far longer than any
 * real stage (the slowest measured sweep is cluster at ~48 s against a 5-minute
 * BullMQ lock), and more importantly the write is ADVISORY: if a job we marked
 * failed is actually still alive, withJobTracking's own UPDATE at the end
 * overwrites the row with the true outcome. So a wrong guess self-corrects
 * rather than losing information — which is what makes it safe to run at boot
 * even when a second worker process is live.
 *
 * Returns the number of rows reconciled.
 */
export async function reconcileStuckJobs(olderThanMinutes: number): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE ingestion_jobs
        SET status = 'failed', finished_at = now(), error_count = error_count + 1
      WHERE status = 'running'
        AND started_at < now() - ($1::int * interval '1 minute')
      RETURNING id`,
    [olderThanMinutes],
  );
  return rows.length;
}
