-- 0009_rank_bucket.sql
-- M4 rollup prerequisite: stamp each board with the rank bucket it was sampled
-- from, so comp_stats / bucket_totals / comp_stat_trends can roll up per
-- (comp, patch, region, rank_bucket).
--
-- The crawl is apex-only today (CRAWL.tiers = ['challenger']), so every existing
-- and new board is 'challenger' — hence the constant DEFAULT, which backfills
-- existing rows in place as a metadata-only change (no table rewrite on PG 11+).
--
-- STOPGAP — revisit when below-apex crawling lands (Risk R8): drop this DEFAULT
-- and have the match-fetch persist write MatchFetchJob.bucket per match, so
-- diamond/plat boards aren't silently tagged 'challenger'. (Profile-path
-- write-through also currently inherits this default; that's a minor impurity
-- while the sample is apex-only, and is addressed by the same R8 change.)

ALTER TABLE match_participants
  ADD COLUMN rank_bucket text NOT NULL DEFAULT 'challenger';

CREATE INDEX mp_rank_bucket_idx ON match_participants (rank_bucket);
