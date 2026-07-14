// _detail-smoke.ts — one-off: check emblem-variant switcher on a family. Temp.
import 'dotenv/config';
import { pool } from '@/lib/db';
import { getCompDetail } from '@/server/comp-detail-service';

async function show(gkey: string, variant?: string): Promise<void> {
  const d = await getCompDetail(gkey, { variant });
  if (!d) return console.log(`${gkey}: null`);
  console.log(`\n=== ${gkey}  (selected: "${d.selectedVariant || 'base'}")`);
  console.log(`   header: ${d.identity.displayName}  avg ${d.metrics.avgPlacement.toFixed(2)}  n=${d.metrics.n}  tier ${d.tier}`);
  console.log(`   variant options:`);
  for (const v of d.variantOptions) {
    console.log(`     ${v.selected ? '>' : ' '} [${v.tier}] ${v.label.padEnd(22)} avg ${v.avgPlacement.toFixed(2)}  n=${v.n}  key="${v.key}"`);
  }
}

async function main(): Promise<void> {
  await show('m:TFT17_Fiora|TFT17_Kindred|TFT17_MasterYi|TFT17_TahmKench');
  // Switch to the base (no-emblem) variant explicitly.
  await show('m:TFT17_Fiora|TFT17_Kindred|TFT17_MasterYi|TFT17_TahmKench', '');
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => void pool.end());
