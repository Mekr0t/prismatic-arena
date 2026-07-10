// _apply-merge.ts — one-off: run the Stage-6 merge job directly (no BullMQ),
// wrapped in the same ingestion_jobs tracking the worker uses. Temporary
// helper; delete after use.
import 'dotenv/config';
import { pool } from '@/lib/db';
import { withJobTracking } from '@/server/queue/job-tracking';
import { runMerge } from '@/server/queue/stages/merge';

withJobTracking('merge', null, (ctx) => runMerge({}, ctx))
  .then(() => console.log('merge applied'))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void pool.end());
