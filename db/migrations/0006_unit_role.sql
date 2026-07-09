-- 0006_unit_role.sql
ALTER TABLE units ADD COLUMN IF NOT EXISTS role text;
