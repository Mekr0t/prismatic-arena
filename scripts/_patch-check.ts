import 'dotenv/config';
import { pool, query } from '@/lib/db';
import { advanceCurrentPatch, resolvePatchId, placeholderPatch, UNVERSIONED_LABEL } from '@/server/patch';

// Live-DB check for the patch dimension. Read-mostly, but two cases MUTATE the
// current-patch flag, so the whole run is wrapped in a restore.
//
// That wrapper is not defensive habit — it is a scar. The steal test used to
// rely on advanceCurrentPatch() to put the flag back, which fails the moment
// advanceCurrentPatch legitimately cannot pick a winner (e.g. the live set has
// matches but none of them has a resolvable patch yet, which is exactly what
// set 18 looked like on launch day). The flag was left parked on a match-less
// catalog row, in production, by the very script meant to verify it.

const show = async (label: string) => {
  const rows = await query<{ id: number; set_number: number; patch: string }>(
    `SELECT id, set_number, patch FROM patches WHERE is_current = true ORDER BY id`,
  );
  console.log(`  ${label}: ${rows.length ? rows.map((r) => `#${r.id} set${r.set_number} ${r.patch}`).join(', ') : '(none)'}`);
  return rows;
};
let fails = 0;
const verdict = (ok: boolean, msg: string) => { if (!ok) fails++; console.log(`  => ${ok ? 'PASS' : 'FAIL'} ${msg}`); };

(async () => {
  // Snapshot the flag up front; restored in the finally no matter what happens.
  const original = (await query<{ id: number }>(`SELECT id FROM patches WHERE is_current = true`)).map((r) => r.id);

  try {
    // Same derivation advanceCurrentPatch uses: newest set with BOTH a catalog
    // and observed matches. Deriving it differently here is how this check
    // started disagreeing with the code it tests.
    const live = await query<{ max: number | null }>(
      `SELECT MAX(u.set_number)::int AS max FROM (SELECT DISTINCT set_number FROM units) u
        WHERE EXISTS (SELECT 1 FROM matches m WHERE m.set_number = u.set_number)`,
    );
    const liveSet = live[0]?.max ?? 0;

    const cands = await query<{ id: number; patch: string; matches: number }>(
      `SELECT p.id, p.patch, count(m.match_id)::int AS matches
         FROM patches p JOIN matches m ON m.patch_id = p.id
        WHERE p.set_number = $1 AND p.patch ~ '^[0-9]+[.][0-9]+$'
        GROUP BY p.id
        ORDER BY (p.patch <> $2) DESC,
                 split_part(p.patch,'.',1)::int DESC, split_part(p.patch,'.',2)::int DESC`,
      [liveSet, placeholderPatch(liveSet)],
    );
    const expected = cands[0];
    const trap = await query<{ patch: string }>(
      `SELECT p.patch FROM patches p
        WHERE p.set_number = $1 AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.patch_id = p.id)`,
      [liveSet],
    );
    console.log(`live set = ${liveSet}`);
    console.log(`match-less rows on it (the trap): ${trap.map((t) => t.patch).join(', ') || '(none)'}`);
    console.log(`expected winner = ${expected?.patch} (#${expected?.id}, ${expected?.matches} matches)`);

    console.log('\n[1] picks the newest patch WITH MATCHES, not simply the newest row');
    await show('before');
    const r1 = await advanceCurrentPatch();
    console.log(`  returned: ${JSON.stringify(r1)}`);
    const after1 = await show('after ');
    verdict(after1.length === 1 && after1[0].id === expected?.id, '(match-less rows skipped)');

    console.log('\n[2] idempotent — a second call writes nothing');
    const r2 = await advanceCurrentPatch();
    verdict(!!r2 && !r2.changed && r2.patch === expected?.patch, '(no write in steady state)');

    console.log('\n[3] a REAL patch outranks the placeholder, whatever the numbers say');
    const ph = placeholderPatch(liveSet);
    const real = cands.filter((c) => c.patch !== ph);
    if (real.length === 0) {
      console.log(`  skipped: every patch on set ${liveSet} is still the "${ph}" placeholder`);
      console.log(`  (that IS the launch-day state — Riot ships game_version as "?.?.?.?" on the new engine)`);
    } else {
      verdict(expected?.patch !== ph, `(winner "${expected?.patch}" is a real patch, not "${ph}")`);
    }

    console.log('\n[4] self-heal — steal the flag onto a foreign set, then advance');
    const thief = await query<{ id: number; set_number: number; patch: string }>(
      `SELECT id, set_number, patch FROM patches WHERE set_number <> $1 ORDER BY id LIMIT 1`, [liveSet]);
    if (!thief[0]) console.log('  skipped: no non-live-set patch row on this install');
    else {
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
    } finally { client.release(); }
    const seqAfter = await query<{ last_value: string }>(`SELECT last_value FROM patches_id_seq`);
    verdict(idA === expected?.id && idA === idB && seqBefore[0].last_value === seqAfter[0].last_value,
      `(existing row read: ${idA}/${idB}, seq unmoved)`);

    console.log('\n[6] an UNVERSIONED game_version gets a set-scoped placeholder, not NULL');
    const c2 = await pool.connect();
    try {
      // Set 18 ships game_version as "TFT Unreal Version ?.?.?.?". Returning
      // null here stored patch_id = NULL, and comp_stats.patch_id is NOT NULL,
      // so those boards could never roll up — invisible forever.
      const id = await resolvePatchId(c2, liveSet, 'TFT Unreal Version ?.?.?.?');
      const row = await query<{ patch: string; label: string | null }>(
        `SELECT patch, label FROM patches WHERE id = $1`, [id]);
      console.log(`  -> patch="${row[0]?.patch}" label="${row[0]?.label}"`);
      verdict(row[0]?.patch === placeholderPatch(liveSet) && row[0]?.label === UNVERSIONED_LABEL,
        '(placeholder created and labelled)');
      const used = await query<{ n: number }>(`SELECT count(*)::int AS n FROM matches WHERE patch_id = $1`, [id]);
      if (used[0].n === 0 && !original.includes(id!)) {
        await query(`DELETE FROM patches WHERE id = $1`, [id]);
        console.log('  (unused placeholder row removed)');
      }
    } finally { c2.release(); }
  } finally {
    // ALWAYS put the flag back exactly as found, even on a thrown assertion.
    if (original.length) {
      await query(`UPDATE patches SET is_current = (id = ANY($1::int[])) WHERE is_current <> (id = ANY($1::int[]))`, [original]);
    }
    console.log('');
    await show('final flag (restored to its original value)');
    console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`);
    await pool.end();
  }
  process.exit(fails === 0 ? 0 : 1);
})().catch(async (e) => { console.error('ERROR:', e); process.exit(1); });
