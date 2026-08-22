-- 0020_matches_player_count.sql
-- Record how many REAL players were in each match, and use it to keep
-- bot-filled lobbies out of the meta.
--
-- WHAT THIS FIXES. The audit logged a "short lobby" data-quality problem:
-- boards from matches with fewer than 8 stored participants posted a 72.9 %
-- top-4 rate against a prior that assumes 50 %, and it was recorded as a
-- genuine ongoing characteristic of Riot's payload. It is not. Measured
-- 2026-08-22: of the 955 ranked matches with fewer than 8 stored boards,
-- **955 contain a participant with the literal puuid 'BOT'** — every single
-- one — and NONE of them is short for any other reason.
--
-- The cause is in our own writer. AI-filled lobbies report every bot with the
-- same literal puuid 'BOT', and persistMatch inserts participants
-- `ON CONFLICT (match_id, puuid) DO NOTHING` — so all of a lobby's bots
-- collapse into ONE row. Verified: 3,064 matches contain a bot row, and every
-- one of them contains exactly one. An 8-player lobby with 4 bots stored 5
-- boards, which is what "short lobby" always was.
--
-- Two distinct harms, both closed by this column:
--   1. 3,064 bot boards were stored, and 1,825 of them had been CLUSTERED into
--      1,161 real comps at avg placement 6.34 — bot boards inside the meta.
--   2. The surviving human boards from those lobbies only had to beat bots, so
--      their placements are not comparable: 10,010 boards at avg 3.638 / 67.4 %
--      top-4. Removing bot rows leaves full lobbies at avg 4.500 / 50.00 %,
--      almost exactly the theoretical values — which is the tell that lobby
--      composition, not luck, was the whole effect.
--
-- persistMatch now skips 'BOT' participants outright and writes this column;
-- the cluster stage stamps comp_id only where player_count = 8, so bot-affected
-- boards go unclustered and the rollup (which aggregates `comp_id IS NOT NULL`)
-- drops them from comp_stats AND from bucket_totals, keeping the play-rate
-- numerator and denominator on the same population.
--
-- NULL means "not known" (a match stored before this column existed and having
-- no participant rows). `= 8` therefore excludes NULL, which is the safe
-- direction.
ALTER TABLE matches ADD COLUMN IF NOT EXISTS player_count int;

COMMENT ON COLUMN matches.player_count IS
  'Real (non-bot) participants in the match. 8 = a full competitive lobby; '
  'fewer means AI filled the empty seats. Only player_count = 8 feeds the meta.';

UPDATE matches m
   SET player_count = c.n
  FROM (
    SELECT match_id, count(*)::int AS n
      FROM match_participants
     WHERE puuid <> 'BOT'
     GROUP BY match_id
  ) c
 WHERE c.match_id = m.match_id
   AND m.player_count IS DISTINCT FROM c.n;
