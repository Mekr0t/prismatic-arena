-- 0016_comps_gkey_index.sql
-- Index the read path's grouping key, and drop an index that can never be selective.
--
-- GROUPING-KEY INDEX. Every comps read derives the archetype key in SQL:
--     COALESCE('m:' || NULLIF(meta_comp, ''), 'c:' || id::text)
-- (`GKEY_SQL` in comps-service.ts). The tier list JOINs on it
-- (`JOIN unnest($4::text[]) AS wanted(gkey) ON wanted.gkey = <expr>`) and the
-- detail page filters on it (`AND <expr> = $4`). Against a computed expression
-- with no index that is a sequential scan of `comps` — 175 k rows / 231 MB —
-- on every page render. Every function in the expression is IMMUTABLE, so it
-- can be indexed directly.
--
-- DROPPED INDEX. mp_rank_bucket_idx (migration 0009) indexes a column whose
-- value is 'challenger' for 100 % of rows — the 0009 column default, since the
-- crawl never writes a real bucket. An index over a single distinct value can
-- never be selective; measured 19 scans lifetime against 21 MB of storage plus
-- a write on every match_participants insert. When R8 lands and the persist
-- path writes a real per-board bucket, re-create it (ideally as a composite
-- `(comp_id, rank_bucket)`, which is the shape the comp-detail queries want).

CREATE INDEX IF NOT EXISTS comps_gkey_idx
  ON comps ((COALESCE('m:' || NULLIF(meta_comp, ''), 'c:' || id::text)));

DROP INDEX IF EXISTS mp_rank_bucket_idx;
