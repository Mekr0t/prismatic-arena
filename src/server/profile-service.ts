import { riot, Priority, routeForPlatform } from '@/lib/riot';
import type { MatchDto } from '@/lib/riot/types';
import type { Platform } from '@/config/regions';
import { query } from '@/lib/db';
import { persistMatch } from './match-persist';

const RANKED_TFT = 'RANKED_TFT';
const RECENT_MATCH_COUNT = 20;

export interface ProfileMatch {
  matchId: string;
  queueId: number;
  placement: number;
  level: number;
  lastRound: number;
  goldLeft: number;
  traits: { name: string; numUnits: number; style: number }[];
  units: { characterId: string; star: number; items: string[] }[];
  augments: string[];
}

export interface PlayerProfile {
  puuid: string;
  gameName: string;
  tagLine: string;
  platform: Platform;
  profileIconId: number | null;
  summonerLevel: number | null;
  rank: {
    tier: string;
    division: string;
    lp: number;
    wins: number;
    losses: number;
  } | null;
  recentMatches: ProfileMatch[];
}

export class ProfileNotFoundError extends Error {}

export async function getPlayerProfile(
  platform: Platform,
  gameName: string,
  tagLine: string,
): Promise<PlayerProfile> {
  const route = routeForPlatform(platform);

  // 1. Riot ID -> account (puuid)
  const account = await riot.account.byRiotId(route, gameName, tagLine, Priority.USER);
  if (!account) throw new ProfileNotFoundError(`No account for ${gameName}#${tagLine}`);
  const { puuid } = account;

  // 2. summoner (icon + level), league entries, and match IDs all only need
  // the puuid — fire all three in parallel.
  const [summoner, leagueEntries, matchIds] = await Promise.all([
    riot.summoner.byPuuid(platform, puuid, Priority.USER),
    riot.league.byPuuid(platform, puuid, Priority.USER),
    riot.match.idsByPuuid(route, puuid, { count: RECENT_MATCH_COUNT }, Priority.USER),
  ]);

  const ranked = leagueEntries.find((e) => e.queueType === RANKED_TFT) ?? null;

  // 3. fetch the recent matches (cached aggressively after first view).
  const matches = await Promise.all(
    matchIds.map((id) => riot.match.byId(route, id, Priority.USER)),
  );

  // Write-through persistence. Best-effort: a DB hiccup should not blank the
  // profile. In Phase 3 this heavy write path moves to the ingest workers so
  // the read path stops doing bulk inserts.
  await persistIdentity(platform, route, gameName, tagLine, puuid, summoner, ranked);
  const persisted = await Promise.allSettled(
    matches.filter((m): m is MatchDto => m !== null).map(persistMatch),
  );
  for (const r of persisted) {
    if (r.status === 'rejected') console.error('persistMatch failed:', r.reason);
  }

  // Build the response from this player's board in each match.
  const recentMatches: ProfileMatch[] = [];
  for (const m of matches) {
    if (!m) continue;
    const me = m.info.participants.find((p) => p.puuid === puuid);
    if (!me) continue;
    recentMatches.push({
      matchId: m.metadata.match_id,
      queueId: m.info.queue_id,
      placement: me.placement,
      level: me.level,
      lastRound: me.last_round,
      goldLeft: me.gold_left,
      traits: me.traits
        .filter((t) => t.style > 0)
        .map((t) => ({
          name: t.name,
          numUnits: t.num_units,
          // Normalize style: unique traits (1 tier) → prismatic (4), others → tier position 1-4.
          style: t.tier_total === 1 ? 4 : Math.min(t.tier_current, 4),
        })),
      units: me.units.map((u) => ({
        characterId: u.character_id,
        star: u.tier,
        items: u.itemNames,
      })),
      augments: me.augments ?? [],
    });
  }
  

  return {
    puuid,
    gameName: account.gameName,
    tagLine: account.tagLine,
    platform,
    profileIconId: summoner?.profileIconId ?? null,
    summonerLevel: summoner?.summonerLevel ?? null,
    rank: ranked
      ? {
          tier: ranked.tier,
          division: ranked.rank,
          lp: ranked.leaguePoints,
          wins: ranked.wins,
          losses: ranked.losses,
        }
      : null,
    recentMatches,
  };
}

async function persistIdentity(
  platform: Platform,
  route: string,
  gameName: string,
  tagLine: string,
  puuid: string,
  summoner: { id?: string; profileIconId: number; summonerLevel: number } | null,
  ranked: {
    queueType: string;
    tier: string;
    rank: string;
    leaguePoints: number;
    wins: number;
    losses: number;
  } | null,
): Promise<void> {
  await query(
    `INSERT INTO accounts (puuid, game_name, tag_line, routing, last_synced_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (puuid) DO UPDATE
       SET game_name = $2, tag_line = $3, routing = $4, last_synced_at = now()`,
    [puuid, gameName, tagLine, route],
  );

  if (summoner) {
    await query(
      `INSERT INTO summoners
         (puuid, platform, summoner_id, profile_icon_id, summoner_level, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (puuid, platform) DO UPDATE
         SET summoner_id = $3, profile_icon_id = $4,
             summoner_level = $5, updated_at = now()`,
      [puuid, platform, summoner.id ?? null, summoner.profileIconId, summoner.summonerLevel],
    );
  }

  if (ranked) {
    // Only snapshot when something actually changed — keeps the series clean for LP graphs.
    const latest = await query<{ tier: string; division: string; league_points: number }>(
      `SELECT tier, division, league_points FROM league_entries
       WHERE puuid = $1 AND platform = $2 AND queue = $3
       ORDER BY snapshot_at DESC LIMIT 1`,
      [puuid, platform, ranked.queueType],
    );
    const last = latest[0];
    const changed =
      !last ||
      last.tier !== ranked.tier ||
      last.division !== ranked.rank ||
      last.league_points !== ranked.leaguePoints;
    if (changed) {
      await query(
        `INSERT INTO league_entries
           (puuid, platform, queue, tier, division, league_points, wins, losses)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [puuid, platform, ranked.queueType, ranked.tier, ranked.rank, ranked.leaguePoints, ranked.wins, ranked.losses],
      );
    }
  }
}