-- 0004_patch_backfill.sql
-- M1 foundation reconciliation:
--   1. Add unique constraints to participant sub-tables so Phase 3 ingest workers
--      can use ON CONFLICT DO NOTHING and stay idempotent.
--   2. Backfill patches from game_version strings already in matches.
--   3. Backfill matches.patch_id from the derived patch rows.

-- ── Idempotent sub-table constraints ────────────────────────────────────────
ALTER TABLE participant_units
  ADD CONSTRAINT participant_units_participant_character_key
  UNIQUE (participant_id, character_id);

ALTER TABLE participant_traits
  ADD CONSTRAINT participant_traits_participant_trait_key
  UNIQUE (participant_id, trait_id);

ALTER TABLE participant_augments
  ADD CONSTRAINT participant_augments_participant_slot_key
  UNIQUE (participant_id, slot);

-- ── Derive patch rows from existing match data ───────────────────────────────
-- game_version looks like "Version 14.11.633.5272 (Nov 05 2023 14:09:57 UTC)".
-- The first "N.NN" token is the canonical patch string.
INSERT INTO patches (set_number, patch)
SELECT DISTINCT
  set_number,
  (regexp_match(game_version, '\d+\.\d+'))[1] AS patch
FROM matches
WHERE game_version IS NOT NULL
  AND (regexp_match(game_version, '\d+\.\d+'))[1] IS NOT NULL
ON CONFLICT (set_number, patch) DO NOTHING;

-- ── Backfill matches.patch_id ────────────────────────────────────────────────
UPDATE matches m
SET patch_id = p.id
FROM patches p
WHERE p.set_number = m.set_number
  AND p.patch = (regexp_match(m.game_version, '\d+\.\d+'))[1]
  AND m.patch_id IS NULL;
