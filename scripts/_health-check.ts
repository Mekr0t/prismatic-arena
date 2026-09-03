import 'dotenv/config';
import { pool } from '@/lib/db';
import { getCrawlHealth } from '@/server/crawl-health-service';

// _health-check.ts — runs the admin crawl-health read model from the CLI.
//
// The panel it feeds is behind the admin login, so this is how the same numbers
// are checked without a browser — and how the queries get exercised against a
// real database, which `npm test` (pure, offline) never does. Read-only.
//
//   npx tsx scripts/_health-check.ts
async function main() {
  const t0 = Date.now();
  const h = await getCrawlHealth();
  console.log(`getCrawlHealth() in ${Date.now() - t0}ms\n`);
  console.log('scope        :', h.scope.tiers.join(','), 'on', h.scope.platforms.join(','), `· recrawl ${h.scope.recrawlHours}h`);
  console.log('seeds        :', h.apexTotal, 'total /', h.apexDrainable, 'drainable · next', h.nextDrainable ?? '—');
  console.table(h.apex);
  console.table(h.queues);
  console.log('waiting by bucket:', JSON.stringify(h.waitingByBucket));
  console.log(`\nflow (${h.flowMinutes}m) — ${h.boardsPerHour}/hour`);
  console.table(h.byBucket);
  console.table(h.byPlatform);
  console.log('tier coverage:', JSON.stringify(h.tierCoverage));
  console.log('\nscope checks:');
  console.table(h.scopeChecks);

  // The one condition worth failing on: comp_stats claims boards for a scope the
  // read path cannot see. That renders a full tier list over empty boards, and
  // it is invisible from the tier list itself.
  const broken = h.scopeChecks.filter((s) => !s.ok);
  if (broken.length > 0) {
    console.error(
      `\nPROBLEM: ${broken.length} scope(s) have comp_stats boards the read path cannot see — ` +
        broken.map((s) => `${s.region}/${s.rankBucket}`).join(', '),
    );
    process.exitCode = 1;
  } else {
    console.log('\nOK — every listed scope is readable');
  }

  // Close the pool rather than process.exit(): exiting here truncates the
  // pending stdout writes on Windows, which silently swallowed this verdict.
  await pool.end();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
