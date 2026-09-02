-- 0021_participant_tier.sql
-- Record the TIER of each board's own player, not just the coarse bucket of the
-- lobby it was sampled from.
--
-- WHY A BUCKET IS NOT ENOUGH. `rank_bucket` (0009, made real in 0017) is the
-- tier of the player the crawler DRAINED to reach a match, stamped onto all
-- eight boards on the stated grounds that "TFT lobbies are rank-homogeneous".
-- Measured 2026-09-02 against `accounts.tier`, that assumption does not hold at
-- the top of the ladder:
--
--     boards labelled master_plus, by the tier of the player who played them
--       MASTER        6,124
--       DIAMOND       3,087
--       EMERALD       2,274
--       GRANDMASTER     919
--       PLATINUM         61
--
-- Roughly 44 % of the "Master+" sample was played by accounts at Diamond or
-- below. That is not a bug in the crawl — the EUW Master population is ~120
-- accounts this early in the set, so matchmaking widens and pulls Diamond and
-- Emerald players into those lobbies. But it does mean `master_plus` describes
-- WHERE A BOARD WAS SAMPLED, not who played it, and the two were being read as
-- the same thing.
--
-- It also blocks the rank model the clustering rework needs: cumulative scopes
-- (gold+, platinum+, emerald+, diamond+, master+) cannot be derived from a
-- bucket that collapses IRON..GOLD into one label and MASTER..GRANDMASTER into
-- another.
--
-- SEMANTICS. `tier` is AS SAMPLED and never updated afterwards, the same
-- contract as `rank_bucket`: a board played in Gold stays a Gold board when its
-- player reaches Platinum, because a stats site that retroactively re-ranks its
-- own history cannot be aggregated. NULL means "we could not establish it",
-- which is a real value and must never be folded into a named tier — the same
-- rule the 0017 header sets out for 'unknown'.
--
-- `rank_bucket` is deliberately LEFT IN PLACE and unchanged. It still drives the
-- live read path, and the two columns answer different questions: the bucket is
-- the sampling frame, the tier is the player. Nothing has to move at once.

ALTER TABLE match_participants ADD COLUMN IF NOT EXISTS tier text;

-- Cumulative scopes select on a LIST of tiers (`tier = ANY(...)`), so a plain
-- b-tree on the column is the shape those queries want.
CREATE INDEX IF NOT EXISTS mp_tier_idx ON match_participants (tier);

-- BACKFILL from the tiers the crawl has already resolved. Every board whose own
-- player is a known account gets that account's tier — 42 k of the 166 k set-18
-- boards at the time of writing, and 86 % of the master_plus ones, which is
-- exactly where the correction matters.
--
-- The caveat, stated rather than hidden: `accounts.tier` is the tier as of the
-- last resolution, not as of the match. Over the days this data spans that is a
-- small error, and it is strictly better than the bucket it refines. Boards
-- whose player has no resolved tier are left NULL rather than guessed at.
--
-- Deliberately NOT filtered to rows where the tier agrees with `rank_bucket`:
-- the disagreements ARE the correction (see the Diamond/Emerald rows above), and
-- discarding them would preserve the very error this column exists to expose.
UPDATE match_participants mp
   SET tier = upper(a.tier)
  FROM accounts a
 WHERE a.puuid = mp.puuid
   AND a.tier IS NOT NULL
   AND mp.tier IS NULL;
