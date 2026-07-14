// merge.ts — Stage 6 (merge). Groups comps into carry-archetype buckets.
//
// Reads the comps that reach the tier list for the in-scope set(s), bulk-fetches
// their boards' unit/item data + static unit costs, builds a CompProfile per
// comp (comp-profile.ts: carries with top-itemized fallback, carry-grade 3★
// set, per-unit identity weights), then runs comp-merge to assign each comp to
// an archetype. The archetype label is written back to comps.meta_comp.
// Idempotent — re-running overwrites.
//
// SCOPE — tier-relevant comps only. Merge used to label EVERY exact-board comp
// (tens of thousands), but the tier list only shows comps whose per-bucket
// sample reaches TIER_MIN_SAMPLE. Grouping the sub-threshold long tail is pure
// waste: those comps never render, and diluting the archetype profiles with
// thousands of n=1/2 boards makes the grouping of the comps that DO matter worse,
// not better. So the input is filtered to comps that are tiered in at least one
// bucket (MAX(cs.n) >= MERGE_MIN_SAMPLE). This is what keeps the JS clustering
// loop and the comps UPDATE sub-second instead of multi-minute — which is what
// stops merge from starving the shared event loop and holding a long transaction
// that deadlocks with cluster.
//
// Pipeline position: after cluster (comps exist + comp_ids are stamped) and
// rollup (comp_stats.n is available as the boardCount weight AND the tier-floor
// filter). Run merge before trend-tier if the UI wants archetype groupings.

import type { PoolClient } from 'pg';
import { pool } from '@/lib/db';
import type { JobContext } from '../job-tracking';
import { buildCompProfile, buildTailProfile } from '../comp-profile';
import { mergeComps, assignTail, type CompProfile } from '../comp-merge';
import { emblemsFromSignature } from '../comp-signature';
import type { RawUnitItem } from '../carry-classify';

// TFT Ranked queue id — keep Double Up / Hyper Roll / normals out.
const RANKED_TFT_QUEUE_ID = 1100;

const _num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

// Only comps whose best single-bucket sample reaches the tier floor are worth
// grouping — everything below never reaches the tier list (trend-tier gates on
// the same per-bucket `n >= TIER_MIN_SAMPLE`). Defaults to TIER_MIN_SAMPLE so
// the merge floor tracks the tier floor automatically; set MERGE_MIN_SAMPLE to
// decouple (e.g. to pre-label comps that are close to qualifying).
const MERGE_MIN_SAMPLE = _num(process.env.MERGE_MIN_SAMPLE ?? process.env.TIER_MIN_SAMPLE, 15);

// Sub-floor comps with at least this many total boards get an assign-only
// labeling attempt against the frozen archetype profiles (comps-table data
// only — no participant_units fetch, which is what the floor exists to avoid).
// Missed-hit boards fragment across many exact signatures, so they
// disproportionately sit below the floor; without this pass every archetype's
// pooled stats stay survivorship-tilted.
const MERGE_ASSIGN_MIN_SAMPLE = _num(process.env.MERGE_ASSIGN_MIN_SAMPLE, 1);

// Yield to the event loop every N tail comparisons — the merge worker shares
// its process with the match workers.
const ASSIGN_YIELD_EVERY = 500;

export interface MergeJob {
  /** Scope to one set. Default (undefined) = every set present in comps. */
  setNumber?: number;
}

/** Static unit costs for the in-scope set(s), keyed `${set}:${characterId}`. */
async function loadUnitCosts(
  client: PoolClient,
  setNumber?: number,
): Promise<Map<string, number>> {
  const res = await client.query<{
    set_number: number;
    character_id: string;
    cost: number | null;
  }>(
    `SELECT set_number, character_id, cost
       FROM units
      WHERE ($1::int IS NULL OR set_number = $1)`,
    [setNumber ?? null],
  );
  const bySetUnit = new Map<string, number>();
  for (const r of res.rows) {
    bySetUnit.set(`${r.set_number}:${r.character_id}`, r.cost ?? 0);
  }
  return bySetUnit;
}

/**
 * Load merge-ready CompProfiles for every tier-relevant comp in scope.
 * Shared by runMerge and scripts/merge-eval.ts so the eval replays the exact
 * production path.
 */
export async function loadCompProfiles(
  client: PoolClient,
  setNumber?: number,
): Promise<CompProfile[]> {
  // ── 1. Tier-relevant comps in scope with their board counts. ───────────────
  // comp_stats.n is per (comp, patch, region, rank_bucket), so SUM gives the
  // total observed boards for each comp (the archetype-freq weight) and MAX
  // gives its best single-bucket sample. HAVING MAX(cs.n) >= floor keeps only
  // comps that are tiered in at least one bucket — the exact set trend-tier
  // will render. Comps with no comp_stats yet have all-NULL cs rows → MAX is
  // NULL → excluded (nothing to group until they roll up), which is correct.
  const compRes = await client.query<{
    id: number;
    set_number: number;
    signature: string;
    core_units: string[];                                        // jsonb → string[]
    carries: { character_id: string; items: string[] }[];        // jsonb
    board_count: string;                                         // bigint → string
  }>(
    `SELECT c.id,
            c.set_number,
            c.signature,
            c.core_units,
            c.carries,
            COALESCE(SUM(cs.n), 0) AS board_count
       FROM comps c
       LEFT JOIN comp_stats cs ON cs.comp_id = c.id
      WHERE ($1::int IS NULL OR c.set_number = $1)
      GROUP BY c.id
     HAVING MAX(cs.n) >= $2::int`,
    [setNumber ?? null, MERGE_MIN_SAMPLE],
  );

  if (compRes.rows.length === 0) return [];

  const compIds = compRes.rows.map((r) => r.id);

  // ── 2. Bulk-fetch all boards' unit+item data for these comps. ──────────────
  // One row per (board × unit × copy). carry-classify handles copy dedup. Now
  // scoped to the ~tier-list-sized comp set, so this stays small.
  const unitRes = await client.query<{
    comp_id: number;
    board_id: string;   // bigint → string
    character_id: string;
    item_ids: string[];
  }>(
    `SELECT mp.comp_id,
            mp.id       AS board_id,
            pu.character_id,
            pu.item_ids
       FROM match_participants mp
       JOIN matches m ON m.match_id = mp.match_id
       JOIN participant_units pu ON pu.participant_id = mp.id
      WHERE mp.comp_id = ANY($1::int[])
        AND m.queue_id = $2`,
    [compIds, RANKED_TFT_QUEUE_ID],
  );

  // ── 3. Static unit costs (flex/cap-slot detection + copySig gate). ─────────
  const costBySetUnit = await loadUnitCosts(client, setNumber);

  // ── 4. Group raw unit rows by comp_id and build profiles. ──────────────────
  const rawByComp = new Map<number, RawUnitItem[]>();
  for (const r of unitRes.rows) {
    let arr = rawByComp.get(r.comp_id);
    if (!arr) { arr = []; rawByComp.set(r.comp_id, arr); }
    arr.push({ boardId: Number(r.board_id), characterId: r.character_id, items: r.item_ids });
  }

  return compRes.rows.map((row) =>
    buildCompProfile({
      compId: row.id,
      setNumber: row.set_number,
      coreUnits: row.core_units,
      // 3-star ids from comps.carries (set by cluster.ts as threeStars).
      threeStars: row.carries.map((c) => c.character_id),
      statTotal: Number(row.board_count),
      rawRows: rawByComp.get(row.id) ?? [],
      costOf: (id) => costBySetUnit.get(`${row.set_number}:${id}`) ?? 0,
      emblems: emblemsFromSignature(row.signature),
    }),
  );
}

/**
 * Load light profiles for the sub-floor tail: every comp in scope below the
 * merge floor but with >= MERGE_ASSIGN_MIN_SAMPLE total boards. Comps-table
 * data only — the tail is tens of thousands of rows, and it's the
 * participant_units fan-out (not this query) that made unfiltered merge
 * multi-minute. Shared with scripts/merge-eval.ts.
 */
export async function loadTailProfiles(
  client: PoolClient,
  setNumber?: number,
): Promise<CompProfile[]> {
  const res = await client.query<{
    id: number;
    set_number: number;
    signature: string;
    core_units: string[];
    carries: { character_id: string }[];
    board_count: string;
  }>(
    `SELECT c.id,
            c.set_number,
            c.signature,
            c.core_units,
            c.carries,
            COALESCE(SUM(cs.n), 0) AS board_count
       FROM comps c
       LEFT JOIN comp_stats cs ON cs.comp_id = c.id
      WHERE ($1::int IS NULL OR c.set_number = $1)
      GROUP BY c.id
     HAVING COALESCE(MAX(cs.n), 0) < $2::int
        AND COALESCE(SUM(cs.n), 0) >= $3::int`,
    [setNumber ?? null, MERGE_MIN_SAMPLE, MERGE_ASSIGN_MIN_SAMPLE],
  );

  const costBySetUnit = await loadUnitCosts(client, setNumber);

  return res.rows.map((row) =>
    buildTailProfile({
      compId: row.id,
      setNumber: row.set_number,
      coreUnits: row.core_units,
      threeStars: row.carries.map((c) => c.character_id),
      statTotal: Number(row.board_count),
      costOf: (id) => costBySetUnit.get(`${row.set_number}:${id}`) ?? 0,
      emblems: emblemsFromSignature(row.signature),
    }),
  );
}

export async function runMerge(job: MergeJob, ctx: JobContext): Promise<void> {
  const client = await pool.connect();
  try {
    const profiles = await loadCompProfiles(client, job.setNumber);

    if (profiles.length === 0) {
      ctx.setItems(0);
      return;
    }

    // ── Run the merge algorithm over the floored comps. ─────────────────────
    const { assignments, archetypes, archetypeProfiles } = mergeComps(profiles);

    const ids: number[] = [];
    const labels: string[] = [];
    for (const [compId, label] of assignments) {
      ids.push(compId);
      labels.push(label);
    }

    // ── Assign-only pass over the sub-floor tail. ────────────────────────────
    // Frozen archetype profiles, so order doesn't matter and nothing dilutes.
    const tail = await loadTailProfiles(client, job.setNumber);
    let tailAssigned = 0;
    for (let i = 0; i < tail.length; i++) {
      if (i > 0 && i % ASSIGN_YIELD_EVERY === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const label = assignTail(tail[i], archetypeProfiles);
      if (label !== null) {
        ids.push(tail[i].compId);
        labels.push(label);
        tailAssigned++;
      }
    }

    // ── Write labels + clear stale ones, one short transaction. ─────────────
    // All JS work is done above, so the transaction is only these statements
    // (the old cluster-deadlock risk came from computing inside the tx).
    // Unassigned comps get their label CLEARED — a label from a previous run
    // whose archetype no longer exists must not linger (pre-floor-era stale
    // labels are what once hung the inspector). The IS DISTINCT FROM guard
    // keeps the hourly rerun from rewriting tens of thousands of unchanged
    // rows (pg makes a dead tuple even for same-value updates).
    await client.query('BEGIN');
    try {
      await client.query(
        `UPDATE comps
            SET meta_comp = NULL
          WHERE ($1::int IS NULL OR set_number = $1)
            AND meta_comp IS NOT NULL
            AND id NOT IN (SELECT unnest($2::int[]))`,
        [job.setNumber ?? null, ids],
      );
      if (ids.length > 0) {
        await client.query(
          `UPDATE comps
              SET meta_comp = v.label
             FROM unnest($1::int[], $2::text[]) AS v(id, label)
            WHERE comps.id = v.id
              AND comps.meta_comp IS DISTINCT FROM v.label`,
          [ids, labels],
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }

    // Items reported = comps labeled this pass (floored + assigned tail).
    ctx.setItems(ids.length);
    console.log(
      `[merge] ${profiles.length} comps → ${archetypes.size} archetypes; ` +
      `tail: ${tailAssigned}/${tail.length} assigned` +
      (job.setNumber ? ` (set ${job.setNumber})` : ''),
    );
  } finally {
    client.release();
  }
}
