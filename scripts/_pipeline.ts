// _pipeline.ts — one-off: re-run cluster → rollup → merge → trend-tier for set
// 17 directly (no BullMQ), so the emblem-aware signature propagates through the
// derived tables. Temporary helper; delete after use.
import 'dotenv/config';
import { pool } from '@/lib/db';
import { withJobTracking } from '@/server/queue/job-tracking';
import { runCluster } from '@/server/queue/stages/cluster';
import { runRollup } from '@/server/queue/stages/rollup';
import { runMerge } from '@/server/queue/stages/merge';
import { runTrendTier } from '@/server/queue/stages/trend-tier';

async function main(): Promise<void> {
  const t0 = Date.now();
  await withJobTracking('cluster', null, (ctx) => runCluster({ setNumber: 17 }, ctx));
  console.log(`cluster done (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  await withJobTracking('rollup', null, (ctx) => runRollup({}, ctx));
  console.log('rollup done');
  await withJobTracking('merge', null, (ctx) => runMerge({ setNumber: 17 }, ctx));
  console.log('merge done');
  await withJobTracking('trend-tier', null, (ctx) => runTrendTier({}, ctx));
  console.log('trend-tier done');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void pool.end());
