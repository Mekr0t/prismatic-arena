-- 0007_ops_tables.sql
-- M3 (admin foundation + ops observability): operational tables.
-- (0005 = M2 description columns, 0006 = unit.role — neither touches these tables.)
--
-- Creates the two tables the pipeline-health panel reads:
--   * ingestion_jobs — BullMQ job health, written by the M4 workers.
--   * api_usage      — per-minute Riot request + 429 counters, written by the
--                      Riot client (src/lib/riot/client.ts) via a fire-and-forget upsert.
--
-- Both exist NOW (before M4) so the M3 panel has a frame to render and the M4
-- workers report into existing tables from their very first run.

CREATE TABLE ingestion_jobs (
  id           bigserial PRIMARY KEY,
  job_type     text NOT NULL,                  -- ladder_crawl | match_fetch | normalize | rollup | cluster | tier_gen
  region       text,                           -- platform or regional route the job targets (null = global)
  status       text NOT NULL DEFAULT 'queued', -- queued | running | success | failed
  started_at   timestamptz,
  finished_at  timestamptz,
  items_done   int NOT NULL DEFAULT 0,
  error_count  int NOT NULL DEFAULT 0,
  cursor       jsonb,                           -- resume point for interruptible crawls
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- "latest job per type" (last-success timestamps, stale-data alerts) and
-- "recent jobs" are the panel's two main reads.
CREATE INDEX ingestion_jobs_type_created_idx ON ingestion_jobs (job_type, created_at DESC);
CREATE INDEX ingestion_jobs_status_idx       ON ingestion_jobs (status);

CREATE TABLE api_usage (
  id            bigserial PRIMARY KEY,
  window_start  timestamptz NOT NULL,           -- truncated to the minute: date_trunc('minute', now())
  region        text NOT NULL,                  -- routing target the call used (e.g. euw1, europe)
  method        text NOT NULL,                  -- logical endpoint label (e.g. account.byRiotId, match.byId)
  request_count int NOT NULL DEFAULT 0,
  rate_429      int NOT NULL DEFAULT 0,
  UNIQUE (window_start, region, method)         -- enables the atomic per-call upsert from the client
);

-- Panel reads recent windows newest-first for the usage / 429 charts.
CREATE INDEX api_usage_window_idx ON api_usage (window_start DESC);