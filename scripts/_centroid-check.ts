import 'dotenv/config';
import { pool } from '@/lib/db';
import { RANKED_TFT_QUEUE_ID } from '@/config/queue-ids';
import { isEmblemItem, MIN_BOARD_UNITS } from '@/server/queue/comp-signature';
import {
  ASSIGN_BAR,
  MIN_SEPARATION,
  SEED_COUNT,
  assignBoard,
  convergeCentroids,
  coreUnits,
  groupBoards,
  listableCentroids,
  nameCentroid,
  resolveNameCollisions,
  type CentroidBoard,
  type ItemisationRate,
  type NameStatics,
  type TraitBreakpoint,
} from '@/server/queue/comp-centroid';

// _centroid-check.ts — runs comp-centroid.ts over the live database, read-only.
//
// The unit tests pin the rules; this answers the question they cannot: do the
// lines it elects look like the lines people actually play, and do their
// generated names read like something a player would say? Not part of `npm test`
// — it needs a populated database.
//
//   npx tsx scripts/_centroid-check.ts [rank_bucket] [set]
//   npx tsx scripts/_centroid-check.ts master_plus 18

const BUCKET = process.argv[2] ?? 'master_plus';
const SET = Number(process.argv[3] ?? 18);

interface LoadedBoard extends CentroidBoard {
  placement: number;
  itemised: string[];
}

async function loadStatics(): Promise<{ statics: NameStatics; costs: Map<string, number> }> {
  const u = await pool.query<{
    set_number: number;
    character_id: string;
    cost: number | null;
    name: string;
    trait_ids: string[] | null;
  }>(`SELECT set_number, character_id, cost, name, trait_ids FROM units`);

  const costs = new Map<string, number>();
  const unitTraits = new Map<string, string[]>();
  const unitNames = new Map<string, string>();
  const unitCosts = new Map<string, number>();
  for (const r of u.rows) {
    costs.set(`${r.set_number}:${r.character_id}`, r.cost ?? 0);
    if (r.set_number !== SET) continue;
    unitTraits.set(r.character_id, r.trait_ids ?? []);
    unitNames.set(r.character_id, r.name);
    unitCosts.set(r.character_id, r.cost ?? 0);
  }

  const t = await pool.query<{ trait_id: string; name: string; breakpoints: unknown }>(
    `SELECT trait_id, name, breakpoints FROM traits WHERE set_number = $1`,
    [SET],
  );
  const traitNames = new Map<string, string>();
  const traitBreakpoints = new Map<string, TraitBreakpoint[]>();
  for (const r of t.rows) {
    traitNames.set(r.trait_id, r.name);
    const bps = (r.breakpoints as { style?: number; minUnits?: number }[]) ?? [];
    traitBreakpoints.set(
      r.trait_id,
      bps.map((b) => ({ style: b.style ?? 1, minUnits: b.minUnits ?? 0 })),
    );
  }

  return { statics: { unitTraits, unitNames, traitNames, traitBreakpoints, unitCosts }, costs };
}

async function loadBoards(costs: Map<string, number>): Promise<LoadedBoard[]> {
  const parts = await pool.query<{ id: string; placement: number }>(
    `SELECT mp.id, mp.placement
       FROM match_participants mp
       JOIN matches m ON m.match_id = mp.match_id
      WHERE m.queue_id = $1 AND m.set_number = $2 AND m.player_count = 8
        AND mp.rank_bucket = $3 AND mp.placement IS NOT NULL
      ORDER BY mp.id`,
    [RANKED_TFT_QUEUE_ID, SET, BUCKET],
  );
  const placement = new Map<string, number>();
  for (const r of parts.rows) placement.set(r.id, r.placement);

  const ids = parts.rows.map((r) => r.id);
  const out: LoadedBoard[] = [];
  for (let i = 0; i < ids.length; i += 20_000) {
    const slice = ids.slice(i, i + 20_000);
    const rows = await pool.query<{ participant_id: string; character_id: string; item_ids: string[] | null }>(
      `SELECT participant_id, character_id, item_ids
         FROM participant_units WHERE participant_id = ANY($1::bigint[])`,
      [slice],
    );
    const byPart = new Map<string, { units: Set<string>; itemised: Set<string> }>();
    for (const row of rows.rows) {
      const cost = costs.get(`${SET}:${row.character_id}`) ?? 0;
      if (cost < 1 || cost > 5) continue; // summons and unknowns are never identity
      let e = byPart.get(row.participant_id);
      if (!e) {
        e = { units: new Set(), itemised: new Set() };
        byPart.set(row.participant_id, e);
      }
      e.units.add(row.character_id);
      if ((row.item_ids ?? []).filter((it) => !isEmblemItem(it)).length >= 2) {
        e.itemised.add(row.character_id);
      }
    }
    for (const [pid, e] of byPart) {
      if (e.units.size < MIN_BOARD_UNITS) continue;
      out.push({ units: [...e.units], placement: placement.get(pid)!, itemised: [...e.itemised] });
    }
  }
  return out;
}

/** Itemisation rate per unit, over the boards of one line that FIELDED it. */
function itemisationFor(boards: readonly LoadedBoard[]): ItemisationRate[] {
  const fielded = new Map<string, number>();
  const carried = new Map<string, number>();
  for (const b of boards) {
    for (const u of b.units) fielded.set(u, (fielded.get(u) ?? 0) + 1);
    for (const u of b.itemised) carried.set(u, (carried.get(u) ?? 0) + 1);
  }
  const out: ItemisationRate[] = [];
  for (const [characterId, n] of fielded) {
    const c = carried.get(characterId) ?? 0;
    out.push({ characterId, rate: c / n, boards: c });
  }
  return out;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

async function main() {
  const { statics, costs } = await loadStatics();
  const boards = await loadBoards(costs);
  if (boards.length === 0) {
    console.log(`no clusterable boards for set ${SET} / ${BUCKET}`);
    await pool.end();
    return;
  }

  const groups = groupBoards(boards);
  const t0 = Date.now();
  const res = convergeCentroids(groups);
  const ms = Date.now() - t0;

  console.log(`\n=== set ${SET} · ${BUCKET} ===`);
  console.log(`boards ${res.totalBoards} · distinct unit-sets ${groups.length}`);
  console.log(
    `seed ${SEED_COUNT} · separation ${MIN_SEPARATION} · bar ${ASSIGN_BAR}  ->  ` +
      `${res.centroids.length} lines in ${res.iterations} iterations (${ms} ms)`,
  );
  console.log(`homed ${pct(res.homedBoards / res.totalBoards)} · off-meta ${pct(1 - res.homedBoards / res.totalBoards)}`);

  // Members, for per-line naming and stats.
  const members = new Map<number, LoadedBoard[]>();
  for (const b of boards) {
    const hit = assignBoard(b.units, res.centroids);
    if (!hit) continue;
    const arr = members.get(hit.index);
    if (arr) arr.push(b);
    else members.set(hit.index, [b]);
  }

  const listed = listableCentroids(res.centroids);
  const rawNames = res.centroids.map((c) => nameCentroid(c, itemisationFor(members.get(c.index) ?? []), statics));
  const names = resolveNameCollisions(rawNames, res.centroids, statics);

  const distinct = new Set(names).size;
  const listedNames = new Set(listed.map((c) => names[c.index]));
  console.log(
    `names: ${distinct}/${res.centroids.length} distinct overall · ` +
      `${listedNames.size}/${listed.length} distinct among listed`,
  );
  console.log(
    `listed ${listed.length} lines covering ` +
      `${pct(listed.reduce((a, c) => a + c.boards, 0) / res.totalBoards)} of boards\n`,
  );

  const shortId = (id: string) => statics.unitNames.get(id) ?? id;
  for (const c of listed) {
    const mine = members.get(c.index) ?? [];
    const pl = mine.map((b) => b.placement);
    const avg = pl.reduce((a, b) => a + b, 0) / (pl.length || 1);
    const top4 = (pl.filter((p) => p <= 4).length / (pl.length || 1)) * 100;
    console.log(`${String(c.boards).padStart(5)}  ${names[c.index]}`);
    console.log(
      `       avg ${avg.toFixed(2)} · top4 ${top4.toFixed(1)}%  ` +
        `core: ${[...coreUnits(c)].map(shortId).join(', ')}`,
    );
    const flex = c.units.filter((u) => u.rate < 0.8);
    if (flex.length > 0) {
      console.log(`       flex: ${flex.map((u) => `${shortId(u.characterId)} ${Math.round(u.rate * 100)}%`).join(' · ')}`);
    }
  }

  // Invariants worth failing on, not just printing.
  const problems: string[] = [];
  if (res.centroids.some((c) => c.boards === 0)) problems.push('a centroid was elected with no boards');
  if (new Set(listed.map((c) => names[c.index])).size !== listed.length) {
    problems.push('two LISTED lines share a name — the collision tiebreak did not separate them');
  }
  const marker = names.filter((n) => n.startsWith('Monolith '));
  if (marker.length > 0) problems.push(`${marker.length} line(s) named after the Monolith marker trait`);

  // Name a colliding pair rather than only counting it: the fix is always in
  // what the two lines actually share, so the report has to show it.
  const seenNames = new Map<string, number[]>();
  for (const c of listed) {
    const arr = seenNames.get(names[c.index]);
    if (arr) arr.push(c.index);
    else seenNames.set(names[c.index], [c.index]);
  }
  for (const [nme, idxs] of seenNames) {
    if (idxs.length < 2) continue;
    console.log(`\n  collision "${nme}":`);
    for (const i of idxs) {
      const c = res.centroids.find((x) => x.index === i)!;
      console.log(
        `    #${i} ${c.boards} boards  raw="${rawNames[i]}"  core: ${[...coreUnits(c)].map(shortId).join(', ')}`,
      );
    }
  }

  console.log(problems.length === 0 ? '\nOK — no invariant violations' : `\nPROBLEMS:\n  ${problems.join('\n  ')}`);
  await pool.end();
  if (problems.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
