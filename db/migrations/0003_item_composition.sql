-- 0003_item_composition.sql
ALTER TABLE items ADD COLUMN IF NOT EXISTS composition text[] DEFAULT '{}';
