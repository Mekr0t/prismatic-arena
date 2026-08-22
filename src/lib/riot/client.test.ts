import test from 'node:test';
import assert from 'node:assert/strict';
import type { RegionalRoute } from '@/config/regions';

// The Riot client is what stands between an upstream problem and a broken page,
// and this session alone saw it produce a 503 (transport timeout) and a 429
// (budget contention). These pin the retry / backoff / cache contract.
//
// Two neutralisations happen BEFORE the client loads, which is why the imports
// below are dynamic: `@/lib/db` and `@/lib/redis` build a pg Pool and an ioredis
// client at module scope from these variables. Pointing them at a closed port
// keeps the suite off a real database (the telemetry write is fire-and-forget
// and swallows its own failure) and lets it run in CI, where neither exists.
process.env.DATABASE_URL = 'postgres://u:p@127.0.0.1:1/none';
process.env.REDIS_URL = 'redis://127.0.0.1:1';
process.env.RIOT_API_KEY = 'RGAPI-test-0000-0000-0000-000000000000';

const { riot, RiotApiError } = await import('./index');
const { redis } = await import('@/lib/redis');

// `RiotApiError` arrives as a VALUE binding from the dynamic import above, so
// it cannot be used as a type directly.
type RiotErr = InstanceType<typeof RiotApiError>;

// Redis IS awaited on the read path, so a dead client would hang every cached
// endpoint — which is all of them. Stub the two methods the client uses, then
// stop the reconnect loop so the process can exit.
let cacheStore: string | null = null;
let lastSet: { key: string; ttl: number } | null = null;
(redis as unknown as { get: (k: string) => Promise<string | null> }).get = async () => cacheStore;
(redis as unknown as { set: (k: string, v: string, m: string, t: number) => Promise<string> }).set =
  async (key, _v, _m, ttl) => {
    lastSet = { key, ttl };
    return 'OK';
  };
redis.disconnect();

// ── fetch + timer harness ────────────────────────────────────────────────────

type Step = () => Response; // may throw, to simulate a transport failure
const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;

interface Harness {
  calls: { url: string; token: string | undefined }[];
  delays: number[];
  /** This test's private rate-limit bucket — see `harness`. */
  route: RegionalRoute;
}

// EVERY TEST GETS ITS OWN RATE-LIMIT BUCKET, and this is load-bearing rather
// than tidiness. The client keys one SlidingWindowQueue per regionKey, and for
// match.byId the regionKey IS the route argument. Sharing 'europe' across the
// file meant that once ~20 calls had accumulated, the limiter began sleeping
// between requests — and because the harness patches the GLOBAL setTimeout, those
// waits landed in `delays` alongside the client's retry backoff. Two writers,
// one channel: locally the limiter never bound and the suite was green; on a
// slower CI runner it did, and `delays` came back [7,7,6,5,3,2,1] for a request
// that never retried at all.
//
// A unique route gives each test a fresh 20/s budget it cannot exhaust in four
// calls, so `delays` has exactly one writer and the backoff assertions can stay
// exact. regionalHost() only interpolates, and fetch is stubbed, so the host
// these produce is never dialled.
let bucket = 0;

/** Serve `steps` in order (the last one repeats), and record backoff delays. */
function harness(steps: Step[], route?: RegionalRoute): Harness {
  const h: Harness = { calls: [], delays: [], route: route ?? (`t${(bucket += 1)}` as RegionalRoute) };
  let i = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    h.calls.push({ url: String(input), token: headers['X-Riot-Token'] });
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    return step();
  }) as typeof fetch;
  // Collapse backoff to ~0 so a full retry path costs milliseconds, but RECORD
  // the delay the client asked for — that is the part worth asserting.
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    if (typeof ms === 'number' && ms > 0) h.delays.push(ms);
    return realSetTimeout(fn, 1);
  }) as unknown as typeof setTimeout;
  return h;
}

function restore(): void {
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realSetTimeout;
  cacheStore = null;
  lastSet = null;
}

const json = (code: number, body: unknown, headers: Record<string, string> = {}): Step =>
  () => new Response(JSON.stringify(body), { status: code, headers });
const status = (code: number, headers: Record<string, string> = {}): Step =>
  () => new Response('', { status: code, headers });
const transportFail = (code: string): Step =>
  () => {
    // undici's shape: a bare TypeError with the real reason on .cause
    const e = new TypeError('fetch failed');
    (e as Error & { cause?: unknown }).cause = { code };
    throw e;
  };

const MATCH = 'EUW1_1234567890';

// ── the happy path ───────────────────────────────────────────────────────────

test('a 200 returns the parsed body, authenticated, at the regional host', async () => {
  // Pinned to a real route: this is the one test that asserts the host.
  const h = harness([json(200, { metadata: { match_id: MATCH } })], 'europe');
  try {
    const out = await riot.match.byId(h.route, MATCH);
    assert.equal((out as { metadata: { match_id: string } }).metadata.match_id, MATCH);
    assert.equal(h.calls.length, 1);
    assert.match(h.calls[0].url, /^https:\/\/europe\.api\.riotgames\.com\/tft\/match\/v1\/matches\//);
    assert.ok(h.calls[0].url.endsWith(MATCH), `unexpected url ${h.calls[0].url}`);
    assert.equal(h.calls[0].token, process.env.RIOT_API_KEY, 'the key must ride on every call');
  } finally {
    restore();
  }
});

test('404 is a normal answer (unknown id / no matches), not an error', async () => {
  const h = harness([status(404)]);
  try {
    assert.equal(await riot.match.byId(h.route, MATCH), null);
    assert.equal(h.calls.length, 1, 'a 404 must not be retried');
  } finally {
    restore();
  }
});

// ── retry: rate limiting ─────────────────────────────────────────────────────

test('a 429 is retried and the call recovers', async () => {
  const h = harness([status(429), status(429), json(200, { ok: true })]);
  try {
    assert.deepEqual(await riot.match.byId(h.route, MATCH), { ok: true });
    assert.equal(h.calls.length, 3);
  } finally {
    restore();
  }
});

test('a persistent 429 throws RiotApiError(429) after the retry budget', async () => {
  const h = harness([status(429)]);
  try {
    await assert.rejects(
      () => riot.match.byId(h.route, MATCH),
      (e: unknown) => {
        assert.ok(e instanceof RiotApiError);
        assert.equal((e as RiotErr).status, 429);
        assert.match((e as Error).message, /429 after 3 retries/);
        return true;
      },
    );
    assert.equal(h.calls.length, 4, 'one initial attempt + 3 retries');
  } finally {
    restore();
  }
});

test('Retry-After wins over the exponential backoff', async () => {
  const h = harness([status(429, { 'Retry-After': '7' }), json(200, { ok: true })]);
  try {
    await riot.match.byId(h.route, MATCH);
    assert.ok(h.delays.includes(7000), `expected a 7s wait, saw ${h.delays.join(',')}`);
  } finally {
    restore();
  }
});

test('without Retry-After the backoff grows exponentially', async () => {
  const h = harness([status(429)]);
  try {
    await assert.rejects(() => riot.match.byId(h.route, MATCH));
    assert.deepEqual(h.delays, [1000, 2000, 4000]);
  } finally {
    restore();
  }
});

// ── retry: server + transport ────────────────────────────────────────────────

test('a 5xx is retried and recovers', async () => {
  const h = harness([status(503), json(200, { ok: true })]);
  try {
    assert.deepEqual(await riot.match.byId(h.route, MATCH), { ok: true });
    assert.equal(h.calls.length, 2);
  } finally {
    restore();
  }
});

test('a transport failure is retried, not escaped', async () => {
  const h = harness([transportFail('ECONNRESET'), json(200, { ok: true })]);
  try {
    assert.deepEqual(await riot.match.byId(h.route, MATCH), { ok: true });
    assert.equal(h.calls.length, 2);
  } finally {
    restore();
  }
});

test('a persistent transport failure surfaces the CAUSE, not "fetch failed"', async () => {
  const h = harness([transportFail('UND_ERR_CONNECT_TIMEOUT')]);
  try {
    await assert.rejects(
      () => riot.match.byId(h.route, MATCH),
      (e: unknown) => {
        assert.ok(e instanceof RiotApiError);
        assert.equal((e as RiotErr).status, 503);
        // The whole point of that fix: the log names the reason, not the
        // generic string undici throws.
        assert.match((e as Error).message, /UND_ERR_CONNECT_TIMEOUT/);
        assert.match((e as Error).message, /unreachable after 3 retries/);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test('a non-retryable 4xx fails immediately', async () => {
  const h = harness([status(403)]);
  try {
    await assert.rejects(() => riot.match.byId(h.route, MATCH), RiotApiError);
    assert.equal(h.calls.length, 1, '403 must not burn the retry budget');
    assert.deepEqual(h.delays, [], 'and must not sleep');
  } finally {
    restore();
  }
});

// ── cache ────────────────────────────────────────────────────────────────────

test('a cache hit short-circuits the network entirely', async () => {
  const h = harness([json(200, { from: 'network' })]);
  cacheStore = JSON.stringify({ from: 'cache' });
  try {
    assert.deepEqual(await riot.match.byId(h.route, MATCH), { from: 'cache' });
    assert.equal(h.calls.length, 0, 'a cached value must not spend a Riot call');
  } finally {
    restore();
  }
});

test('a successful response is cached under the endpoint TTL', async () => {
  const h = harness([json(200, { ok: true })]);
  try {
    await riot.match.byId(h.route, MATCH);
    assert.ok(lastSet, 'expected a cache write');
    assert.equal(lastSet!.ttl, 60 * 60 * 24 * 30, 'match detail is immutable — 30 days');
    assert.equal(
      lastSet!.key,
      `riot:cache:https://${h.route}.api.riotgames.com/tft/match/v1/matches/${MATCH}`,
      'the cache key is the full request URL, so two regions never collide',
    );
  } finally {
    restore();
  }
});

test('an error response is NOT cached', async () => {
  const h = harness([status(500)]);
  try {
    await assert.rejects(() => riot.match.byId(h.route, MATCH));
    assert.equal(lastSet, null, 'a failure must never poison the cache');
  } finally {
    restore();
  }
});

// ── input guards (the SSRF fix) ──────────────────────────────────────────────

// NOTE THE SHAPE: this throws SYNCHRONOUSLY, not as a rejected promise, because
// the segment guard runs while building the path — before request() is ever
// called. Safe as written: every call site is inside an async function, which
// converts the throw into a rejection anyway, and the route handlers validate
// the id at the boundary first. But `riot.match.byId(bad).catch(h)` from a
// non-async context would NOT catch it, so the shape is pinned here rather than
// left to be rediscovered.
test('a malformed id throws before any request is made', () => {
  const h = harness([json(200, { ok: true })]);
  try {
    for (const bad of ['../../riot/account/v1', 'EUW1_1?x=1', 'EUW1_1&x=1', '', 'a'.repeat(200)]) {
      assert.throws(
        () => riot.match.byId(h.route, bad),
        (e: unknown) => {
          assert.ok(e instanceof RiotApiError, `expected RiotApiError for ${JSON.stringify(bad)}`);
          assert.equal((e as RiotErr).status, 400);
          return true;
        },
      );
    }
    assert.equal(h.calls.length, 0, 'the key must never be spent on a malformed id');
  } finally {
    restore();
  }
});

// ── configuration ────────────────────────────────────────────────────────────

test('a missing API key fails before the network, not at Riot', async () => {
  const saved = process.env.RIOT_API_KEY;
  delete process.env.RIOT_API_KEY;
  const h = harness([json(200, { ok: true })]);
  try {
    await assert.rejects(
      () => riot.match.byId(h.route, MATCH),
      (e: unknown) => {
        assert.ok(e instanceof RiotApiError);
        assert.equal((e as RiotErr).status, 500);
        return true;
      },
    );
    assert.equal(h.calls.length, 0);
  } finally {
    process.env.RIOT_API_KEY = saved;
    restore();
  }
});
