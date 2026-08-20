import { headers } from 'next/headers';
import { redis } from '@/lib/redis';

// Request throttling for the endpoints that spend the Riot API budget.
//
// WHY THIS EXISTS: a profile lookup fans out to ~23 live Riot calls, and a dev
// key allows 100 requests per 2 minutes. Without a limiter, a handful of
// anonymous requests exhausts the key — which doesn't just slow the page, it
// starves the background crawler for the rest of the window. The limiter
// protects a shared budget, not a secret.
//
// TWO LAYERS, on purpose:
//   • PER-IP  — fairness. Derived from x-forwarded-for, which a caller can spoof
//               when nothing upstream rewrites it, so this layer alone is not a
//               security boundary.
//   • GLOBAL  — budget protection. Counted across all callers, so it holds even
//               when the per-IP key is forged. This is the layer that actually
//               keeps the key alive.
//
// FAIL-OPEN: if Redis is unreachable the request is allowed. A rate limiter
// guarding a quota must not become a second outage when its own backing store
// is down — the failure it prevents (a spent API key) is recoverable, the one it
// would cause (the whole site 500ing) is worse. Failures are logged once per
// occurrence so a silently-degraded limiter is visible in the worker logs.

const num = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Named limits, all env-overridable so tuning is config, not a deploy. */
export const LIMITS = {
  /** Riot-backed read routes (profile, match, leaderboard). */
  riotRead: {
    perIp: num(process.env.RL_RIOT_PER_IP, 30),
    global: num(process.env.RL_RIOT_GLOBAL, 120),
    windowSeconds: num(process.env.RL_RIOT_WINDOW_S, 60),
  },
  /** Admin sign-in attempts. Tighter, and counted over a longer window. */
  adminLogin: {
    perIp: num(process.env.RL_LOGIN_PER_IP, 5),
    global: num(process.env.RL_LOGIN_GLOBAL, 20),
    windowSeconds: num(process.env.RL_LOGIN_WINDOW_S, 300),
  },
} as const;

export interface RateLimitVerdict {
  ok: boolean;
  /** Seconds until the caller may retry. 0 when allowed. */
  retryAfter: number;
  /** Which layer rejected — for logging, never surfaced to the caller. */
  scope: 'ip' | 'global' | null;
}

const ALLOWED: RateLimitVerdict = { ok: true, retryAfter: 0, scope: null };

/**
 * Best-effort client IP. Behind a reverse proxy the leftmost x-forwarded-for
 * entry is the client; with no proxy the header is absent and every caller
 * shares the 'unknown' bucket (which is why the global layer exists).
 */
export async function clientIp(): Promise<string> {
  const h = await headers();
  const fwd = h.get('x-forwarded-for');
  if (fwd) {
    const first = fwd.split(',')[0]?.trim();
    if (first) return first;
  }
  return h.get('x-real-ip')?.trim() || 'unknown';
}

/** Fixed-window counter. Returns the count after incrementing, or null on error. */
async function bump(key: string, windowSeconds: number): Promise<number | null> {
  try {
    const [[incrErr, count]] = (await redis
      .multi()
      .incr(key)
      .expire(key, windowSeconds, 'NX')
      .exec()) as [[Error | null, number], ...unknown[]];
    if (incrErr) throw incrErr;
    return count;
  } catch (err) {
    console.error('[rate-limit] redis unavailable, failing open:', (err as Error).message);
    return null;
  }
}

/**
 * Apply both layers for a named limit. `bucket` namespaces the counters so
 * profile and login attempts never share a window.
 */
export async function rateLimit(
  bucket: string,
  limit: { perIp: number; global: number; windowSeconds: number },
): Promise<RateLimitVerdict> {
  const { perIp, global: globalLimit, windowSeconds } = limit;
  // One window id for both layers, so they expire together and a caller can't
  // straddle two windows to double their allowance.
  const window = Math.floor(Date.now() / 1000 / windowSeconds);
  const ip = await clientIp();

  const [ipCount, globalCount] = await Promise.all([
    bump(`rl:${bucket}:ip:${ip}:${window}`, windowSeconds),
    bump(`rl:${bucket}:all:${window}`, windowSeconds),
  ]);

  // Seconds left in the current window — an honest Retry-After.
  const retryAfter = windowSeconds - (Math.floor(Date.now() / 1000) % windowSeconds);

  if (ipCount !== null && ipCount > perIp) return { ok: false, retryAfter, scope: 'ip' };
  if (globalCount !== null && globalCount > globalLimit) {
    return { ok: false, retryAfter, scope: 'global' };
  }
  return ALLOWED;
}

/** Convenience wrapper for the Riot-backed read routes. */
export function limitRiotRead(bucket: string): Promise<RateLimitVerdict> {
  return rateLimit(bucket, LIMITS.riotRead);
}
