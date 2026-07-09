import { riot, Priority, routeForPlatform } from '@/lib/riot';
import type { Platform } from '@/config/regions';
import { query } from '@/lib/db';
import { persistMatch } from '@/server/match-persist';
import type { RankBucket } from '@/config/rank-buckets';
import type { JobContext } from '../job-tracking';

// Stage 2 (consumer). Processes one PUUID's batch of match IDs: an existence
// check skips the Riot call for matches already stored (the real dedup boundary),
// then persistMatch idempotently stores new ones. items_done = matches stored.
//
// It also REGISTERS every player seen in these matches as an uncrawled crawl
// candidate (accounts, ON CONFLICT DO NOTHING). That feedback is what expands the
// frontier: the ~7 other players in each lobby become future seeds for the
// ladder-crawl drain. The seed itself is marked crawled by ladder-crawl at enqueue.

export interface MatchFetchJob {
  platform: string;
  puuid: string;
  matchIds: string[];
  // Rank bucket this batch was crawled from. Carried for the rollup; not
  // persisted yet (match_participants.rank_bucket rides the 0009 default).
  bucket: RankBucket;
}

export async function runMatchFetch(data: MatchFetchJob, ctx: JobContext): Promise<void> {
  const route = routeForPlatform(data.platform as Platform);
  let stored = 0;
  let skipped = 0;
  const discovered = new Set<string>();

  for (const matchId of data.matchIds) {
    // Dedup boundary: a match we already have skips the Riot fetch outright.
    const existing = await query('SELECT 1 FROM matches WHERE match_id = $1', [matchId]);
    if (existing.length > 0) {
      skipped += 1;
      continue;
    }

    const match = await riot.match.byId(route, matchId, Priority.BATCH);
    if (!match) continue;

    await persistMatch(match); // idempotent — re-checks existence for race safety
    for (const p of match.info.participants) discovered.add(p.puuid);
    stored += 1;
    ctx.setItems(stored);
  }

  // Expand the frontier: every player seen here becomes an uncrawled candidate.
  // Existing rows (already known / crawled) are left untouched by DO NOTHING.
  if (discovered.size > 0) {
    await query(
      `INSERT INTO accounts (puuid, routing)
       SELECT unnest($1::text[]), $2
       ON CONFLICT (puuid) DO NOTHING`,
      [[...discovered], route],
    );
  }

  console.log(
    `[match-fetch] ${data.puuid}: stored=${stored} skipped=${skipped} total=${data.matchIds.length} discovered=${discovered.size}`,
  );
}