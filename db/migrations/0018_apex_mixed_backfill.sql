-- 0018_apex_mixed_backfill.sql
-- Relabel the pre-R1 boards from 'challenger' to 'apex_mixed'.
--
-- WHY. Until 0017 every board got rank_bucket = 'challenger' from a column
-- DEFAULT, not from anyone's actual rank. The crawler expanded its frontier
-- through every match participant, so that population is apex-SEEDED but
-- mixed-rank. Since R1 the crawl resolves each seed's tier and writes a real
-- bucket, so a verified 'master_plus' bucket now sits in the tier list beside a
-- 724 k-board 'challenger' bucket that is an artifact — a user comparing them
-- compares a measurement against a default value.
--
-- 'apex_mixed' is the honest name for that data: really collected, really from
-- apex-seeded lobbies, but never rank-verified. Relabelling keeps it selectable
-- and comparable instead of deleting a third of a million boards of real signal,
-- and it frees 'challenger' to rebuild from verified data.
--
-- SAFE TO RUN: verified before writing that zero 'challenger' boards had been
-- ingested in the preceding 6 hours and zero CHALLENGER accounts crawled since
-- R1 — so no genuinely-verified board is swept up. No 'apex_mixed' row exists
-- anywhere yet, so none of the UNIQUE constraints on the derived tables can
-- collide.
--
-- REVERSIBLE: every affected row held the same constant, so the inverse is
--   UPDATE ... SET rank_bucket = 'challenger' WHERE rank_bucket = 'apex_mixed';
--
-- comp_stats and bucket_totals are rebuilt from match_participants by the rollup
-- anyway, but they are relabelled here too so the tier list is consistent the
-- moment this lands rather than after the next pipeline pass. comp_stat_trends
-- is NOT rebuilt — relabelling it is what keeps the detail-page trend charts
-- continuous across the rename.

UPDATE match_participants SET rank_bucket = 'apex_mixed' WHERE rank_bucket = 'challenger';
UPDATE comp_stats         SET rank_bucket = 'apex_mixed' WHERE rank_bucket = 'challenger';
UPDATE bucket_totals      SET rank_bucket = 'apex_mixed' WHERE rank_bucket = 'challenger';
UPDATE comp_stat_trends   SET rank_bucket = 'apex_mixed' WHERE rank_bucket = 'challenger';
UPDATE tier_list_entries  SET rank_bucket = 'apex_mixed' WHERE rank_bucket = 'challenger';
