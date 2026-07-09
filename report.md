# TFT Platform — Status Report
_Generated 2026-06-27_

---

## Done

### Infrastructure
- [x] Next.js 15 App Router scaffold, TypeScript, global CSS partials
- [x] PostgreSQL pool (`lib/db.ts`), Redis singleton (`lib/redis.ts`)
- [x] Riot API client with sliding-window rate limiter + Redis cache (`lib/riot/`)
- [x] `api_usage` instrumentation centralized in the Riot client (fire-and-forget per-minute upsert)

### Database schema (all migrations applied through 0008)
- [x] `0001` — base tables: `patches`, `units`, `traits`, `augments`, `items`, `accounts`, `summoners`, `league_entries`, `matches`, `match_participants`, `participant_units/_traits/_augments`
- [x] `0002–0006` — enrichment columns: icon paths, item composition, patch backfill, descriptions, unit role
- [x] `0007` — ops tables: `ingestion_jobs`, `api_usage`
- [x] `0008` — derived tables: `comps`, `comp_stats`, `bucket_totals`, `comp_stat_trends`, `tier_list_entries`

### Web UI (M1–M2)
- [x] Home page with leaderboard preview
- [x] Player profile page (rank, match history, placement history)
- [x] Match detail page (8-player lobby, unit boards, traits)
- [x] Leaderboard page (paginated apex ladder)
- [x] Planner (drag-drop hex board, trait calculator, share codes)
- [x] Library (units / traits / items / augments browser with tooltips)
- [x] Game-data popup system (unit/trait/item tooltips + modals)

### Admin (M3)
- [x] Admin login page + server actions (HMAC-signed cookie session, no DB)
- [x] Guarded `/admin/*` route group (`requireAdmin()` in layout)
- [x] Pipeline health dashboard: usage chart, by-endpoint table, ingestion-jobs table
- [x] `ops-service.ts` — reads `api_usage` + `ingestion_jobs` for the panel
- [x] `AutoRefresh` client component (15s `router.refresh()`)
- [x] `admin.css` partial

### M4 — Ingest pipeline (shared infrastructure)
- [x] `match-persist.ts` — idempotent match persistence, shared by profile path + worker
- [x] `patch.ts` — `resolvePatchId` upserts `patches`, shared by profile + worker
- [x] `accounts.ts` — accounts-table-first batch name resolver
- [x] BullMQ connection options (`queue/connection.ts`) — separate from app `ioredis` instance
- [x] `queue/queues.ts` — `QUEUE` stage names + `makeQueue`
- [x] `queue/job-tracking.ts` — `withJobTracking` wraps every stage in `ingestion_jobs` lifecycle
- [x] `config/rank-buckets.ts` — `RankBucket` type + `bucketForTier(tier)`
- [x] `config/crawl.ts` — env-overridable crawl caps (platform, tiers, PUUID cap, match-ID cap)

### M4 — Ingest pipeline (stages)
- [x] **Stage 1 `ladder-crawl`** (`stages/ladder-crawl.ts`) — apex ladder → PUUIDs → enqueues `MatchFetchJob` per player; LP-sorted; PUUID dedup via BullMQ jobId
- [x] **Stage 2 `match-fetch`** (`stages/match-fetch.ts`) — existence-check dedup → `riot.match.byId` → `persistMatch`; reports items stored
- [x] **Worker entrypoint** (`queue/worker.ts`) — real two-worker process; `RUN_CRAWL=1` trigger; graceful shutdown

---

## Needs to be done

### M4 — Remaining pipeline stages
- [ ] **Stage 3 — `cluster`**: group `match_participants` into `comps` by signature (sorted key traits + carries); upsert `comps`, set `match_participants.comp_id`
- [ ] **Stage 4 — `rollup`**: aggregate `comp_stats` per `(comp_id, patch_id, region, rank_bucket)` from participants; upsert `bucket_totals`
- [ ] **Stage 5 — `trend-tier`**: daily snapshot → `comp_stat_trends`; derive `tier_list_entries` (score → S/A/B/C/D); Wilson interval + SEM computed on read

### M4 — Plumbing gaps
- [ ] **Persist `bucket` in `match-fetch`**: `MatchFetchJob.bucket` is carried but not yet written anywhere — needs to land on `match_participants` or be passed into the rollup stage
- [ ] **Below-apex crawl** (Risk R8): non-apex tiers in `CRAWL.tiers` are silently skipped; needs paginated `entries/{tier}/{division}` iteration for Diamond and below
- [ ] **Crawl scheduler**: currently manual (`RUN_CRAWL=1 npm run worker`); needs a cron trigger (BullMQ `RepeatableJob` or an external cron) for continuous operation

### Web UI — M4 surfaces
- [ ] **`/comps` tier-list page**: table of comps by tier (S/A/B/C/D), filterable by patch, region, rank bucket
- [ ] **Comp detail page**: placement distribution, trend chart, unit/trait breakdown
- [ ] **Home page comp preview**: "Top comps this patch" widget (analogous to existing `TopPlayers`)
- [ ] **API endpoints**: `/api/comps`, `/api/comps/[id]` (if needed by client components)

### Admin — M4 surfaces
- [ ] **Manual tier overrides UI**: `tier_list_entries` has `is_manual`, `override_note`, `editor` columns; admin panel needs a form to set/clear overrides
- [ ] **Cluster/rollup/trend-tier job visibility**: once those stages land, the pipeline-health panel will show them automatically (ingestion_jobs rows), but the ops panel may need a "run now" trigger button

### Dev / ops
- [ ] **Start local services**: Postgres (`tft` DB + user) and Redis must be running locally for dev; both currently ECONNREFUSED
- [ ] **Apply migration 0008**: derived tables not yet applied to local DB
- [ ] **Set admin env vars**: `ADMIN_PASSWORD` and `ADMIN_SESSION_SECRET` in `.env` to access the panel
- [ ] **Import `admin.css`**: `src/app/styles/admin.css` needs an `@import` added to `src/app/globals.css`

---

## Current schema (as of migration 0008)

### Reference tables
| Table | Key columns |
|---|---|
| `patches` | `id`, `set_number`, `patch_label` (e.g. `"14.11"`), `released_at` |
| `units` | `id`, `unit_id`, `name`, `cost`, `role`, `ability_name`, `ability_desc`, `stats jsonb`, `icon_path` |
| `traits` | `id`, `trait_id`, `name`, `description`, `icon_path` |
| `items` | `id`, `item_id`, `name`, `description`, `composition text[]`, `icon_path` |
| `augments` | `id`, `augment_id`, `name`, `description`, `icon_path` |

### Account / ranked tables
| Table | Key columns |
|---|---|
| `accounts` | `puuid` PK, `game_name`, `tag_line` |
| `summoners` | `puuid` PK, `summoner_id`, `platform`, `summoner_level`, `profile_icon_id` |
| `league_entries` | `puuid`, `platform`, `queue_type`, `tier`, `division`, `lp`, `wins`, `losses` |

### Match tables
| Table | Key columns |
|---|---|
| `matches` | `match_id` PK, `platform`, `region`, `game_datetime`, `game_length`, `game_version`, `patch_id → patches`, `set_number`, `set_core_name`, `tft_set_number` |
| `match_participants` | `id`, `match_id → matches`, `puuid → accounts`, `placement`, `level`, `last_round`, `augments text[]`, `comp_id → comps` (nullable until cluster runs) |
| `participant_units` | `id`, `participant_id → match_participants`, `unit_id`, `tier`, `items text[]`, `rarity`, `chosen` |
| `participant_traits` | `id`, `participant_id`, `trait_id`, `tier_current`, `tier_total`, `style`, `num_units` |
| `participant_augments` | `id`, `participant_id`, `augment_id` |

### Ops tables
| Table | Key columns |
|---|---|
| `ingestion_jobs` | `id` bigserial, `job_type`, `region`, `status` (queued/running/success/failed), `started_at`, `finished_at`, `items_done`, `error_count`, `cursor jsonb`, `created_at` |
| `api_usage` | `id` bigserial, `window_start` (minute bucket), `region`, `method`, `request_count`, `rate_429`; UNIQUE `(window_start, region, method)` |

### Derived / stats tables
| Table | Key columns |
|---|---|
| `comps` | `id`, `set_number`, `signature` (sorted key traits + carries); UNIQUE `(set_number, signature)` |
| `comp_stats` | `comp_id`, `patch_id`, `region`, `rank_bucket`; sufficient stats: `n`, `placement_sum`, `placement_sumsq`, `top4_count`, `win_count`; UNIQUE `(comp_id, patch_id, region, rank_bucket)` |
| `bucket_totals` | PK `(patch_id, region, rank_bucket)`, `total_boards` (play-rate denominator) |
| `comp_stat_trends` | PK `(comp_id, patch_id, region, rank_bucket, snapshot_date)`, same sufficient stats + `bucket_total` |
| `tier_list_entries` | `comp_id`, `patch_id`, `region`, `rank_bucket`, `tier` (S/A/B/C/D), `score`, `is_manual`, `override_note`, `editor`; UNIQUE `(patch_id, region, rank_bucket, comp_id)` |
