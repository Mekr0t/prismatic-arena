import 'dotenv/config';
import { pool, query } from '@/lib/db';
import { GKEY_SQL } from '@/server/comp-gkey';
import { getCompDetail } from '@/server/comp-detail-service';

let fails = 0;
const v = (ok: boolean, l: string) => { if (!ok) fails++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${l}`); };

(async () => {
  // Pick a live archetype whose label carries a ##k: anchor.
  const g = await query<{ gkey: string; patch_id: number; region: string; rank_bucket: string; n: number }>(
    `SELECT ${GKEY_SQL} AS gkey, cs.patch_id, cs.region, cs.rank_bucket, sum(cs.n)::int AS n
       FROM comp_stats cs JOIN comps c ON c.id = cs.comp_id
      WHERE c.meta_comp LIKE '%##k:%'
      GROUP BY 1,2,3,4 HAVING sum(cs.n) >= 15 ORDER BY 5 DESC LIMIT 1`);
  const t = g[0];
  const sel = { patchId: t.patch_id, region: t.region, rankBucket: t.rank_bucket };
  console.log(`subject: ${t.gkey.slice(0, 78)}\n  (${t.n} boards)\n`);

  console.log('[0] the live key still resolves to itself (no spurious redirect)');
  const base = await getCompDetail(t.gkey, sel);
  v(!!base && base.groupKey === t.gkey, 'exact key returns the same groupKey');

  console.log('\n[1] stale ##k: anchor — pointing at a DIFFERENT member of the same group');
  const members = await query<{ id: number }>(`SELECT c.id FROM comps c WHERE ${GKEY_SQL} = $1 ORDER BY c.id`, [t.gkey]);
  const other = members[members.length - 1]?.id;
  const staleAnchor = t.gkey.replace(/##k:\d+/, `##k:${other}`);
  v(staleAnchor !== t.gkey, `built a stale key anchored on member #${other}`);
  const r1 = await getCompDetail(staleAnchor, sel);
  v(!!r1, 'stale-anchor key resolves instead of 404');
  v(r1?.groupKey === t.gkey, `resolved to the live key (${r1?.groupKey === t.gkey ? 'same' : r1?.groupKey?.slice(0,40)})`);

  console.log('\n[2] stale tag — same carries, a ##dup: segment that no longer exists');
  const staleTag = 'm:' + t.gkey.slice(2).split('##')[0] + '##dup:TFT17_NoSuchUnit';
  const r2 = await getCompDetail(staleTag, sel);
  v(!!r2, 'tag-mangled key resolves via the carry base instead of 404');
  v(r2?.groupKey.startsWith('m:' + t.gkey.slice(2).split('##')[0]) ?? false,
    `landed on a group with the same carries (${r2?.groupKey.slice(0, 48)}...)`);

  console.log('\n[3] genuinely bogus keys still 404');
  v((await getCompDetail('m:TFT17_NotAUnit|TFT17_AlsoNot', sel)) === null, 'unknown carries -> null');
  v((await getCompDetail('c:999999999', sel)) === null, 'unknown comp id -> null');
  v((await getCompDetail('garbage', sel)) === null, 'malformed key -> null');

  console.log('\n[4] cost of the miss path');
  const t0 = Date.now(); await getCompDetail(staleTag, sel);
  console.log(`  stale-key resolution + render: ${Date.now() - t0}ms`);
  const t1 = Date.now(); await getCompDetail('m:TFT17_NotAUnit|TFT17_AlsoNot', sel);
  console.log(`  worst case (resolves to nothing): ${Date.now() - t1}ms`);

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`);
  await pool.end();
  process.exit(fails === 0 ? 0 : 1);
})().catch(async (e) => { console.error('ERROR:', e); await pool.end(); process.exit(1); });
