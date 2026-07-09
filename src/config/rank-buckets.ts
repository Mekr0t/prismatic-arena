// Rank-bucket dimension for derived stats. Defined once as a code constant (per
// the roadmap) and stored as a label downstream; boundaries are tunable here
// without a migration. Boards are bucketed by the ladder tier they were crawled
// from — a Challenger-ladder crawl tags everything 'challenger'. Per-board rank
// isn't in match data, so this is the standard "bucket = the ladder we mined"
// convention; true per-board rank would cost a league lookup per player.

export type RankBucket =
  | 'iron_gold'
  | 'plat_emerald'
  | 'diamond'
  | 'master_plus'
  | 'challenger'
  | 'all';

/** Maps a Riot tier name to its bucket label. */
export function bucketForTier(tier: string): RankBucket {
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
      return 'all';
  }
}
