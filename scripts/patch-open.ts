import 'dotenv/config';
import { pool } from '@/lib/db';
import { PATCH_RE, comparePatch, parsePatch } from '@/server/patch';

// patch-open.ts — declare that a new patch has started.
//
// WHY THIS IS A SCRIPT AND NOT DERIVED. TFT on Unreal carries no version in its
// payload ("TFT Unreal Version ?.?.?.?") and is no longer tied to the League
// client's release train: Riot ships 18.1, then 18.1a out of band when something
// breaks the meta, then 18.2, on no schedule anyone can derive. So the boundary
// cannot be inferred from the data or predicted from a calendar — the only
// honest source is someone who watched it land.
//
// WHY NOT AN ENV VAR. A variable records WHICH patch, never WHEN it started, so
// it cannot place the matches already ingested and cannot be re-derived later;
// it needs a restart to take effect; and it goes stale the moment nobody
// remembers to update it, which is the failure advanceCurrentPatch's own header
// warns about. A boundary is a fact about a moment in time, so it belongs in a
// row.
//
//   npm run patch:open -- 18.1
//   npm run patch:open -- 18.1a --at "2026-09-10T11:00:00Z"
//   npm run patch:open -- 18.2 --set 18 --dry-run
//
// You will realistically run this HOURS after the patch actually dropped, so the
// script re-resolves the matches already stored past the boundary. Without that
// step "run it when I notice" quietly mislabels everything in between.
//
// comp_stats needs no repair: the rollup is a full recompute from
// match_participants, so the next pipeline pass picks the new patch_id up.

interface Args {
  patch: string;
  at: Date;
  setNumber: number | null;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const rest: string[] = [];
  let at: Date | null = null;
  let setNumber: number | null = null;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--at') at = new Date(argv[++i] ?? '');
    else if (a === '--set') setNumber = Number(argv[++i]);
    else if (a === '--dry-run') dryRun = true;
    else rest.push(a);
  }

  const patch = (rest[0] ?? '').trim().toLowerCase();
  if (!PATCH_RE.test(patch)) {
    throw new Error(
      `expected a patch like 18.1, 18.1a or 18.2 — got ${JSON.stringify(rest[0] ?? '')}`,
    );
  }
  if (at && Number.isNaN(at.getTime())) throw new Error('--at is not a valid date');
  if (setNumber !== null && !Number.isFinite(setNumber)) throw new Error('--set is not a number');

  return { patch, at: at ?? new Date(), setNumber, dryRun };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Default the set to the one the patch number names (18.1 → 18), which is how
  // TFT numbers them; --set overrides for anything that does not follow.
  const setNumber = args.setNumber ?? parsePatch(args.patch)!.major;

  const existing = await pool.query<{ patch: string; released_at: Date | null; is_current: boolean }>(
    `SELECT patch, released_at, is_current FROM patches WHERE set_number = $1 ORDER BY patch`,
    [setNumber],
  );
  const known = existing.rows.slice().sort((a, b) => comparePatch(a.patch, b.patch));

  console.log(`set ${setNumber} patches already known:`);
  for (const r of known) {
    const when = r.released_at ? r.released_at.toISOString() : 'no declared boundary';
    console.log(`  ${r.patch.padEnd(8)} ${r.is_current ? 'CURRENT' : '       '}  ${when}`);
  }

  const newer = known.filter((r) => comparePatch(r.patch, args.patch) > 0);
  if (newer.length > 0) {
    // Not fatal — reopening an older patch is a legitimate correction — but it
    // is never what you meant to do by accident.
    console.warn(
      `\nWARNING: ${newer.map((r) => r.patch).join(', ')} already exist(s) and sort(s) AFTER ${args.patch}.`,
    );
  }

  const affected = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM matches
      WHERE set_number = $1 AND game_datetime >= $2`,
    [setNumber, args.at],
  );

  console.log(
    `\nopening ${args.patch} for set ${setNumber} at ${args.at.toISOString()}` +
      `\n  ${affected.rows[0].n} already-stored match(es) played at or after that boundary will be re-resolved`,
  );

  if (args.dryRun) {
    console.log('\n--dry-run: nothing written');
    await pool.end();
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // The patch row may already exist — a match could have created it through
    // resolvePatchId before anyone declared the boundary. Setting released_at is
    // what turns it from an inferred row into a declared one.
    const up = await client.query<{ id: number }>(
      `INSERT INTO patches (set_number, patch, released_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (set_number, patch)
         DO UPDATE SET released_at = EXCLUDED.released_at
       RETURNING id`,
      [setNumber, args.patch, args.at],
    );
    const patchId = up.rows[0].id;

    // One statement, so the flag is never briefly on two rows or on none.
    await client.query(
      `UPDATE patches SET is_current = (id = $1) WHERE is_current <> (id = $1)`,
      [patchId],
    );

    // Re-resolve the gap. Bounded by the boundary rather than by patch_id, so it
    // catches matches that landed on the placeholder AND ones that landed on the
    // previous patch.
    const moved = await client.query(
      `UPDATE matches
          SET patch_id = $1
        WHERE set_number = $2
          AND game_datetime >= $3
          AND patch_id IS DISTINCT FROM $1`,
      [patchId, setNumber, args.at],
    );

    await client.query('COMMIT');
    console.log(
      `\ndone — ${args.patch} is now the current patch (id ${patchId}), ` +
        `${moved.rowCount} match(es) re-resolved onto it.`,
    );
    console.log('The next rollup pass rebuilds comp_stats; no manual repair needed.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await pool.end();
}

main().catch((e) => {
  console.error(`patch:open failed — ${(e as Error).message}`);
  process.exit(1);
});
