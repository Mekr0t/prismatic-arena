import { SET18_TRAITS } from './set18-traits';

// map22-source.ts — champions straight from the game's own data.
//
// TEMPORARY BRIDGE, used only when DATA_SOURCE=map22.
//
// `map22.bin.json` is the raw TFT map data CDragon mirrors from the client, and
// it is the file CDragon's own TFT extractor reads. On set-18 launch day that
// extractor could not parse the new format — it emitted 2 champions out of 74 —
// while the raw mirror it reads FROM was complete and current. So this reads
// the source directly and skips the broken derived file.
//
// It supplies CHAMPIONS ONLY. Traits, items and augments still come from
// CDragon's tft/en_us.json, which publishes them correctly; the one thing
// missing everywhere is the champion-to-trait mapping, which comes from the
// hand-transcribed seed (see set18-traits.ts).
//
// DELETE THIS once _set-readiness.ts reports READY.

const MAP22 = 'https://raw.communitydragon.org/latest/game/data/maps/shipping/map22/map22.bin.json';
const DDRAGON = 'https://ddragon.leagueoflegends.com';

/** Display names that cannot be derived from the id. From the in-game client. */
const MANUAL_NAMES: Record<string, string> = {
  DA_18_Sentry: 'Pebbles',
  DA_CrimsonRaptor18: 'Mama Beak',
};

/**
 * LIVE CONTENT ONLY. The set-18 shop in map22 carries two prefixes:
 *   DA_*     74 champions — every one present in Riot's published Data Dragon,
 *            every one visible in the client's trait list.
 *   TFT18_*  19 champions — ZERO in Data Dragon, 10 with no icon path, 10 with
 *            no display-name string, none visible in the client.
 * The second group is datamined future content. Loading it would invent
 * champions players cannot field, all of them trait-less.
 */
const isLive = (id: string): boolean => /^DA_/.test(id);

/** "DA_Krug18" -> "Krug", "DA_Gromp18_AP" -> "Gromp", "DA_18_ElderDragon" -> "Elder Dragon" */
export function deriveName(id: string): string {
  const core = id
    .replace(/^DA_/, '')
    .replace(/^18_/, '')
    .replace(/18(_[A-Z]{2,3})?$/, '')
    .replace(/_(AD|AP)$/, '');
  return core.replace(/([a-z])([A-Z])/g, '$1 $2').trim();
}

export interface Map22Champion {
  apiName: string;
  name: string;
  cost: number;
  // Present-but-absent on purpose: the loader reads these off a CDragon
  // champion, and map22's shop record carries none of them. Declaring them
  // keeps the two shapes interchangeable at the insert without a cast, and
  // every one lands as NULL, which is honest — ability text and stats come
  // back when CDragon's extractor does.
  role?: undefined;
  icon?: undefined;
  ability?: undefined;
  stats?: undefined;
  /** Trait API NAMES, not display names. The loader's display-name lookup falls
   *  through unchanged for anything it does not recognise, so these pass to the
   *  DB as-is — which is what we want, since the seed already holds real ids. */
  traits: string[];
  tileIcon: string | null;
}

interface ShopEntry {
  mName?: string;
  BaseCost?: number;
  SquareSplashPath?: string;
  TeamPlannerPortraitPath?: string;
}

/** Raw champion rows for a set, without traits. Shared with the seed generator. */
export async function fetchMap22Champions(
  setNumber: number,
): Promise<{ id: string; name: string; cost: number; icon: string | null }[]> {
  const map22 = JSON.parse(await (await fetch(MAP22)).text()) as Record<string, Record<string, unknown>>;
  const shop = Object.entries(map22)
    .filter(
      ([k, v]) =>
        new RegExp(`TFTSet${setNumber}/Shop/`, 'i').test(k) &&
        (v as { __type?: string }).__type === 'TftShopData',
    )
    .map(([, v]) => v as ShopEntry);

  // Display names come from Riot's published feed where it has them; the
  // Riftbeast units are not in it, so those are derived from the id.
  let ddName = new Map<string, string>();
  try {
    const vs = (await (await fetch(`${DDRAGON}/api/versions.json`)).json()) as string[];
    const dd = (await (
      await fetch(`${DDRAGON}/cdn/${vs[0]}/data/en_US/tft-champion.json`)
    ).json()) as { data?: Record<string, { id?: string; name?: string }> };
    ddName = new Map(
      Object.entries(dd.data ?? {})
        .filter(([k]) => new RegExp(`TFTSet${setNumber}\\b`, 'i').test(k))
        .map(([, v]) => [v.id!, v.name!]),
    );
  } catch {
    // Data Dragon is a nicety here, not a dependency: without it every name is
    // derived from the id, which is correct if less pretty.
  }

  return shop
    .filter((c) => (c.BaseCost ?? 0) >= 1 && (c.BaseCost ?? 0) <= 5 && c.mName && isLive(c.mName))
    .map((c) => ({
      id: c.mName!,
      name: MANUAL_NAMES[c.mName!] ?? ddName.get(c.mName!) ?? deriveName(c.mName!),
      cost: c.BaseCost!,
      // Both are game asset paths, which is exactly what iconUrl() expects.
      icon: c.SquareSplashPath ?? c.TeamPlannerPortraitPath ?? null,
    }));
}

/** Champions for the loader, with traits attached from the seed. */
export async function championsFromMap22(setNumber: number): Promise<Map22Champion[]> {
  if (setNumber !== 18) {
    throw new Error(
      `DATA_SOURCE=map22 only carries a trait seed for set 18, not set ${setNumber}. ` +
        `Any other set should load from CDragon normally.`,
    );
  }
  const raw = await fetchMap22Champions(setNumber);
  const missing = raw.filter((c) => !SET18_TRAITS[c.id]);
  if (missing.length) {
    console.warn(
      `[map22] ${missing.length} champion(s) have no seeded traits and will load trait-less: ` +
        missing.map((c) => c.id).join(', '),
    );
    console.warn('[map22]   re-run: npx tsx scripts/_gen-set18-traits.ts');
  }
  return raw.map((c) => ({
    apiName: c.id,
    name: c.name,
    cost: c.cost,
    traits: SET18_TRAITS[c.id] ?? [],
    tileIcon: c.icon,
  }));
}
