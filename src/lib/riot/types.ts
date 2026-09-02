// Subset of Riot's TFT response shapes used in Phase 1.
// Field names match the API exactly (snake_case where Riot uses it).

export interface AccountDto {
  puuid: string;
  gameName: string;
  tagLine: string;
}

export interface SummonerDto {
  id?: string; // deprecated by Riot; may be absent from /by-puuid responses
  puuid: string;
  profileIconId: number;
  summonerLevel: number;
  revisionDate: number;
}

export interface LeagueEntryDto {
  puuid?: string;
  summonerId: string;
  queueType: string; // 'RANKED_TFT'
  tier: string; // 'DIAMOND'
  rank: string; // 'I' | 'II' | 'III' | 'IV'
  leaguePoints: number;
  wins: number; // in TFT this counts 1st-place finishes
  losses: number;
  hotStreak?: boolean;
}

export interface LeagueItemDto {
  summonerId: string;
  puuid?: string;
  leaguePoints: number;
  rank: string;
  wins: number;
  losses: number;
}

export interface LeagueListDto {
  tier: string;
  queue: string;
  name: string;
  entries: LeagueItemDto[];
}

export interface MatchUnitDto {
  character_id: string;
  itemNames: string[];
  rarity: number;
  tier: number; // star level: 1, 2, 3
}

export interface MatchTraitDto {
  name: string;
  num_units: number;
  style: number; // 0 inactive, 1 bronze, 2 silver, 3 gold, 4 prismatic/chromatic
  tier_current: number;
  tier_total: number;
}

export interface MatchParticipantDto {
  puuid: string;
  placement: number; // 1..8
  level: number;
  last_round: number;
  players_eliminated: number;
  total_damage_to_players: number;
  gold_left: number;
  time_eliminated: number;
  augments?: string[];
  traits: MatchTraitDto[];
  units: MatchUnitDto[];
  companion?: { content_ID: string; skin_ID: number; species: string };
}

export interface MatchDto {
  metadata: {
    match_id: string;
    data_version: string;
    participants: string[]; // puuids
  };
  info: {
    game_datetime: number; // epoch ms
    game_length: number;
    game_version: string;
    queue_id: number;
    tft_set_number: number;
    tft_game_type?: string;
    participants: MatchParticipantDto[];
  };
}

/**
 * True when an HTTP status describes OUR side or the upstream's, never the
 * request itself: 0 is a transport failure, 401/403 an expired or revoked key,
 * 429 the rate limiter, 5xx the upstream. A caller can retry these and can
 * treat them as saying nothing about the resource it asked for.
 *
 * The distinction is load-bearing in the crawl: a batch that failed for one of
 * these reasons is still wanted, while a 400 (malformed id) or 404 will fail
 * identically forever and retrying it only re-spends the key's budget.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 0 || status === 401 || status === 403 || status === 429 || status >= 500;
}
