// drain-active.ts — clear stale "Running" state from both BullMQ (Redis) and
// the ingestion_jobs table (Postgres).
//
// When the worker process is killed mid-job:
//   - BullMQ leaves the job in the Redis "active" set (lock eventually expires,
//     then stall-detection re-queues it — causing "Missing lock" errors on the
//     next worker start as the new worker picks up the orphaned job).
//   - ingestion_jobs rows stay in status='running' forever.
//
// Run this BEFORE starting a fresh worker after a crash to prevent both.
//
// Usage: tsx scripts/drain-active.ts

import '../src/server/queue/env';
import { makeQueue, QUEUE } from '../src/server/queue/queues';
import { query, pool } from '../src/lib/db';

// ── 1. Remove active jobs from every BullMQ queue (Redis) ────────────────────
let bullTotal = 0;
for (const queueName of Object.values(QUEUE)) {
  const q = makeQueue(queueName);
  try {
    const active = await q.getJobs(['active']);
    let removed = 0, skipped = 0;
    for (const job of active) {
      try {
        await job.remove();
        removed++;
      } catch {
        // Job is locked by a live worker — skip it (it will finish on its own).
        skipped++;
      }
    }
    if (removed > 0) console.log(`[bullmq] ${queueName}: removed ${removed} stale active job(s)`);
    if (skipped > 0) console.log(`[bullmq] ${queueName}: skipped ${skipped} job(s) locked by a live worker`);
    bullTotal += removed;
  } finally {
    await q.close();
  }
}
if (bullTotal === 0) console.log('[bullmq] no active jobs found');

// ── 2. Mark stale ingestion_jobs rows as failed (Postgres) ───────────────────
const rows = await query<{ id: string; job_type: string; started_at: Date }>(
  `UPDATE ingestion_jobs
      SET status = 'failed', finished_at = now()
    WHERE status = 'running'
    RETURNING id, job_type, started_at`,
);

if (rows.length === 0) {
  console.log('[postgres] no stale running rows found');
} else {
  for (const row of rows) {
    const age = Math.round((Date.now() - new Date(row.started_at).getTime()) / 1000);
    console.log(`[postgres] failed: ${row.job_type} (id=${row.id}, was running ${age}s)`);
  }
  console.log(`[postgres] marked ${rows.length} row(s) as failed`);
}

await pool.end();
process.exit(0);
