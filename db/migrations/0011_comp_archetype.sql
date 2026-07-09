-- 0011_comp_archetype.sql
-- #3 — intent archetype per comp: 1cost_reroll | 2cost_reroll | 3cost_reroll |
-- fast8 | fast9 | standard. The clusterer assigns it from the board's cost/star
-- shape and it is part of the signature, so it's stable per comp. This column
-- just lets the UI show a tag chip without re-deriving. No backfill — the next
-- re-cluster repopulates every comp (and the new signatures replace the old).
ALTER TABLE comps ADD COLUMN IF NOT EXISTS archetype text;
