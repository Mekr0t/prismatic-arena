-- 0005_descriptions.sql
-- M2 static data extension: add description/ability/stats columns so the
-- Library and click-through popups have rich content to display.

-- Units: ability name, rich description text, and base stats.
ALTER TABLE units ADD COLUMN IF NOT EXISTS ability_name text;
ALTER TABLE units ADD COLUMN IF NOT EXISTS ability_desc text;
ALTER TABLE units ADD COLUMN IF NOT EXISTS stats jsonb;

-- Traits: top-level description (bonus text that applies across breakpoints).
ALTER TABLE traits ADD COLUMN IF NOT EXISTS description text;

-- Items: description text.
ALTER TABLE items ADD COLUMN IF NOT EXISTS description text;

-- Augments: description text and icon (icon was never stored).
ALTER TABLE augments ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE augments ADD COLUMN IF NOT EXISTS icon_path text;
