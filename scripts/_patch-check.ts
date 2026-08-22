import 'dotenv/config';
import { pool, query } from '@/lib/db';
import { advanceCurrentPatch, resolvePatchId } from '@/server/patch';

const show = async (label: string) => {
  const rows = await query<{ id: number; set_number: number; patch: string }>(
    `SELECT id, set_number, patch FROM patches WHERE is_current = true ORDER BY id`,
  );
  console.log(`  ${label}: ${rows.length ? rows.map((r) => `#${r.id} set${r.set_number} ${r.patch}`).join(', ') : '(none)'}`);
  return rows;
};
const verdict = (ok: boolean, msg: string) => console.log(`  => ${ok ? 'PASS' : 'FAIL'} ${msg}`);

(async () => {
  const live = await query<{ max: number | null }>(`SELECT MAX(set_number)::int AS max FROM units`);
  const liveSet = live[0]?.max ?? 0;

  const cands = await query<{ id: number; patch: string; matches: number }>(
    `SELECT p.id, p.patch, count(m.match_id)::int AS matches
       FROM patches p JOIN matches m ON m.patch_id = p.id
      WHERE p.set_number = $1 AND p.patch ~ '^[0-9]+[.][0-9]+$'
      GROUP BY p.id
      ORDER BY split_part(p.patch,'.',1)::int DESC, split_part(p.patch,'.',2)::int DESC`,
    [liveSet],
  );
  const trap = await query<{ patch: string }>(
    `SELECT p.patch FROM patches p
      WHERE p.set_number = $1 AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.patch_id = p.id)
      ORDER BY split_part(p.patch,'.',1)::int DESC, split_part(p.patch,'.',2)::int DESC`,
    [liveSet],
  );
  const expected = cands[0];
  console.log(`live set = ${liveSet}`);
  console.log(`match-less rows on the live set (the trap): ${trap.map((c) => c.patch).join(', ') || '(none)'}`);
  console.log(`patches WITH matches, newest first: ${cands.slice(0, 6).map((c) => c.patch).join(' > ')}`);
  console.log(`expected winner = ${expected?.patch} (#${expected?.id}, ${expected?.matches} matches)`);

  console.log('\n[1] picks the newest patch WITH MATCHES, not simply the newest row');
  await show('before');
  const r1 = await advanceCurrentPatch();
  console.log(`  returned: ${JSON.stringify(r1)}`);
  const after1 = await show('after ');
  verdict(after1.length === 1 && after1[0].id === expected?.id, '(match-less catalog rows skipped)');

  console.log('\n[2] idempotent — a second call writes nothing');
  const r2 = await advanceCurrentPatch();
  console.log(`  returned: ${JSON.stringify(r2)}`);
  verdict(!!r2 && !r2.changed && r2.patch === expected?.patch, '(no write in steady state)');

  console.log('\n[3] numeric ordering — "16.10" must beat "16.9", not lose lexically');
  const lex = [...cands].map((c) => c.patch).sort().reverse()[0];
  console.log(`  numeric winner = ${expected?.patch} · lexical winner would be = ${lex}`);
  verdict(expected?.patch === r1?.patch && lex !== expected?.patch, '(ordering is numeric)');

  console.log('\n[4] self-heal — steal the flag onto a foreign set, then advance');
  const thief = await query<{ id: number; set_number: number; patch: string }>(
    `SELECT id, set_number, patch FROM patches WHERE set_number <> $1 ORDER BY id LIMIT 1`,
    [liveSet],
  );
  if (!thief[0]) {
    console.log('  skipped: no non-live-set patch row on this install');
  } else {
    await query(`UPDATE patches SET is_current = (id = $1) WHERE is_current <> (id = $1)`, [thief[0].id]);
    await show('stolen');
    const r4 = await advanceCurrentPatch();
    const after4 = await show('healed');
    verdict(after4.length === 1 && after4[0].id === expected?.id && r4?.changed === true,
      '(restored to the live-set winner, exactly one row true)');
  }

  console.log('\n[5] resolvePatchId — read-first: idempotent, burns no sequence values');
  const seqBefore = await query<{ last_value: string }>(`SELECT last_value FROM patches_id_seq`);
  const client = await pool.connect();
  let idA: number | null = null;
  let idB: number | null = null;
  try {
    await client.query('BEGIN');
    idA = await resolvePatchId(client, liveSet, `Version ${expected?.patch}.999.9999 (test)`);
    idB = await resolvePatchId(client, liveSet, `Version ${expected?.patch}.999.9999 (test)`);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  const seqAfter = await query<{ last_value: string }>(`SELECT last_value FROM patches_id_seq`);
  console.log(`  resolved twice: ${idA} / ${idB} (expected ${expected?.id})`);
  console.log(`  patches_id_seq: ${seqBefore[0].last_value} -> ${seqAfter[0].last_value}`);
  verdict(idA === expected?.id && idA === idB && seqBefore[0].last_value === seqAfter[0].last_value,
    '(existing row read, zero sequence values burned)');

  console.log('\n[6] resolvePatchId — unparseable game_version returns null');
  const c2 = await pool.connect();
  try {
    verdict((await resolvePatchId(c2, liveSet, 'no digits here')) === null, '');
  } finally {
    c2.release();
  }

  console.log('');
  await show('final flag');
  await pool.end();
})().catch(async (e) => { console.error('ERROR:', e); await pool.end(); process.exit(1); });
