-- 0026_autovacuum_churn.sql
-- Autovacuum settings for the three tables the derived pipeline rewrites whole.
--
-- THE PROBLEM, measured 2026-09-04. Every pipeline pass rewrites all of
-- `comps.meta_comp`, all of `comp_stats` (DELETE + INSERT), and all of
-- `match_participants.comp_id` (clear-first, then stamp). At four passes an hour
-- that is a few million dead tuples an hour, and the default autovacuum
-- threshold — 20% of the table — is reached long after the damage is done:
--
--   match_participants   1,295,069 live · 1,928,277 dead (149%) · 1,905 MB
--   comps                  420,345 live ·   413,851 dead ( 98%) ·   703 MB
--   comp_stats             477,630 live ·   475,450 dead (100%) ·   202 MB
--
-- Roughly half of every page read was dead, which is what took `cluster` from
-- ~50 s to 247 s average and 1,034 s at worst. Nothing about the algorithm got
-- slower; it was reading twice the pages.
--
-- 2% instead of 20%, with a small cost limit lifted so the worker can actually
-- keep up. These tables are rewritten wholesale on a schedule, so vacuuming them
-- ten times more often is not wasted work — it is the only way the churn ever
-- gets reclaimed between passes.
--
-- This treats the symptom. The cause is that the derived stages rewrite whole
-- tables to express small changes, and the clustering rework removes the two
-- worst offenders outright (`elect` replaces both `cluster` and `merge`, and ran
-- the same work in 27 s).

ALTER TABLE match_participants SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_vacuum_cost_limit = 2000
);

ALTER TABLE comps SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_vacuum_cost_limit = 2000
);

ALTER TABLE comp_stats SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_vacuum_cost_limit = 2000
);
