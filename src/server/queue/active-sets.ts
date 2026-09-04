import type { PoolClient } from 'pg';

// active-sets.ts — which sets the derived stages should still be recomputing.
//
// The stages are full re-derivations. Re-deriving a set nobody is crawling
// produces byte-identical output at full cost, and that cost is not small:
// measured 2026-09-04, cluster swept 775,608 boards of which 513,288 were set 17
// — a set that had not received a board since set 18 launched — and merge
// processed 258,331 set-17 comps out of 420,345 on every pass.
//
// Keyed on RECENT INGEST rather than on "the live set" deliberately. It needs no
// configuration and no set-rollover handling: a set drops out on its own when
// the crawler stops feeding it, comes back on its own if it is ever backfilled,
// and during a rollover BOTH sets are active, which is the correct answer rather
// than a special case.

const days = (): number => {
  const n = Number(process.env.PIPELINE_ACTIVE_DAYS ?? process.env.CLUSTER_ACTIVE_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 7;
};

/**
 * Sets with a match ingested inside the window, newest first.
 *
 * An empty result means every set is older than the window — in which case the
 * caller should fall back to processing everything rather than doing nothing,
 * because "no data is recent" must not silently mean "there is no work".
 */
export async function activeSets(client: PoolClient): Promise<number[]> {
  const res = await client.query<{ set_number: number }>(
    `SELECT DISTINCT set_number FROM matches
      WHERE set_number IS NOT NULL
        AND ingested_at > now() - make_interval(days => $1::int)
      ORDER BY set_number DESC`,
    [days()],
  );
  return res.rows.map((r) => r.set_number);
}

export const ACTIVE_SET_DAYS = days;
