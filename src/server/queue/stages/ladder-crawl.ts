import { riot, Priority, routeForPlatform } from '@/lib/riot';
import type { Platform } from '@/config/regions';
import { query } from '@/lib/db';
import { CRAWL } from '@/config/crawl';
import { bucketForTier } from '@/config/rank-buckets';
import { makeQueue, QUEUE } from '../queues';
import type { JobContext } from '../job-tracking';
import type { MatchFetchJob } from './match-fetch';

// Stage 1 (producer) — FRONTIER-DRAINING crawl.
//
// The old version re-pulled the apex ladder and re-seeded the same LP-sorted top
// players every pass, so the 8 participants discovered in each match (~7 of whom
// are new players) were never crawled: the frontier filled but never drained.
//
// Now `accounts` is the frontier registry. Every discovered puuid lands there as
// an uncrawled candidate — match-fetch registers a match's participants, and this
// stage registers the apex ladder — and `accounts.last_crawled_at` marks who has
// been fetched. Each pass:
//   1) DISCOVER — pull the apex ladder(s) and upsert their puuids (uncrawled).
//   2) DRAIN    — select never-crawled (then stalest) players, oldest-frontier
//                 first, and enqueue one match-fetch per player.
// Bounded by maxPuuidsPerRun / maxMatchFetchesPerPass. A player is re-crawled
// only once its data is older than CRAWL_RECRAWL_HOURS, so coverage stays current
// without re-fetching the same history every pass.

export interface LadderCrawlJob {
  platform: string;
}

const APEX_TIERS = ['challenger', 'grandmaster', 'master'] as const;
type ApexTier = (typeof APEX_TIERS)[number];
function isApexTier(t: string): t is ApexTier {
  return (APEX_TIERS as readonly string[]).includes(t);
}

function envInt(key: string, fallback: number): number {
  const n = Number(process.env[key]);
  return Number.isFinite(n) ? n : fallback;
}

export async function runLadderCrawl(data: LadderCrawlJob, ctx: JobContext): Promise<void> {
  const platform = (data.platform ?? CRAWL.platform) as Platform;
  const route = routeForPlatform(platform);
  const matchFetchQueue = makeQueue(QUEUE.matchFetch);

  const recrawlHours = envInt('CRAWL_RECRAWL_HOURS', 12);
  // rank_bucket is vestigial until R8 (match_participants.rank_bucket rides the
  // 0009 column default); the job carries it but match-fetch doesn't persist it.
  const bucket = bucketForTier(CRAWL.tiers.find(isApexTier) ?? 'challenger');

  try {
    // 1) DISCOVER — register apex ladder puuids as uncrawled candidates. One
    //    cached Riot call per tier; no per-player fetches. Entries missing a
    //    puuid are skipped (they'll be discovered as match participants anyway).
    for (const tier of CRAWL.tiers) {
      if (!isApexTier(tier)) continue;
      const list = await riot.league.apex(platform, tier, Priority.BATCH);
      const puuids = (list?.entries ?? [])
        .map((e) => e.puuid)
        .filter((p): p is string => typeof p === 'string' && p.length > 0);
      if (puuids.length > 0) {
        await query(
          `INSERT INTO accounts (puuid, routing)
           SELECT unnest($1::text[]), $2
           ON CONFLICT (puuid) DO NOTHING`,
          [puuids, route],
        );
      }
    }

    // 2) DRAIN — never-crawled first (NULLS FIRST), then anything past the
    //    re-crawl window. This works down the discovered backlog instead of
    //    re-seeding the ladder top. Index: accounts (last_crawled_at NULLS FIRST).
    const seeds = await query<{ puuid: string }>(
      `SELECT puuid
         FROM accounts
        WHERE last_crawled_at IS NULL
           OR last_crawled_at < now() - make_interval(hours => $2)
        ORDER BY last_crawled_at ASC NULLS FIRST
        LIMIT $1`,
      [CRAWL.maxPuuidsPerRun, recrawlHours],
    );

    let enqueued = 0;
    let fetchBudget = CRAWL.maxMatchFetchesPerPass;
    const crawled: string[] = [];

    for (const { puuid } of seeds) {
      if (enqueued >= CRAWL.maxPuuidsPerRun || fetchBudget <= 0) break;

      const count = Math.min(CRAWL.matchIdsPerPuuid, fetchBudget);
      let matchIds: string[];
      try {
        matchIds = await riot.match.idsByPuuid(route, puuid, { count }, Priority.BATCH);
      } catch (err) {
        // One bad seed (malformed puuid, deleted account, etc.) must not abort
        // the whole drain pass — that leaves every seed after it un-crawled too,
        // and since it stays NULL it jumps back to the front next run, wedging
        // the crawler on the same seed forever. Mark it crawled anyway and move on.
        console.warn(`[ladder-crawl] skipping ${puuid}: ${(err as Error).message}`);
        crawled.push(puuid);
        continue;
      }

      // Mark at enqueue (not at fetch completion): a selected player is "crawled"
      // for this window regardless of whether the fetch later succeeds, so a
      // failing player can't wedge the drain. It retries after CRAWL_RECRAWL_HOURS.
      crawled.push(puuid);
      if (matchIds.length === 0) continue;

      const job: MatchFetchJob = { platform, puuid, matchIds, bucket };
      await matchFetchQueue.add('fetch', job, {
        jobId: `mf:${platform}:${puuid}`,
        removeOnComplete: true, // free the id so a later re-crawl can re-enqueue
        removeOnFail: { count: 500 },
      });

      enqueued += 1;
      fetchBudget -= matchIds.length;
      ctx.setItems(enqueued);
    }

    if (crawled.length > 0) {
      await query(
        `UPDATE accounts SET last_crawled_at = now() WHERE puuid = ANY($1::text[])`,
        [crawled],
      );
    }

    console.log(
      `[ladder-crawl] frontier drain — ${seeds.length} candidates, enqueued ${enqueued}, budget left ${fetchBudget}`,
    );
  } finally {
    await matchFetchQueue.close();
  }
}