-- 0017_account_tier.sql
-- Rank-gating the crawl frontier (R1), and making rank_bucket mean something.
--
-- THE PROBLEM. Every board carried rank_bucket = 'challenger', not because it
-- was a Challenger board but because that was the 0009 column DEFAULT. The
-- crawler expands its frontier through every participant of every match it
-- fetches, so the sample reaches well below apex — 279 k accounts discovered
-- against ~18 k crawled, with the tier of exactly 6 of them known. The tier
-- selector was therefore describing a sample it did not describe.
--
-- THE FIX (see stages/ladder-crawl.ts). A candidate's tier is resolved lazily,
-- one league.byPuuid call at DRAIN time — ~1 call per player against the ~20
-- match calls that player is about to cost, so roughly 5 % overhead — and
-- cached here. Out-of-scope players are marked crawled and skipped without
-- spending the match budget. The resolved tier rides MatchFetchJob.bucket into
-- persistMatch, which now writes it per board.
--
-- THE DEFAULT becomes 'unknown' rather than 'challenger': a board whose rank we
-- could not establish must say so instead of claiming the top of the ladder.
--
-- EXISTING ROWS ARE LEFT AT 'challenger' ON PURPOSE. Rewriting 706 k historical
-- boards to 'unknown' would empty the live tier list in one statement, and the
-- honest label for that data ("apex-seeded, mixed") is a product decision, not a
-- migration decision. New boards get real buckets from here; the backfill call
-- is tracked in the audit's open-decisions section.

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS tier text;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS tier_checked_at timestamptz;

-- The drain reads (last_crawled_at, tier_checked_at) together.
CREATE INDEX IF NOT EXISTS accounts_tier_idx ON accounts (tier);

ALTER TABLE match_participants ALTER COLUMN rank_bucket SET DEFAULT 'unknown';
