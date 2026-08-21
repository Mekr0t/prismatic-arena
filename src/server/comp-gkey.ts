// comp-gkey.ts — the archetype GROUPING KEY, as SQL, in one place.
//
// A comp belongs to an archetype via `comps.meta_comp` (the carry-archetype
// label the merge stage writes). A comp with no label keys on its own id, so it
// stands alone rather than collapsing every unlabeled comp into one null bucket.
//
// This lives in its own module because BOTH PLANES need it and they must not
// drift: the read plane groups the tier list and the detail page by it
// (comps-service, comp-detail-service), and the ingest plane groups the daily
// trend snapshot by it (stages/trend-tier). The read-plane modules import
// `next/cache` at module level, so a worker stage cannot reach the constant
// through them — hence a dependency-free module rather than an import across
// the plane boundary. Same reasoning as comp-signature.ts.
//
// Requires the `comps` table to be aliased as `c` in the query that interpolates
// it. Indexed by 0016_comps_gkey_index.sql — keep the expressions identical or
// the index stops being used.
export const GKEY_SQL = `COALESCE('m:' || NULLIF(c.meta_comp, ''), 'c:' || c.id::text)`;
