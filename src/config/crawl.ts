// Crawl scope + hard caps. Every value is env-overridable so widening coverage
// is a config change, not a code change. The defaults are deliberately tiny —
// enough to validate the full ladder→matches path on the dev key without
// burning the budget. Used by the 2b ladder-crawl / match-fetch workers.

function numEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export const CRAWL = {
  // Seed platform (regional route is derived from it).
  platform: process.env.CRAWL_PLATFORM ?? 'euw1',
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
} as const;