import 'dotenv/config';
import { pool } from '@/lib/db';
import { runMerge } from '@/server/queue/stages/merge';
async function main() {
  const busy = await pool.query(
    `SELECT COUNT(*)::int n FROM ingestion_jobs WHERE status='running'
      AND job_type IN ('cluster','rollup','merge','trend-tier','elect')`);
  if (busy.rows[0].n > 0) { console.log('pipeline busy — skipping'); await pool.end(); return; }
  const t0 = Date.now();
  await runMerge({}, { setItems: () => {} });
  console.log(`\nrunMerge() in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const l = await pool.query(
    `SELECT set_number, COUNT(meta_comp)::int labelled, COUNT(DISTINCT meta_comp)::int archetypes
       FROM comps GROUP BY 1 ORDER BY 1 DESC`);
  console.table(l.rows);
  await pool.end();
}
main().catch((e) => { console.error(e.message); process.exit(1); });
