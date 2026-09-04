-- 0024_comp_lines_slug.sql
-- The slug is COSMETIC; the id resolves the URL.
--
-- 0023 made (set_number, patch_id, slug) unique, which is wrong in a way that
-- loses data rather than erroring: two lines can legitimately generate the same
-- name. resolveNameCollisions appends a distinguishing unit when it can, but
-- deliberately returns the bare name when two profiles are genuinely
-- indistinguishable — inventing a difference there would be a lie. Under a
-- unique slug the second line's upsert then OVERWRITES the first instead of
-- being stored beside it, and a whole line disappears silently.
--
-- /comps/<slug>-<id> resolves on the id, so duplicate slugs are harmless: the
-- slug exists to make a link readable and to survive a rename, which is exactly
-- why it must not also be an identity.

ALTER TABLE comp_lines DROP CONSTRAINT IF EXISTS comp_lines_set_number_patch_id_slug_key;
CREATE INDEX IF NOT EXISTS comp_lines_slug_idx ON comp_lines (patch_id, slug);
