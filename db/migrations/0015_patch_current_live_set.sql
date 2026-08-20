-- 0015_patch_current_live_set.sql
-- Clear an is_current flag sitting on a set we have no catalog for.
--
-- Rotating game modes (Double Up, the set-16 revival queue, event modes) replay
-- OLD sets on today's client version, so the same patch string exists for
-- several sets at once — "16.14" is present for sets 1, 16 and 17 in live data.
-- resolvePatchId compared patch strings without set awareness, so the first
-- revival match on a new patch could move the global flag onto its own set;
-- currentSet() then resolved to a set with no rows in `units` and the catalog,
-- Library and planner all rendered empty.
--
-- patch.ts now gates the writer to the live set and static-data.ts ignores a
-- flag on a catalog-less set, so this migration only cleans existing state. It
-- is a no-op when the flag is already correct. If it clears the only flagged
-- row, the next persisted match re-establishes it (a live set with no current
-- row reads as "none current"), and currentSet() falls back to the newest set
-- with units in the meantime.

UPDATE patches
   SET is_current = false
 WHERE is_current = true
   AND NOT EXISTS (SELECT 1 FROM units u WHERE u.set_number = patches.set_number);
