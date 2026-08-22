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
  // Rank bucket this batch was crawled from, resolved by ladder-crawl's rank
  // gate and written per board by persistMatch (R1).
  bucket: RankBucket;
}

export async function runMatchFetch(data: MatchFetchJob, ctx: JobContext): Promise<void> {
  const route = routeForPlatform(data.platform as Platform);
  let stored = 0;
  let skipped = 0;
  let metaOnly = 0; // non-ranked: matches row written, boards deliberately not

  const discovered = new Set<string>();

  // One match id must not sink the batch. The client already retries transport
  // failures, so anything still throwing here is either persistent (a bad id, a
  // sustained network outage) or an expired key — none of which is a reason to
  // discard the other 20-odd ids in this job, which is what an unguarded loop
  // did. Failures are counted; the job only fails if EVERY id failed, so a real
  // outage still surfaces as a failed job rather than a silent no-op.
  const errors: string[] = [];

  for (const matchId of data.matchIds) {
    try {
      // Dedup boundary: a match we already have skips the Riot fetch outright.
      const existing = await query('SELECT 1 FROM matches WHERE match_id = $1', [matchId]);
      if (existing.length > 0) {
        skipped += 1;
        continue;
      }

      const match = await riot.match.byId(route, matchId, Priority.BATCH);
      if (!match) continue;

      // The seed player's tier buckets every board in the match (TFT lobbies are
      // rank-homogeneous). This is what finally makes rank_bucket real instead
      // of the 0009 column default.
      const outcome = await persistMatch(match, data.bucket); // idempotent — re-checks existence
      if (outcome === 'meta-only') metaOnly += 1;
      // AI-filled lobbies report bot participants with the literal puuid "BOT" —
      // not a real account, and Riot 400s any match/league call made with it.
      for (const p of match.info.participants) {
        if (p.puuid !== 'BOT') discovered.add(p.puuid);
      }
      stored += 1;
      ctx.setItems(stored);
    } catch (err) {
      errors.push(`${matchId}: ${(err as Error).message}`);
      console.warn(`[match-fetch] skipping ${matchId}: ${(err as Error).message}`);
    }
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
    `[match-fetch] ${data.puuid}: stored=${stored} (meta-only=${metaOnly}) ` +
      `skipped=${skipped} failed=${errors.length} ` +
      `total=${data.matchIds.length} discovered=${discovered.size}`,
  );

  // Everything failed — that's an outage or a dead key, not a batch of bad ids.
  // Throw so BullMQ retries and ingestion_jobs records it, instead of reporting
  // a successful pass that stored nothing.
  if (errors.length > 0 && stored === 0 && skipped === 0) {
    throw new Error(
      `all ${errors.length} match fetches failed — first: ${errors[0]}`,
    );
  }
}