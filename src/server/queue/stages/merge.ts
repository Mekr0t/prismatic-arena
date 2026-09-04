// merge.ts — Stage 6 (merge). Groups comps into carry-archetype buckets.
//
// Reads the comps that reach the tier list for the in-scope set(s), bulk-fetches
// their boards' unit/item data + static unit costs, builds a CompProfile per
// comp (comp-profile.ts: carries with top-itemized fallback, carry-grade 3★
// set, per-unit identity weights), then runs comp-merge to assign each comp to
// an archetype. The archetype label is written back to comps.meta_comp.
// Idempotent — re-running overwrites.
//
// SCOPE — universal, in three evidence tiers. Floored comps (MAX(cs.n) >=
// MERGE_MIN_SAMPLE in some bucket) get full itemization profiles (the
// participant_units fan-out stays bounded by the floor — that fan-out is what
// made the first universal-merge attempt multi-minute). Mid-tier comps
// (total >= MERGE_SEED_MIN_TOTAL) join the same merge with presence-only
// profiles. Singletons get assign-only labeling. The clustering itself stays
// event-loop-safe at this scale via comp-merge's candidate index + yield
// points, and the comps UPDATE runs in its own short transaction so merge
// can't deadlock with cluster.
//
// Pipeline position: after cluster (comps exist + comp_ids are stamped) and
// rollup (comp_stats.n is available as the boardCount weight AND the tier-floor
// filter). Run merge before trend-tier if the UI wants archetype groupings.

import type { PoolClient } from 'pg';
import { pool } from '@/lib/db';
import type { JobContext } from '../job-tracking';
import { activeSets } from '../active-sets';
import { buildCompProfile, buildTailProfile } from '../comp-profile';
import { mergeComps, makeTailAssigner, type CompProfile } from '../comp-merge';
import { emblemsFromSignature } from '../comp-signature';
import type { RawUnitItem } from '../carry-classify';
import { RANKED_TFT_QUEUE_ID } from '@/config/queue-ids';

// TFT Ranked queue id — keep Double Up / Hyper Roll / normals out.
// Re-exported from config so the writer (match-persist) and every reader agree.

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

// UNIVERSAL MERGE — the sub-floor population splits in two:
//
// MID-TIER (total boards >= MERGE_SEED_MIN_TOTAL, below the bucket floor):
// joins the REAL merge with presence-only profiles (comps-table data — units,
// 3★ set, level; no participant_units fetch). These comps may join floored
// archetypes (presence-proxied carries, assignTail's old bar) or seed/join
// micro-archetypes with EACH OTHER — the fix for niche lines fragmented across
// sub-floor hit-state signatures, which the assign-only tail could never
// consolidate (a 10-variant / 80-board reroll family used to render as 10
// separate singleton rows forever).
//
// SINGLETONS (below MERGE_SEED_MIN_TOTAL): assign-only against the frozen
// post-merge profiles, exactly the old tail pass. Missed-hit boards fragment
// across many exact signatures, so they disproportionately sit down here;
// without this pass every archetype's pooled stats stay survivorship-tilted.
const MERGE_SEED_MIN_TOTAL    = _num(process.env.MERGE_SEED_MIN_TOTAL, 2);
const MERGE_ASSIGN_MIN_SAMPLE = _num(process.env.MERGE_ASSIGN_MIN_SAMPLE, 1);

// Yield to the event loop every N tail comparisons — the merge worker shares
// its process with the match workers.
const ASSIGN_YIELD_EVERY = 500;

export interface MergeJob {
  /** Scope to one set. Default (undefined) = every set present in comps. */
  setNumber?: number;
}

/** Average final board level per comp (ranked boards only), set-scoped in one
 *  grouped pass over mp_comp_idx — feeds the merge-level LEVEL_CONFLICT_GAP
 *  intent guard for floored AND tail profiles. */
async function loadAvgLevels(
  client: PoolClient,
  setNumber?: number,
): Promise<Map<number, number>> {
  const res = await client.query<{ comp_id: number; avg_level: number }>(
    `SELECT mp.comp_id, AVG(mp.level)::float8 AS avg_level
       FROM match_participants mp
       JOIN matches m ON m.match_id = mp.match_id
      WHERE mp.comp_id IS NOT NULL
        AND mp.level IS NOT NULL
        AND m.queue_id = $2
        AND ($1::int IS NULL OR m.set_number = $1)
      GROUP BY mp.comp_id`,
    [setNumber ?? null, RANKED_TFT_QUEUE_ID],
  );
  const map = new Map<number, number>();
  for (const r of res.rows) map.set(r.comp_id, Number(r.avg_level));
  return map;
}

/** Static trait data for frame building, keyed by set like loadUnitCosts:
 *  unit → trait ids, trait → ascending breakpoint minUnits, and worn-emblem
 *  item → trait id (name convention `TFTn_Item_<X>EmblemItem` → `TFTn_<X>`,
 *  kept only when that trait actually exists for the set). */
export interface TraitStatics {
  unitTraits: Map<string, string[]>; // `${set}:${characterId}` → trait ids
  breakpoints: Map<string, number[]>; // `${set}:${traitId}` → minUnits asc
  emblemTrait: Map<string, string>; // `${set}:${itemId}` → traitId
}

async function loadTraitStatics(
  client: PoolClient,
  setNumber?: number,
): Promise<TraitStatics> {
  const [unitRes, traitRes] = await Promise.all([
    client.query<{ set_number: number; character_id: string; trait_ids: string[] | null }>(
      `SELECT set_number, character_id, trait_ids
         FROM units
        WHERE ($1::int IS NULL OR set_number = $1)`,
      [setNumber ?? null],
    ),
    client.query<{
      set_number: number;
      trait_id: string;
      breakpoints: { minUnits?: number }[] | null;
    }>(
      `SELECT set_number, trait_id, breakpoints
         FROM traits
        WHERE ($1::int IS NULL OR set_number = $1)`,
      [setNumber ?? null],
    ),
  ]);

  const unitTraits = new Map<string, string[]>();
  for (const r of unitRes.rows) {
    unitTraits.set(`${r.set_number}:${r.character_id}`, r.trait_ids ?? []);
  }
  const breakpoints = new Map<string, number[]>();
  for (const r of traitRes.rows) {
    const mins = (Array.isArray(r.breakpoints) ? r.breakpoints : [])
      .map((b) => b.minUnits ?? 0)
      .filter((m) => m > 0)
      .sort((a, b) => a - b);
    // Single-[1] traits are one-unit markers (FioraUniqueTrait, GravesTrait…)
    // — active on every board fielding the unit, so they carry no FRAME
    // information and only flatten the similarity (a dozen 1.0-weight marker
    // tokens drowned the real verticals when they were kept).
    if (mins.length === 1 && mins[0] === 1) continue;
    breakpoints.set(`${r.set_number}:${r.trait_id}`, mins);
  }
  // Emblem → trait by naming convention (TFT17_DarkStar → TFT17_Item_
  // DarkStarEmblemItem), derived from the trait id's own prefix so it can only
  // map emblems whose trait exists for the set.
  const emblemTrait = new Map<string, string>();
  for (const key of breakpoints.keys()) {
    const sep = key.indexOf(':');
    const setStr = key.slice(0, sep);
    const traitId = key.slice(sep + 1);
    const us = traitId.indexOf('_');
    if (us <= 0) continue;
    const pfx = traitId.slice(0, us); // e.g. 'TFT17'
    const suffix = traitId.slice(us + 1); // e.g. 'DarkStar'
    emblemTrait.set(`${setStr}:${pfx}_Item_${suffix}EmblemItem`, traitId);
  }
  return { unitTraits, breakpoints, emblemTrait };
}

/** Trait frame of one exact board: trait → activation index (how many
 *  breakpoints the DISTINCT-unit count clears — 1 = bronze, higher = deeper
 *  vertical; inactive traits are omitted). Copies never double-count a trait;
 *  each worn emblem adds one unit to its trait. */
function buildTraitFrame(
  setNumber: number,
  coreUnits: string[],
  emblems: string[],
  statics: TraitStatics,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const id of new Set(coreUnits)) {
    for (const t of statics.unitTraits.get(`${setNumber}:${id}`) ?? []) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  for (const e of emblems) {
    const t = statics.emblemTrait.get(`${setNumber}:${e}`);
    if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const frame = new Map<string, number>();
  for (const [t, n] of counts) {
    const mins = statics.breakpoints.get(`${setNumber}:${t}`);
    if (!mins || mins.length === 0) continue; // unknown/pseudo trait
    let idx = 0;
    for (const m of mins) if (n >= m) idx += 1;
    if (idx > 0) frame.set(t, idx);
  }
  return frame;
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

/** Static lookups shared by every profile loader in one merge run — the
 *  avg-level GROUP BY walks all of match_participants, so load it ONCE and
 *  pass it down instead of once per loader call. */
export interface MergeStatic {
  costs: Map<string, number>;
  levels: Map<number, number>;
  traits: TraitStatics;
}

export async function loadMergeStatic(
  client: PoolClient,
  setNumber?: number,
): Promise<MergeStatic> {
  return {
    costs: await loadUnitCosts(client, setNumber),
    levels: await loadAvgLevels(client, setNumber),
    traits: await loadTraitStatics(client, setNumber),
  };
}

/**
 * Load merge-ready CompProfiles for every tier-relevant comp in scope.
 * Shared by runMerge and scripts/merge-eval.ts so the eval replays the exact
 * production path.
 */
export async function loadCompProfiles(
  client: PoolClient,
  setNumber?: number,
  preloaded?: MergeStatic,
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

  // ── 3. Static lookups: costs (flex/copySig gates), levels, trait frames. ────
  const { costs: costBySetUnit, levels: avgLevels, traits: traitStatics } =
    preloaded ?? (await loadMergeStatic(client, setNumber));

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
      avgLevel: avgLevels.get(row.id) ?? 0,
      traitFrame: buildTraitFrame(
        row.set_number,
        row.core_units,
        emblemsFromSignature(row.signature),
        traitStatics,
      ),
    }),
  );
}

/**
 * Load light presence profiles for sub-floor comps in a total-board range:
 * `minTotal <= SUM(cs.n) < maxTotal` (maxTotal omitted = unbounded). Comps-table
 * data only — the sub-floor population is tens of thousands of rows, and it's
 * the participant_units fan-out (not this query) that made unfiltered merge
 * multi-minute. Callers: runMerge / merge-eval load the mid-tier
 * (>= MERGE_SEED_MIN_TOTAL, joins the real merge) and the singleton tail
 * (< MERGE_SEED_MIN_TOTAL, assign-only) as two slices of this.
 */
export async function loadTailProfiles(
  client: PoolClient,
  setNumber?: number,
  bounds?: { minTotal?: number; maxTotal?: number },
  preloaded?: MergeStatic,
): Promise<CompProfile[]> {
  const minTotal = bounds?.minTotal ?? MERGE_ASSIGN_MIN_SAMPLE;
  const maxTotal = bounds?.maxTotal ?? null;
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
        AND COALESCE(SUM(cs.n), 0) >= $3::int
        AND ($4::int IS NULL OR COALESCE(SUM(cs.n), 0) < $4::int)`,
    [setNumber ?? null, MERGE_MIN_SAMPLE, minTotal, maxTotal],
  );

  const { costs: costBySetUnit, levels: avgLevels, traits: traitStatics } =
    preloaded ?? (await loadMergeStatic(client, setNumber));

  return res.rows.map((row) =>
    buildTailProfile({
      compId: row.id,
      setNumber: row.set_number,
      coreUnits: row.core_units,
      threeStars: row.carries.map((c) => c.character_id),
      statTotal: Number(row.board_count),
      costOf: (id) => costBySetUnit.get(`${row.set_number}:${id}`) ?? 0,
      emblems: emblemsFromSignature(row.signature),
      avgLevel: avgLevels.get(row.id) ?? 0,
      traitFrame: buildTraitFrame(
        row.set_number,
        row.core_units,
        emblemsFromSignature(row.signature),
        traitStatics,
      ),
    }),
  );
}

export async function runMerge(job: MergeJob, ctx: JobContext): Promise<void> {
  const client = await pool.connect();
  try {
    // SKIP FROZEN SETS. Merge is a full re-derivation and its cost scales with
    // comp count; measured 2026-09-04 it processed 258,331 set-17 comps out of
    // 420,345 on every pass, for a set that had not received a board since set
    // 18 launched, and the pass took 1,162 s.
    //
    // Deliberately conservative: it narrows only when there is EXACTLY ONE
    // active set. Merge takes a single setNumber and its label-clearing is
    // scoped by it, so with two active sets — a rollover — narrowing to one
    // would freeze the other's labels while its comps were still moving.
    // Falling back to every set there is the safe direction, and rollovers are
    // rare and short.
    const active = job.setNumber === undefined ? await activeSets(client) : [];
    const setNumber = job.setNumber ?? (active.length === 1 ? active[0] : undefined);
    if (setNumber !== undefined && job.setNumber === undefined) {
      console.log(`[merge] scoped to the one active set (${setNumber})`);
    }

    const shared = await loadMergeStatic(client, setNumber);
    const floored = await loadCompProfiles(client, setNumber, shared);
    // Mid-tier presence profiles join the real merge (see MERGE_SEED_MIN_TOTAL).
    const mid = await loadTailProfiles(
      client,
      setNumber,
      { minTotal: MERGE_SEED_MIN_TOTAL },
      shared,
    );
    const profiles = [...floored, ...mid];

    if (profiles.length === 0) {
      ctx.setItems(0);
      return;
    }

    // ── Run the merge algorithm over floored + mid-tier comps. ──────────────
    const { assignments, archetypes, archetypeProfiles } = await mergeComps(profiles);

    const ids: number[] = [];
    const labels: string[] = [];
    for (const [compId, label] of assignments) {
      ids.push(compId);
      labels.push(label);
    }

    // ── Assign-only pass over the singleton tail. ────────────────────────────
    // Frozen archetype profiles, so order doesn't matter and nothing dilutes.
    const tail = await loadTailProfiles(
      client,
      setNumber,
      { maxTotal: MERGE_SEED_MIN_TOTAL },
      shared,
    );
    const assign = makeTailAssigner(archetypeProfiles);
    let tailAssigned = 0;
    for (let i = 0; i < tail.length; i++) {
      if (i > 0 && i % ASSIGN_YIELD_EVERY === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const label = assign(tail[i]);
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
      // NOT EXISTS over a CTE, not `id NOT IN (SELECT unnest(array))`.
      //
      // The NOT IN form is what made this stage look algorithmically slow: with
      // ~76,000 assigned ids it was measured at 651 s ALONE, on a freshly
      // vacuumed table with no lock contention — Postgres cannot turn a NOT IN
      // over a large array into a hash anti-join (it has to preserve NULL
      // semantics), so it re-evaluated the set per candidate row. The CTE lets
      // it hash once and anti-join, which is the same answer in seconds.
      //
      // The scope MUST match the run: a clear wider than the merge nulls the
      // labels of every comp it did not look at, so narrowing the merge to one
      // set while clearing all of them would wipe a frozen set's labels
      // wholesale, and the tier list for those patches with them.
      await client.query(
        `WITH assigned AS (SELECT unnest($2::int[]) AS id)
         UPDATE comps c
            SET meta_comp = NULL
          WHERE ($1::int IS NULL OR c.set_number = $1)
            AND c.meta_comp IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM assigned a WHERE a.id = c.id)`,
        [setNumber ?? null, ids],
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

    // Items reported = comps labeled this pass (merged + assigned tail).
    ctx.setItems(ids.length);
    console.log(
      `[merge] ${floored.length} floored + ${mid.length} mid-tier → ${archetypes.size} archetypes; ` +
      `singles: ${tailAssigned}/${tail.length} assigned` +
      (setNumber ? ` (set ${setNumber})` : ''),
    );
  } finally {
    client.release();
  }
}
