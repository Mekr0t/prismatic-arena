import { redis } from '@/lib/redis';
import { query } from '@/lib/db';
import {
  platformHost,
  regionalHost,
  routeForPlatform,
  type Platform,
  type RegionalRoute,
} from '@/config/regions';
import { CACHE_TTL } from '@/config/cache';
import { DEV_APP_WINDOWS, SlidingWindowQueue } from './rate-limiter';
import type {
  AccountDto,
  SummonerDto,
  LeagueEntryDto,
  LeagueListDto,
  MatchDto,
} from './types';

if (!process.env.RIOT_API_KEY && process.env.NODE_ENV === 'production') {
  throw new Error('RIOT_API_KEY environment variable is required in production');
}

/** User-facing requests jump ahead of background crawl requests. */
export enum Priority {
  USER = 10,
  BATCH = 0,
}

const MAX_RETRIES = 3;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// One app-rate-limit budget per host. We key by the region identifier of the
// host being called: regional routes (americas/europe/...) for account+match,
// platform ids (na1/euw1/...) for summoner+league. Each host is metered
// independently by Riot, so a separate limiter per key is correct.
const limiters = new Map<string, SlidingWindowQueue>();
function limiterFor(regionKey: string): SlidingWindowQueue {
  let l = limiters.get(regionKey);
  if (!l) {
    l = new SlidingWindowQueue(DEV_APP_WINDOWS);
    limiters.set(regionKey, l);
  }
  return l;
}

export class RiotApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'RiotApiError';
  }
}

// ── API-usage telemetry (M3 ops panel) ──────────────────────────────────────
// Every real HTTP call to Riot is counted into a per-minute bucket keyed by
// (region, method); 429s are tracked separately so the admin panel can see
// rate-limit pressure. Writes are fire-and-forget on purpose: ops telemetry
// must never add latency to, or throw inside, a user-facing Riot call. At
// dev-key volume one upsert per call is trivial; the production-scale version
// would batch these through a Redis counter (not needed yet).

/** Maps a request path to a stable endpoint label for api_usage.method. */
function methodLabel(path: string): string {
  const p = path.split('?')[0];
  if (p.startsWith('/riot/account/v1/accounts/by-riot-id')) return 'account.byRiotId';
  if (p.startsWith('/riot/account/v1/accounts/by-puuid')) return 'account.byPuuid';
  if (p.startsWith('/tft/summoner/v1/summoners/by-puuid')) return 'summoner.byPuuid';
  if (p.startsWith('/tft/summoner/v1/summoners/')) return 'summoner.byId';
  if (p.startsWith('/tft/league/v1/by-puuid')) return 'league.byPuuid';
  if (p.startsWith('/tft/league/v1/entries/by-summoner')) return 'league.bySummoner';
  if (/^\/tft\/league\/v1\/(challenger|grandmaster|master)\b/.test(p)) return 'league.apex';
  if (p.startsWith('/tft/match/v1/matches/by-puuid')) return 'match.idsByPuuid';
  if (p.startsWith('/tft/match/v1/matches/')) return 'match.byId';
  return 'other';
}

/** Fire-and-forget per-minute upsert of request + 429 counts. Never awaited. */
function recordUsage(regionKey: string, path: string, is429: boolean): void {
  query(
    `INSERT INTO api_usage (window_start, region, method, request_count, rate_429)
     VALUES (date_trunc('minute', now()), $1, $2, 1, $3)
     ON CONFLICT (window_start, region, method)
     DO UPDATE SET request_count = api_usage.request_count + 1,
                   rate_429      = api_usage.rate_429 + EXCLUDED.rate_429`,
    [regionKey, methodLabel(path), is429 ? 1 : 0],
  ).catch(() => {
    // Swallow: telemetry failures (e.g. table missing) must not affect requests.
  });
}

interface RequestOpts {
  host: string;
  path: string;
  regionKey: string; // rate-limit bucket
  priority: Priority;
  cacheTtl?: number; // seconds; omit to skip caching
}

async function request<T>(opts: RequestOpts): Promise<T | null> {
  const { host, path, regionKey, priority, cacheTtl } = opts;
  const url = `${host}${path}`;
  const cacheKey = cacheTtl ? `riot:cache:${url}` : null;

  if (cacheKey) {
    const cached = await redis.get(cacheKey);
    if (cached !== null) return JSON.parse(cached) as T;
  }

  const apiKey = process.env.RIOT_API_KEY;
  if (!apiKey) throw new RiotApiError(500, 'RIOT_API_KEY is not set');

  const limiter = limiterFor(regionKey);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await limiter.acquire(priority);

    const res = await fetch(url, {
      headers: { 'X-Riot-Token': apiKey },
      cache: 'no-store', // our Redis layer owns caching, not fetch's
    });

    // Count every real HTTP call (incl. 404s and each 429 retry) against usage.
    recordUsage(regionKey, path, res.status === 429);

    // 404 is normal: unknown Riot ID, or a player with no matches.
    if (res.status === 404) return null;

    // Back off on rate-limit and server errors, honoring Retry-After.
    if (res.status === 429 || res.status >= 500) {
      if (attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers.get('Retry-After'));
        const backoff =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : Math.min(1000 * 2 ** attempt, 10_000);
        await sleep(backoff);
        continue;
      }
      throw new RiotApiError(
        res.status,
        `Riot API ${res.status} after ${MAX_RETRIES} retries: ${url}`,
      );
    }

    if (!res.ok) {
      throw new RiotApiError(res.status, `Riot API ${res.status}: ${url}`);
    }

    const data = (await res.json()) as T;
    if (cacheKey) await redis.set(cacheKey, JSON.stringify(data), 'EX', cacheTtl!);
    return data;
  }

  return null; // unreachable; keeps the type checker happy
}

// ── Typed endpoint methods ──────────────────────────────────────────────────

// ACCOUNT-V1 is served only on americas / asia / europe — `sea` (used by
// match-v1 for OCE/SEA platforms) is NOT a valid account host. PUUIDs are
// global, so route SEA account calls through ASIA.
function accountRoute(route: RegionalRoute): RegionalRoute {
  return route === 'sea' ? 'asia' : route;
}

export const riot = {
  account: {
    /** Riot ID -> account (puuid). Regional host. */
    byRiotId(
      route: RegionalRoute,
      gameName: string,
      tagLine: string,
      priority = Priority.USER,
    ) {
      const r = accountRoute(route);
      return request<AccountDto>({
        host: regionalHost(r),
        path: `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`,
        regionKey: r,
        priority,
        cacheTtl: CACHE_TTL.account,
      });
    },
    /** PUUID -> account (refresh display name). Regional host. */
    byPuuid(route: RegionalRoute, puuid: string, priority = Priority.USER) {
      const r = accountRoute(route);
      return request<AccountDto>({
        host: regionalHost(r),
        path: `/riot/account/v1/accounts/by-puuid/${puuid}`,
        regionKey: r,
        priority,
        cacheTtl: CACHE_TTL.account,
      });
    },
  },

  summoner: {
    /** PUUID -> summoner (id, level, icon). Platform host. */
    byPuuid(platform: Platform, puuid: string, priority = Priority.USER) {
      return request<SummonerDto>({
        host: platformHost(platform),
        path: `/tft/summoner/v1/summoners/by-puuid/${puuid}`,
        regionKey: platform,
        priority,
        cacheTtl: CACHE_TTL.summoner,
      });
    },
    /** Encrypted summonerId -> summoner. Used when seeding from apex ladders. */
    byId(platform: Platform, summonerId: string, priority = Priority.BATCH) {
      return request<SummonerDto>({
        host: platformHost(platform),
        path: `/tft/summoner/v1/summoners/${summonerId}`,
        regionKey: platform,
        priority,
        cacheTtl: CACHE_TTL.summoner,
      });
    },
  },

  league: {
    /** Ranked entries for a player by PUUID. Platform host. Returns [] if unranked. */
    async byPuuid(platform: Platform, puuid: string, priority = Priority.USER) {
      const data = await request<LeagueEntryDto[]>({
        host: platformHost(platform),
        path: `/tft/league/v1/by-puuid/${puuid}`,
        regionKey: platform,
        priority,
        cacheTtl: CACHE_TTL.league,
      });
      return data ?? [];
    },
    /** @deprecated Use byPuuid — /by-summoner endpoint removed by Riot June 2025. */
    async bySummoner(platform: Platform, summonerId: string, priority = Priority.USER) {
      const data = await request<LeagueEntryDto[]>({
        host: platformHost(platform),
        path: `/tft/league/v1/entries/by-summoner/${summonerId}`,
        regionKey: platform,
        priority,
        cacheTtl: CACHE_TTL.league,
      });
      return data ?? [];
    },
    /** Apex ladder snapshot. Platform host. */
    apex(
      platform: Platform,
      tier: 'challenger' | 'grandmaster' | 'master',
      priority = Priority.BATCH,
    ) {
      return request<LeagueListDto>({
        host: platformHost(platform),
        path: `/tft/league/v1/${tier}`,
        regionKey: platform,
        priority,
        cacheTtl: CACHE_TTL.apexLeague,
      });
    },
  },

  match: {
    /** Recent match IDs for a puuid. Regional host. `startTime` (epoch
     *  seconds) excludes games started before it — the crawler uses it to
     *  spend its budget on current-patch games only. */
    async idsByPuuid(
      route: RegionalRoute,
      puuid: string,
      opts: { start?: number; count?: number; startTime?: number } = {},
      priority = Priority.USER,
    ) {
      const { start = 0, count = 20, startTime } = opts;
      const since = startTime ? `&startTime=${Math.floor(startTime)}` : '';
      const data = await request<string[]>({
        host: regionalHost(route),
        path: `/tft/match/v1/matches/by-puuid/${puuid}/ids?start=${start}&count=${count}${since}`,
        regionKey: route,
        priority,
        cacheTtl: CACHE_TTL.matchIds,
      });
      return data ?? [];
    },
    /** Full match detail. Regional host. Immutable -> cached for 30 days. */
    byId(route: RegionalRoute, matchId: string, priority = Priority.USER) {
      return request<MatchDto>({
        host: regionalHost(route),
        path: `/tft/match/v1/matches/${matchId}`,
        regionKey: route,
        priority,
        cacheTtl: CACHE_TTL.matchDetail,
      });
    },
  },
};

export { routeForPlatform };