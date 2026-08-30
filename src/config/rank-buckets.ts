// Rank-bucket dimension for derived stats. Defined once as a code constant (per
// the roadmap) and stored as a label downstream; boundaries are tunable here
// without a migration.
//
// A board is bucketed by the TIER OF THE PLAYER THE CRAWL DRAINED to reach that
// match, resolved with one league.byPuuid call at drain time (ladder-crawl) and
// cached on `accounts.tier`. TFT matchmaking is rank-homogeneous, so the seed
// player's tier is a sound label for the whole lobby — per-participant rank
// would cost eight league calls per match.
//
// 'unknown' is a real, honest value, not a placeholder: it is what a board gets
// when the crawl could not establish a tier. It must never be silently folded
// into a named bucket — the previous behaviour, where every board defaulted to
// 'challenger', is precisely what made the rank dimension fiction.

// 'apex_mixed' is a LEGACY-ONLY label: the pre-R1 population that was collected
// from apex-seeded lobbies but never rank-verified (migration 0018). Nothing
// writes it any more — `bucketForTier` can never return it — but it stays in the
// union because those boards are still real data the tier list can select.
export type RankBucket =
  | 'iron_gold'
  | 'plat_emerald'
  | 'diamond'
  | 'master_plus'
  | 'challenger'
  | 'apex_mixed'
  | 'unknown'
  | 'all';

/** Maps a Riot tier name to its bucket label. Unrecognised or missing → 'unknown'. */
export function bucketForTier(tier: string | null | undefined): RankBucket {
  if (!tier) return 'unknown';
  switch (tier.toUpperCase()) {
    case 'CHALLENGER':
      return 'challenger';
    case 'GRANDMASTER':
    case 'MASTER':
      return 'master_plus';
    case 'DIAMOND':
      return 'diamond';
    case 'EMERALD':
    case 'PLATINUM':
      return 'plat_emerald';
    case 'GOLD':
    case 'SILVER':
    case 'BRONZE':
    case 'IRON':
      return 'iron_gold';
    default:
      return 'unknown';
  }
}

/** Human-readable bucket names for the UI. Naive capitalisation of the raw
 *  value rendered these as "Master_plus" and "Apex_mixed"; the label is also the
 *  only place a user learns what `apex_mixed` actually means, so it says so. */
const BUCKET_LABELS: Record<string, string> = {
  challenger: 'Challenger',
  master_plus: 'Master+',
  apex_mixed: 'Apex (mixed)',
  diamond: 'Diamond',
  plat_emerald: 'Platinum / Emerald',
  iron_gold: 'Iron – Gold',
  unknown: 'Unranked sample',
  all: 'All ranks',
};

/** Display name for a rank bucket; unknown values fall back to capitalisation. */
export function bucketLabel(bucket: string): string {
  return BUCKET_LABELS[bucket] ?? bucket.charAt(0).toUpperCase() + bucket.slice(1);
}

/**
 * True when a tier is inside the configured crawl scope. Compared on the Riot
 * tier name so `CRAWL_TIERS` stays human-readable ('challenger,grandmaster').
 *
 * Two scope tokens exist beyond the tier names, and they are what make a crawl
 * possible AT THE START OF A SET:
 *
 *   'all'       — no gate. Every candidate is crawled and bucketed by whatever
 *                 tier resolves.
 *   'unranked'  — a candidate with NO resolved tier is in scope. Their boards
 *                 bucket as 'unknown', which is an honest label rather than a
 *                 placeholder (see the header of this file).
 *
 * WHY THIS IS NEEDED. On set-18 launch day all three EUW apex ladders returned
 * ZERO entries — the ranked ladder resets, so for the first days of a set there
 * is no Master+ population to seed from or gate on, and almost every player is
 * unranked until placements finish. An apex-only scope therefore crawls nothing
 * at exactly the moment the meta is forming and the data is most wanted. Widen
 * the scope for that window, then narrow it again once the ladder fills — the
 * 'unknown' boards stay selectable as their own bucket either way, so nothing
 * collected during the window contaminates a rank-verified one.
 */
export function tierInScope(tier: string | null | undefined, scope: readonly string[]): boolean {
  if (scope.some((s) => s.toLowerCase() === 'all')) return true;
  if (!tier) return scope.some((s) => s.toLowerCase() === 'unranked');
  const t = tier.toUpperCase();
  return scope.some((s) => s.toUpperCase() === t);
}
