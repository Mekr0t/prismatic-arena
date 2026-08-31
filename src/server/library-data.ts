import { query } from '@/lib/db';
import { iconUrl } from '@/lib/icon-url';
import type { Breakpoint } from '@/lib/planner/core';
import { COMPONENT_IDS, ITEM_JUNK, ITEM_NAME_JUNK, isArtifactItem } from './item-filters';
import { isSetItem } from './set-config';
import { currentSet } from './static-data';

export interface LibUnit {
  id: string;
  name: string;
  cost: number;
  role: string | null;
  traits: string[];
  iconUrl: string | null;
  abilityName: string | null;
  abilityDesc: string | null;
  stats: Record<string, number> | null;
}

export interface LibTrait {
  id: string;
  name: string;
  iconUrl: string | null;
  description: string | null;
  breakpoints: Breakpoint[];
}

export interface ItemStat {
  label: string;
  value: string;
}

export interface LibItem {
  id: string;
  name: string;
  iconUrl: string | null;
  description: string | null;
  stats: ItemStat[];
  kind: 'component' | 'emblem' | 'craftable' | 'artifact' | 'other';
}

export type AugmentTier = 'Silver' | 'Gold' | 'Prismatic';

export interface LibAugment {
  id: string;
  name: string;
  iconUrl: string | null;
  description: string | null;
  tier: AugmentTier;
}

// CommunityDragon icon paths encode tier as Roman numeral suffix before the extension:
//   _II.  or  -II.  → Gold    (e.g. NeuralNetwork_II.TFT_Set14.tex)
//   _III. or  -III. → Prismatic (e.g. Accomplice_III.tex)
//   _I.   or  -I.   → Silver  (default)
// Missing placeholder icons use Missing-T1/T2/T3 convention.
function tierFromIcon(iconPath: string | null): AugmentTier {
  if (!iconPath) return 'Silver';
  if (/[_-]III\.|Missing-T3\./i.test(iconPath)) return 'Prismatic';
  if (/[_-]II\.|Missing-T2\./i.test(iconPath)) return 'Gold';
  return 'Silver';
}

export interface LibraryData {
  setNumber: number;
  units: LibUnit[];
  traits: LibTrait[];
  items: LibItem[];
  augments: LibAugment[];
}

export async function getLibraryData(): Promise<LibraryData> {
  const setNumber = await currentSet();

  const [unitRows, traitRows, itemRows, augmentRows] = await Promise.all([
    query<{
      character_id: string; name: string; cost: number | null; role: string | null; trait_ids: string[];
      icon_path: string | null; ability_name: string | null; ability_desc: string | null;
      stats: Record<string, number> | null;
    }>(
      `SELECT character_id, name, cost, role, trait_ids, icon_path, ability_name, ability_desc, stats
       FROM units WHERE set_number = $1 ORDER BY cost NULLS FIRST, name`,
      [setNumber],
    ),
    query<{
      trait_id: string; name: string; icon_path: string | null;
      description: string | null; breakpoints: Breakpoint[];
    }>(
      `SELECT trait_id, name, icon_path, description, breakpoints
       FROM traits WHERE set_number = $1 ORDER BY name`,
      [setNumber],
    ),
    query<{
      item_id: string; name: string; icon_path: string | null;
      description: string | null; composition: string[]; stats: ItemStat[] | null;
    }>(
      `SELECT item_id, name, icon_path, description, composition, stats
       FROM items WHERE set_number = $1`,
      [setNumber],
    ),
    query<{ augment_id: string; name: string; icon_path: string | null; description: string; tier: string | null }>(`
      SELECT augment_id, name, icon_path, description, tier
      FROM augments
      WHERE set_number = $1
      AND description IS NOT NULL
      ORDER BY name`,
      [setNumber],
    ),
  ]);

  const units: LibUnit[] = unitRows
    .filter((r) => r.cost != null && r.cost >= 1 && r.cost <= 5)
    .map((r) => ({
      id: r.character_id,
      name: r.name,
      cost: r.cost!,
      role: r.role,
      traits: r.trait_ids ?? [],
      iconUrl: iconUrl(r.icon_path),
      abilityName: r.ability_name,
      abilityDesc: r.ability_desc,
      stats: r.stats,
    }));

  const traits: LibTrait[] = traitRows.map((t) => ({
    id: t.trait_id,
    name: t.name,
    iconUrl: iconUrl(t.icon_path),
    description: t.description,
    breakpoints: (Array.isArray(t.breakpoints) ? t.breakpoints : [])
      .filter((b): b is Breakpoint => !!b && typeof b.minUnits === 'number')
      .sort((a, b) => a.minUnits - b.minUnits)
      .map((b, i, arr) => ({
        minUnits: b.minUnits,
        style: arr.length === 1 ? 4 : Math.min(i + 1, 4),
        effect: b.effect ?? null,
      })),
  }));


  // rank for preferring which version to keep when names collide
  const kindRank = { component: 0, craftable: 1, emblem: 2, artifact: 3, other: 4 } as const;

  const itemsByName = new Map<string, LibItem>();

  for (const r of itemRows) {
    const id = r.item_id;
    if (!id || !r.name) continue;
    if (!isSetItem(setNumber, id)) continue;
    if (ITEM_JUNK.test(id)) continue;
    if (ITEM_NAME_JUNK.test(r.name)) continue;

    let kind: LibItem['kind'];
    if (COMPONENT_IDS.has(id)) kind = 'component';
    else if (/Emblem/i.test(id) || /Emblem/i.test(r.name)) kind = 'emblem';
    else if (Array.isArray(r.composition) && r.composition.length === 2) kind = 'craftable';
    else if (isArtifactItem(id)) kind = 'artifact';
    else kind = 'other';

    const key = r.name.toLowerCase();
    const existing = itemsByName.get(key);

    if (!existing || kindRank[kind] < kindRank[existing.kind]) {
      itemsByName.set(key, {
        id,
        name: r.name,
        iconUrl: iconUrl(r.icon_path),
        description: r.description,
        stats: Array.isArray(r.stats) ? r.stats : [],
        kind,
      });
    }
  }

  const kindOrder = { component: 0, craftable: 1, emblem: 2, artifact: 3, other: 4 } as const;
  const items = Array.from(itemsByName.values()).sort(
    (a, b) => kindOrder[a.kind] - kindOrder[b.kind] || a.name.localeCompare(b.name),
  );

  const seenAugNames = new Set<string>();
  const augments: LibAugment[] = [];
  for (const a of augmentRows) {
    const key = a.name.toLowerCase();
    if (seenAugNames.has(key)) continue;
    seenAugNames.add(key);
    augments.push({
      id: a.augment_id,
      name: a.name,
      iconUrl: iconUrl(a.icon_path),
      description: a.description,
      tier: (a.tier as AugmentTier) ?? tierFromIcon(a.icon_path),
    });
  }

  augments.sort((a, b) => a.name.localeCompare(b.name));

  return { setNumber, units, traits, items, augments };
}
