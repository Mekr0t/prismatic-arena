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

/**
 * The set we actually serve: the newest set with a loaded catalog. Only this
 * set is allowed to advance `is_current` (see resolvePatchId).
 *
 * Memoized because it changes only when `npm run data:load` runs, and
 * resolvePatchId is called once per persisted match — a per-match round-trip
 * for a value that moves once a set would be pure overhead.
 */
let liveSet: { value: number; at: number } | null = null;
const LIVE_SET_TTL_MS = 5 * 60 * 1000;

async function liveSetNumber(client: PoolClient): Promise<number> {
  if (liveSet && Date.now() - liveSet.at < LIVE_SET_TTL_MS) return liveSet.value;
  const res = await client.query<{ max: number | null }>(
    `SELECT MAX(set_number)::int AS max FROM units`,
  );
  const value = res.rows[0]?.max ?? 0;
  liveSet = { value, at: Date.now() };
  return value;
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
 *
 * LIVE-SET GATE: patch strings are only comparable WITHIN a set. Rotating game
 * modes replay old sets on today's client version, so patch "16.14" exists for
 * sets 1, 16 and 17 simultaneously in real data. Without this gate the first
 * set-16 revival match on the next patch wins the numeric comparison and moves
 * the flag onto set 16 — and since `units` only holds the live set's catalog,
 * currentSet() then resolves to a set with no units and the catalog, Library
 * and planner all go blank. So only the live set may touch the flag, and the
 * "what's current" read is scoped to that set too, which self-heals a flag that
 * was already stolen (no row for the live set reads as "none current").
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

  // Only the live set may advance the flag — a revival-mode match must never
  // steal it (see the LIVE-SET GATE note above).
  if (setNumber === (await liveSetNumber(client))) {
    const current = await client.query<{ patch: string }>(
      `SELECT patch FROM patches WHERE is_current = true AND set_number = $1 LIMIT 1`,
      [setNumber],
    );
    const currentPatch = current.rows[0]?.patch;
    if (!currentPatch || isNewerPatch(patch, currentPatch)) {
      await client.query(`UPDATE patches SET is_current = false WHERE is_current = true`);
      await client.query(
        `UPDATE patches SET is_current = true WHERE set_number = $1 AND patch = $2`,
        [setNumber, patch],
      );
    }
  }

  return id;
}
