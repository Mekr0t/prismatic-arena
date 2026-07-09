-- 0001_init.sql
-- Phase 1 schema: static reference (versioned per set/patch), accounts & ranked,
-- and normalized match observations. Derived tables (comps, comp_stats,
-- tier_list_entries) and ops tables (ingestion_jobs, api_usage, saved_planners,
-- admin) arrive in a later migration with the Phase 3 pipeline.

-- ── Static reference (versioned per set/patch) ──────────────────────────────
CREATE TABLE patches (
  id          serial PRIMARY KEY,
  set_number  int  NOT NULL,
  patch       text NOT NULL,
  label       text,
  released_at timestamptz,
  is_current  boolean NOT NULL DEFAULT false,
  UNIQUE (set_number, patch)
);

CREATE TABLE units (
  id           serial PRIMARY KEY,
  set_number   int  NOT NULL,
  character_id text NOT NULL,
  name         text NOT NULL,
  cost         int,
  trait_ids    text[] NOT NULL DEFAULT '{}',
  icon_path    text,
  UNIQUE (set_number, character_id)
);

CREATE TABLE traits (
  id          serial PRIMARY KEY,
  set_number  int  NOT NULL,
  trait_id    text NOT NULL,
  name        text NOT NULL,
  breakpoints jsonb NOT NULL DEFAULT '[]',
  UNIQUE (set_number, trait_id)
);

CREATE TABLE augments (
  id         serial PRIMARY KEY,
  set_number int  NOT NULL,
  augment_id text NOT NULL,
  name       text NOT NULL,
  tier       text,
  UNIQUE (set_number, augment_id)
);

CREATE TABLE items (
  id         serial PRIMARY KEY,
  set_number int  NOT NULL,
  item_id    text NOT NULL,
  name       text NOT NULL,
  UNIQUE (set_number, item_id)
);

-- ── Accounts & ranked ───────────────────────────────────────────────────────
CREATE TABLE accounts (
  puuid          text PRIMARY KEY,
  game_name      text,
  tag_line       text,
  routing        text NOT NULL,        -- americas | europe | asia | sea
  last_synced_at timestamptz
);
CREATE INDEX accounts_riot_id_idx ON accounts (lower(game_name), lower(tag_line));

CREATE TABLE summoners (
  puuid           text NOT NULL REFERENCES accounts(puuid) ON DELETE CASCADE,
  platform        text NOT NULL,       -- na1 | euw1 | kr | ...
  summoner_id     text,                -- encrypted, region-scoped
  profile_icon_id int,
  summoner_level  int,
  updated_at      timestamptz,
  PRIMARY KEY (puuid, platform)
);
CREATE INDEX summoners_summoner_id_idx ON summoners (platform, summoner_id);

CREATE TABLE league_entries (
  id            bigserial PRIMARY KEY,
  puuid         text REFERENCES accounts(puuid) ON DELETE CASCADE,
  platform      text NOT NULL,
  queue         text NOT NULL,         -- RANKED_TFT
  tier          text,
  division      text,                  -- I..IV (null for apex tiers)
  league_points int,
  wins          int,
  losses        int,
  snapshot_at   timestamptz NOT NULL DEFAULT now()  -- history for LP graphs
);
CREATE INDEX league_entries_player_idx
  ON league_entries (puuid, platform, snapshot_at DESC);

-- ── Normalized match observations ───────────────────────────────────────────
-- One match yields 8 participant boards: the participant is the unit of analysis.
CREATE TABLE matches (
  match_id      text PRIMARY KEY,      -- e.g. 'EUW1_1234567890'
  region        text NOT NULL,
  patch_id      int REFERENCES patches(id),
  game_version  text,
  queue_id      int,
  set_number    int,
  game_datetime timestamptz,
  game_length   real,
  ingested_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX matches_datetime_idx ON matches (game_datetime DESC);
CREATE INDEX matches_patch_idx ON matches (patch_id);

CREATE TABLE match_participants (
  id           bigserial PRIMARY KEY,
  match_id     text NOT NULL REFERENCES matches(match_id) ON DELETE CASCADE,
  puuid        text NOT NULL,
  placement    int NOT NULL,           -- 1..8
  level        int,
  last_round   int,
  players_elim int,
  gold_left    int,
  total_dmg    int,
  companion    jsonb,
  comp_id      int,                    -- backfilled by the clusterer (Phase 3)
  UNIQUE (match_id, puuid)
);
CREATE INDEX mp_puuid_idx ON match_participants (puuid);
CREATE INDEX mp_comp_idx  ON match_participants (comp_id);

CREATE TABLE participant_units (
  id             bigserial PRIMARY KEY,
  participant_id bigint NOT NULL REFERENCES match_participants(id) ON DELETE CASCADE,
  character_id   text NOT NULL,
  star_tier      int,                  -- 1 | 2 | 3
  item_ids       text[] NOT NULL DEFAULT '{}',
  is_carry       boolean NOT NULL DEFAULT false
);
CREATE INDEX pu_participant_idx ON participant_units (participant_id);
CREATE INDEX pu_character_idx   ON participant_units (character_id);

CREATE TABLE participant_traits (
  id             bigserial PRIMARY KEY,
  participant_id bigint NOT NULL REFERENCES match_participants(id) ON DELETE CASCADE,
  trait_id       text NOT NULL,
  num_units      int,
  active_style   int                   -- 0 inactive, 1 bronze, 2 silver, ...
);
CREATE INDEX pt_participant_idx ON participant_traits (participant_id);

CREATE TABLE participant_augments (
  id             bigserial PRIMARY KEY,
  participant_id bigint NOT NULL REFERENCES match_participants(id) ON DELETE CASCADE,
  augment_id     text NOT NULL,
  slot           int                   -- 1 | 2 | 3
);
CREATE INDEX pa_participant_idx ON participant_augments (participant_id);
