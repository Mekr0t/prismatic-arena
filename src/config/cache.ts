// Cache TTLs in seconds. These mirror how volatile each piece of data is:
// identity barely changes, rank changes between games, match detail never changes.
export const CACHE_TTL = {
  account: 60 * 60 * 24,            // 24h — Riot ID <-> puuid identity
  summoner: 60 * 60 * 6,           // 6h  — level / icon / summonerId
  league: 60 * 10,                 // 10m — rank / LP move every game
  matchIds: 60 * 5,                // 5m  — recent match list
  matchDetail: 60 * 60 * 24 * 30,  // 30d — a finished match is immutable
  apexLeague: 60 * 30,             // 30m — ladder snapshots
} as const;
