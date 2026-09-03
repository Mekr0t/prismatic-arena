import { query } from '@/lib/db';
import { CRAWL } from '@/config/crawl';
import { RANKED_TFT_QUEUE_ID } from '@/config/queue-ids';
import { superRegionForRegionCode, regionCodesFor } from '@/config/regions';
import { inScopeBuckets } from '@/config/rank-buckets';
import { makeQueue, QUEUE } from '@/server/queue/queues';

// crawl-health-service.ts — read model for the admin crawl-health panel.
//
// WHY IT EXISTS. The existing pipeline panel answers "is a job failing", and
// that is not the same question as "is ingestion actually happening". Both of
// 2026-09-02's incidents slipped through it:
//
//   • ladder-crawl threw on every pass for hours, and ingestion looked merely
//     slow because the match-fetch queue kept draining its existing backlog. The
//     tell was elsewhere entirely — 185 apex accounts drainable while the queue
//     had fallen to 49 waiting jobs. Nothing surfaced that pair.
//   • A read-path region regression left every comp's boards empty while the
//     tier list above them rendered perfectly from comp_stats. The tell was that
//     comp_stats claimed 131,704 boards for a scope where the read path's own
//     query found 0.
//
// So this panel deliberately reports SUPPLY (how many seeds exist and how many
// are eligible), FLOW (what is actually landing, by bucket and platform), and
// CONSISTENCY (do the derived tables and the read path still agree). Each of
// those is a question the job list cannot answer.

/** Ingest window for the flow figures. Long enough to survive a quiet minute. */
const FLOW_MINUTES = 60;

export interface ApexTierRow {
  tier: string;
  accounts: number;
  drainable: number;
}
export interface QueueDepth {
  name: string;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
}
export interface BucketFlow {
  bucket: string;
  boards: number;
  newest: string | null;
}
export interface PlatformFlow {
  region: string;
  superRegion: string | null;
  boards: number;
}
export interface ScopeCheck {
  patchId: number;
  region: string;
  rankBucket: string;
  statBoards: number;
  /** What the READ PATH finds for the same scope, via regionCodesFor. */
  readBoards: number;
  ok: boolean;
}
export interface CrawlHealth {
  scope: { tiers: string[]; platforms: string[]; recrawlHours: number; buckets: string[] | null };
  apex: ApexTierRow[];
  apexTotal: number;
  apexDrainable: number;
  /** When the next locked-out apex account becomes eligible again, ISO. */
  nextDrainable: string | null;
  queues: QueueDepth[];
  waitingByBucket: { bucket: string; jobs: number }[];
  flowMinutes: number;
  byBucket: BucketFlow[];
  byPlatform: PlatformFlow[];
  boardsPerHour: number;
  tierCoverage: { boards: number; withTier: number };
  scopeChecks: ScopeCheck[];
}

const envInt = (key: string, fallback: number): number => {
  const n = Number(process.env[key]);
  return Number.isFinite(n) ? n : fallback;
};

/** Queue depths, and the buckets of the work actually waiting. Opens one
 *  short-lived BullMQ connection per queue and closes it — this page is
 *  admin-only and force-dynamic, so a per-request connection is acceptable
 *  where a long-lived one in the read plane would not be. */
async function readQueues(): Promise<{ queues: QueueDepth[]; waitingByBucket: { bucket: string; jobs: number }[] }> {
  const queues: QueueDepth[] = [];
  let waitingByBucket: { bucket: string; jobs: number }[] = [];

  for (const name of Object.values(QUEUE)) {
    const q = makeQueue(name);
    try {
      const c = await q.getJobCounts('waiting', 'active', 'delayed', 'failed');
      queues.push({
        name,
        waiting: c.waiting ?? 0,
        active: c.active ?? 0,
        delayed: c.delayed ?? 0,
        failed: c.failed ?? 0,
      });
      if (name === QUEUE.matchFetch && (c.waiting ?? 0) > 0) {
        // The bucket mix of the WAITING work is what says whether the rank gate
        // is being honoured: a queue full of iron_gold under an apex-only scope
        // is a backlog from before the scope changed, not new work.
        const jobs = await q.getJobs(['waiting'], 0, 999);
        const tally = new Map<string, number>();
        for (const j of jobs) {
          const bucket = (j.data as { bucket?: string })?.bucket ?? '(none)';
          tally.set(bucket, (tally.get(bucket) ?? 0) + 1);
        }
        waitingByBucket = [...tally.entries()]
          .map(([bucket, jobs]) => ({ bucket, jobs }))
          .sort((a, b) => b.jobs - a.jobs);
      }
    } finally {
      await q.close();
    }
  }
  return { queues, waitingByBucket };
}

export async function getCrawlHealth(): Promise<CrawlHealth> {
  const recrawlHours = envInt('CRAWL_RECRAWL_HOURS', 12);
  const scopeUpper = CRAWL.tiers.map((t) => t.toUpperCase());
  const buckets = inScopeBuckets(CRAWL.tiers);

  const [apexRows, nextRow, flowBuckets, flowPlatforms, coverage, statScopes, rawScopes, queueInfo] =
    await Promise.all([
      // SUPPLY. Only the tiers the crawl is configured for — an apex-only scope
      // that lists Gold accounts is answering the wrong question.
      query<{ tier: string; accounts: number; drainable: number }>(
        `SELECT upper(tier) AS tier,
                COUNT(*)::int AS accounts,
                COUNT(*) FILTER (
                  WHERE last_crawled_at IS NULL
                     OR last_crawled_at < now() - make_interval(hours => $2::int)
                )::int AS drainable
           FROM accounts
          WHERE tier IS NOT NULL AND upper(tier) = ANY($1::text[])
          GROUP BY 1 ORDER BY 2 DESC`,
        [scopeUpper, recrawlHours],
      ),
      query<{ next: string | null }>(
        `SELECT MIN(last_crawled_at + make_interval(hours => $2::int))::text AS next
           FROM accounts
          WHERE tier IS NOT NULL AND upper(tier) = ANY($1::text[])
            AND last_crawled_at IS NOT NULL
            AND last_crawled_at >= now() - make_interval(hours => $2::int)`,
        [scopeUpper, recrawlHours],
      ),
      // FLOW, by rank bucket.
      query<{ bucket: string; boards: number; newest: string | null }>(
        `SELECT mp.rank_bucket AS bucket, COUNT(*)::int AS boards, MAX(m.ingested_at)::text AS newest
           FROM match_participants mp
           JOIN matches m ON m.match_id = mp.match_id
          WHERE m.ingested_at > now() - make_interval(mins => $1::int)
          GROUP BY 1 ORDER BY 2 DESC`,
        [FLOW_MINUTES],
      ),
      // FLOW, by platform — the crawl seeds several, and a platform silently
      // contributing nothing is the shape a bad route or a dead ladder takes.
      query<{ region: string; boards: number }>(
        `SELECT m.region, COUNT(*)::int AS boards
           FROM match_participants mp
           JOIN matches m ON m.match_id = mp.match_id
          WHERE m.ingested_at > now() - make_interval(mins => $1::int)
          GROUP BY 1 ORDER BY 2 DESC`,
        [FLOW_MINUTES],
      ),
      query<{ boards: number; with_tier: number }>(
        `SELECT COUNT(*)::int AS boards, COUNT(mp.tier)::int AS with_tier
           FROM match_participants mp
           JOIN matches m ON m.match_id = mp.match_id
          WHERE m.set_number = (SELECT MAX(set_number) FROM matches)`,
      ),
      // CONSISTENCY, side A: what the derived tables claim.
      query<{ patch_id: number; region: string; rank_bucket: string; boards: number }>(
        `SELECT patch_id, region, rank_bucket, SUM(n)::int AS boards
           FROM comp_stats GROUP BY 1,2,3 ORDER BY 4 DESC LIMIT 8`,
      ),
      // CONSISTENCY, side B: raw boards, grouped by PLATFORM so the fold to a
      // super-region happens in TS through the same helper the read path uses.
      // One pass, rather than a count per scope.
      query<{ patch_id: number; region: string; rank_bucket: string; boards: number }>(
        `SELECT m.patch_id, m.region, mp.rank_bucket, COUNT(*)::int AS boards
           FROM match_participants mp
           JOIN matches m ON m.match_id = mp.match_id
          WHERE mp.comp_id IS NOT NULL AND m.patch_id IS NOT NULL AND m.queue_id = $1
          GROUP BY 1,2,3`,
        [RANKED_TFT_QUEUE_ID],
      ),
      readQueues(),
    ]);

  // Fold raw platform rows into the region the read path would ask for, then
  // compare. A scope where comp_stats has boards and the read path finds none is
  // exactly the "no board data" failure: the tier list renders and every board
  // under it is empty.
  const rawByScope = new Map<string, number>();
  for (const r of rawScopes) {
    for (const key of [`${r.patch_id}|${r.region}|${r.rank_bucket}`,
                       `${r.patch_id}|${superRegionForRegionCode(r.region) ?? r.region}|${r.rank_bucket}`]) {
      rawByScope.set(key, (rawByScope.get(key) ?? 0) + r.boards);
    }
  }
  const scopeChecks: ScopeCheck[] = statScopes.map((s) => {
    // Sum the codes the read path expands to, exactly as it would.
    const readBoards = regionCodesFor(s.region).reduce(
      (acc, code) => acc + (rawByScope.get(`${s.patch_id}|${code}|${s.rank_bucket}`) ?? 0),
      0,
    );
    return {
      patchId: s.patch_id,
      region: s.region,
      rankBucket: s.rank_bucket,
      statBoards: s.boards,
      readBoards,
      ok: readBoards > 0,
    };
  });

  const apex = apexRows.map((r) => ({ tier: r.tier, accounts: r.accounts, drainable: r.drainable }));
  const byBucketBoards = flowBuckets.reduce((a, b) => a + b.boards, 0);

  return {
    scope: {
      tiers: CRAWL.tiers,
      platforms: CRAWL.platforms,
      recrawlHours,
      buckets: buckets ? [...buckets] : null,
    },
    apex,
    apexTotal: apex.reduce((a, r) => a + r.accounts, 0),
    apexDrainable: apex.reduce((a, r) => a + r.drainable, 0),
    nextDrainable: nextRow[0]?.next ?? null,
    queues: queueInfo.queues,
    waitingByBucket: queueInfo.waitingByBucket,
    flowMinutes: FLOW_MINUTES,
    byBucket: flowBuckets.map((r) => ({ bucket: r.bucket, boards: r.boards, newest: r.newest })),
    byPlatform: flowPlatforms.map((r) => ({
      region: r.region,
      superRegion: superRegionForRegionCode(r.region),
      boards: r.boards,
    })),
    boardsPerHour: Math.round((byBucketBoards / FLOW_MINUTES) * 60),
    tierCoverage: { boards: coverage[0]?.boards ?? 0, withTier: coverage[0]?.with_tier ?? 0 },
    scopeChecks,
  };
}
