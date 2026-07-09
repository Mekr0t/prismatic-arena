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
