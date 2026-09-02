import type { PoolClient } from 'pg';
import { one, query } from '@/lib/db';

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
 * Patch string for a set whose `game_version` carries no version at all.
 *
 * Set 18 shipped on the Unreal engine with `game_version` literally reading
 * "TFT Unreal Version ?.?.?.?" — no digits, so patchFromVersion returns null.
 * Left there, every set-18 match stores `patch_id = NULL`, and since
 * `comp_stats.patch_id` is NOT NULL those boards can never roll up: they land in
 * the database and are invisible forever. A set-scoped placeholder keeps them
 * groupable and says plainly that the patch is unknown, rather than guessing one.
 *
 * The row is labelled so the placeholder is identifiable in the patch selector
 * and in the database, and advanceCurrentPatch prefers ANY real patch over it
 * (see there) — which matters because the client version for set 18 is 16.x,
 * numerically BELOW "18.0", so plain numeric ordering would let the placeholder
 * outrank the real patches that eventually replace it.
 */
export function placeholderPatch(setNumber: number): string {
  return `${setNumber}.0`;
}

/** Label written on a placeholder patches row. Also the marker the selector reads. */
export const UNVERSIONED_LABEL = 'Unversioned';

/**
 * A patch string: `<major>.<minor>` with an optional lowercase hotfix suffix.
 *
 * The suffix is not decoration. TFT on Unreal is no longer tied to the League
 * client's release train, so Riot ships an out-of-band fix whenever something
 * breaks the meta — 18.1, then 18.1a, then 18.1b, then 18.2. Those are separate
 * metas and have to be separate patches, which means the shape has to admit them
 * and the ORDERING has to place them correctly. The previous guard
 * (`^[0-9]+[.][0-9]+$`) excluded them outright, so a hotfix could never have
 * taken the current-patch flag.
 */
export const PATCH_RE = /^(\d+)\.(\d+)([a-z]*)$/;

export interface ParsedPatch {
  major: number;
  minor: number;
  /** '' for a base patch, 'a' / 'b' / … for an out-of-band fix. */
  hotfix: string;
}

/** Parse a patch string, or null when it is not one. */
export function parsePatch(patch: string): ParsedPatch | null {
  const m = PATCH_RE.exec(patch.trim().toLowerCase());
  return m ? { major: Number(m[1]), minor: Number(m[2]), hotfix: m[3] } : null;
}

/**
 * Order two patch strings oldest-first. Numeric on the numbers — "16.10" comes
 * after "16.9", which plain string comparison gets backwards — and the base
 * patch comes before its own hotfixes, so 18.1 < 18.1a < 18.1b < 18.2.
 * Unparseable strings sort before everything, since the only ones in the data
 * predate the format.
 */
export function comparePatch(a: string, b: string): number {
  const pa = parsePatch(a);
  const pb = parsePatch(b);
  if (!pa || !pb) return !pa && !pb ? (a < b ? -1 : a > b ? 1 : 0) : !pa ? -1 : 1;
  return (
    pa.major - pb.major ||
    pa.minor - pb.minor ||
    // '' < 'a' < 'b' — and localeCompare would treat them as equal-ish under
    // some collations, so compare the raw strings.
    (pa.hotfix < pb.hotfix ? -1 : pa.hotfix > pb.hotfix ? 1 : 0)
  );
}

/**
 * Resolves the patches row id for (setNumber, derived patch), creating it on
 * first sight. Returns null when the version string has no parseable patch.
 * Runs on a transaction-scoped client so callers can fold it into their own
 * BEGIN/COMMIT.
 *
 * READ-FIRST, and DO NOTHING on conflict, both deliberately. This runs once per
 * persisted match inside the caller's transaction, so what it must not do is
 * hold a row lock on `patches` for the rest of that transaction:
 *
 *   • The previous `ON CONFLICT DO UPDATE SET patch = EXCLUDED.patch` was a
 *     no-op write that nonetheless locked the row until COMMIT — and burned a
 *     sequence value and a dead tuple every time (`patches.id` reached 77,700
 *     for 70 live rows).
 *   • `DO NOTHING` does not lock the conflicting row, and the steady-state
 *     path never reaches the INSERT at all: a patch is new once, then read.
 *
 * The third statement covers the race where a concurrent transaction inserts
 * the same patch between our SELECT and our INSERT — DO NOTHING then returns no
 * row, and the value we want is the one the winner committed.
 */
export async function resolvePatchId(
  client: PoolClient,
  setNumber: number,
  gameVersion: string,
  gameDatetimeMs?: number | null,
): Promise<number | null> {
  // A DECLARED CALENDAR WINS, when the set has one.
  //
  // Set 18 ships no version at all ("TFT Unreal Version ?.?.?.?"), and TFT on
  // Unreal is no longer tied to the League release train — Riot ships 18.1, then
  // 18.1a out of band when something breaks the meta, then 18.2, on no schedule
  // anyone can derive. Nothing in the payload distinguishes those, so the only
  // honest source is a boundary someone declared: `npm run patch:open` writes
  // `released_at`, and a match belongs to the latest patch released at or before
  // it was played.
  //
  // Sets that DO carry a real game_version have no released_at rows and fall
  // straight through to the derivation below, unchanged — which matters, because
  // 515 k set-17 matches depend on it.
  if (gameDatetimeMs != null && Number.isFinite(gameDatetimeMs)) {
    const onCalendar = await client.query<{ id: number }>(
      `SELECT id FROM patches
        WHERE set_number = $1
          AND released_at IS NOT NULL
          AND released_at <= to_timestamp($2::double precision / 1000.0)
        ORDER BY released_at DESC
        LIMIT 1`,
      [setNumber, gameDatetimeMs],
    );
    // No row means the match predates the first declared boundary — fall through
    // rather than guessing, so pre-calendar matches keep the patch they had.
    if (onCalendar.rows[0]) return onCalendar.rows[0].id;
  }

  const parsed = patchFromVersion(gameVersion);
  const patch = parsed ?? placeholderPatch(setNumber);

  const SELECT_ID = `SELECT id FROM patches WHERE set_number = $1 AND patch = $2`;

  const existing = await client.query<{ id: number }>(SELECT_ID, [setNumber, patch]);
  if (existing.rows[0]) return existing.rows[0].id;

  const inserted = await client.query<{ id: number }>(
    `INSERT INTO patches (set_number, patch, label)
     VALUES ($1, $2, $3)
     ON CONFLICT (set_number, patch) DO NOTHING
     RETURNING id`,
    [setNumber, patch, parsed ? null : UNVERSIONED_LABEL],
  );
  if (inserted.rows[0]) return inserted.rows[0].id;

  const raced = await client.query<{ id: number }>(SELECT_ID, [setNumber, patch]);
  return raced.rows[0]?.id ?? null;
}

/**
 * Advances the single global `is_current` flag to the newest patch ACTUALLY
 * OBSERVED IN MATCHES for the live set. Real match data is the only source of
 * truth for "current", never a hand-set config value (those drift stale the
 * moment nobody remembers to update them) — but the flag is DERIVED, so it is settled periodically
 * rather than per match.
 *
 * WHY THIS IS NOT IN resolvePatchId ANY MORE. It used to run inside every
 * match-persist transaction: `UPDATE patches SET is_current = false WHERE
 * is_current = true` took row locks on rows chosen by a table-wide predicate,
 * while the same transaction already held locks on `matches` and
 * `match_participants` — at matchWorker concurrency 3, plus the profile
 * write-path. That is a genuine lock-ordering cycle, and it fired: a merge
 * failed with a Postgres deadlock on 2026-08-18 and wedged the pipeline chain
 * for hours. A patch flips roughly every two weeks; paying for it on every one
 * of thousands of matches an hour bought nothing.
 *
 * It now runs once per ladder-crawl pass, in its own single statement outside
 * any caller's transaction. The write locks only the rows that actually change
 * and commits immediately, so it cannot participate in a cycle with the persist
 * path (which touches exactly one `patches` row and never returns to the table).
 *
 * LIVE-SET GATE: patch strings are only comparable WITHIN a set. Rotating game
 * modes replay old sets on today's client version, so patch "16.14" exists for
 * sets 1, 16 and 17 simultaneously in real data. Without this gate the first
 * set-16 revival match on the next patch wins the numeric comparison and moves
 * the flag onto set 16 — and since `units` only holds the live set's catalog,
 * currentSet() then resolves to a set with no units and the catalog, Library
 * and planner all go blank. So the winner is chosen only among live-set patches.
 * Picking the winner absolutely (rather than comparing against whatever is
 * flagged) also self-heals a flag already stolen by another set: the write
 * clears every row that is not the winner, whatever set it belongs to.
 *
 * Returns the patch now flagged, or null when there is nothing to flag (no
 * catalog loaded, or no matches yet for the live set) — in which case the flag
 * is left alone rather than cleared, and static-data.ts's reader backstop falls
 * back to the newest set with units.
 */
export async function advanceCurrentPatch(): Promise<{ patch: string; changed: boolean } | null> {
  // LIVE SET = the newest set that has BOTH a catalog and observed matches.
  //
  // It used to be plain MAX(set_number) FROM units, which trusts the catalog
  // alone — and the catalog can lie. CDragon publishes a stub entry for an
  // upcoming set weeks early (traits, augments, and a handful of jungle camps
  // with costs), so `npm run data:load` happily wrote set 18 four days before
  // its launch. Nothing broke on the read path — static-data.ts's backstop
  // ignores an is_current flag on a set with no units — but THIS function
  // silently became a no-op: it looked for the newest set-18 patch, found no
  // set-18 matches, and returned null, so the set-17 flag could never advance
  // again. A stalled flag is invisible until a patch rolls over and the crawl
  // is still bounded by the previous one.
  //
  // Requiring matches makes the derivation self-correcting. At a real set
  // launch the catalog lands first and the live set stays put until the first
  // game of the new set is actually ingested, which is the right moment to move.
  const live = await one<{ max: number | null }>(
    `SELECT MAX(u.set_number)::int AS max
       FROM (SELECT DISTINCT set_number FROM units) u
      WHERE EXISTS (SELECT 1 FROM matches m WHERE m.set_number = u.set_number)`,
  );
  const setNumber = live?.max ?? null;
  if (!setNumber) return null;

  // MUST HAVE MATCHES. `patches` mixes two numbering systems in one column:
  // rows derived from a match's game_version (label NULL — "16.16", the client
  // version) and rows written by load-static-data.ts for the catalog it loads
  // (label set — "17.6", the OFFICIAL TFT patch number). Both land on set 17,
  // and the official number sorts HIGHER than the client one, so ordering the
  // table alone hands the flag to a catalog row with zero matches behind it.
  // Measured 2026-08-21: that flagged 17.6 (0 matches) over 16.16 (11,430),
  // which would have emptied ladder-crawl's current-patch boundary — MIN() over
  // no rows is NULL, i.e. no filter — and pointed the patch selector at a patch
  // with no comp_stats. The EXISTS is an index probe (matches_patch_idx).
  //
  // A REAL PATCH ALWAYS BEATS THE PLACEHOLDER, and that cannot be left to the
  // numeric sort: the client version for set 18 is 16.x, which is numerically
  // BELOW the "18.0" placeholder, so ordering on the number alone would pin the
  // flag to the placeholder forever once real versions started arriving.
  //
  // A DECLARED boundary wins over an inferred one. `released_at` is set only by
  // `npm run patch:open`, i.e. by someone who watched the patch land; ordering on
  // it first means the flag follows what was declared rather than what a string
  // comparison makes of the numbers. Rows without one keep the old derivation.
  //
  // Numeric, not lexical — "16.10" must sort after "16.9". The hotfix suffix is
  // split out of the minor component so 18.1 < 18.1a < 18.1b (see comparePatch);
  // without that split the ::int cast throws on "1a" and the whole flag advance
  // fails. The regex guard keeps the cast off any row that predates the format
  // (the 0004 backfill derived the same shape, but a cast that can throw has no
  // business being load-bearing).
  const winner = await one<{ id: number; patch: string }>(
    `SELECT p.id, p.patch
       FROM patches p
      WHERE p.set_number = $1
        AND p.patch ~ '^[0-9]+[.][0-9]+[a-z]*$'
        AND EXISTS (SELECT 1 FROM matches m WHERE m.patch_id = p.id)
      ORDER BY (p.patch <> $2) DESC,
               p.released_at DESC NULLS LAST,
               split_part(p.patch, '.', 1)::int DESC,
               regexp_replace(split_part(p.patch, '.', 2), '[^0-9]', '', 'g')::int DESC,
               regexp_replace(split_part(p.patch, '.', 2), '[0-9]', '', 'g') DESC
      LIMIT 1`,
    [setNumber, placeholderPatch(setNumber)],
  );
  if (!winner) return null;

  // One statement: sets the winner true and every other flagged row false,
  // touching only rows whose value actually changes.
  const changed = await query<{ id: number }>(
    `UPDATE patches
        SET is_current = (id = $1)
      WHERE is_current <> (id = $1)
      RETURNING id`,
    [winner.id],
  );

  return { patch: winner.patch, changed: changed.length > 0 };
}
