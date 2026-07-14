import { query } from '@/lib/db';
import { iconUrl } from '@/lib/icon-url';
import type { PlannerData, PlannerUnit, PlannerTrait, PlannerItem, Breakpoint } from '@/lib/planner/core';
import { COMPONENT_IDS, ITEM_JUNK, ITEM_NAME_JUNK } from './item-filters';
import { currentSet } from './static-data';

const TEAMPLANNER_URL =
  'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/tftchampions-teamplanner.json';

async function fetchTeamPlannerCodes(setNumber: number): Promise<Map<string, number>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch(TEAMPLANNER_URL, { next: { revalidate: 3600 }, signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return new Map();
    const data = await res.json() as Record<string, { character_id: string; team_planner_code: number }[]>;
    const entries = data[`TFTSet${setNumber}`] ?? [];
    return new Map(entries.map((e) => [e.character_id, e.team_planner_code]));
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof Error && err.name === 'AbortError') {
      console.warn('fetchTeamPlannerCodes timed out');
    }
    return new Map();
  }
}

export async function getPlannerData(): Promise<PlannerData> {
  const setNumber = await currentSet();

  const [unitRows, traitRows, itemRows, teamPlannerCodes] = await Promise.all([
    query<{ character_id: string; name: string; cost: number | null; trait_ids: string[]; icon_path: string | null }>(
      `SELECT character_id, name, cost, trait_ids, icon_path FROM units WHERE set_number = $1 ORDER BY cost NULLS FIRST, name`,
      [setNumber],
    ),
    query<{ trait_id: string; name: string; icon_path: string | null; breakpoints: Breakpoint[] }>(
      `SELECT trait_id, name, icon_path, breakpoints FROM traits WHERE set_number = $1 ORDER BY name`,
      [setNumber],
    ),
    query<{ item_id: string; name: string; icon_path: string | null; composition: string[] }>(
      `SELECT item_id, name, icon_path, composition FROM items WHERE set_number = $1`,
      [setNumber],
    ),
    fetchTeamPlannerCodes(setNumber),
  ]);

  const units: PlannerUnit[] = unitRows
    .filter((r) => r.cost != null && r.cost >= 1 && r.cost <= 5)
    .map((r) => ({
      id: r.character_id,
      name: r.name,
      cost: r.cost!,
      traits: r.trait_ids ?? [],
      iconUrl: iconUrl(r.icon_path),
      plannerCode: teamPlannerCodes.get(r.character_id) ?? null,
    }));

  const traitIdByName = new Map(traitRows.map((t) => [t.name.toLowerCase(), t.trait_id]));
  const traits: PlannerTrait[] = traitRows.map((t) => {
    const breakpoints = (Array.isArray(t.breakpoints) ? t.breakpoints : [])
      .filter((b): b is Breakpoint => !!b && typeof b.minUnits === 'number')
      .sort((a, b) => a.minUnits - b.minUnits)
      // Normalize to sequential styles 1,2,3,4 — raw data may use 1,3,5,7.
      // Single-breakpoint traits are "unique" (1-of-1) and always show as prismatic.
      .map((b, i, arr) => ({ minUnits: b.minUnits, style: arr.length === 1 ? 4 : Math.min(i + 1, 4) }));
    return { id: t.trait_id, name: t.name, iconUrl: iconUrl(t.icon_path), breakpoints };
  });

  // Keep standard (TFT_Item_*) and current-set (TFT{n}_Item_*) items; classify them.
  // When the same display name appears in both a global TFT_Item_* and a set-specific
  // TFT{n}_Item_*, keep whichever has the better kind (lower rank = more specific).
  const setPrefix = `TFT${setNumber}_Item_`;
  const kindRank = { component: 0, craftable: 1, emblem: 2, artifact: 3, other: 4 } as const;
  const itemsByName = new Map<string, PlannerItem>();
  for (const r of itemRows) {
    const id = r.item_id;
    if (!id || !r.name) continue;
    if (!id.startsWith('TFT_Item_') && !id.startsWith(setPrefix)) continue;
    if (ITEM_JUNK.test(id)) continue;
    if (ITEM_NAME_JUNK.test(r.name)) continue;

    let kind: PlannerItem['kind'];
    let trait: string | undefined;
    if (COMPONENT_IDS.has(id)) {
      kind = 'component';
    } else if (/Emblem/i.test(id) || /Emblem/i.test(r.name)) {
      kind = 'emblem';
      trait = traitIdByName.get(r.name.replace(/\s*Emblem\s*$/i, '').trim().toLowerCase());
    } else if (Array.isArray(r.composition) && r.composition.length === 2) {
      kind = 'craftable';
    } else if (/_Item_Artifact_/i.test(id)) {
      kind = 'artifact';
    } else {
      kind = 'other';
    }
    const key = r.name.toLowerCase();
    const existing = itemsByName.get(key);
    if (!existing || kindRank[kind] < kindRank[existing.kind]) {
      itemsByName.set(key, { id, name: r.name, iconUrl: iconUrl(r.icon_path), kind, trait });
    }
  }

  const deduped = Array.from(itemsByName.values());

  // Components first, then craftable, emblems, artifacts, other — all alphabetically within group.
  deduped.sort((a, b) => kindRank[a.kind] - kindRank[b.kind] || a.name.localeCompare(b.name));

  return { units, traits, items: deduped, setNumber };
}
