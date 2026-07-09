import { riot, Priority, routeForPlatform } from '@/lib/riot';
import type { Platform } from '@/config/regions';
import { getCatalog } from './static-data';
import { buildBoard, bucketOf, type MatchDetailVM, type LobbyParticipantVM } from './view-models';
import { resolveAccounts } from './accounts';

export async function getMatchDetail(platform: Platform, matchId: string): Promise<MatchDetailVM | null> {
  const route = routeForPlatform(platform);
  const match = await riot.match.byId(route, matchId, Priority.USER);
  if (!match) return null;

  const catalog = await getCatalog();

  // Resolve all 8 Riot IDs through the shared accounts-first resolver: one DB
  // read, Riot only for unseen puuids, each hit persisted for next time.
  const names = await resolveAccounts(
    match.info.participants.map((p) => p.puuid),
    route,
    Priority.USER,
  );
  const nameFor = (puuid: string): { name: string; tagLine: string } => {
    const r = names.get(puuid);
    return r?.gameName
      ? { name: r.gameName, tagLine: r.tagLine ?? '' }
      : { name: `${puuid.slice(0, 6)}…`, tagLine: '' };
  };

  const participants: LobbyParticipantVM[] = match.info.participants
    .map((p) => {
      const id = nameFor(p.puuid);
      return {
        puuid: p.puuid,
        name: id.name,
        tagLine: id.tagLine,
        placement: p.placement,
        bucket: bucketOf(p.placement),
        level: p.level,
        board: buildBoard(
          p.units.map((u) => ({ characterId: u.character_id, star: u.tier, items: u.itemNames ?? [] })),
          p.traits.map((t) => ({ traitId: t.name, numUnits: t.num_units, style: t.style })),
          catalog,
        ),
      };
    })
    .sort((a, b) => a.placement - b.placement);

  return {
    matchId,
    playedAt: match.info.game_datetime,
    gameLengthSeconds: Math.round(match.info.game_length),
    setNumber: match.info.tft_set_number,
    queueId: match.info.queue_id,
    participants,
  };
}