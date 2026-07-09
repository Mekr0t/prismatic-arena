-- 0013_meta_comp.sql
-- Archetype grouping label written by Stage 6 (merge).
-- Groups structurally similar comps (shared carry unit + sufficient unit
-- overlap) under a common label: sorted isBucketCarry character IDs,
-- pipe-joined (e.g. "TFT17_Aurora|TFT17_Diana"). NULL until the merge
-- stage has run for the set.
ALTER TABLE comps ADD COLUMN IF NOT EXISTS meta_comp text;
