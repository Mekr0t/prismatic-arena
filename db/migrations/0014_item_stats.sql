-- 0014_item_stats.sql
-- Item stat bonuses (CDragon `effects` map, curated to true stats) so the
-- Library / popup can show "+15% AD, +15 AP, …" instead of only the effect text.
ALTER TABLE items ADD COLUMN IF NOT EXISTS stats jsonb;
