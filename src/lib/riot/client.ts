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

/** Unwrap undici's `TypeError: fetch failed` to the real transport reason. The
 *  outer message is always the same string, so without this every network
 *  failure — DNS, reset, timeout — is indistinguishable in the logs. */
function transportCause(err: unknown): string {
  const e = err as { message?: string; cause?: { code?: string; message?: string } };
  return e?.cause?.code ?? e?.cause?.message ?? e?.message ?? 'unknown';
}

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

// ── Path-segment safety ─────────────────────────────────────────────────────
// Every id below is interpolated into an upstream URL that carries our API key.
// Un-encoded segments let a caller-supplied value inject path traversal ("../")
// or a query string ("?"), which the WHATWG URL parser then normalizes into a
// DIFFERENT Riot endpoint — turning this client into an authenticated proxy for
// whoever controls the input. encodeURIComponent() is the fix (it escapes "/",
// "?" and "#", so ".." can no longer traverse); the regex guards are
// defence-in-depth so a malformed id fails here rather than burning a request,
// and so a future caller that forgets to validate at the route boundary is
// still safe. They are deliberately permissive about length — Riot has changed
// id widths before, and rejecting a valid id is a worse failure than allowing
// an odd-looking one that encodeURIComponent has already neutralized.

/** e.g. "EUW1_7412345678" — platform prefix, underscore, digits. */
const MATCH_ID_RE = /^[A-Za-z0-9]{2,8}_[0-9]{1,24}$/;
/** Riot PUUIDs are base64url-ish. Also covers the literal "BOT" participant. */
const ID_TOKEN_RE = /^[A-Za-z0-9_-]{1,128}$/;

function safeSegment(value: string, re: RegExp, label: string): string {
  if (typeof value !== 'string' || !re.test(value)) {
    throw new RiotApiError(400, `Malformed ${label}`);
  }
  return encodeURIComponent(value);
}

const matchIdSeg = (v: string) => safeSegment(v, MATCH_ID_RE, 'match id');
const puuidSeg = (v: string) => safeSegment(v, ID_TOKEN_RE, 'puuid');
const summonerIdSeg = (v: string) => safeSegment(v, ID_TOKEN_RE, 'summoner id');

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

    // TRANSPORT failures throw instead of returning a response: undici reports
    // them as a bare TypeError('fetch failed') with the real reason on .cause
    // (ECONNRESET, ENOTFOUND, UND_ERR_CONNECT_TIMEOUT, EAI_AGAIN…). Left
    // unhandled they escaped this loop entirely — the retry logic below only
    // ever inspected res.status — and killed the whole calling job, discarding
    // a 20-30 match batch because one connection dropped. They are retried on
    // the same backoff as 429/5xx, and the cause is surfaced in the message so
    // the next occurrence is diagnosable from the worker log rather than
    // showing up as the word "fetch failed".
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { 'X-Riot-Token': apiKey },
        cache: 'no-store', // our Redis layer owns caching, not fetch's
      });
    } catch (err) {
      const reason = transportCause(err);
      if (attempt < MAX_RETRIES) {
        // Log the RECOVERED case too. Without this a retry that succeeds leaves
        // no trace, so "no failures" can't be distinguished from "failing
        // constantly but absorbed" — and the cause code is the only clue to
        // whether this is DNS, connection churn, or upstream shedding load.
        console.warn(
          `[riot] transport ${reason} on ${methodLabel(path)} (attempt ${attempt + 1}/${MAX_RETRIES}), retrying`,
        );
        await sleep(Math.min(1000 * 2 ** attempt, 10_000));
        continue;
      }
      throw new RiotApiError(
        503,
        `Riot API unreachable after ${MAX_RETRIES} retries (${reason}): ${url}`,
      );
    }

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
        path: `/riot/account/v1/accounts/by-puuid/${puuidSeg(puuid)}`,
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
        path: `/tft/summoner/v1/summoners/by-puuid/${puuidSeg(puuid)}`,
        regionKey: platform,
        priority,
        cacheTtl: CACHE_TTL.summoner,
      });
    },
    /** Encrypted summonerId -> summoner. Used when seeding from apex ladders. */
    byId(platform: Platform, summonerId: string, priority = Priority.BATCH) {
      return request<SummonerDto>({
        host: platformHost(platform),
        path: `/tft/summoner/v1/summoners/${summonerIdSeg(summonerId)}`,
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
        path: `/tft/league/v1/by-puuid/${puuidSeg(puuid)}`,
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
        path: `/tft/league/v1/entries/by-summoner/${summonerIdSeg(summonerId)}`,
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
        path: `/tft/match/v1/matches/by-puuid/${puuidSeg(puuid)}/ids?start=${Number(start)}&count=${Number(count)}${since}`,
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
        path: `/tft/match/v1/matches/${matchIdSeg(matchId)}`,
        regionKey: route,
        priority,
        cacheTtl: CACHE_TTL.matchDetail,
      });
    },
  },
};

export { routeForPlatform };