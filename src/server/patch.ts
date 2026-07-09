import type { PoolClient } from 'pg';

// Single source of truth for deriving a patch from a Riot game_version. Shared
// by the profile write-path and the M4 match-fetch worker so both land matches
// on the exact same patch_id — the one dimension every rollup groups by. (If
// these two ever diverge, freshly-crawled matches drift to a different/NULL
// patch and silently fall out of stats.)

/** Extracts "major.minor" from a Riot game_version, e.g. "Version 14.11.633.5272 (…)" → "14.11". */
export function patchFromVersion(gameVersion: string): string | null {
  return gameVersion.match(/(\d+\.\d+)/)?.[1] ?? null;
}

/** Numeric (not lexical) patch comparison — "16.10" must sort after "16.9". */
function isNewerPatch(a: string, b: string): boolean {
  const [aMaj, aMin] = a.split('.').map(Number);
  const [bMaj, bMin] = b.split('.').map(Number);
  return aMaj !== bMaj ? aMaj > bMaj : aMin > bMin;
}

/**
 * Upserts the patches row for (setNumber, derived patch) and returns its id.
 * Also auto-advances the single global `is_current` flag whenever the patch
 * just seen is numerically newer than whatever's currently flagged — real
 * match data is the only source of truth for "current", never a hand-set
 * config value (those drift stale the moment nobody remembers to update them).
 * Returns null when the version string has no parseable patch. Runs on a
 * transaction-scoped client so callers can fold it into their own BEGIN/COMMIT.
 */
export async function resolvePatchId(
  client: PoolClient,
  setNumber: number,
  gameVersion: string,
): Promise<number | null> {
  const patch = patchFromVersion(gameVersion);
  if (!patch) return null;
  const res = await client.query<{ id: number }>(
    `INSERT INTO patches (set_number, patch)
     VALUES ($1, $2)
     ON CONFLICT (set_number, patch) DO UPDATE SET patch = EXCLUDED.patch
     RETURNING id`,
    [setNumber, patch],
  );
  const id = res.rows[0]?.id ?? null;

  const current = await client.query<{ patch: string }>(
    `SELECT patch FROM patches WHERE is_current = true LIMIT 1`,
  );
  const currentPatch = current.rows[0]?.patch;
  if (!currentPatch || isNewerPatch(patch, currentPatch)) {
    await client.query(`UPDATE patches SET is_current = false WHERE is_current = true`);
    await client.query(
      `UPDATE patches SET is_current = true WHERE set_number = $1 AND patch = $2`,
      [setNumber, patch],
    );
  }

  return id;
}
