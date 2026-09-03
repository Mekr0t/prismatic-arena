// Crawl scope + hard caps. Every value is env-overridable so widening coverage
// is a config change, not a code change. The defaults are deliberately tiny —
// enough to validate the full ladder→matches path on the dev key without
// burning the budget. Used by the 2b ladder-crawl / match-fetch workers.

function numEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

// Platforms to seed from, in order. CRAWL_PLATFORMS (comma-separated) wins;
// CRAWL_PLATFORM stays supported as the single-platform form it always was.
//
// WHY MORE THAN ONE. The constraint on apex sample is not the API budget, it is
// how many apex accounts exist to drain. Measured 2026-09-02, EUW alone holds
// 146 Master entries; the crawl bursts through them in a couple of passes and
// then idles until the re-crawl window lapses. Adding the rest of EMEA (eun1 21,
// tr1 18, ru 5, me1 0) takes the pool to ~190 — a 30 % widening, not a
// multiplier, and worth knowing which it is.
//
// IT DOES NOT RAISE THE CEILING. Every European platform routes to the SAME
// `europe` host for TFT-MATCH-V1, and the rate limiter keys on that route, so
// match fetches across EUW, EUNE, TR, RU and ME share one budget. What does
// scale is TFT-LEAGUE-V1, which is per-platform — so the rank gate's lookups no
// longer queue behind each other.
function platformList(): string[] {
  const many = process.env.CRAWL_PLATFORMS;
  if (many) {
    const parsed = many.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);
    if (parsed.length > 0) return parsed;
  }
  return [process.env.CRAWL_PLATFORM ?? 'euw1'];
}

export const CRAWL = {
  // First configured platform. Kept because several callers want "the" platform
  // for a single-shot run; the crawl itself iterates `platforms`.
  platform: platformList()[0],
  /** Every platform the crawl seeds from. Regional routes are derived per platform. */
  platforms: platformList(),
  // Apex tiers to seed from. Widen to e.g. 'challenger,grandmaster,master',
  // then ladder tiers, as the production key allows.
  tiers: (process.env.CRAWL_TIERS ?? 'challenger')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean),
  // How many ladder entries (PUUIDs) to enqueue per run.
  maxPuuidsPerRun: numEnv('CRAWL_MAX_PUUIDS', 25),
  // Recent match IDs to pull per PUUID. Keep maxPuuidsPerRun × matchIdsPerPuuid
  // ≤ maxMatchFetchesPerPass so every enqueued PUUID gets crawled before the
  // ceiling binds (default 25 × 4 = 100). More PUUIDs × fewer matches each gives
  // better comp diversity than the reverse.
  matchIdsPerPuuid: numEnv('CRAWL_MATCH_IDS_PER_PUUID', 4),
  // Hard ceiling on match IDs enqueued per pass (the running fetch budget); the
  // ladder crawl stops adding PUUID batches once this is hit. Actual Riot calls
  // land below it, since the existence-check skips matches already stored.
  maxMatchFetchesPerPass: numEnv('CRAWL_MAX_MATCH_FETCHES', 100),
  // Tier lookups spent per pass on candidates whose tier is UNKNOWN.
  //
  // Uncapped, this is where the budget goes. The frontier snowballs from match
  // participants, so it is ~360 k accounts of which a few hundred are apex; with
  // an apex-only scope the drain worked through unknown-tier candidates one
  // league.byPuuid at a time and discarded nearly all of them — measured
  // 2026-09-02 at 70 league calls/min against 63 match calls/min, i.e. HALF the
  // key's budget spent proving that low-elo accounts are low-elo. Apex players
  // are discovered from the apex ladder in step 1 for free, so exploration only
  // needs to be a trickle, not the whole pass.
  exploreUnknownPerPass: numEnv('CRAWL_EXPLORE_UNKNOWN', 25),
  // A tier already resolved OUT of scope is re-checked this rarely. A Gold
  // player does not reach Master inside the ordinary tier TTL, and re-resolving
  // them is the same wasted call as above.
  outOfScopeTtlHours: numEnv('CRAWL_OUT_OF_SCOPE_TTL_HOURS', 720),
  // Attempts per match-fetch job, and the base delay of its exponential backoff.
  // match-fetch throws only when EVERY id in the batch failed — an outage or a
  // dead key, never a bad batch — and its comment has always said "throw so
  // BullMQ retries", but no attempts option was ever set, so it never did: one
  // transport blip permanently failed the job. Measured 2026-09-02: 190 of 200
  // sampled failed jobs were apex batches, the ones that matter most.
  matchFetchAttempts: numEnv('CRAWL_MATCH_FETCH_ATTEMPTS', 3),
  matchFetchBackoffMs: numEnv('CRAWL_MATCH_FETCH_BACKOFF_MS', 60_000),
} as const;