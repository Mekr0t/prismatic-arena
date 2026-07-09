-- 0008_m4_derived.sql
-- M4 pipeline — the derived tier on top of the normalized observations.
-- (0005 descriptions, 0006 unit.role, 0007 ops tables precede this.)
--
--   comps             one canonical composition per set (signature-keyed)
--   comp_stats        per (comp, patch, region, rank_bucket) — CI sufficient stats
--   bucket_totals     total boards per (patch, region, rank_bucket) — play_rate denominator
--   comp_stat_trends  daily snapshots for patch velocity
--   tier_list_entries auto-generated + manual-override tier placements
--
-- Plus the FK from the already-existing match_participants.comp_id → comps(id).
-- Stats store SUFFICIENT STATISTICS, not derived rates/bounds: avg placement,
-- top-4/win rate, and Wilson/SEM intervals are all computed on read, so the
-- interval method can change without a re-crawl.

-- ── Comps (set-scoped: signature is built from set-stable IDs) ───────────────
CREATE TABLE comps (
  id          serial PRIMARY KEY,
  set_number  int  NOT NULL,
  signature   text NOT NULL,                  -- hash of sorted key traits + carries
  name        text,                           -- auto- or editor-generated label
  key_traits  jsonb NOT NULL DEFAULT '[]',    -- [{trait_id, min_units}]
  core_units  jsonb NOT NULL DEFAULT '[]',    -- [character_id, ...]
  carries     jsonb NOT NULL DEFAULT '[]',    -- [{character_id, items:[...]}]
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (set_number, signature)
);

-- match_participants.comp_id already exists (int, indexed by mp_comp_idx in 0001).
-- SET NULL on delete so re-clustering can replace comps without dropping boards.
ALTER TABLE match_participants
  ADD CONSTRAINT match_participants_comp_id_fkey
  FOREIGN KEY (comp_id) REFERENCES comps(id) ON DELETE SET NULL;

-- ── Comp stats: one row per (comp, patch, region, rank_bucket) ───────────────
CREATE TABLE comp_stats (
  id              bigserial PRIMARY KEY,
  comp_id         int  NOT NULL REFERENCES comps(id) ON DELETE CASCADE,
  patch_id        int  NOT NULL REFERENCES patches(id),
  region          text NOT NULL,              -- platform/region label, or 'all'
  rank_bucket     text NOT NULL,              -- e.g. 'plat_emerald', 'master_plus', 'all'
  -- CI sufficient statistics
  n               int    NOT NULL DEFAULT 0,
  placement_sum   bigint NOT NULL DEFAULT 0,  -- Σ placement
  placement_sumsq bigint NOT NULL DEFAULT 0,  -- Σ placement² (variance / SEM)
  top4_count      int    NOT NULL DEFAULT 0,
  win_count       int    NOT NULL DEFAULT 0,
  computed_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (comp_id, patch_id, region, rank_bucket)
);
CREATE INDEX comp_stats_lookup_idx ON comp_stats (patch_id, region, rank_bucket);

-- ── Bucket totals: play_rate denominator, maintained by the rollup ──────────
CREATE TABLE bucket_totals (
  patch_id     int  NOT NULL REFERENCES patches(id),
  region       text NOT NULL,
  rank_bucket  text NOT NULL,
  total_boards int  NOT NULL DEFAULT 0,
  computed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (patch_id, region, rank_bucket)
);

-- ── Daily trend snapshots (patch velocity reads these) ──────────────────────
CREATE TABLE comp_stat_trends (
  comp_id       int  NOT NULL REFERENCES comps(id) ON DELETE CASCADE,
  patch_id      int  NOT NULL REFERENCES patches(id),
  region        text NOT NULL,
  rank_bucket   text NOT NULL,
  snapshot_date date NOT NULL,
  n             int    NOT NULL DEFAULT 0,
  bucket_total  int    NOT NULL DEFAULT 0,     -- total boards in bucket that day (play-rate over time)
  placement_sum bigint NOT NULL DEFAULT 0,
  top4_count    int    NOT NULL DEFAULT 0,
  win_count     int    NOT NULL DEFAULT 0,
  PRIMARY KEY (comp_id, patch_id, region, rank_bucket, snapshot_date)
);
-- "what's rising/falling in this bucket" scans dates across comps.
CREATE INDEX comp_stat_trends_bucket_date_idx
  ON comp_stat_trends (patch_id, region, rank_bucket, snapshot_date);

-- ── Tier list: auto-generated, with admin override on top ───────────────────
CREATE TABLE tier_list_entries (
  id            bigserial PRIMARY KEY,
  patch_id      int  NOT NULL REFERENCES patches(id),
  region        text NOT NULL,
  rank_bucket   text NOT NULL,
  comp_id       int  NOT NULL REFERENCES comps(id) ON DELETE CASCADE,
  tier          text NOT NULL,                 -- S | A | B | C | D
  score         numeric,                       -- derived ranking score
  rank_order    int,
  is_manual     boolean NOT NULL DEFAULT false,
  override_note text,
  editor        text,                          -- admin label (no admin_users table)
  computed_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (patch_id, region, rank_bucket, comp_id)
);
CREATE INDEX tier_list_lookup_idx
  ON tier_list_entries (patch_id, region, rank_bucket, rank_order);
