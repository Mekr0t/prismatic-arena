-- 0019_comp_stat_trends_date_idx.sql
-- Index comp_stat_trends by snapshot_date alone.
--
-- The existing comp_stat_trends_bucket_date_idx leads with patch_id, so it
-- cannot serve a predicate on snapshot_date by itself. Two statements in
-- trend-tier now need exactly that, on a table that had grown to 2.26 M rows /
-- 577 MB before retention existed:
--
--   • the per-day rewrite  DELETE ... WHERE snapshot_date = CURRENT_DATE
--   • the retention prune  DELETE ... WHERE snapshot_date < CURRENT_DATE - N
--
-- Without this index both are sequential scans of the whole table, every
-- pipeline pass.
CREATE INDEX IF NOT EXISTS comp_stat_trends_date_idx
  ON comp_stat_trends (snapshot_date);
