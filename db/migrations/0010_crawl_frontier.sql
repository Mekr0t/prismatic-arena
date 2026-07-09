-- 0010_crawl_frontier.sql
-- Frontier-draining crawl support.
--
-- The crawl now treats `accounts` as the registry of every known player and
-- drains it oldest-frontier-first, instead of re-seeding the apex ladder top
-- each pass (which left the ~7 discovered participants of every match uncrawled).
-- `last_crawled_at` marks when a player's match history was last fetched:
--   NULL  → never crawled (drained first)
--   < now() - CRAWL_RECRAWL_HOURS → stale, re-crawled to pick up new games

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS last_crawled_at timestamptz;

-- Drain order: never-crawled (NULL) first, then stalest. Matches the crawl's
-- `ORDER BY last_crawled_at ASC NULLS FIRST`.
CREATE INDEX IF NOT EXISTS accounts_last_crawled_idx
  ON accounts (last_crawled_at ASC NULLS FIRST);

-- One-time backfill: every player already seen as a match participant becomes an
-- (uncrawled) crawl candidate, so the drain works down the existing backlog from
-- the very first pass. routing is best-effort (it is NOT used to fetch — the
-- crawl fetches every seed on the crawl platform's route — only to satisfy the
-- NOT NULL column); current data is all EUW1 → europe.
INSERT INTO accounts (puuid, routing)
SELECT DISTINCT mp.puuid,
  CASE
    WHEN m.region IN ('NA1','BR1','LA1','LA2')              THEN 'americas'
    WHEN m.region IN ('KR','JP1')                            THEN 'asia'
    WHEN m.region IN ('OC1','PH2','SG2','TH2','TW2','VN2')   THEN 'asia'
    ELSE 'europe'
  END
FROM match_participants mp
JOIN matches m ON m.match_id = mp.match_id
ON CONFLICT (puuid) DO NOTHING;
