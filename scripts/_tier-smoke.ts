// _tier-smoke.ts — check for empty example boards. Temp.
import 'dotenv/config';
import { pool } from '@/lib/db';
import { getTierList } from '@/server/comps-service';

async function main(): Promise<void> {
  const vm = await getTierList({ niche: false });
  if (!vm.selection) return console.log('no selection');
  let empty = 0;
  let total = 0;
  for (const g of vm.groups) {
    for (const r of g.comps) {
      total++;
      const boardEmpty = r.exampleTeam.units.length === 0;
      if (boardEmpty) {
        empty++;
        console.log(`  EMPTY BOARD: [${g.tier}] ${r.identity.displayName}  n=${r.metrics.n}`);
      }
      if (/Aurelion Sol Nunu/.test(r.identity.displayName ?? '')) {
        console.log(`  Aurelion Sol Nunu: units=${r.exampleTeam.units.length}  n=${r.metrics.n}  emblem=${r.identity.emblems.map((e) => e.name).join(',') || 'none'}`);
      }
    }
  }
  console.log(`\n${total} rows, ${empty} with empty board`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => void pool.end());
