import { riot, Priority, routeForPlatform, RiotApiError } from '@/lib/riot';
import type { Platform } from '@/config/regions';
import { query } from '@/lib/db';
import { CRAWL } from '@/config/crawl';
import { advanceCurrentPatch } from '@/server/patch';
import { bucketForTier, tierInScope } from '@/config/rank-buckets';
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

/** Riot's queueType for the ranked TFT ladder — the entry whose tier we bucket by. */
const RANKED_TFT = 'RANKED_TFT';

/** How many candidates to pull per intended enqueue. Out-of-scope players are
 *  skipped without consuming an enqueue slot, so without headroom a run full of
 *  low-ELO accounts would enqueue nothing at all. */
const SEED_OVERSELECT = 4;

const APEX_TIERS = ['challenger', 'grandmaster', 'master'] as const;
type ApexTier = (typeof APEX_TIERS)[number];
function isApexTier(t: string): t is ApexTier {
  return (APEX_TIERS as readonly string[]).includes(t);
}

function envInt(key: string, fallback: number): number {
  const n = Number(process.env[key]);
  return Number.isFinite(n) ? n : fallback;
}

// Focus the fetch budget on the CURRENT patch. Once a patch flips, old-patch
// games are history — they can't change "what's good right now", so the ids
// pull skips them (an old match that does slip through still lands on its own
// patch_id harmlessly). The boundary is DERIVED FROM DATA, never hand-set:
// the first observed current-patch match, minus a safety margin covering the
// deploy-to-first-observation gap (the filter otherwise permanently hides
// current-patch games played before we first saw one). Bootstrap (no
// current-patch match yet) → no filter; the boundary self-advances when
// advanceCurrentPatch() moves is_current, which runs at the top of this same
// pass — so the boundary is always derived from a flag settled moments ago.
// Set CRAWL_CURRENT_PATCH_ONLY=false to crawl full recent histories.
const CURRENT_PATCH_ONLY = process.env.CRAWL_CURRENT_PATCH_ONLY !== 'false';

/** Epoch seconds of the current-patch crawl boundary, or null (no filter). */
async function currentPatchStart(): Promise<number | null> {
  if (!CURRENT_PATCH_ONLY) return null;
  const rows = await query<{ start: string | null }>(
    `SELECT extract(epoch FROM MIN(m.game_datetime))::bigint::text AS start
       FROM matches m
       JOIN patches p ON p.id = m.patch_id
      WHERE p.is_current = true`,
  );
  const start = rows[0]?.start ? Number(rows[0].start) : null;
  if (start === null || !Number.isFinite(start)) return null;
  const marginHours = envInt('CRAWL_SINCE_MARGIN_HOURS', 12);
  return start - marginHours * 3600;
}

export async function runLadderCrawl(data: LadderCrawlJob, ctx: JobContext): Promise<void> {
  const platform = (data.platform ?? CRAWL.platform) as Platform;
  const route = routeForPlatform(platform);
  const matchFetchQueue = makeQueue(QUEUE.matchFetch);

  const recrawlHours = envInt('CRAWL_RECRAWL_HOURS', 12);
  // A cached tier is trusted for this long before it's re-resolved. Players do
  // move between tiers, but not on the timescale of a crawl pass, and every
  // re-check costs a Riot call.
  const tierTtlHours = envInt('CRAWL_TIER_TTL_HOURS', 72);

  try {
    // 0) SETTLE THE CURRENT PATCH. Derived from ingested matches, so this is
    //    the natural place for it: ladder-crawl is the only producer of new
    //    ingestion AND the main consumer of the flag (currentPatchStart below
    //    bounds the fetch budget by it). It used to run inside every
    //    match-persist transaction, where it deadlocked against the pipeline
    //    stages — see advanceCurrentPatch's header.
    const flagged = await advanceCurrentPatch();
    if (flagged?.changed) console.log(`[ladder-crawl] current patch advanced to ${flagged.patch}`);

    // 1) DISCOVER — register apex ladder puuids as uncrawled candidates. One
    //    cached Riot call per tier; no per-player fetches. Entries missing a
    //    puuid are skipped (they'll be discovered as match participants anyway).
    //
    //    The ladder tells us these players' tier for FREE, so it is recorded
    //    here — every account seeded this way skips the per-player league call
    //    the drain would otherwise spend on it.
    for (const tier of CRAWL.tiers) {
      if (!isApexTier(tier)) continue;
      const list = await riot.league.apex(platform, tier, Priority.BATCH);
      const puuids = (list?.entries ?? [])
        .map((e) => e.puuid)
        .filter((p): p is string => typeof p === 'string' && p.length > 0);
      if (puuids.length > 0) {
        await query(
          `INSERT INTO accounts (puuid, routing, tier, tier_checked_at)
           SELECT unnest($1::text[]), $2, $3, now()
           ON CONFLICT (puuid) DO UPDATE
             SET tier = EXCLUDED.tier, tier_checked_at = now()`,
          [puuids, route, tier.toUpperCase()],
        );
      }
    }

    // Current-patch-only boundary for every ids pull this pass (see above).
    const sinceEpoch = await currentPatchStart();
    if (sinceEpoch !== null) {
      console.log(
        `[ladder-crawl] current-patch-only: fetching games since ${new Date(sinceEpoch * 1000).toISOString()}`,
      );
    }

    // 2) DRAIN — never-crawled first (NULLS FIRST), then anything past the
    //    re-crawl window. This works down the discovered backlog instead of
    //    re-seeding the ladder top. Index: accounts (last_crawled_at NULLS FIRST).
    // Over-select: out-of-scope candidates are skipped without consuming an
    // enqueue slot, so the drain needs more rows than it intends to enqueue or
    // a run full of low-ELO accounts would do nothing.
    // ORDERING MATTERS AS MUCH AS THE GATE. The frontier is ~280 k accounts
    // snowballed from match participants, of which only a few hundred are
    // actually apex — so draining it oldest-first would spend a tier lookup on
    // candidate after candidate and enqueue almost nothing. Candidates whose
    // CACHED tier is already in scope (everyone seeded from the apex ladder,
    // where the tier came free) sort first; unknown-tier accounts next, so the
    // frontier still gets explored; already-checked out-of-scope players sort
    // last and fall off the LIMIT.
    const scopeUpper = CRAWL.tiers.map((t) => t.toUpperCase());
    // The tier TTL is PER CLASS. An in-scope tier is re-checked on the ordinary
    // window because those players are the sample and a demotion matters; a tier
    // already resolved OUT of scope (or resolved as unranked, hence NULL) is
    // left alone far longer, because re-resolving it spends a Riot call to learn
    // what we already knew. One TTL for both is what let the drain re-check the
    // same low-elo accounts every few days forever.
    const seeds = await query<{ puuid: string; tier: string | null; tier_fresh: boolean }>(
      `SELECT puuid, tier,
              (tier_checked_at IS NOT NULL
               AND tier_checked_at > now() - make_interval(hours =>
                     CASE WHEN tier IS NOT NULL AND upper(tier) = ANY($4::text[])
                          THEN $3 ELSE $5 END)) AS tier_fresh
         FROM accounts
        WHERE last_crawled_at IS NULL
           OR last_crawled_at < now() - make_interval(hours => $2)
        ORDER BY (tier IS NOT NULL AND upper(tier) = ANY($4::text[])) DESC,
                 (tier IS NULL) DESC,
                 last_crawled_at ASC NULLS FIRST
        LIMIT $1`,
      [
        CRAWL.maxPuuidsPerRun * SEED_OVERSELECT,
        recrawlHours,
        tierTtlHours,
        scopeUpper,
        CRAWL.outOfScopeTtlHours,
      ],
    );

    let enqueued = 0;
    let fetchBudget = CRAWL.maxMatchFetchesPerPass;
    let skippedOutOfScope = 0;
    let tierLookups = 0;
    // Lookups spent this pass on candidates with no known tier. Capped — see
    // CRAWL.exploreUnknownPerPass. Apex players arrive from the ladder in step 1
    // with their tier already attached, so exploring the frontier is a bonus,
    // not the mechanism, and it must not eat the pass.
    let unknownLookups = 0;
    const crawled: string[] = [];

    for (const seed of seeds) {
      const { puuid } = seed;
      if (enqueued >= CRAWL.maxPuuidsPerRun || fetchBudget <= 0) break;

      // RANK GATE. One league.byPuuid call per candidate — against the ~20 match
      // calls that candidate is about to cost, roughly 5 % overhead — resolves
      // the tier that buckets every board of every match we pull for them. A
      // player outside CRAWL_TIERS is marked crawled and skipped WITHOUT
      // spending the match budget, which is what keeps the frontier from
      // snowballing down the ladder while every board claims to be Challenger.
      let tier = seed.tier;
      if (!seed.tier_fresh) {
        // Budget guard, before the call rather than after it. Deliberately does
        // NOT mark the candidate crawled: it was never examined, so it stays at
        // the front of the frontier for the next pass instead of being burned
        // for the re-crawl window.
        if (seed.tier === null && unknownLookups >= CRAWL.exploreUnknownPerPass) continue;
        try {
          const entries = await riot.league.byPuuid(platform, puuid, Priority.BATCH);
          tier = entries.find((e) => e.queueType === RANKED_TFT)?.tier ?? null;
          tierLookups += 1;
          if (seed.tier === null) unknownLookups += 1;
        } catch (err) {
          // A failed lookup means we can't bucket this player's boards, and a
          // wrong bucket is worse than a missing board — so we always skip them
          // this pass. WHETHER TO BURN THE CANDIDATE depends on WHY it failed:
          //
          //   permanent (400, malformed puuid) → mark crawled, or one bad id
          //     jumps back to the front of the drain forever and wedges it;
          //   infrastructure (401/403 auth, 429, 5xx, 503 transport) → do NOT
          //     mark crawled. The failure says nothing about the player, and
          //     marking them burned ~240 accounts per pass into the 12 h recrawl
          //     window during an expired-key window, having fetched nothing.
          //
          // An auth failure additionally aborts the pass: if the key is dead
          // every remaining candidate fails identically, and there is no point
          // spending the rest of the budget discovering that one call at a time.
          const status = err instanceof RiotApiError ? err.status : 0;
          if (status === 401 || status === 403) {
            console.error(
              `[ladder-crawl] auth failed (${status}) — aborting this pass, no candidate ` +
                'marked crawled. Check RIOT_API_KEY.',
            );
            break;
          }
          if (status === 400) crawled.push(puuid); // permanently bad id
          console.warn(`[ladder-crawl] tier lookup failed for ${puuid}: ${(err as Error).message}`);
          continue;
        }
        await query(
          `UPDATE accounts SET tier = $2, tier_checked_at = now() WHERE puuid = $1`,
          [puuid, tier],
        );
      }

      if (!tierInScope(tier, CRAWL.tiers)) {
        crawled.push(puuid); // don't re-check until the recrawl window lapses
        skippedOutOfScope += 1;
        continue;
      }

      const count = Math.min(CRAWL.matchIdsPerPuuid, fetchBudget);
      let matchIds: string[];
      try {
        matchIds = await riot.match.idsByPuuid(
          route,
          puuid,
          { count, startTime: sinceEpoch ?? undefined },
          Priority.BATCH,
        );
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

      // The bucket now travels PER SEED, from that player's resolved tier —
      // it used to be one constant for the whole pass, derived from config
      // rather than from data.
      const job: MatchFetchJob = { platform, puuid, matchIds, bucket: bucketForTier(tier) };
      await matchFetchQueue.add('fetch', job, {
        jobId: `mf:${platform}:${puuid}`,
        removeOnComplete: true, // free the id so a later re-crawl can re-enqueue
        removeOnFail: { count: 500 },
        // match-fetch throws only when EVERY id failed — an outage or a dead
        // key. Its comment has always said "throw so BullMQ retries", but with
        // no attempts option it never did, and one transport blip failed the
        // batch permanently. A retry re-enters the WAITING list at the back, so
        // a retrying batch never blocks the ones behind it.
        attempts: CRAWL.matchFetchAttempts,
        backoff: { type: 'exponential', delay: CRAWL.matchFetchBackoffMs },
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

    // STAMP boards whose player's tier we have since resolved. A board is
    // written with the tier known at persist time, and for a player discovered
    // in that very match that is nothing — so without this the column would only
    // ever describe accounts the crawl had already drained. This is the right
    // place for it because this stage is what resolves tiers in the first place;
    // it is one indexed UPDATE, bounded so it can never turn a 5-minute pass
    // into a table sweep. Boards are stamped ONCE and never re-stamped: the tier
    // is as-sampled, and a stats site that retroactively re-ranks its own
    // history cannot be aggregated.
    const stampLimit = envInt('CRAWL_TIER_STAMP_LIMIT', 20_000);
    const stamped = await query(
      `WITH pending AS (
         SELECT mp.id, upper(a.tier) AS tier
           FROM match_participants mp
           JOIN accounts a ON a.puuid = mp.puuid AND a.tier IS NOT NULL
          WHERE mp.tier IS NULL
          LIMIT $1
       )
       UPDATE match_participants mp SET tier = p.tier
         FROM pending p WHERE p.id = mp.id
       RETURNING mp.id`,
      [stampLimit],
    );
    if (stamped.length > 0) {
      console.log(`[ladder-crawl] stamped ${stamped.length} board(s) with a newly resolved tier`);
    }

    console.log(
      `[ladder-crawl] frontier drain — ${seeds.length} candidates, enqueued ${enqueued}, ` +
        `tier lookups ${tierLookups} (${unknownLookups} exploratory), ` +
        `out-of-scope skipped ${skippedOutOfScope}, budget left ${fetchBudget}`,
    );
  } finally {
    await matchFetchQueue.close();
  }
}
/**
 * Un-burn a candidate whose match-fetch could not run for reasons that say
 * nothing about the player — an outage, a rate limit, an expired key.
 *
 * The drain marks a player crawled at ENQUEUE, on purpose, so a player who
 * fails cannot wedge it. The cost of that choice only shows up at the top of
 * the ladder: the apex frontier is ~126 accounts, so one expired-key window
 * burned ALL of them for CRAWL_RECRAWL_HOURS having fetched nothing, and
 * master_plus flatlined for half a day. Measured 2026-09-02: 190 of 200 sampled
 * failed match-fetch jobs were apex batches.
 *
 * The account is released to `now() - recrawl + retryMinutes` rather than to
 * NULL: NULL sorts first in the drain (NULLS FIRST), so a permanently unlucky
 * account would jump the queue every pass — the exact wedge the enqueue-time
 * mark exists to prevent. A short offset re-offers it soon without giving it
 * priority over the never-crawled frontier.
 */
export async function releaseCrawlCandidate(puuid: string): Promise<void> {
  const recrawlHours = envInt('CRAWL_RECRAWL_HOURS', 12);
  const retryMinutes = envInt('CRAWL_FAILED_RETRY_MINUTES', 15);
  await query(
    `UPDATE accounts
        SET last_crawled_at = now() - make_interval(hours => $2) + make_interval(mins => $3)
      WHERE puuid = $1`,
    [puuid, recrawlHours, retryMinutes],
  );
}
