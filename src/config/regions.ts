// Riot routes some APIs through *regional* hosts and others through *platform*
// hosts, and each host has its OWN app-rate-limit budget.
//
//   Regional host (americas/europe/asia/sea): ACCOUNT-V1, TFT-MATCH-V1
//   Platform host (na1/euw1/kr/...):          TFT-SUMMONER-V1, TFT-LEAGUE-V1, TFT-STATUS-V1

export type RegionalRoute = 'americas' | 'europe' | 'asia' | 'sea';

export type Platform =
  | 'na1' | 'br1' | 'la1' | 'la2'
  | 'euw1' | 'eun1' | 'tr1' | 'ru'
  | 'kr' | 'jp1'
  | 'oc1' | 'ph2' | 'sg2' | 'th2' | 'tw2' | 'vn2';

export const PLATFORMS: Platform[] = [
  'na1', 'br1', 'la1', 'la2',
  'euw1', 'eun1', 'tr1', 'ru',
  'kr', 'jp1',
  'oc1', 'ph2', 'sg2', 'th2', 'tw2', 'vn2',
];

// Verify against current Riot docs before going multi-region — Riot has shuffled
// a few of these (notably OCE) over time.
export const PLATFORM_TO_REGION: Record<Platform, RegionalRoute> = {
  na1: 'americas', br1: 'americas', la1: 'americas', la2: 'americas',
  euw1: 'europe', eun1: 'europe', tr1: 'europe', ru: 'europe',
  kr: 'asia', jp1: 'asia',
  oc1: 'sea', ph2: 'sea', sg2: 'sea', th2: 'sea', tw2: 'sea', vn2: 'sea',
};

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
