// Riot routes some APIs through *regional* hosts and others through *platform*
// hosts, and each host has its OWN app-rate-limit budget.
//
//   Regional host (americas/europe/asia/sea): ACCOUNT-V1, TFT-MATCH-V1
//   Platform host (na1/euw1/kr/...):          TFT-SUMMONER-V1, TFT-LEAGUE-V1, TFT-STATUS-V1

export type RegionalRoute = 'americas' | 'europe' | 'asia' | 'sea';

export type Platform =
  | 'na1' | 'br1' | 'la1' | 'la2'
  | 'euw1' | 'eun1' | 'tr1' | 'ru' | 'me1'
  | 'kr' | 'jp1'
  | 'oc1' | 'ph2' | 'sg2' | 'th2' | 'tw2' | 'vn2';

export const PLATFORMS: Platform[] = [
  'na1', 'br1', 'la1', 'la2',
  'euw1', 'eun1', 'tr1', 'ru', 'me1',
  'kr', 'jp1',
  'oc1', 'ph2', 'sg2', 'th2', 'tw2', 'vn2',
];

// Verify against current Riot docs before going multi-region — Riot has shuffled
// a few of these (notably OCE) over time.
export const PLATFORM_TO_REGION: Record<Platform, RegionalRoute> = {
  na1: 'americas', br1: 'americas', la1: 'americas', la2: 'americas',
  euw1: 'europe', eun1: 'europe', tr1: 'europe', ru: 'europe', me1: 'europe',
  kr: 'asia', jp1: 'asia',
  oc1: 'sea', ph2: 'sea', sg2: 'sea', th2: 'sea', tw2: 'sea', vn2: 'sea',
};

// ── Super-regions ────────────────────────────────────────────────────────────
//
// The competitive scene is split three ways, and that split — not Riot's routing
// — is the one worth reporting stats under. The game's rules are identical
// everywhere; only playstyle and field strength differ, so a per-PLATFORM tier
// list fragments one meta into shards that each have too little sample to say
// anything.
//
// Not the same thing as RegionalRoute, which is a rate-limit and host boundary:
// 'sea' and 'asia' are separate routes but one competitive region, and mainland
// China is a super-region with no route at all here — it runs on Tencent's
// infrastructure and is not served by the public Riot API, so it is deliberately
// absent rather than present and permanently empty.

export type SuperRegion = 'AMER' | 'EMEA' | 'APAC';

export const PLATFORM_TO_SUPER_REGION: Record<Platform, SuperRegion> = {
  na1: 'AMER', br1: 'AMER', la1: 'AMER', la2: 'AMER',
  euw1: 'EMEA', eun1: 'EMEA', tr1: 'EMEA', ru: 'EMEA', me1: 'EMEA',
  kr: 'APAC', jp1: 'APAC',
  oc1: 'APAC', ph2: 'APAC', sg2: 'APAC', th2: 'APAC', tw2: 'APAC', vn2: 'APAC',
};

export function superRegionForPlatform(platform: Platform): SuperRegion {
  return PLATFORM_TO_SUPER_REGION[platform];
}

/**
 * Super-region for a stored `matches.region`, which is the UPPERCASE platform
 * prefix of a match id ("EUW1_7967092353" → "EUW1"), not a Platform literal.
 *
 * Returns null for anything unrecognised — including the synthetic prefixes used
 * by the persist check ("ZZTEST1") — so the rollup can leave those grouped under
 * their own raw value instead of silently folding test rows into a real region.
 */
export function superRegionForRegionCode(regionCode: string): SuperRegion | null {
  const p = regionCode.toLowerCase();
  return isPlatform(p) ? PLATFORM_TO_SUPER_REGION[p] : null;
}

export function isPlatform(value: string): value is Platform {
  return (PLATFORMS as string[]).includes(value);
}

export function platformHost(platform: Platform): string {
  return `https://${platform}.api.riotgames.com`;
}

export function regionalHost(route: RegionalRoute): string {
  return `https://${route}.api.riotgames.com`;
}

export function routeForPlatform(platform: Platform): RegionalRoute {
  return PLATFORM_TO_REGION[platform];
}

/**
 * The `matches.region` codes a selected region covers.
 *
 * The derived tables (`comp_stats`, `bucket_totals`, `tier_list_entries`,
 * `comp_stat_trends`) are keyed by SUPER-REGION, but `matches.region` still
 * holds the platform a match was played on — so any query that reads raw boards
 * for a selection has to expand the one into the other. Comparing them directly
 * silently matches nothing: a tier list built from `comp_stats` hands you
 * 'EMEA', no `matches` row has ever said 'EMEA', and every example board comes
 * back empty.
 *
 * A value that is not a super-region passes through as itself, so a raw platform
 * code, a legacy row, or the persist check's synthetic 'ZZTEST1' still resolve.
 */
export function regionCodesFor(selected: string): string[] {
  const upper = selected.toUpperCase();
  if (upper !== 'AMER' && upper !== 'EMEA' && upper !== 'APAC') return [selected];
  return PLATFORMS.filter((p) => PLATFORM_TO_SUPER_REGION[p] === upper).map((p) => p.toUpperCase());
}
