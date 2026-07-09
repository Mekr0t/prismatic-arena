import type { PlayerProfile } from '@/server/profile-service';

// ── view-model types ────────────────────────────────────────────────────────
export interface ItemVM {
  itemId: string;
  name: string;
  iconUrl: string | null;
}
export interface UnitVM {
  characterId: string;
  name: string;
  cost: number;
  star: number;
  items: ItemVM[];
  iconUrl: string | null;
  isCarry: boolean;
}
export interface TraitVM {
  traitId: string;
  name: string;
  numUnits: number;
  style: number; // 1 bronze, 2 silver, 3 gold, 4 prismatic
  unique: boolean; // single-breakpoint trait (no bronze/silver/gold/prismatic scaling)
  iconUrl: string | null;
}
export interface BoardVM {
  units: UnitVM[];
  traits: TraitVM[];
}
export type Bucket = 'first' | 'top4' | 'bottom';

export interface MatchSummaryVM {
  matchId: string;
  queueId: number;
  placement: number;
  bucket: Bucket;
  level: number;
  lastRound: number;
  goldLeft: number;
  board: BoardVM;
}
export interface ProfileVM {
  puuid: string;
  gameName: string;
  tagLine: string;
  platform: string;
  initial: string;
  profileIconId: number | null;
  summonerLevel: number | null;
  rank: { tier: string; division: string; lp: number; wins: number; losses: number } | null;
  summary: { games: number; avgPlacement: number; top4Rate: number; firstRate: number };
  matches: MatchSummaryVM[];
}
export interface LobbyParticipantVM {
  puuid: string;
  name: string;
  tagLine: string;
  placement: number;
  bucket: Bucket;
  level: number;
  board: BoardVM;
}
export interface MatchDetailVM {
  matchId: string;
  playedAt: number;          // epoch ms (game_datetime)
  gameLengthSeconds: number;
  setNumber: number;
  queueId: number;
  participants: LobbyParticipantVM[];
}

// ── leaderboard ────────────────────────────────────────────────────────────
export type LeaderboardTier = 'challenger' | 'grandmaster' | 'master';

export interface LeaderboardRowVM {
  rank: number;        // ladder position (1-based, by LP desc)
  puuid: string;
  name: string;        // gameName
  tagLine: string;
  leaguePoints: number;
  wins: number;        // TFT: 1st-place finishes
  losses: number;
  winRate: number;     // 0..1, or -1 when no games are recorded
}

export interface LeaderboardVM {
  platform: string;
  tier: LeaderboardTier;
  tierLabel: string;   // e.g. "Challenger"
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  rows: LeaderboardRowVM[];
}

// The static-data catalog contract (implemented in @/server/static-data).
export interface Catalog {
  setNumber: number;
  unit(characterId: string): { characterId: string; name: string; cost: number; iconUrl: string | null };
  trait(traitId: string): { traitId: string; name: string; iconUrl: string | null; breakpoints: { minUnits: number; style: number }[] };
  item(itemId: string): { itemId: string; name: string; iconUrl: string | null };
  /** Map a variant trait ID to its canonical parent, if one exists (e.g. TFT17_Stargazer_Wolf → TFT17_Stargazer). */
  normalizeTraitId(id: string): string;
}

// ── helpers ──────────────────────────────────────────────────────────────────
export function bucketOf(placement: number): Bucket {
  return placement === 1 ? 'first' : placement <= 4 ? 'top4' : 'bottom';
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

interface RawUnit { characterId: string; star: number; items: string[] }
interface RawTrait { traitId: string; numUnits: number; style: number }

function styleFromBreakpoints(breakpoints: { minUnits: number; style: number }[], numUnits: number): number {
  let style = 0;
  for (const bp of breakpoints) {
    if (numUnits >= bp.minUnits) style = bp.style;
    else break;
  }
  return style;
}

export function buildBoard(units: RawUnit[], traits: RawTrait[], catalog: Catalog): BoardVM {
  // carry = most items, tie-broken by cost
  let carryIdx = -1, bestItems = 0, bestCost = -1;
  units.forEach((u, i) => {
    const cost = catalog.unit(u.characterId).cost;
    const items = u.items.length;
    if (items > bestItems || (items === bestItems && cost > bestCost)) {
      bestItems = items; bestCost = cost; carryIdx = i;
    }
  });
  const carryHasItems = bestItems > 0;

  const unitVMs: UnitVM[] = units.map((u, i) => {
    const meta = catalog.unit(u.characterId);
    return {
      characterId: u.characterId,
      name: meta.name,
      cost: meta.cost,
      star: u.star,
      iconUrl: meta.iconUrl,
      isCarry: i === carryIdx && carryHasItems,
      items: u.items.map((id) => {
        const im = catalog.item(id);
        return { itemId: id, name: im.name, iconUrl: im.iconUrl };
      }),
    };
  });
  unitVMs.sort(
    (a, b) =>
      Number(b.isCarry) - Number(a.isCarry) ||
      b.cost - a.cost ||
      b.star - a.star ||
      a.name.localeCompare(b.name),
  );

  const traitVMs: TraitVM[] = traits
    .filter((t) => t.numUnits > 0)
    .map((t) => {
      const meta = catalog.trait(t.traitId);
      const style = meta.breakpoints.length
        ? styleFromBreakpoints(meta.breakpoints, t.numUnits)
        : t.style;
      const unique = meta.breakpoints.length === 1;
      return { traitId: t.traitId, name: meta.name, numUnits: t.numUnits, style, unique, iconUrl: meta.iconUrl };
    })
    .filter((t) => t.style > 0)
    .sort((a, b) => b.style - a.style || b.numUnits - a.numUnits);

  return { units: unitVMs, traits: traitVMs };
}

export function buildProfileVM(profile: PlayerProfile, catalog: Catalog): ProfileVM {
  const matches: MatchSummaryVM[] = profile.recentMatches.map((m) => ({
    matchId: m.matchId,
    queueId: m.queueId,
    placement: m.placement,
    bucket: bucketOf(m.placement),
    level: m.level,
    lastRound: m.lastRound,
    goldLeft: m.goldLeft,
    board: buildBoard(
      m.units.map((u) => ({ characterId: u.characterId, star: u.star, items: u.items })),
      m.traits.map((t) => ({ traitId: t.name, numUnits: t.numUnits, style: t.style })),
      catalog,
    ),
  }));

  const n = profile.recentMatches.length;
  const sum = profile.recentMatches.reduce(
    (acc, m) => {
      acc.place += m.placement;
      if (m.placement <= 4) acc.top4 += 1;
      if (m.placement === 1) acc.first += 1;
      return acc;
    },
    { place: 0, top4: 0, first: 0 },
  );

  return {
    puuid: profile.puuid,
    gameName: profile.gameName,
    tagLine: profile.tagLine,
    platform: profile.platform,
    initial: (profile.gameName.trim()[0] ?? '?').toUpperCase(),
    profileIconId: profile.profileIconId,
    summonerLevel: profile.summonerLevel,
    rank: profile.rank,
    summary: {
      games: n,
      avgPlacement: n ? sum.place / n : 0,
      top4Rate: n ? sum.top4 / n : 0,
      firstRate: n ? sum.first / n : 0,
    },
    matches,
  };
}
