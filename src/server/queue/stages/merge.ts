// merge.ts — Stage 6 (merge). Groups comps into carry-archetype buckets.
//
// Reads the comps that reach the tier list for the in-scope set(s), bulk-fetches
// their boards' unit/item data, runs carry-classify on each comp's boards to
// identify confirmed carries, then runs comp-merge to assign each comp to an
// archetype. The archetype label (sorted isBucketCarry character IDs,
// pipe-joined) is written back to comps.meta_comp. Idempotent — re-running
// overwrites the label.
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

import { pool } from '@/lib/db';
import type { JobContext } from '../job-tracking';
import {
  classifyCarries,
  bucketCarryIds,
  classifyHeroAugments,
  HERO_AUGMENT_CHAMPIONS,
  type RawUnitItem,
} from '../carry-classify';
import { mergeComps, type CompProfile } from '../comp-merge';

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

export interface MergeJob {
  /** Scope to one set. Default (undefined) = every set present in comps. */
  setNumber?: number;
}

export async function runMerge(job: MergeJob, ctx: JobContext): Promise<void> {
  const client = await pool.connect();
  try {
    // ── 1. Load tier-relevant comps in scope with their board counts. ─────────
    // comp_stats.n is per (comp, patch, region, rank_bucket), so SUM gives the
    // total observed boards for each comp (the archetype-freq weight) and MAX
    // gives its best single-bucket sample. HAVING MAX(cs.n) >= floor keeps only
    // comps that are tiered in at least one bucket — the exact set trend-tier
    // will render — so we don't burn minutes labeling the sub-threshold tail.
    // Comps with no comp_stats yet have all-NULL cs rows → MAX is NULL → excluded
    // (nothing to group until they roll up), which is correct.
    const compRes = await client.query<{
      id: number;
      set_number: number;
      core_units: string[];                                        // jsonb → string[]
      carries: { character_id: string; items: string[] }[];        // jsonb
      board_count: string;                                         // bigint → string
    }>(
      `SELECT c.id,
              c.set_number,
              c.core_units,
              c.carries,
              COALESCE(SUM(cs.n), 0) AS board_count
         FROM comps c
         LEFT JOIN comp_stats cs ON cs.comp_id = c.id
        WHERE ($1::int IS NULL OR c.set_number = $1)
        GROUP BY c.id
       HAVING MAX(cs.n) >= $2::int`,
      [job.setNumber ?? null, MERGE_MIN_SAMPLE],
    );

    if (compRes.rows.length === 0) {
      ctx.setItems(0);
      return;
    }

    const compIds = compRes.rows.map((r) => r.id);

    // ── 2. Bulk-fetch all boards' unit+item data for these comps. ─────────────
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

    // ── 3. Group raw unit rows by comp_id. ────────────────────────────────────
    const rawByComp = new Map<number, RawUnitItem[]>();
    for (const r of unitRes.rows) {
      const compId = r.comp_id;
      let arr = rawByComp.get(compId);
      if (!arr) { arr = []; rawByComp.set(compId, arr); }
      arr.push({ boardId: Number(r.board_id), characterId: r.character_id, items: r.item_ids });
    }

    // ── 4. Build a CompProfile per comp. ─────────────────────────────────────
    const profiles: CompProfile[] = [];

    for (const row of compRes.rows) {
      // core_units is a MULTISET (pg JSONB → string[]): the duplicate-copy augment
      // lists a unit more than once. Count copies so a board that doubles a unit
      // stays a distinct archetype from the classic single-copy build. The Set of
      // DISTINCT ids is what unit-overlap scoring uses; the doubled-unit set
      // (copySig) is a separate hard-fail guard in comp-merge.
      const copyCounts = new Map<string, number>();
      for (const u of row.core_units) copyCounts.set(u, (copyCounts.get(u) ?? 0) + 1);
      const units = new Set(copyCounts.keys());
      const copySig = [...copyCounts.entries()]
        .filter(([, c]) => c >= 2)
        .map(([id]) => id)
        .sort()
        .join('|');

      // 3-star signature from comps.carries (set by cluster.ts as threeStars).
      // Used as the "duplicate class" to prevent reroll comps with different
      // starred units from merging even when their other units overlap heavily.
      const threeStars = (row.carries as { character_id: string }[])
        .map((c) => c.character_id)
        .sort();
      const duplicateSig = threeStars.join('|');

      // Total boards for this comp from the sum of comp_stats. Use distinct
      // raw board_id count when raw rows exist (more accurate; filters to the
      // ranked queue), otherwise fall back to the stats aggregate.
      const rawRows   = rawByComp.get(row.id) ?? [];
      const statTotal = Number(row.board_count);
      const totalBoards = rawRows.length > 0
        ? new Set(rawRows.map((r) => r.boardId)).size
        : statTotal;

      // Run carry-classify on this comp's raw boards to identify item-based
      // carries (different from the 3-star-based carries in comps.carries).
      const classified = classifyCarries(rawRows, totalBoards);
      const carries    = new Set(bucketCarryIds(classified));

      // Hero augment: only champs that are BOTH 3-star in this comp's exact
      // signature (threeStars, above) AND eligible (HERO_AUGMENT_CHAMPIONS) can
      // be running one — being 3-star is comp-wide, so that half of the gate is
      // a set intersection here; classifyHeroAugments checks the per-board
      // itemization half. A board can only run one hero augment, so take the
      // strongest signal if more than one eligible champ somehow qualifies.
      const heroAugmentEligible = new Set(
        threeStars.filter((id) => HERO_AUGMENT_CHAMPIONS.has(id)),
      );
      const heroAugments = classifyHeroAugments(rawRows, totalBoards, heroAugmentEligible);
      const heroAugmentSig = heroAugments.find((h) => h.isHeroAugment)?.characterId ?? '';

      profiles.push({
        compId:       row.id,
        setNumber:    row.set_number,
        units,
        carries,
        duplicateSig,
        copySig,
        heroAugmentSig,
        boardCount:   statTotal > 0 ? statTotal : totalBoards,
      });
    }

    // ── 5. Run the merge algorithm. ───────────────────────────────────────────
    const { assignments, archetypes } = mergeComps(profiles);

    // ── 6. Write meta_comp labels back to comps. ──────────────────────────────
    const ids: number[] = [];
    const labels: string[] = [];
    for (const [compId, label] of assignments) {
      ids.push(compId);
      labels.push(label);
    }

    if (ids.length > 0) {
      await client.query(
        `UPDATE comps
            SET meta_comp = v.label
           FROM unnest($1::int[], $2::text[]) AS v(id, label)
          WHERE comps.id = v.id`,
        [ids, labels],
      );
    }

    // Items reported = tier-relevant comps labeled this pass (not the whole comp
    // table). This should track your tier-list size, ~a few hundred at most.
    ctx.setItems(ids.length);
    console.log(
      `[merge] ${ids.length} comps → ${archetypes.size} archetypes` +
      (job.setNumber ? ` (set ${job.setNumber})` : ''),
    );
  } finally {
    client.release();
  }
}