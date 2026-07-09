# TFT Stats Platform — Foundation Plan

**Status:** Draft v1 · **Owner:** TBD · **Last updated:** 2026-06-13
**Scope:** Public TFT stats website + internal admin/analytics platform, powered by the official Riot Games TFT API plus a derived match-mining pipeline.

This single document covers all six deliverables from the brief: product requirements, architecture, data model, Riot API integration plan, UI/UX plan, and a phased roadmap with risks. It is written to be carried into a real dev environment (Claude Code) and turned into a repo.

---

## 0. Locked decisions

These are the six open questions, decided. Override any of them and the affected sections change, but nothing here is a one-way door.

| # | Question | Decision | Why |
|---|----------|----------|-----|
| 1 | One region or global? | **One platform first (EUW1 or NA1), region-aware everywhere from day one.** | A dev key cannot feed a global ingest. Riot's API is already regionalized, so multi-region is later config, not a rewrite. |
| 2 | Live vs scheduled data? | **Hybrid: profiles on-demand (short cache), all stats/comps/tier-lists batch-computed on a schedule.** | Tier lists physically cannot be computed inside a user request under rate limits. |
| 3 | Planner scope? | **Phase 2: URL-encoded shareable state + export code. Saved/named builds deferred until auth exists.** | URL state makes sharing free and accountless. In-game import is *not* assumed (see Risk R5). |
| 4 | Tier lists: manual or automated? | **Automated rankings are the source of truth; admin gets an override/annotation layer on top.** | Satisfies the editorial requirement without making editors do the math. |
| 5 | Patch-specific by default? | **Yes. Default every stats view to the current patch; retain history for trends.** | Live set is **Set 17 "Space Gods," patch 17.5.** Patch format is `set.patch` (first number = set, ~8 patches/set). Cross-patch aggregates are noise. |
| 6 | Stack? | **Next.js (App Router) + React + Node + PostgreSQL + Redis + BullMQ + a Data Dragon / Community Dragon static-data loader.** | Exactly the proposed stack; the queue and static loader are the only additions. |

**Region recommendation:** start with **EUW1** (large, active ladder = dense match data for the pipeline) or **NA1**. Pick one and treat it as the seed region.

---

## 1. Product requirements (condensed PRD)

### 1.1 Goal
Give TFT players fast, accurate, patch-aware answers to: *"How is this player doing?"*, *"What happened in this game?"*, *"What comps are strong right now?"*, and *"Help me plan a board."* Give the operator a dashboard to monitor data health, curate featured content, and read traffic/usage analytics.

### 1.2 Primary users
- **Player / climber** — looks up themselves and others, studies match history, reads the tier list, copies a comp.
- **Theorycrafter** — uses the comp explorer with deep filters and the team planner.
- **Operator/admin** — monitors ingestion health, overrides tier placements, curates featured comps, reads analytics.

### 1.3 Public feature set
- Search by **Riot ID** (`gameName#tagLine`); summoner-name search is deprecated by Riot and not built.
- **Player profile**: current rank + LP, ranked win/loss, recent placements, average placement, top-4 rate, most-played comps/traits/units, recent augment choices.
- **Match detail**: all 8 boards, each with units (+ star level + items), active traits at their breakpoints, augments, placement, level, gold left, last round, damage to players.
- **Leaderboards**: apex ladder (Challenger / Grandmaster / Master) + ranked ladder per region, sortable.
- **Comp explorer**: derived comps with filters for rank bucket, region, patch, traits, units, placement band, and minimum sample size; sortable by avg placement / top-4 / play rate.
- **Tier list**: auto-generated per patch + region + rank bucket, with admin overrides surfaced.
- **Stats pages**: unit / trait / augment performance (avg placement when included, frequency, by patch).
- **Team planner**: selectable units and traits with live trait-activation readout, an export/share code, and a shareable URL.
- Global search, filtering, sorting, responsive desktop + mobile.

### 1.4 Admin feature set
- Featured-content editor (homepage spotlights, featured comps).
- Tracked-comps management (watchlist with alerting on metric shifts).
- Tier-list override editor (pin tier, reorder, annotate, with attribution + audit).
- Analytics: traffic, search usage, comp popularity, planner usage.
- Pipeline health: job status, last-success timestamps, error rates, API-usage and 429 monitoring, stale-data alerts.

### 1.5 Explicit non-goals (v1)
- No real-time in-game overlay (Riot has no push/event stream for this).
- No user accounts on the public site until the planner needs saved builds.
- No esports/tournament data (Tournament API is a separate track).

---

## 2. Architecture

Three planes that intentionally barely touch each other. The read plane never blocks on the ingest plane; the ingest plane never blocks on user traffic.

```
                         ┌─────────────────────────────────────────┐
                         │            STATIC DATA PLANE             │
                         │  Data Dragon + Community Dragon loader   │
                         │  units / traits / items / augments       │
                         │  versioned per set + patch → Postgres    │
                         └───────────────┬─────────────────────────┘
                                         │ (read-only reference)
   ┌──────────────┐   HTTP   ┌───────────▼───────────┐
   │   Browser    │ ───────► │   READ PLANE           │
   │ (Next.js UI) │ ◄─────── │   Next.js server +     │
   └──────────────┘          │   API routes           │
                             │   • profiles (on-demand│
                             │     w/ short cache)    │
                             │   • stats/comps/tiers   │
                             │     (precomputed only) │
                             └───┬───────────────┬────┘
                                 │ read          │ read/write cache
                       ┌─────────▼────┐   ┌──────▼──────┐
                       │  PostgreSQL  │   │    Redis    │
                       │ (normalized  │   │ cache +     │
                       │  + derived)  │   │ BullMQ queue│
                       └─────────▲────┘   └──────▲──────┘
                                 │ write         │ jobs
                             ┌───┴───────────────┴────────────────┐
                             │        INGEST / COMPUTE PLANE       │
                             │  Node workers (BullMQ):             │
                             │   • ladder crawler                  │
                             │   • match fetcher                   │
                             │   • normalizer                      │
                             │   • comp clusterer                  │
                             │   • metric rollups + tier generator │
                             │  Shared Riot API client             │
                             │  (throttle + retry + cache)         │
                             └───────────────┬─────────────────────┘
                                             │ HTTPS
                                   ┌─────────▼─────────┐
                                   │   Riot Games API  │
                                   └───────────────────┘
```

### 2.1 The shared Riot API client (the keystone)
Every Riot call — user-facing or batch — goes through one module. Everything else depends on getting this right.
- **Token-bucket throttle** keyed by `(region, method)` to respect both the app rate limit (per region) and per-method limits.
- **Header-aware**: Riot's limits are dynamic and returned in `X-App-Rate-Limit` / `X-Method-Rate-Limit` / `Retry-After`; read them and adapt rather than hardcoding.
- **Retry with backoff** on `429` and `5xx`, honoring `Retry-After`.
- **Response cache** in Redis with per-endpoint TTLs (see §4.3).
- **Priority lanes**: user-facing requests jump the queue ahead of batch crawl requests so a backlog of mining never starves a live profile lookup.

### 2.2 Read plane
Next.js App Router with server components for data pages. Profile pages may trigger an on-demand refresh (rate-limited, short TTL); every other data surface reads **only** precomputed rows from Postgres/Redis and never calls Riot synchronously.

### 2.3 Ingest/compute plane
Independent Node worker process(es) driven by BullMQ. Four job families: ladder crawl → match fetch → normalize → roll up + cluster + generate tiers. Scheduled via repeatable jobs (e.g., crawl continuously, roll up hourly, regenerate tiers per patch or daily).

### 2.4 Static data plane
A scheduled loader pulls champion/trait/item/augment definitions from **Data Dragon** and **Community Dragon**, versioned by set + patch. This is the lookup layer that turns raw `character_id` / `trait_id` strings from match data into names, costs, icons, and trait breakpoints. It must be re-runnable on every patch and especially on set rotation.

---

## 3. Data model

PostgreSQL. Three tiers: **static reference** (versioned per set/patch), **normalized observations** (raw match facts), and **derived** (comps, stats, tier lists). Plus ops tables. DDL below is a sketch — types and indexes get refined in implementation.

### 3.1 Static reference (versioned)

```sql
patches (
  id              serial PRIMARY KEY,
  set_number      int  NOT NULL,        -- e.g. 17
  patch           text NOT NULL,        -- e.g. '17.5'
  label           text,                 -- 'Space Gods'
  released_at     timestamptz,
  is_current      bool DEFAULT false,
  UNIQUE (set_number, patch)
);

units (
  id            serial PRIMARY KEY,
  set_number    int  NOT NULL,
  character_id  text NOT NULL,          -- Riot's id, e.g. 'TFT17_Aurora'
  name          text NOT NULL,
  cost          int,
  trait_ids     text[] ,
  icon_path     text,
  UNIQUE (set_number, character_id)
);

traits (
  id            serial PRIMARY KEY,
  set_number    int  NOT NULL,
  trait_id      text NOT NULL,
  name          text NOT NULL,
  breakpoints   jsonb,                  -- [{units:2,style:1}, {units:4,style:2}, ...]
  UNIQUE (set_number, trait_id)
);

augments (
  id            serial PRIMARY KEY,
  set_number    int  NOT NULL,
  augment_id    text NOT NULL,
  name          text NOT NULL,
  tier          text,                   -- silver/gold/prismatic
  UNIQUE (set_number, augment_id)
);

items (
  id            serial PRIMARY KEY,
  set_number    int  NOT NULL,
  item_id       text NOT NULL,
  name          text NOT NULL,
  UNIQUE (set_number, item_id)
);
```

### 3.2 Accounts & ranked

```sql
accounts (
  puuid           text PRIMARY KEY,     -- the durable cross-region id
  game_name       text,
  tag_line        text,
  routing         text,                 -- americas | asia | europe | sea
  last_synced_at  timestamptz
);

summoners (
  puuid           text REFERENCES accounts(puuid),
  platform        text NOT NULL,        -- na1 | euw1 | kr | ...
  summoner_id     text,                 -- encrypted, region-scoped
  profile_icon_id int,
  summoner_level  int,
  updated_at      timestamptz,
  PRIMARY KEY (puuid, platform)
);

league_entries (
  id            bigserial PRIMARY KEY,
  puuid         text REFERENCES accounts(puuid),
  platform      text NOT NULL,
  queue         text NOT NULL,          -- RANKED_TFT
  tier          text,                   -- IRON..CHALLENGER
  division      text,                   -- I..IV (null for apex)
  league_points int,
  wins          int,
  losses        int,
  snapshot_at   timestamptz NOT NULL    -- keep history for LP graphs
);
```

### 3.3 Normalized match observations
One match detail returns **8 participant boards** — the unit of analysis is the participant, not the player.

```sql
matches (
  match_id       text PRIMARY KEY,      -- e.g. 'EUW1_1234567890'
  region         text NOT NULL,
  patch_id       int REFERENCES patches(id),
  game_version   text,
  queue_id       int,
  set_number     int,
  game_datetime  timestamptz,
  game_length    real,
  ingested_at    timestamptz DEFAULT now()
);

match_participants (
  id              bigserial PRIMARY KEY,
  match_id        text REFERENCES matches(match_id),
  puuid           text,
  placement       int NOT NULL,         -- 1..8
  level           int,
  last_round      int,
  players_elim    int,
  gold_left       int,
  total_dmg       int,
  companion       jsonb,
  comp_id         int,                  -- backfilled by clusterer (FK comps)
  UNIQUE (match_id, puuid)
);

participant_units (
  id              bigserial PRIMARY KEY,
  participant_id  bigint REFERENCES match_participants(id),
  character_id    text NOT NULL,
  star_tier       int,                  -- 1/2/3
  item_ids        text[],
  is_carry        bool                  -- derived: itemized / highest cost
);

participant_traits (
  id              bigserial PRIMARY KEY,
  participant_id  bigint REFERENCES match_participants(id),
  trait_id        text NOT NULL,
  num_units       int,
  active_style    int                   -- 0=inactive,1=bronze,2=silver,...
);

participant_augments (
  id              bigserial PRIMARY KEY,
  participant_id  bigint REFERENCES match_participants(id),
  augment_id      text NOT NULL,
  slot            int                   -- 1/2/3
);
```

### 3.4 Derived: comps, stats, tier lists

```sql
comps (
  id            serial PRIMARY KEY,
  patch_id      int REFERENCES patches(id),
  signature     text NOT NULL,          -- canonical hash of key traits + carries
  name          text,                   -- editor- or auto-generated label
  key_traits    jsonb,                  -- [{trait_id, min_units}]
  core_units    jsonb,                  -- [character_id, ...]
  carries       jsonb,                  -- [{character_id, items:[...]}]
  created_at    timestamptz DEFAULT now(),
  UNIQUE (patch_id, signature)
);

comp_stats (
  id            bigserial PRIMARY KEY,
  comp_id       int REFERENCES comps(id),
  patch_id      int REFERENCES patches(id),
  region        text,
  rank_bucket   text,                   -- e.g. 'challenger', 'diamond_plus', 'all'
  sample_size   int,
  avg_placement numeric(4,3),
  top4_rate     numeric(5,4),
  win_rate      numeric(5,4),           -- placement = 1
  play_rate     numeric(5,4),
  computed_at   timestamptz,
  UNIQUE (comp_id, patch_id, region, rank_bucket)
);

comp_stat_trends (                       -- time series for trend lines
  comp_id       int REFERENCES comps(id),
  region        text,
  rank_bucket   text,
  bucket_date   date,
  sample_size   int,
  avg_placement numeric(4,3),
  PRIMARY KEY (comp_id, region, rank_bucket, bucket_date)
);

tier_list_entries (
  id               bigserial PRIMARY KEY,
  patch_id         int REFERENCES patches(id),
  region           text,
  rank_bucket      text,
  comp_id          int REFERENCES comps(id),
  tier             text,                -- S / A / B / C / D
  score            numeric,             -- derived ranking score
  rank_order       int,
  is_manual        bool DEFAULT false,  -- admin override
  override_note    text,
  editor_id        int,
  computed_at      timestamptz,
  UNIQUE (patch_id, region, rank_bucket, comp_id)
);
```

### 3.5 Ops, admin, planner

```sql
ingestion_jobs (
  id            bigserial PRIMARY KEY,
  job_type      text,                   -- ladder_crawl | match_fetch | normalize | rollup | tier_gen
  region        text,
  status        text,                   -- queued | running | success | failed
  started_at    timestamptz,
  finished_at   timestamptz,
  items_done    int,
  error_count   int,
  cursor        jsonb                   -- resume point
);

api_usage (
  id            bigserial PRIMARY KEY,
  window_start  timestamptz,
  region        text,
  method        text,
  request_count int,
  rate_429      int
);

saved_planners (                         -- Phase 2, anonymous + shareable
  id            uuid PRIMARY KEY,
  code          text,                   -- export/import code
  units         jsonb,                  -- [{character_id, position, items}]
  traits_cache  jsonb,
  set_number    int,
  created_at    timestamptz DEFAULT now()
);

admin_users      ( id, email, role, created_at );          -- admin auth only
featured_content ( id, kind, payload jsonb, position, active, updated_by );
tracked_comps    ( id, comp_id, watch_reason, created_by, alert_threshold );
```

---

## 4. Riot API integration plan

### 4.1 Routing (gets people every time)
- **Regional hosts** (`americas` / `asia` / `europe` / `sea`) serve **ACCOUNT-V1** and **TFT-MATCH-V1**.
- **Platform hosts** (`na1` / `euw1` / `kr` / `br1` / …) serve **TFT-SUMMONER-V1**, **TFT-LEAGUE-V1**, **TFT-STATUS-V1**.
- Maintain a platform→routing map (e.g. `euw1 → europe`, `na1 → americas`, `kr → asia`).

### 4.2 Endpoint reference

| Purpose | Endpoint | Host |
|---|---|---|
| Riot ID → PUUID | `GET /riot/account/v1/accounts/by-riot-id/{gameName}/{tagLine}` | regional |
| PUUID → Riot ID (refresh names) | `GET /riot/account/v1/accounts/by-puuid/{puuid}` | regional |
| PUUID → summoner (id, level, icon) | `GET /tft/summoner/v1/summoners/by-puuid/{puuid}` | platform |
| summonerId → summoner (for apex crawl) | `GET /tft/summoner/v1/summoners/{summonerId}` | platform |
| Ranked entries for a player | `GET /tft/league/v1/entries/by-summoner/{summonerId}` | platform |
| Apex ladders | `GET /tft/league/v1/{challenger\|grandmaster\|master}` | platform |
| Ladder by tier/division (paged) | `GET /tft/league/v1/entries/{tier}/{division}?page=N` | platform |
| Recent match IDs | `GET /tft/match/v1/matches/by-puuid/{puuid}/ids?start=0&count=20` | regional |
| Match detail | `GET /tft/match/v1/matches/{matchId}` | regional |
| Platform status | `GET /tft/status/v1/platform-data` | platform |

> Prefer PUUID-based variants wherever Riot offers them; the league-by-summonerId path above is the reliable established route. Verify whether a `league/v1/by-puuid` variant is live for TFT in current docs and switch if so.

### 4.3 Profile lookup flow (user-facing, on-demand)
```
Riot ID  →[Account-V1]→  PUUID
PUUID    →[TFT-Summoner-V1]→  summonerId, level, icon
summonerId →[TFT-League-V1 by-summoner]→  rank, LP, W/L
PUUID    →[TFT-Match-V1 ids]→  recent matchIds
matchId  →[TFT-Match-V1 detail]→  full match (cache aggressively)
```
Suggested cache TTLs: account/summoner identity ~24h; rank ~10 min; match IDs ~5 min; **match detail effectively immutable → cache for days/forever.** A profile is ~3–4 calls + N match details, most of which are cache hits after the first view.

### 4.4 Rate-limit strategy
- **Dev key reality:** the standard development key ceiling is ~**20 req/s and 100 req/2 min**, and the key **expires every 24h and must be regenerated manually** — build key rotation into dev tooling now, and never commit a key. Dev limits are enough to *build* on, nowhere near enough to mine a region.
- **Production key:** requires a formal application + approval, and grants higher, per-method limits negotiated with Riot. Apply early; commercial/public use is gated and policy-bound (see R3).
- The shared client's token buckets, header-reading, backoff, and priority lanes (§2.1) are what keep us under both app and method limits and keep the key off the blacklist.

### 4.5 Ingest crawl (batch, the hard part)
There is **no "best comps" endpoint** — meta data is mined. The crawl is a throttled BFS over players, but the efficiency win is that **each match detail yields 8 participant boards**, so we harvest 8 comp samples per match request rather than looking up players one by one.

```
1. SEED: pull apex ladders (challenger/GM/master) for the region → summonerIds
2. RESOLVE: summonerId → PUUID  (TFT-Summoner-V1 by-id)
3. FAN OUT: PUUID → recent match IDs (TFT-Match-V1)
4. DEDUPE: skip matchIds already in `matches`
5. FETCH: match detail → store match + 8 participants + their units/traits/augments
6. EXPAND: enqueue the 8 participants' PUUIDs as new frontier (rank-gated)
7. THROTTLE: all calls go through the shared client; batch lane yields to user lane
```
Rank-gate the frontier (e.g. Diamond+ only) so the sample reflects the rank bucket you advertise. Tag every match with its `patch_id` so rollups stay patch-scoped.

### 4.6 Comp clustering + metrics
Reduce each participant board to a **canonical signature**, then aggregate.
1. Compute the board's **active traits at breakpoint** (from `participant_traits` where `active_style > 0`).
2. Identify **carries** (most-itemized units, tie-broken by cost).
3. Signature = sorted(key active traits) + sorted(carries). Hash it → `comps.signature`.
4. Upsert the comp; backfill `match_participants.comp_id`.
5. Roll up per `(comp, patch, region, rank_bucket)`: `sample_size = count`, `avg_placement = avg(placement)`, `top4_rate = avg(placement ≤ 4)`, `win_rate = avg(placement = 1)`, `play_rate = count / total_boards_in_bucket`.
6. Enforce a **minimum sample size** before a comp is shown or tiered (small samples lie).
7. **Tier score** combines avg placement + top-4 rate, weighted by sample confidence; map score bands → S/A/B/C/D; admin overrides set `is_manual = true` and win on display.

Clustering granularity is the part that needs iteration — too coarse merges distinct lines, too fine fragments the same comp into noise. Start trait+carry-based and tune.

---

## 5. UI/UX plan

Visual direction and component styling are deferred to the build (frontend-design pass in Claude Code). This is the information architecture.

### 5.1 Pages
- **Home** — search front-and-center, current-patch tier-list teaser, featured comps, meta-shift highlights.
- **Player profile** — header (rank, LP, icon, region) → ranked summary (avg placement, top-4 rate, games) → recent matches list → most-played comps/units/traits/augments.
- **Match detail** — all 8 boards side by side; each board expandable to units (star + items), traits at breakpoints, augments; placement and end-state stats.
- **Leaderboards** — apex + ladder per region, paged, sortable, links to profiles.
- **Comp explorer** — filter rail (rank bucket, region, patch, traits, units, placement band, min sample) + sortable results (avg placement, top-4, play rate, trend); row → comp detail.
- **Comp detail** — the canonical board, items per carry, stat block, placement distribution, trend chart, sample size + patch + bucket clearly labeled.
- **Tier list** — grouped S→D per patch/region/rank bucket, override badges visible.
- **Stats** — unit / trait / augment tables (avg placement when included, frequency, by patch).
- **Team planner** — board grid + unit picker + live trait-activation readout; **export code** button (copies a portable encoding) and a **shareable URL** that round-trips the board via encoded state.

### 5.2 Cross-cutting UX
- Global search bar (Riot ID) in the header on every page.
- Patch + region + rank-bucket selectors are first-class, persistent controls on all stats surfaces; every stat is labeled with the patch/region/bucket and sample size it came from.
- Filtering, sorting, responsive layouts; mobile collapses filter rails into sheets.
- Honest empty/low-sample states ("not enough games yet this patch").

### 5.3 Admin
- Auth-gated (admin accounts only).
- **Pipeline health** — job table with status + last-success timestamps, error rates, API-usage/429 charts, stale-data alerts (e.g. "no fresh matches in N hours").
- **Tier-list override editor** — pin tier, reorder, annotate, with attribution + audit trail.
- **Featured-content editor** — homepage spotlights and featured comps.
- **Tracked comps** — watchlist with metric-shift alerting.
- **Analytics** — traffic, search usage, comp popularity, planner usage.

---

## 6. Roadmap, risks, assumptions

### 6.1 Phase 1 — MVP (walking skeleton first)
The first build target is the smallest end-to-end slice that proves the whole data flow:
> **Riot ID search → PUUID → profile (rank + match IDs) → one match detail rendered.**

Then expand to the full Phase 1 set:
- Shared Riot API client (throttle + header-aware backoff + Redis cache + priority lanes).
- Static-data loader (Set 17 units/traits/items/augments).
- Player profile + match-history pages, basic stats summaries.
- Simple regional leaderboards (apex + ladder).
- Postgres schema (static + accounts + normalized matches).

**Exit criteria:** any EUW1/NA1 Riot ID resolves to a profile with real rank + readable match detail, every Riot call routes through the throttled client, and match details are cached.

### 6.2 Phase 2 — planner, admin, UX
- Team planner with live trait readout, export code, shareable URL state.
- `saved_planners` + (optional) lightweight accounts if named/saved builds are wanted.
- Admin dashboard: pipeline health, featured content, tracked comps, analytics.
- Improved filtering/search UX across data pages.

### 6.3 Phase 3 — pipeline + meta intelligence
- Full ladder-crawl ingest with rank-gated frontier and dedupe.
- Comp clustering + metric rollups + trend series.
- Auto tier-list generation with admin override layer.
- Advanced filters (patch, rank, region, sample size) wired to derived tables.
- Deep analytics: units, traits, augments, meta trends over time.

### 6.4 Technical risks
- **R1 — Dev-key throughput.** 20 req/s + 100/2min is far too little to mine a region; meta features (Phase 3) are effectively blocked on a production key. *Mitigation:* build/validate the pipeline on a tiny sample, apply for production early, keep the crawl rank-gated and dedupe-heavy.
- **R2 — Dev-key 24h expiry.** Keys die daily in dev. *Mitigation:* rotation tooling + key from env/secret store, never committed.
- **R3 — Production approval + commercial policy.** A public, possibly ad-supported stats site needs approval and must follow Riot's developer/commercial terms. *Mitigation:* check eligibility and apply before launch planning hardens.
- **R4 — Comp clustering quality.** Signature granularity directly determines whether comps and tiers are trustworthy. *Mitigation:* treat clustering as iterative, enforce minimum sample sizes, validate against known meta.
- **R5 — "Team code" / in-game import.** A "paste into the live game to load this board" path is **not assumed to exist**; the export code is a portable encoding for sharing across web tools. *Mitigation:* confirm what import means for users before promising it; default to share-URL + code round-trip within our own planner.
- **R6 — Set/patch rotation breaks static data.** Unit/trait/augment IDs change each set. *Mitigation:* version everything by set+patch, make the static loader re-runnable, never hardcode Set 17.
- **R7 — Stale-data illusion.** Cached/precomputed data can silently go stale. *Mitigation:* label every stat with its patch/region/bucket + freshness, and alert when ingest stalls.

### 6.5 Assumptions
- A single seed region (EUW1 or NA1) for Phases 1–2; multi-region in/after Phase 3.
- TFT ranked queue (`RANKED_TFT`) is the focus; non-ranked and esports are out of scope for v1.
- The build happens in a real dev environment (Next.js + Postgres + Redis + workers), not in a chat sandbox.

---

## 7. Immediate next step
Stand up the **walking skeleton** (§6.1) in Claude Code: scaffold the Next.js repo, the Postgres schema for static + accounts + matches, Redis, and the shared Riot API client, then wire the single search→profile→match-detail slice against a dev key. Everything else in Phase 1 is repetition on top of that proven slice.
