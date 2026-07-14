import { query } from '@/lib/db';
import { riot, Priority } from '@/lib/riot';
import type { RegionalRoute } from '@/config/regions';

// Shared puuid → display-name resolver. Reads the local accounts table in one
// query, calls Riot only for misses (bounded, low-priority), and persists each
// hit back so the table fills over time. This is what keeps leaderboard pages
// and match lobbies from firing hundreds of account.byPuuid calls at once, and
// it's the account-resolution layer the M4 crawler reuses.
//
// Callers must tolerate a null name (Riot exhausted / unknown) and fall back to
// a truncated puuid for display.

export interface ResolvedName {
  gameName: string | null;
  tagLine: string | null;
}

// Cap simultaneous cold lookups. The Riot client's per-route limiter already
// spaces calls; this just bounds how many promises are in flight at once.
const MISS_CONCURRENCY = 5;

export async function resolveAccounts(
  puuids: string[],
  route: RegionalRoute,
  priority: Priority = Priority.BATCH,
): Promise<Map<string, ResolvedName>> {
  const result = new Map<string, ResolvedName>();
  const unique = [...new Set(puuids.filter(Boolean))];
  if (unique.length === 0) return result;

  // 1. Accounts-table-first: one query for everything we already know.
  const rows = await query<{
    puuid: string;
    game_name: string | null;
    tag_line: string | null;
  }>(
    `SELECT puuid, game_name, tag_line FROM accounts WHERE puuid = ANY($1::text[])`,
    [unique],
  );
  const known = new Set<string>();
  for (const r of rows) {
    // A row with a NULL name is a frontier stub (the crawler registers
    // discovered puuids as name-less candidates) — treat it as a miss so the
    // name still gets resolved from Riot and persisted, otherwise every
    // crawler-discovered player renders as a truncated puuid forever.
    if (r.game_name === null) continue;
    result.set(r.puuid, { gameName: r.game_name, tagLine: r.tag_line });
    known.add(r.puuid);
  }

  // 2. Resolve misses from Riot in bounded batches. BATCH priority by default so
  //    a bulk ladder resolve can never starve a live profile lookup. Persist hits.
  const misses = unique.filter((p) => !known.has(p));
  for (let i = 0; i < misses.length; i += MISS_CONCURRENCY) {
    const batch = misses.slice(i, i + MISS_CONCURRENCY);
    await Promise.all(
      batch.map(async (puuid) => {
        try {
          const acct = await riot.account.byPuuid(route, puuid, priority);
          if (acct) {
            result.set(puuid, { gameName: acct.gameName, tagLine: acct.tagLine });
            await persistAccount(puuid, acct.gameName, acct.tagLine, route);
          } else {
            result.set(puuid, { gameName: null, tagLine: null });
          }
        } catch {
          // Rate-limit exhaustion etc. — degrade gracefully; caller shows fallback.
          result.set(puuid, { gameName: null, tagLine: null });
        }
      }),
    );
  }

  return result;
}

async function persistAccount(
  puuid: string,
  gameName: string,
  tagLine: string,
  routing: RegionalRoute,
): Promise<void> {
  await query(
    `INSERT INTO accounts (puuid, game_name, tag_line, routing, last_synced_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (puuid) DO UPDATE
       SET game_name      = EXCLUDED.game_name,
           tag_line       = EXCLUDED.tag_line,
           last_synced_at = now()`,
    [puuid, gameName, tagLine, routing],
  ).catch(() => {
    // Best-effort: a failed write must never block name resolution.
  });
}
