import { riot, Priority, routeForPlatform } from '@/lib/riot';
import type { Platform } from '@/config/regions';
import type { LeaderboardTier, LeaderboardVM, LeaderboardRowVM } from './view-models';
import { resolveAccounts } from './accounts';

export const LEADERBOARD_TIERS: LeaderboardTier[] = ['challenger', 'grandmaster', 'master'];

export const TIER_LABELS: Record<LeaderboardTier, string> = {
  challenger: 'Challenger',
  grandmaster: 'Grandmaster',
  master: 'Master',
};

export function isLeaderboardTier(value: string): value is LeaderboardTier {
  return (LEADERBOARD_TIERS as string[]).includes(value);
}

/**
 * One apex (challenger/grandmaster/master) ladder, sorted by LP and paginated.
 *
 * The ladder itself is a single Riot call (cached ~30m by the client). Display
 * names for the visible page resolve through the shared accounts-first resolver:
 * one DB read for the whole page, Riot only for puuids we've never seen, and
 * each hit persisted so repeat loads (and the M4 crawler) find them locally.
 * Apex entries usually carry `puuid`; the rare ones that don't get a single
 * Summoner-V1 lookup to recover it.
 */
export async function getLeaderboard(
  platform: Platform,
  tier: LeaderboardTier,
  page: number,
  pageSize: number,
): Promise<LeaderboardVM> {
  const route = routeForPlatform(platform);
  const list = await riot.league.apex(platform, tier, Priority.USER);

  const entries = (list?.entries ?? [])
    .slice()
    .sort((a, b) => b.leaguePoints - a.leaguePoints);

  const total = entries.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const clampedPage = Math.min(Math.max(1, page), totalPages);
  const start = (clampedPage - 1) * pageSize;
  const slice = entries.slice(start, start + pageSize);

  // A puuid per entry. Most apex entries carry one; for the rare ones that
  // don't, recover it with a single Summoner-V1 lookup by summonerId.
  const puuids = await Promise.all(
    slice.map(async (e) => {
      if (e.puuid) return e.puuid;
      try {
        const s = await riot.summoner.byId(platform, e.summonerId, Priority.USER);
        return s?.puuid ?? null;
      } catch (err) {
        console.warn(`leaderboard: summoner lookup failed for ${e.summonerId}:`, err);
        return null;
      }
    }),
  );

  // One accounts-first batch resolves every name on the page.
  const names = await resolveAccounts(
    puuids.filter((p): p is string => p !== null),
    route,
    Priority.USER,
  );

  const rows: LeaderboardRowVM[] = slice.map((e, i): LeaderboardRowVM => {
    const games = e.wins + e.losses;
    const puuid = puuids[i] ?? null;
    const resolved = puuid ? names.get(puuid) : undefined;

    let name = resolved?.gameName ?? '';
    let tagLine = resolved?.tagLine ?? '';
    if (!name) {
      name = `${(e.puuid ?? e.summonerId).slice(0, 6)}…`;
      tagLine = '';
    }

    return {
      rank: start + i + 1,
      puuid: e.puuid ?? puuid ?? '',
      name,
      tagLine,
      leaguePoints: e.leaguePoints,
      wins: e.wins,
      losses: e.losses,
      winRate: games > 0 ? e.wins / games : -1,
    };
  });

  return {
    platform,
    tier,
    tierLabel: TIER_LABELS[tier],
    page: clampedPage,
    pageSize,
    total,
    totalPages,
    rows,
  };
}