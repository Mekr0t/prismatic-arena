import 'dotenv/config';
import { pool } from '@/lib/db';
import { runElect } from '@/server/queue/stages/elect';

// _elect-check.ts — runs the elect stage twice against the LIVE database and
// checks the property the URL scheme depends on: a re-election must keep every
// line's id. If it does not, /comps/<slug>-<id> churns on every pipeline pass
// and every shared link rots — the exact failure the old `##k:` anchor caused.
//
// Not in `npm test` (that suite is pure and offline). Read-mostly, but it DOES
// write comp_lines / line_stats / line_id — which is safe, because the stage is
// a full recompute and nothing serves those tables yet.
//
//   npx tsx scripts/_elect-check.ts

const snapshot = async () => {
  const r = await pool.query<{ id: number; name: string; core_units: string[]; elected_boards: number }>(
    `SELECT id, name, core_units, elected_boards FROM comp_lines ORDER BY id`,
  );
  return new Map(r.rows.map((x) => [x.id, x]));
};

const ctx = { setItems: () => {} };

async function main() {
  console.log('--- pass 1 ---');
  await runElect({}, ctx);
  const first = await snapshot();

  console.log('\n--- pass 2 (same data) ---');
  await runElect({}, ctx);
  const second = await snapshot();

  const kept = [...second.keys()].filter((id) => first.has(id));
  const added = [...second.keys()].filter((id) => !first.has(id));
  const removed = [...first.keys()].filter((id) => !second.has(id));
  const renamed = kept.filter((id) => first.get(id)!.name !== second.get(id)!.name);

  console.log(`\nlines ${first.size} -> ${second.size}`);
  console.log(`  kept ${kept.length} · added ${added.length} · removed ${removed.length} · renamed ${renamed.length}`);

  const stats = await pool.query<{ rows: number; lines: number; boards: number; orphan: number }>(
    `SELECT COUNT(*)::int rows, COUNT(DISTINCT line_id)::int lines, SUM(n)::int boards,
            COUNT(*) FILTER (WHERE NOT EXISTS (
              SELECT 1 FROM comp_lines cl WHERE cl.id = ls.line_id))::int orphan
       FROM line_stats ls`,
  );
  console.log(
    `line_stats: ${stats.rows[0].rows} rows over ${stats.rows[0].lines} lines, ` +
      `${stats.rows[0].boards} boards, ${stats.rows[0].orphan} orphaned`,
  );

  const problems: string[] = [];
  // Ids churning is the failure this check exists for: it is invisible in the
  // stage's own output and only shows up later as dead links.
  if (added.length > 0 || removed.length > 0) {
    problems.push(`re-election churned ids — ${added.length} added, ${removed.length} removed`);
  }
  if (renamed.length > 0) problems.push(`${renamed.length} line(s) renamed on identical data`);
  if (stats.rows[0].orphan > 0) problems.push(`${stats.rows[0].orphan} line_stats row(s) point at no line`);

  console.log(problems.length === 0 ? '\nOK — re-election is stable' : `\nPROBLEMS:\n  ${problems.join('\n  ')}`);
  if (problems.length > 0) process.exitCode = 1;
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
