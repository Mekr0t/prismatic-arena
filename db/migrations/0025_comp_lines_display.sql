-- 0025_comp_lines_display.sql
-- Display facts computed WITH the election, not re-derived on read.
--
-- All three are already known at elect time — the namer computes the carries and
-- the headline trait, and the example board falls out of the same member set —
-- so deriving them again per request would be both slower and capable of
-- disagreeing with the name the line is stored under.
--
-- THE EXAMPLE BOARD DOES NOT FOLLOW THE RANK DIAL. It is the line's canonical
-- board, elected with the line from master+ boards, and it stays the same at
-- every scope the detail page can select. A per-scope example would quietly turn
-- the page into "here is a different comp" as the user widens for sample.

ALTER TABLE comp_lines ADD COLUMN IF NOT EXISTS carries text[] NOT NULL DEFAULT '{}';
ALTER TABLE comp_lines ADD COLUMN IF NOT EXISTS trait_id text;

-- [{ characterId, rate, star, items[] }], rate-descending. `star` is 3 only when
-- the hit is the usual outcome for the players who field that unit, and `items`
-- is the modal build among boards that itemised it — both measured against the
-- boards that FIELDED the unit, never against every board in the line. The
-- difference is not cosmetic: a 58%-flex unit can never clear a rate bar
-- measured against the whole line, however consistently its players build it.
ALTER TABLE comp_lines ADD COLUMN IF NOT EXISTS example_board jsonb NOT NULL DEFAULT '[]'::jsonb;
