-- 0012_unit_copy_index.sql
-- Allow multiple copies of the same unit on one board (duplicate-copy augment).
-- Replaces the UNIQUE(participant_id, character_id) constraint with a three-column
-- key that incluesd copy_index (0-based per character within a participant).
-- match-persist.ts assigns copy_index by counting occurrences of each character_id
-- as it iterates p.units; comps-service already aggregates copies correctly.

ALTER TABLE participant_units
  DROP CONSTRAINT participant_units_participant_character_key;

ALTER TABLE participant_units
  ADD COLUMN copy_index smallint NOT NULL DEFAULT 0;

ALTER TABLE participant_units
  ADD CONSTRAINT participant_units_participant_character_copy_key
  UNIQUE (participant_id, character_id, copy_index);
