import { pool } from '@/lib/db';
import type { PoolClient } from 'pg';
import { RANKED_TFT_QUEUE_ID } from '@/config/queue-ids';
import { PLATFORMS, superRegionForPlatform } from '@/config/regions';
import { tiersAtOrAbove } from '@/config/rank-buckets';
import { MIN_BOARD_UNITS, isEmblemItem } from '../comp-signature';
import {
  MIN_SEPARATION,
  assignBoard,
  convergeCentroids,
  coreUnits,
  groupBoards,
  jaccard,
  nameCentroid,
  resolveNameCollisions,
  type Centroid,
  type ItemisationRate,
  type NameStatics,
  type TraitBreakpoint,
} from '../comp-centroid';
import type { JobContext } from '../job-tracking';

// elect.ts — the presence-profile clustering stage (DESIGN-2026-09-02-clustering.md).
//
// ADDITIVE. It writes only comp_lines / line_stats / match_participants.line_id;
// `comps`, `comp_stats` and `meta_comp` are untouched and keep serving the site,
// so the two models can be compared on identical data before anything cuts over.
//
// THE ASYMMETRY THAT MAKES IT WORK, and the thing most easily broken here:
// lines are ELECTED from master+ only, then EVERY board is assigned into them.
// A board that wins in Iron and loses in Master is not a different meta — Iron is
// less punishing, so it tolerates plays that do not work — so the strongest
// available evidence decides which lines exist, and weaker tiers only ever widen
// the sample. Measured: freezing the master+ centroids and assigning gold+ into
// them costs 2.7pp of homing against letting gold+ elect its own, and the boards
// it rejects average 5.12 placement against 4.19 for the homed ones. The rejects
// are the bad boards, which is why off-meta is NULL rather than nearest-line.
//
// SCOPED TO ONE PATCH. Lines do not outlive a patch: the meta changes at a
// boundary and old numbers stop being useful. That is what removes the
// centroid-retirement machinery an earlier draft needed.

export interface ElectJob {
  /** Elect for this set. Default: the live set (newest with both catalog and matches). */
  setNumber?: number;
}

const envInt = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Boards per scan chunk, mirroring cluster.ts — peak heap scales with a chunk's
 *  unit rows, not with the patch's board count. */
const SCAN_CHUNK = envInt(process.env.ELECT_SCAN_CHUNK, 25_000);
const WRITE_CHUNK = envInt(process.env.ELECT_WRITE_CHUNK, 5_000);

/** The tier floor lines are elected from. Everything else assigns into them. */
const ELECT_FLOOR = process.env.ELECT_TIER_FLOOR ?? 'MASTER';

/** Below this many electing boards the stage refuses to run rather than electing
 *  from noise — a degraded centroid set silently degrades everything downstream,
 *  and an empty tier list is a louder failure than a wrong one. */
const MIN_ELECT_BOARDS = envInt(process.env.ELECT_MIN_BOARDS, 2_000);

interface ScannedBoard {
  participantId: string;
  units: string[];
  placement: number;
  region: string;
  tier: string | null;
  /** Units carrying ≥2 non-emblem items — the naming scheme's carry evidence. */
  itemised: string[];
}

const yieldToEventLoop = () => new Promise<void>((r) => setImmediate(r));

// Platform code (as stored in matches.region) → super-region, as parallel arrays
// for SQL. Derived from config/regions.ts rather than listed here, so this and
// the rollup cannot drift apart about which platform belongs where.
const SUPER_CODES = PLATFORMS.map((p) => p.toUpperCase());
const SUPER_NAMES = PLATFORMS.map((p) => superRegionForPlatform(p));

async function loadStatics(client: PoolClient, setNumber: number): Promise<{
  statics: NameStatics;
  costs: Map<string, number>;
}> {
  const u = await client.query<{
    character_id: string;
    cost: number | null;
    name: string;
    trait_ids: string[] | null;
  }>(`SELECT character_id, cost, name, trait_ids FROM units WHERE set_number = $1`, [setNumber]);

  const costs = new Map<string, number>();
  const unitTraits = new Map<string, string[]>();
  const unitNames = new Map<string, string>();
  const unitCosts = new Map<string, number>();
  for (const r of u.rows) {
    costs.set(r.character_id, r.cost ?? 0);
    unitTraits.set(r.character_id, r.trait_ids ?? []);
    unitNames.set(r.character_id, r.name);
    unitCosts.set(r.character_id, r.cost ?? 0);
  }

  const t = await client.query<{ trait_id: string; name: string; breakpoints: unknown }>(
    `SELECT trait_id, name, breakpoints FROM traits WHERE set_number = $1`,
    [setNumber],
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

/**
 * Chunked scan of one patch's ranked boards.
 *
 * `tierFilter` restricts to the electing scope; null takes every board, which is
 * the assignment pass. Summons and unknown-cost units are excluded from identity
 * and cannot pad a short board, exactly as comp-signature does.
 */
async function scanBoards(
  client: PoolClient,
  patchId: number,
  costs: Map<string, number>,
  tierFilter: string[] | null,
  ctx: JobContext,
): Promise<ScannedBoard[]> {
  const out: ScannedBoard[] = [];
  let cursor = '0';

  for (;;) {
    const parts = await client.query<{
      id: string;
      placement: number;
      region: string;
      tier: string | null;
    }>(
      `SELECT mp.id, mp.placement, m.region, mp.tier
         FROM match_participants mp
         JOIN matches m ON m.match_id = mp.match_id
        WHERE m.queue_id = $1 AND m.patch_id = $2 AND m.player_count = 8
          AND mp.placement IS NOT NULL
          AND ($4::text[] IS NULL OR mp.tier = ANY($4::text[]))
          AND mp.id > $3::bigint
        ORDER BY mp.id
        LIMIT $5`,
      [RANKED_TFT_QUEUE_ID, patchId, cursor, tierFilter, SCAN_CHUNK],
    );
    if (parts.rows.length === 0) break;

    const ids = parts.rows.map((r) => r.id);
    const units = await client.query<{
      participant_id: string;
      character_id: string;
      item_ids: string[] | null;
    }>(
      `SELECT participant_id, character_id, item_ids
         FROM participant_units WHERE participant_id = ANY($1::bigint[])`,
      [ids],
    );

    const byPart = new Map<string, { units: Set<string>; itemised: Set<string> }>();
    for (const row of units.rows) {
      if ((costs.get(row.character_id) ?? 0) < 1 || (costs.get(row.character_id) ?? 0) > 5) continue;
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

    for (const p of parts.rows) {
      const e = byPart.get(p.id);
      if (!e || e.units.size < MIN_BOARD_UNITS) continue;
      out.push({
        participantId: p.id,
        units: [...e.units],
        placement: p.placement,
        region: p.region,
        tier: p.tier,
        itemised: [...e.itemised],
      });
    }

    cursor = ids[ids.length - 1];
    ctx.setItems(out.length);
    await yieldToEventLoop();
  }
  return out;
}

/** Itemisation rate per unit over the boards of one line that FIELDED it. The
 *  denominator matters: measured against every board in the line, a 58%-flex
 *  unit can never clear a rate bar however consistently its players build it. */
function itemisationFor(boards: readonly ScannedBoard[]): ItemisationRate[] {
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

const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'line';

interface PersistedLine {
  id: number;
  coreUnits: string[];
}

/**
 * Match freshly elected profiles onto the lines already stored for this patch,
 * so an hourly re-election does not churn every `/comps/<slug>-<id>` link.
 *
 * A profile keeps an existing id when its ≥50% core is within MIN_SEPARATION of
 * that line's. WHEN TWO PROFILES MATCH THE SAME LINE the larger takes the id and
 * the smaller is treated as new — arbitrary either way, but it has to be stated,
 * because "whichever we looked at first" is an order dependency and this model
 * exists to have none.
 */
function matchOntoExisting(
  centroids: readonly Centroid[],
  existing: readonly PersistedLine[],
): (number | null)[] {
  const taken = new Set<number>();
  const byBoards = [...centroids].sort((a, b) => b.boards - a.boards);
  const assigned = new Map<number, number | null>();

  for (const c of byBoards) {
    const core = coreUnits(c, 0.5);
    let best: { id: number; score: number } | null = null;
    for (const e of existing) {
      if (taken.has(e.id)) continue;
      const score = jaccard(core, new Set(e.coreUnits));
      if (score >= MIN_SEPARATION && (!best || score > best.score)) best = { id: e.id, score };
    }
    if (best) taken.add(best.id);
    assigned.set(c.index, best?.id ?? null);
  }
  return centroids.map((c) => assigned.get(c.index) ?? null);
}

export async function runElect(job: ElectJob, ctx: JobContext): Promise<void> {
  const client = await pool.connect();
  try {
    // The live set and its current patch. Lines are patch-scoped, so an
    // unresolved current patch means there is nothing to elect for.
    const scope = await client.query<{ set_number: number; patch_id: number }>(
      `SELECT p.set_number, p.id AS patch_id
         FROM patches p
        WHERE p.is_current = true
          AND ($1::int IS NULL OR p.set_number = $1)
        LIMIT 1`,
      [job.setNumber ?? null],
    );
    if (scope.rows.length === 0) {
      console.log('[elect] no current patch — nothing to elect');
      ctx.setItems(0);
      return;
    }
    const { set_number: setNumber, patch_id: patchId } = scope.rows[0];

    const { statics, costs } = await loadStatics(client, setNumber);

    // 1 ─ ELECT from the top of the ladder only.
    const electFloor = tiersAtOrAbove(ELECT_FLOOR);
    if (electFloor.length === 0) throw new Error(`ELECT_TIER_FLOOR is not a tier: ${ELECT_FLOOR}`);
    const electing = await scanBoards(client, patchId, costs, electFloor, ctx);
    if (electing.length < MIN_ELECT_BOARDS) {
      console.log(
        `[elect] only ${electing.length} ${ELECT_FLOOR}+ boards on patch ${patchId} ` +
          `(floor ${MIN_ELECT_BOARDS}) — refusing to elect from noise`,
      );
      ctx.setItems(0);
      return;
    }

    const res = convergeCentroids(groupBoards(electing.map((b) => ({ units: b.units }))));
    console.log(
      `[elect] set ${setNumber} patch ${patchId}: ${electing.length} ${ELECT_FLOOR}+ boards -> ` +
        `${res.centroids.length} lines in ${res.iterations} iterations ` +
        `(${((res.homedBoards / res.totalBoards) * 100).toFixed(1)}% homed)`,
    );

    // 2 ─ Name them, from the electing boards' own itemisation.
    const electedMembers = new Map<number, ScannedBoard[]>();
    const electedCounts = new Map<number, number>();
    for (const b of electing) {
      const hit = assignBoard(b.units, res.centroids);
      if (!hit) continue;
      const arr = electedMembers.get(hit.index);
      if (arr) arr.push(b);
      else electedMembers.set(hit.index, [b]);
      electedCounts.set(hit.index, (electedCounts.get(hit.index) ?? 0) + 1);
    }
    const rawNames = res.centroids.map((c) =>
      nameCentroid(c, itemisationFor(electedMembers.get(c.index) ?? []), statics),
    );
    const names = resolveNameCollisions(rawNames, res.centroids, statics);

    // 3 ─ Assign EVERY board on the patch, at every tier, into the frozen lines.
    const all = await scanBoards(client, patchId, costs, null, ctx);

    // 4 ─ One transaction: persist lines, stamp boards, rebuild line_stats.
    await client.query('BEGIN');
    try {
      const existing = await client.query<{ id: number; core_units: string[] }>(
        `SELECT id, core_units FROM comp_lines WHERE patch_id = $1 FOR UPDATE`,
        [patchId],
      );
      const matched = matchOntoExisting(
        res.centroids,
        existing.rows.map((r) => ({ id: r.id, coreUnits: r.core_units })),
      );

      const lineIdByIndex = new Array<number>(res.centroids.length);
      for (let i = 0; i < res.centroids.length; i++) {
        const c = res.centroids[i];
        const core = [...coreUnits(c, 0.5)].sort();
        const profile = JSON.stringify(c.units);
        const boards = electedCounts.get(c.index) ?? 0;
        // The slug carries the id's row, not the other way round: a rename must
        // never orphan a link, so the id is allocated first and the slug is just
        // what it currently reads as.
        const slug = `${slugify(names[i])}`;
        const existingId = matched[i];

        if (existingId !== null) {
          await client.query(
            `UPDATE comp_lines
                SET core_units = $2, profile = $3::jsonb, name = $4, slug = $5,
                    elected_boards = $6, computed_at = now()
              WHERE id = $1`,
            [existingId, core, profile, names[i], slug, boards],
          );
          lineIdByIndex[i] = existingId;
        } else {
          // No ON CONFLICT on the slug: it is cosmetic, and two lines may
          // legitimately share one when resolveNameCollisions finds nothing
          // honest to distinguish them. Upserting on it would overwrite a real
          // line with another (migration 0024).
          const ins = await client.query<{ id: number }>(
            `INSERT INTO comp_lines
               (set_number, patch_id, core_units, profile, name, slug, elected_boards)
             VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
             RETURNING id`,
            [setNumber, patchId, core, profile, names[i], slug, boards],
          );
          lineIdByIndex[i] = ins.rows[0].id;
        }
      }

      // A line elected on a previous pass but not this one keeps its row and its
      // URL — mid-patch link stability — but reports zero elected boards, so the
      // listing floor drops it without a 404.
      const keptIds = lineIdByIndex.length > 0 ? lineIdByIndex : [-1];
      await client.query(
        `UPDATE comp_lines SET elected_boards = 0, computed_at = now()
          WHERE patch_id = $1 AND NOT (id = ANY($2::int[])) AND elected_boards <> 0`,
        [patchId, keptIds],
      );

      // CLEAR FIRST, deliberately broader than the scan: a board that has left
      // scope must lose its stamp rather than keep a stale one forever. Same
      // rule, and the same reasoning, as cluster.ts.
      await client.query(
        `UPDATE match_participants mp
            SET line_id = NULL
           FROM matches m
          WHERE m.match_id = mp.match_id AND m.patch_id = $1 AND mp.line_id IS NOT NULL`,
        [patchId],
      );

      const stampIds: string[] = [];
      const stampLines: number[] = [];
      let homedAll = 0;
      for (const b of all) {
        const hit = assignBoard(b.units, res.centroids);
        if (!hit) continue; // off-meta: NULL, never nearest-line
        stampIds.push(b.participantId);
        stampLines.push(lineIdByIndex[hit.index]);
        homedAll += 1;
      }
      for (let s = 0; s < stampIds.length; s += WRITE_CHUNK) {
        await client.query(
          `UPDATE match_participants mp
              SET line_id = v.line_id
             FROM unnest($1::bigint[], $2::int[]) AS v(id, line_id)
            WHERE mp.id = v.id`,
          [stampIds.slice(s, s + WRITE_CHUNK), stampLines.slice(s, s + WRITE_CHUNK)],
        );
      }

      // 5 ─ line_stats, rebuilt for this patch from the stamps just written.
      // Keyed by DISJOINT tier; the read path sums the tiers a cumulative scope
      // covers, because the scopes overlap and storing them directly would
      // double-count every board.
      await client.query(`DELETE FROM line_stats WHERE patch_id = $1`, [patchId]);
      await client.query(
        `INSERT INTO line_stats
           (line_id, patch_id, region, tier, n, placement_sum, placement_sumsq,
            top4_count, win_count, computed_at)
         SELECT mp.line_id, m.patch_id,
                COALESCE(sr.super, m.region), mp.tier,
                count(*), sum(mp.placement), sum(mp.placement::bigint * mp.placement),
                count(*) FILTER (WHERE mp.placement <= 4),
                count(*) FILTER (WHERE mp.placement = 1),
                now()
           FROM match_participants mp
           JOIN matches m ON m.match_id = mp.match_id
           LEFT JOIN unnest($2::text[], $3::text[]) AS sr(code, super) ON sr.code = m.region
          WHERE mp.line_id IS NOT NULL AND m.patch_id = $1
          GROUP BY mp.line_id, m.patch_id, COALESCE(sr.super, m.region), mp.tier`,
        [patchId, SUPER_CODES, SUPER_NAMES],
      );

      await client.query('COMMIT');
      console.log(
        `[elect] stamped ${homedAll}/${all.length} boards ` +
          `(${((homedAll / all.length) * 100).toFixed(1)}% homed, ${all.length - homedAll} off-meta)`,
      );
      ctx.setItems(res.centroids.length);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  } finally {
    client.release();
  }
}
