-- 0002_icon_paths.sql
ALTER TABLE traits ADD COLUMN IF NOT EXISTS icon_path text;
ALTER TABLE items  ADD COLUMN IF NOT EXISTS icon_path text;
