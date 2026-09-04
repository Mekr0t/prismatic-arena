-- 0023_comp_lines.sql
-- Tables for the presence-profile clustering model (DESIGN-2026-09-02-clustering.md).
--
-- ADDITIVE ONLY. `comps`, `comp_stats` and `meta_comp` are untouched and keep
-- serving the site; the elect stage writes here in parallel so the two models can
-- be compared on identical data before anything is cut over. An over-merge you
-- did not predict is only visible side by side.
--
-- WHAT A LINE IS. Not a board. A map from unit → the rate that unit appears on
-- boards of the line, so a board that missed one unit stays in its line instead
-- of spawning a row. Under the exact-multiset model a line's headline row was
-- its most common exact unit-set, which tracks BOARD SIZE and therefore
-- placement: measured on set 18, iron_gold headlines read +13 to +24pp top-4
-- HIGH while master_plus headlines on the same lines read 23–48pp LOW.

CREATE TABLE IF NOT EXISTS comp_lines (
  id          serial PRIMARY KEY,
  set_number  int  NOT NULL,
  -- Lines are elected per patch and do not outlive one: the meta changes at a
  -- boundary, old-patch numbers stop being useful, and nobody opens a link to
  -- last patch's comp. That is what removes the retirement machinery an earlier
  -- draft needed.
  patch_id    int  NOT NULL REFERENCES patches(id) ON DELETE CASCADE,

  -- IDENTITY, and what a re-election matches on. `core_units` is the ≥50% core;
  -- a re-elected profile whose core is within MIN_SEPARATION of this keeps this
  -- row's id, so /comps/<slug>-<id> survives the hourly pass.
  core_units  text[] NOT NULL,
  -- The full profile: [{characterId, rate}], rate-descending. Superset of
  -- core_units — it also carries the flex band, which is the statement the old
  -- model could not make (a 58% unit was either merged in or split off, and
  -- both were wrong).
  profile     jsonb  NOT NULL,

  -- DISPLAY. `slug` is cosmetic and may change when a naming collision resolves;
  -- the id is what resolves the URL, so a rename never 404s a shared link — the
  -- failure the `##k:` anchor caused under the old labelling.
  name        text NOT NULL,
  slug        text NOT NULL,

  -- Boards that homed to this line in the ELECTING scope (master+), which is
  -- what the listing floor and the coverage target are computed against.
  elected_boards int NOT NULL DEFAULT 0,
  computed_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (set_number, patch_id, slug)
);

CREATE INDEX IF NOT EXISTS comp_lines_patch_idx ON comp_lines (patch_id, elected_boards DESC);

-- Sufficient statistics per line, keyed by the DISJOINT tier rather than by a
-- cumulative scope. The scopes overlap (gold+ contains master+), so storing them
-- directly would duplicate every board across five rows and make the totals lie;
-- the read path sums the tiers a scope covers instead. Same sufficient-stat
-- shape as comp_stats, so comp-stats-math.ts serves both models unchanged.
--
-- `tier` is NULL for a board whose player's tier could not be established. That
-- is a real state, not a gap, and such rows are excluded from every cumulative
-- scope rather than being folded into the weakest one. Coverage rises on its own
-- as the crawl resolves accounts, and the rollup is a full recompute, so those
-- boards migrate into their scope with no repair step.
CREATE TABLE IF NOT EXISTS line_stats (
  id              bigserial PRIMARY KEY,
  line_id         int  NOT NULL REFERENCES comp_lines(id) ON DELETE CASCADE,
  patch_id        int  NOT NULL REFERENCES patches(id),
  region          text NOT NULL,             -- super-region: AMER / EMEA / APAC
  tier            text,                      -- Riot tier, NULL = unresolved
  n               int    NOT NULL DEFAULT 0,
  placement_sum   bigint NOT NULL DEFAULT 0,
  placement_sumsq bigint NOT NULL DEFAULT 0,
  top4_count      int    NOT NULL DEFAULT 0,
  win_count       int    NOT NULL DEFAULT 0,
  computed_at     timestamptz NOT NULL DEFAULT now()
);

-- NULLS NOT DISTINCT: without it, every unresolved-tier row is unique to
-- Postgres and the upsert inserts a duplicate on each pass instead of updating.
CREATE UNIQUE INDEX IF NOT EXISTS line_stats_scope_idx
  ON line_stats (line_id, patch_id, region, tier) NULLS NOT DISTINCT;

-- Which line each board homed to, or NULL for OFF-META — a board that matched no
-- line closely enough. Off-meta is a real answer and not a missing one: those
-- boards average 5.10 placement against 4.33 for homed ones, so forcing them
-- into the nearest line would import that average into a line's stats.
ALTER TABLE match_participants ADD COLUMN IF NOT EXISTS line_id int;
CREATE INDEX IF NOT EXISTS mp_line_idx ON match_participants (line_id);
