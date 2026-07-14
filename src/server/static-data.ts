import { query } from '@/lib/db';
import { iconUrl } from '@/lib/icon-url';
import type { Catalog } from './view-models';

const TTL_MS = 60 * 60 * 1000; // 1h — catalog only changes on patch/set load

function prettify(id: string): string {
  return (
    id
      .replace(/^TFT\d+[_]?/i, '')
      .replace(/^TFT[_]?/i, '')
      .replace(/_/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/\bTrait\b/g, '')
      .trim() || id
  );
}

interface NormalizedBreakpoint { minUnits: number; style: number }

interface Loaded {
  setNumber: number;
  units: Map<string, { name: string; cost: number; iconUrl: string | null }>;
  traits: Map<string, { name: string; iconUrl: string | null; breakpoints: NormalizedBreakpoint[] }>;
  /** Maps variant trait IDs to their canonical parent (e.g. TFT17_Stargazer_Wolf → TFT17_Stargazer). */
  traitVariants: Map<string, string>;
  items: Map<string, { name: string; iconUrl: string | null }>;
  loadedAt: number;
}

let cache: Loaded | null = null;
let loading: Promise<Loaded> | null = null;

/** Current set number: the is_current patch's set, else the newest set with
 *  loaded units. Shared by library-data and planner-data. */
export async function currentSet(): Promise<number> {
  const current = await query<{ set_number: number }>(
    `SELECT set_number FROM patches WHERE is_current = true ORDER BY set_number DESC LIMIT 1`,
  );
  if (current[0]) return current[0].set_number;
  const max = await query<{ max: number | null }>(`SELECT max(set_number)::int AS max FROM units`);
  return max[0]?.max ?? 0;
}

async function load(): Promise<Loaded> {
  const setNumber = await currentSet();
  const [unitRows, traitRows, itemRows] = await Promise.all([
    query<{ character_id: string; name: string; cost: number | null; icon_path: string | null }>(
      `SELECT character_id, name, cost, icon_path FROM units WHERE set_number = $1`,
      [setNumber],
    ),
    query<{ trait_id: string; name: string; icon_path: string | null; breakpoints: { minUnits?: number; style?: number }[] | null }>(
      `SELECT trait_id, name, icon_path, breakpoints FROM traits WHERE set_number = $1`, [setNumber]),
    query<{ item_id: string; name: string; icon_path: string | null }>(`SELECT item_id, name, icon_path FROM items WHERE set_number = $1`, [setNumber]),
  ]);

  const units = new Map<string, { name: string; cost: number; iconUrl: string | null }>();
  for (const r of unitRows) units.set(r.character_id, { name: r.name, cost: r.cost ?? 0, iconUrl: iconUrl(r.icon_path) });
  const traits = new Map<string, { name: string; iconUrl: string | null; breakpoints: NormalizedBreakpoint[] }>();
  for (const r of traitRows) {
    const raw = Array.isArray(r.breakpoints) ? r.breakpoints : [];
    const breakpoints: NormalizedBreakpoint[] = raw
      .filter((b) => typeof b.minUnits === 'number')
      .sort((a, b) => a.minUnits! - b.minUnits!)
      .map((b, i, arr) => ({ minUnits: b.minUnits!, style: arr.length === 1 ? 4 : Math.min(i + 1, 4) }));
    traits.set(r.trait_id, { name: r.name, iconUrl: iconUrl(r.icon_path), breakpoints });
  }
  const items = new Map<string, { name: string; iconUrl: string | null }>();
  for (const r of itemRows) items.set(r.item_id, { name: r.name, iconUrl: iconUrl(r.icon_path) });

  // Build variant normalization: TFT17_Stargazer_Wolf → TFT17_Stargazer, etc.
  // A trait ID is a variant if stripping its last _Suffix yields another known trait ID.
  const traitVariants = new Map<string, string>();
  for (const id of traits.keys()) {
    const cut = id.lastIndexOf('_');
    if (cut > 0) {
      const parent = id.slice(0, cut);
      if (traits.has(parent)) traitVariants.set(id, parent);
    }
  }

  return { setNumber, units, traits, traitVariants, items, loadedAt: Date.now() };
}

function toCatalog(c: Loaded): Catalog {
  return {
    setNumber: c.setNumber,
    unit(id) {
      const u = c.units.get(id);
      return u
        ? { characterId: id, name: u.name, cost: u.cost, iconUrl: u.iconUrl }
        : { characterId: id, name: prettify(id), cost: 0, iconUrl: null };
    },
    trait(id) {
      const t = c.traits.get(id);
      return { traitId: id, name: t?.name ?? prettify(id), iconUrl: t?.iconUrl ?? null, breakpoints: t?.breakpoints ?? [] };
    },
    item(id) {
      const it = c.items.get(id);
      return { itemId: id, name: it?.name ?? prettify(id), iconUrl: it?.iconUrl ?? null };
    },
    normalizeTraitId(id) {
      return c.traitVariants.get(id) ?? id;
    },
  };
}

/** Cached catalog with stale-while-revalidate; only the first call (cold cache) awaits a DB load. */
export async function getCatalog(): Promise<Catalog> {
  const fresh = cache && Date.now() - cache.loadedAt < TTL_MS;
  if (!fresh && !loading) {
    loading = load()
      .then((c) => {
        cache = c;
        return c;
      })
      .finally(() => {
        loading = null;
      });
    // Background revalidation (warm cache) has no awaiter — attach a no-op
    // handler so a transient DB failure can't become a fatal unhandled
    // rejection. Cold-start callers still await `loading` and see the error.
    loading.catch(() => {});
  }
  const loaded = cache ?? (await loading!);
  return toCatalog(loaded);
}
