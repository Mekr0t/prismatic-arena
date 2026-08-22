// queue-ids.ts — Riot TFT queue ids.
//
// 1100 is Ranked TFT. It is the ONLY queue the meta is built from: cluster,
// rollup, merge and every read-side query filter on it, and match-persist now
// uses it to decide whether a match is worth storing boards for at all.
//
// That last use is why this constant exists instead of a fourth local copy. The
// filter used to be read-side only, so a drift between two copies just meant
// storing rows nobody read. Now the WRITER depends on it too, and a writer that
// disagrees with a reader doesn't waste space — it silently omits boards the
// reader is looking for, which is unrecoverable without a re-crawl.
export const RANKED_TFT_QUEUE_ID = 1100;

// KEPT IN SYNC BY HAND (read-plane SQL, where the id is inlined into the query
// text rather than imported): comp-detail-service.ts and comps-example-team.ts.
// If this value ever changes, change those too — grep for `queue_id = `.
