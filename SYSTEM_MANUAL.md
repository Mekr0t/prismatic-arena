# TFT Platform — System Manual

> Read this before editing. Update the relevant section after any structural change (new file, renamed export, deleted function).

---

## Stack

| Layer | Tech |
|---|---|
| Framework | Next.js 15.1, App Router, React 19, TypeScript 5.7 |
| Styling | Global CSS only — `src/app/globals.css` imports partial files from `src/app/styles/` |
| Database | PostgreSQL via `pg` pool (`src/lib/db.ts`) |
| Cache | Redis via `ioredis` (`src/lib/redis.ts`) + Next.js `revalidate` for ISR |
| External API | Riot Games API — rate-limited client (`src/lib/riot/client.ts`) |
| Assets | CommunityDragon CDN via `src/lib/icon-url.ts` |
| Background jobs | BullMQ workers in a **separate process** (`src/server/queue/`), run via `npm run worker` |

---

## Directory Map

```
src/
  app/                   Next.js App Router pages + API routes
    styles/              CSS partials (imported by globals.css)
    api/                 REST endpoints
    [region]/[gameName]/[tagLine]/   Player profile route
    leaderboard/[region]/            Leaderboard route
    match/[region]/[matchId]/        Match detail route
    library/             Library page
    planner/             Planner page
    admin/
      login/                         Admin sign-in (page + server actions) — unguarded
      (panel)/                       Guarded admin subtree (route group)
                                       layout = requireAdmin + admin shell
                                       page   = pipeline-health dashboard
  components/            React components (mix of server + client)
    admin/               Admin-only client components (AutoRefresh)
  config/                Static constants (regions, cache TTLs, crawl caps)
  lib/                   Pure utilities + context + external clients
    riot/                Riot API client, types, rate limiter
    planner/             Pure planner logic (no React)
  server/                Server-only services (DB + API orchestration)
    queue/               BullMQ connection, queues, job tracking, worker entrypoint
      stages/            Per-stage BullMQ job logic (ladder-crawl, match-fetch, …)
db/
  migrations/            Ordered *.sql, applied by `npm run db:migrate`
scripts/
  load-static-data.ts    CDragon static-catalog loader (`npm run data:load`)
  merge-eval.ts          Read-only Stage-6 merge replay + labeled-pairs eval (`npm run merge:eval`)
  merge-eval-pairs.json  Hand-labeled must-merge / must-split comp pairs (the /photos golden set)
```

---

## CSS Files (`src/app/styles/`)

All loaded via `@import` in `src/app/globals.css` in cascade order.

| File | What it styles |
|---|---|
| `base.css` | `:root` tokens, reset, `body`, `.skeleton`, `.notice`, `@keyframes rise/shimmer` |
| `layout.css` | `.header`, `.brand`, `.search`, `.nav`, `.site-footer` |
| `board.css` | `.board`, `.unit`, `.tile`, `.items`, `.traits`, `.chip` |
| `profile.css` | `.profile`, `.avatar`, `.identity`, `.rank`, `.crest`, `.summary`, `.mode-tabs` |
| `match.css` | `.match`, `.hex`, `.match-detail`, `.pl` (lobby rows), `.match-page` |
| `leaderboard.css` | `.lb`, `.lb-table`, `.lb-row`, `.pager`, skeleton rows |
| `home.css` | `.home-hero`, `.home-grid`, `.top-list`, `.feature` cards |
| `planner.css` | `.planner`, `.pl-boardwrap`, `.hexcell`, `.sel-strip`, `.slot`, `.up-grid`, `.ip-backdrop` |
| `library.css` | `.library`, `.lib-tabs`, `.lib-unit-grid`, `.lib-detail`, `.lib-tooltip` |
| `tier.css` | `.tier-page`/`.tier-controls`, `.tier-table`/`.tier-section`/`.tier-band`, `.tier-badge` (S–D), `.comp-row`, `.comp-ident`/`.cportrait`/`.tchip`, `.comp-stat`/`.cs-conf`, `.niche-head` (the `/comps` tier list) |
| `comp-detail.css` | `.cd-*` — the `/comps/[key]` archetype detail page: `.cd-head`/`.cd-stats`, `.cd-strips` (core/flex), `.cd-cols`/`.cd-panel`, `.cd-tabs` (Placement/Hit-states switch), `.cd-table` (hit states, units w/ `.good`/`.bad` delta), `.cd-bands` (level bars + `.cd-pl` placement histogram, bottom-4 muted), `.cd-builds`, `.cd-boards`, `.cd-mini` portraits. Reuses tier.css badges/tags and the `.ex-*` tile conventions |
| `popups.css` | `.gd-tooltip`, `.gd-backdrop`, `.gd-modal`, `.gd-bp-pill`, `.gd-trait-pill` |
| `admin.css` | `.admin-login`/`.login-card`, `.admin-bar` shell, `.ops-*` panel (cards, `.usage-chart`, `.ops-table`, `.badge-*`) |

---

## Config Files (`src/config/`)

### `regions.ts`
Region and platform constants for Riot API routing.

| Export | Type | Description |
|---|---|---|
| `RegionalRoute` | type | `"americas" \| "europe" \| "asia" \| "sea"` |
| `Platform` | type | All 15 Riot platform strings (na1, euw1, kr, …) |
| `PLATFORMS` | `Platform[]` | All platform values |
| `PLATFORM_TO_REGION` | `Record<Platform, RegionalRoute>` | Maps platform → regional route |
| `isPlatform(value)` | fn | Type guard |
| `platformHost(platform)` | fn | Returns `https://{platform}.api.riotgames.com` |
| `regionalHost(route)` | fn | Returns `https://{route}.api.riotgames.com` |
| `routeForPlatform(platform)` | fn | Returns regional route for a platform |

### `cache.ts`
Cache TTL constants (seconds): `account` 24h, `summoner` 6h, `league` 10m, `matchIds` 5m, `matchDetail` 30d, `apexLeague` 30m.

### `crawl.ts`
Crawl scope + hard caps for the M4 pipeline. Every value is **env-overridable** so widening coverage is a config change, not code. Defaults are deliberately small — enough to validate the full ladder→matches path on the dev key without burning the budget.

| Export | Field | Default | Env override |
|---|---|---|---|
| `CRAWL` | `platform` | `euw1` | `CRAWL_PLATFORM` |
| | `tiers` | `['challenger']` | `CRAWL_TIERS` (comma-sep) |
| | `maxPuuidsPerRun` | `25` | `CRAWL_MAX_PUUIDS` |
| | `matchIdsPerPuuid` | `4` | `CRAWL_MATCH_IDS_PER_PUUID` |
| | `maxMatchFetchesPerPass` | `100` | `CRAWL_MAX_MATCH_FETCHES` |

Design note: `maxPuuidsPerRun × matchIdsPerPuuid` should be ≤ `maxMatchFetchesPerPass` (default 25 × 4 = 100) so every enqueued PUUID gets crawled before the ceiling binds. More PUUIDs × fewer matches each gives better comp diversity than the reverse.

### `rank-buckets.ts`
Rank-bucket dimension for derived stats. Boards are bucketed by the ladder tier they were crawled from — a Challenger crawl tags everything `'challenger'`. Per-board rank is absent from match data, so "bucket = the ladder we mined" is the standard convention.

| Export | Type / Description |
|---|---|
| `RankBucket` | `'iron_gold' \| 'plat_emerald' \| 'diamond' \| 'master_plus' \| 'challenger' \| 'all'` |
| `bucketForTier(tier)` | Maps a Riot tier string (case-insensitive) → `RankBucket`. Unknown tiers → `'all'` |

---

## Library Files (`src/lib/`)

### `db.ts`
PostgreSQL singleton pool. Exports `pool` (`pg.Pool`), `query<T>(text, params?)` → `T[]`, `one<T>(text, params?)` → `T | null`.

### `redis.ts`
Redis singleton. Exports `redis` (`ioredis`). **Note:** BullMQ does *not* share this instance — it uses its own connection options (`src/server/queue/connection.ts`).

### `icon-url.ts`
`iconUrl(path)` — converts an `ASSETS/...` game path to a `https://raw.communitydragon.org/latest/game/...` CDN URL.

### `game-data.tsx`
`'use client'` — global context for the popup/modal system (`GameDataProvider`, `useGameData()`, `EntityType`, popup components). Fetches `/api/game-data` once on mount.

### `planner/core.ts`
Pure planner types + algorithms (`PlannerUnit/Trait/Item/Data`, `Cell`, `ActiveTrait`, `BOARD_*`, `emptyBoard`, `computeActiveTraits`, `encodeBoard`/`decodeBoard`, `encodeRiotCode`/`decodeRiotCode`).

### `riot/types.ts`
Riot API DTO type definitions (`AccountDto`, `SummonerDto`, `LeagueEntryDto`, `LeagueItemDto`, `LeagueListDto`, `MatchUnitDto`, `MatchTraitDto`, `MatchParticipantDto`, `MatchDto`).

### `riot/rate-limiter.ts`
Sliding-window-log rate limiter (`RateWindow`, `DEV_APP_WINDOWS` = 20/1s + 100/2min, `SlidingWindowQueue` with priority `acquire`).

### `riot/client.ts`
Typed Riot API client. All methods cached in Redis and rate-limited.

| Export | Description |
|---|---|
| `Priority` | Enum: `USER = 10`, `BATCH = 0` |
| `RiotApiError` | Error subclass with `.status: number` |
| `riot.account.byRiotId / byPuuid` | → `AccountDto` (regional host; SEA routed via ASIA) |
| `riot.summoner.byPuuid / byId` | → `SummonerDto` (platform host) |
| `riot.league.byPuuid / bySummoner / apex` | → entries / list (platform host). `bySummoner` is **deprecated** (Riot removed `/by-summoner` June 2025); use `byPuuid` |
| `riot.match.idsByPuuid / byId` | → match IDs / `MatchDto` (regional host) |

**API-usage instrumentation:** the internal `request()` records every real HTTP call into `api_usage` (per-minute bucket, keyed by routing target + a stable `methodLabel(path)`, 429s tracked separately). It's **fire-and-forget** and never awaited, so it can't add latency to or break a call. Centralized here, so any caller — including the workers — is instrumented automatically with no per-caller logging.

### `riot/index.ts`
Barrel — re-exports `riot/client.ts`, `riot/types.ts`, and `routeForPlatform`.

---

## Server Services (`src/server/`)

All files are **server-only** (never import into client components).

### `static-data.ts`
`getCatalog()` → `Catalog` (units/traits/items), stale-while-revalidate, 1h TTL.

### `view-models.ts`
View-model types + builders (`ItemVM`, `UnitVM`, `TraitVM`, `BoardVM`, `MatchSummaryVM`, `ProfileVM`, `LobbyParticipantVM`, `MatchDetailVM`, `LeaderboardRowVM`, `LeaderboardVM`, `Catalog`, `bucketOf`, `ordinal`, `buildBoard`, `buildProfileVM`).

### `accounts.ts`
Shared puuid → display-name resolver. **Accounts-table-first:** one DB read for a batch, Riot only for misses (bounded, persisted back). The single path leaderboard, match-lobby, and the crawler use — never per-row `account.byPuuid`.

| Export | Description |
|---|---|
| `ResolvedName` | `{ gameName: string \| null; tagLine: string \| null }` |
| `resolveAccounts(puuids, route, priority?)` | → `Map<puuid, ResolvedName>`. `priority` defaults to `BATCH` (foreground callers pass `USER`). Misses are upserted into `accounts`. Caller must tolerate a null name (truncated-puuid fallback) |

### `patch.ts`
Single source of truth for deriving a patch from `game_version`. Shared by the profile write-path and the M4 match-fetch worker so both land matches on the same `patch_id`.

| Export | Description |
|---|---|
| `patchFromVersion(gameVersion)` | `"Version 14.11.633…"` → `"14.11"` (or null) |
| `resolvePatchId(client, setNumber, gameVersion)` | Upserts `patches`, returns `id`. Runs on a transaction-scoped `PoolClient` |

### `match-persist.ts`
`persistMatch(match)` — idempotent match persistence (early-exit on existing `match_id`, all sub-inserts `ON CONFLICT DO NOTHING`, carry heuristic, `patch_id` via `resolvePatchId`). Shared by the profile path **and** the match-fetch worker. Extracted from `profile-service.ts`.

### `profile-service.ts`
Fetches player profile, hydrates from Riot, persists via `persistMatch`. Exports `ProfileMatch`, `PlayerProfile`, `ProfileNotFoundError`, `getPlayerProfile(platform, gameName, tagLine)`. (Match persistence + patch derivation now live in `match-persist.ts` / `patch.ts`.)

### `leaderboard-service.ts`
Apex ladder, sorted + paginated. Names for the visible page resolve through `resolveAccounts` (one batched call). Exports `LEADERBOARD_TIERS`, `TIER_LABELS`, `isLeaderboardTier`, `getLeaderboard(platform, tier, page, pageSize)`.

### `match-service.ts`
`getMatchDetail(platform, matchId)` → `MatchDetailVM`. All 8 lobby names resolve through one `resolveAccounts` call.

### `library-data.ts`
`getLibraryData()` → `LibraryData` (units/traits/items/augments) for the library + popups.

### `planner-data.ts`
`getPlannerData()` → `PlannerData` (units with plannerCodes, traits, items).

### `item-filters.ts`
`COMPONENT_IDS`, `ITEM_JUNK`, `ITEM_NAME_JUNK` — filter junk items out of match data.

### `admin-auth.ts`
Minimal single-operator admin auth. **No user table** — one password in `ADMIN_PASSWORD`, a signed (HMAC-SHA256) httpOnly cookie carries the session. Upgrading to multiple admins is localized here.

| Export | Description |
|---|---|
| `passwordMatches(submitted)` | Constant-time compare against `ADMIN_PASSWORD` |
| `startSession()` / `endSession()` | Set/clear the signed cookie (call only from a Server Action / Route Handler) |
| `isAuthed()` | True if the request carries a valid, unexpired session |
| `requireAdmin()` | `redirect('/admin/login')` unless authed — called by the (panel) layout, and **must** be called by any future `/api/admin/*` handler (a layout guard does not cover API routes) |

Env required: `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`.

### `ops-service.ts`
Read-side service for the admin pipeline-health panel. Reads `api_usage` + `ingestion_jobs`.

| Export | Description |
|---|---|
| `UsageMinute` / `MethodUsage` / `UsageOverview` | Per-minute series, per-method totals, usage summary (60-min window) |
| `JobRow` / `JobTypeHealth` / `JobsOverview` | Recent jobs, last-success-per-type + staleness, jobs summary |
| `OpsOverview` | `{ usage, jobs }` |
| `getOpsOverview()` | Builds `OpsOverview`. Usage series is a gapless 60-bucket `generate_series`; stats are derived on read |

### `comps-types.ts`
Public view-model interfaces for the M5 tier list. Lives in a separate file so the dependency graph stays acyclic (`comps-types` ← `comps-example-team` ← `comps-service`). All types are **re-exported** through `comps-service.ts` so component import paths stay unchanged.

Exports: `CarryPortraitVM`, `KeyTraitChipVM`, `ExampleItemVM`, `ExampleUnitVM`, `ExampleTraitVM`, `ExampleTeamVM`, `CompIdentityVM`, `CompRowVM`, `TierGroupVM`, `PatchOption`, `SelectorOptions`, `TierListSelection`, `TierListVM`, `TierListQuery`.

### `comps-example-team.ts`
Builds the `ExampleTeamVM` (modal board snapshot) for each comp from `participant_units` and `participant_traits`. Used only by `comps-service.ts`.

| Export | Description |
|---|---|
| `breakpointStyleToTier(style)` | Converts a raw CDragon style → normalized 1–4 tier |
| `styleAtUnits(breakpoints, numUnits)` | Derives active style (0 = inactive) from a trait's breakpoints at a given unit count |
| `EMPTY_TEAM` | Sentinel `ExampleTeamVM` returned when no boards exist for a comp |
| `loadExampleTeams(compIds, cat)` | Bulk-loads the most-representative board per comp from the DB → `Map<compId, ExampleTeamVM>`. Zero-breakpoint traits (per-unit marker pseudo-traits, e.g. Miss Fortune's "Choose Trait" chooser) are filtered out — never rendered, never name a comp |

### `comps-service.ts`
Read-side service for the **M5 comp tier list**. Drives from `comp_stats` + `bucket_totals` grouped by `comps.meta_comp` (unlabeled comps stand alone on their own id); `tier_list_entries` only supplies **manual pins** now (an `is_manual` row on any member pins the archetype's tier — highest-n pinned member wins). **The tier floor is POOLED**: an archetype qualifies when Σ n across its members (including merge's assigned sub-floor tail) reaches `TIER_MIN_SAMPLE` — a per-member floor survivorship-dropped exactly the missed-hit boards. Representative (identity + example board) = the member with the most 3★s **on the label's carries** (a lottery 3★ on a fast-8/9 line is luck, not identity) with a usable sample (n ≥ max(5, 5% of pooled)), then highest n — reroll lines show the board they're trying to hit; lines that don't roll for 3★s show their most-played board. **Identity comes from the merge label**: carry portraits/names are the label's dominant itemized carries (cost-desc; rep's 3★ set only for unlabeled singletons / no-carry archetypes), `##dup:`/`##aug:` segments surface as `CompIdentityVM.dupUnits`/`heroAugmentUnit` (badges in `TierTable`), and `keyTraits` are backfilled from the example team's top non-unique trait (the clusterer writes none) before `displayName` ("[trait] [carries]") is recomputed. Loads example teams via `comps-example-team`, and runs `computeMetrics` per pooled group on read (same `comp-stats-math` the writer uses). All VM types live in `comps-types.ts` and are re-exported here.

| Export | Description |
|---|---|
| `getTierList(q: TierListQuery)` | → `TierListVM`. Probes available `(patch, region, rank_bucket)` combos to drive the three selectors and resolve/validate the selection (default = current patch → highest volume); pools each group's sufficient stats, tiers S→D by pooled score; the niche flag appends the below-pooled-floor groups (biggest first, capped). Returns `null` selection when nothing is clustered yet |
| VM types (re-exported) | `TierListVM`, `TierGroupVM`, `CompRowVM`, `CompIdentityVM`, `CarryPortraitVM`, `KeyTraitChipVM`, `ExampleTeamVM`, `ExampleUnitVM`, `ExampleTraitVM`, `ExampleItemVM`, `SelectorOptions`, `PatchOption`, `TierListSelection`, `TierListQuery` |

### `comp-detail-service.ts`
Read model for the **comp-detail page (M6)** — one archetype drilled down. `getCompDetail(groupKey, q)` → `CompDetailVM | null`: resolves the (patch, region, bucket) via the same combos probe as the tier list, loads the group's member rows, builds the header with comps-service's `buildArchetypeRow` (shared exports: `loadCombos`, `resolveSelection`, `buildArchetypeRow`, `asCarries`, `CompStatRow`), then adds board-level aggregations (SQL-side, scoped to the bucket + ranked queue): core/flex unit strips + per-unit table with star split and a placement **delta** vs the archetype average; final-level distribution (7-/8/9+); **hit-state variants** (members grouped by exact 3★ set, pooled — the "when you hit vs when you don't" numbers); a 1st–8th **placement histogram**; carry item builds (modal completed sets); most-played exact boards via `loadExampleTeams`. `hitStatesDefault` marks hit-shaped lines (≥ `DETAIL_HITS_DEFAULT_MIN_SHARE` (0.35) of games hit a 3★) — the view opens those on the Hit states tab, everything else on Placement. Tunables: `DETAIL_CORE_MIN_FREQ` (0.75), `DETAIL_FLEX_MIN_FREQ` (0.25). Derived on read; no new tables.

### `comp-inspector.ts`
Admin/debug read model for the merge stage (Stage 6). `loadArchetypeInspector(setNumber?)` → `InspectorVM`: lists every `meta_comp` archetype and, for each, its member comps — floored to `MERGE_MIN_SAMPLE`/`TIER_MIN_SAMPLE` so it mirrors exactly what merge grouped, not the historical long tail. Parses the archetype label's `##dup:`/`##aug:` tag segments into `dupUnits` (doubled-copy augment units) and `heroAugmentUnit` (resolved hero-augment carry name, from `comp-merge.ts`'s `heroAugmentSig`); unknown segments (e.g. the `##k:` collision disambiguator) are ignored; each `InspectorUnitVM` also carries `isHeroAugment` so the specific champ is tagged inline, not just the archetype as a whole.

### Queue / Workers (`src/server/queue/`)

Background ingest runs in a **separate Node process** (`npm run worker`), not the Next runtime. BullMQ uses **connection options**, never the app's shared `ioredis` instance (BullMQ bundles its own ioredis; sharing an instance causes a version mismatch).

| File | Exports / role |
|---|---|
| `env.ts` | **Side-effect module, imported FIRST in `worker.ts`.** Runs `loadEnvConfig` (`@next/env`) so `.env*` loads before `@/lib/db` builds its pool. (A `loadEnvConfig()` call in the worker body runs too late — ESM hoists imports.) |
| `connection.ts` | `bullConnection: ConnectionOptions` — parsed from `REDIS_URL` (default `localhost:6379`), `maxRetriesPerRequest: null` |
| `job-tracking.ts` | `withJobTracking(jobType, region, fn)` — wraps work in an `ingestion_jobs` lifecycle row (`running` → `success`/`failed`, `error_count`, `items_done`). `JobContext.setItems(n)` reports progress. The single seam every stage runs through |
| `queues.ts` | `QUEUE` (stage names: `ladder-crawl`, `match-fetch`, `cluster`, `rollup`, `merge`, `trend-tier` — also used as `ingestion_jobs.job_type`), `QueueName`, `makeQueue(name)` |
| `worker.ts` | Worker entrypoint. **Six real BullMQ workers** in one process: `ladderWorker` (1), `matchWorker` (3), `clusterWorker` (1), `rollupWorker` (1), `mergeWorker` (1), `trendTierWorker` (1). Boot triggers, each behind its own env flag — run as **separate** `npm run worker` invocations so ordering holds: `RUN_CRAWL`, `RUN_CLUSTER` (optional `CLUSTER_SET`), `RUN_ROLLUP`, `RUN_MERGE` (optional `MERGE_SET`), `RUN_TREND_TIER`, `RUN_SCHEDULER` (register repeatables), `SCHED_CLEAR` (remove them). Graceful shutdown closes all six. |
| `stages/ladder-crawl.ts` | **Stage 1 — producer.** `LadderCrawlJob { platform }`. `runLadderCrawl` pulls each apex-tier ladder (sorted by LP), resolves PUUIDs (entry field or fallback Summoner-V1 lookup), pulls recent match IDs, and enqueues one `MatchFetchJob` per PUUID into the `match-fetch` queue. JobId keyed on `mf:{platform}:{puuid}` — re-enqueueing the same player within the BullMQ retention window is a no-op. Below-apex tiers (Diamond and down) are silently skipped (Risk R8 — needs paginated iteration). |
| `stages/match-fetch.ts` | **Stage 2 — consumer.** `MatchFetchJob { platform, puuid, matchIds, bucket }`. `runMatchFetch` iterates match IDs: existence-checked against `matches` first (skips the Riot call entirely for already-stored matches), then calls `riot.match.byId` + `persistMatch` for new ones. `ctx.setItems` reports how many matches were actually stored. `bucket` is carried in the job but **not** written by this stage; boards are tagged via the `match_participants.rank_bucket` column default (`0009`) — a stopgap while the crawl is apex-only. |
| `comp-signature.ts` | Pure comp-identity logic — the **only** place clustering granularity is tuned. Exports `buildIdentity(units: SigUnit[]): CompIdentity | null`, `CompIdentity` (interface: `{ signature, coreUnits, threeStars }`), `SigUnit`, `MIN_BOARD_UNITS`. One env-overridable knob: `SIG_MIN_BOARD_UNITS` (default 6 — boards below this drop as surrenders/DCs). Exact-unit multiset identity: 3★ is its own star bucket; 1★ and 2★ collapse to the same. No carries, no traits, no archetype in identity. Signature = sorted multiset of `characterId:starBucket` tokens, pipe-joined. `threeStars` is surfaced for display labelling only (the `comps.carries` JSONB at cluster time). |
| `stages/cluster.ts` | **Stage 3 — clusterer.** `ClusterJob { setNumber? }`. `runCluster` sweeps every eligible board (standard ranked `queue_id` 1100, `set_number` known), signatures each via `comp-signature.ts`, upserts distinct `comps` (`ON CONFLICT (set_number, signature)`), batch-stamps `match_participants.comp_id`, and **prunes orphan comps** in the processed sets — one transaction. Full re-cluster every run (idempotent on signature), so granularity is tuned by re-running. Bucket/patch-blind: comp identity is set-scoped. |
| `stages/rollup.ts` | **Stage 4 — rollup.** `RollupJob` (no params; full recompute). `runRollup` rebuilds `comp_stats` + `bucket_totals` from clustered ranked boards (`comp_id` + `patch_id` present, `queue_id` 1100), grouped by `(comp, patch, region, rank_bucket)`. Stores **sufficient statistics only** (`n`, `placement_sum`, `placement_sumsq`, `top4_count`, `win_count`); rates + Wilson/SEM intervals derived on read. `bucket_totals` counts clustered boards so play rates sum to 1. `DELETE`+`INSERT` in one transaction — readers never catch an empty table. |
| `comp-stats-math.ts` | Pure stats over `comp_stats` sufficient stats — the **single source** of scoring/intervals/confidence, called by **both** `trend-tier` (write) and `comps-service` (read), so the method can change with no re-rollup. Exports `computeMetrics`, `wilson`, `placementSem`, `confidenceLabel`, `scoreToTier`, and `SufficientStats`/`Interval`/`Confidence`/`CompMetrics`. Score = **shrinkage** toward the lobby prior (placement 4.5 / top-4 0.5) by `n/(n+SCORE_PRIOR_WEIGHT)` so a thin sample can't post a flashy score; **display** intervals stay 95% (Wilson for top-4, SEM for placement). Knobs: `SCORE_PRIOR_WEIGHT` (40), `LOW_SAMPLE_N` (30), `TIER_BANDS` (S≥.55/A≥.50/B≥.45/C≥.40/D), confidence cutoffs (Low: n<15 or top-4 CI width>.30; High: n≥50 & width≤.18). |
| `carry-classify.ts` | Pure carry classification (no DB). `classifyCarries(rows, totalBoards)` → `BucketCarry[]`: takes flat `RawUnitItem[]` (boardId, characterId, items), deduplicates copies per (board, unit), ranks units by completed-item count per board, accumulates `fullyItemizedRate` + `topItemizedRate` (a top slot only counts with ≥ 1 completed item — the rate feeds comp-profile's fallback-carry path) + modal item set per unit. `isBucketCarry = fullyItemizedRate >= CARRY_FULL_RATE` (env, default 0.5). `bucketCarryIds(carries)` extracts confirmed carry characterIds. Tunables: `CARRY_FULLY_ITEMIZED` (3), `CARRY_FULL_RATE` (0.5), `CARRY_TOP_ITEM_SLOTS` (2). Also classifies **hero augments** (set 17): `HERO_AUGMENT_CHAMPIONS` (Poppy, Jax, Aatrox, Gragas, Mordekaiser, Nasus, Leona, Meepsie/`TFT17_IvernMinion`) and `DAMAGE_ITEMS` (the 24-item damage-item pool; several are set-17 renames, e.g. Void Staff → `TFT_Item_StatikkShiv`, Kraken's Fury → `TFT_Item_RunaansHurricane` — verified against the `items` table, not derived from names). `classifyHeroAugments(rows, totalBoards, eligibleIds)` → `HeroAugmentCarry[]`: for champs the caller has already confirmed are 3-star (comp-wide, so checked by the caller), rate of boards where the champ holds ≥ `HERO_AUGMENT_MIN_DAMAGE_ITEMS` (2) damage items; `isHeroAugment = damageItemRate >= HERO_AUGMENT_RATE` (env, default = `CARRY_FULL_RATE`). |
| `comp-profile.ts` | Pure `CompProfile` construction (no DB) — bridges carry-classify and comp-merge; extracted from the merge stage so tests and `scripts/merge-eval.ts` exercise the production path. `buildCompProfile(CompRowInput)` → `CompProfile`: `copySig` (doubled units, **cost-gated to 1–3-costs** via `MERGE_COPY_MAX_COST` — a doubled 4/5-cost is a late-game bench copy, not the duplicate augment; unknown costs never classify); `carries` = isBucketCarry with a **top-itemized fallback** when a comp never fully itemizes (dead / missed-hit boards keep their carry identity; `MERGE_FALLBACK_TOP_RATE` 0.5, max 2); `carryGrade3` = 3★ ∩ itemized (incidental 3★s from augment copies excluded); per-unit **identity weights** for overlap scoring (carries/3★ 1.0, core `MERGE_WEIGHT_CORE` 0.7, flex `MERGE_WEIGHT_FLEX` 0.25 for cost ≥ `MERGE_FLEX_MIN_COST` (4) units with item rates < `MERGE_FLEX_MAX_ITEM_RATE` (0.25)); `heroAugmentSig`. Also `buildTailProfile(TailRowInput)` — light profile for a sub-floor comp from comps-table data alone (no itemization): empty carries, FULL 3★ set as `carryGrade3`, neutral weights, `heroAugmentSig` '' — input for `assignTail`. |
| `comp-merge.ts` | Pure carry-archetype merge (no DB). `mergeComps(profiles)` → `MergeResult`, in three passes: (1) greedy, most-populated first, each comp joining the **best-scoring archetype among those that pass every guard**; (2) a guard-respecting **fold pass** reuniting fragments stranded by greedy ordering; (3) labeling, where colliding labels get a `##k:<anchorCompId>` disambiguator — `meta_comp` is the downstream grouping key, so two distinct archetypes must never share a label. Score = UNIT_WEIGHT·containment + JACCARD_WEIGHT·jaccard + CARRY_WEIGHT·carryOverlap, with containment/jaccard **weighted by per-unit identity weights** (from `comp-profile.ts`) so cap-unit swaps don't split a line (survivor effect). Hard-fail guards: `grade3_conflict` (**conflict-only 3★ guard** — fails only when both sides' carry-grade 3★ sets are non-empty and disjoint; missed hits, extra hits, and different secondary hits pool into one line, genuinely different reroll targets split), `copy_class`, `hero_augment`, `carry_overlap` (≥ MIN_CARRY_OVERLAP), `containment` (≥ MIN_CONTAINMENT), `jaccard` (≥ MIN_JACCARD). Also exports `debugCompare(a, b)` → `CompareResult` (score parts + failed-guard names) and `assignTail(comp, archetypeProfiles)` — assign-only labeling of sub-floor comps against the **frozen** post-merge profiles (`MergeResult.archetypeProfiles`): carry evidence proxied by *presence* of the archetype's carries on the board (restricted to carries the archetype fields in its own unit set — off-board carriers like the Mecha summon prove nothing by their absence), conflict rule on the comp's full 3★ set, never joins a hero-augment archetype, score bar raised by `MERGE_ASSIGN_MARGIN` (0.02). **Strong carry agreement buys unit slack**: when carry overlap ≥ `MERGE_STRONG_CARRY_OVERLAP` (0.75), the score and jaccard bars relax by `MERGE_STRONG_CARRY_SLACK` (0.06) — variants that agree on the itemized carries merge despite secondary-unit drift; hard class guards and containment never relax. Label = `<sorted dominant-carry ids>[##dup:…][##aug:…][##k:…]`. Thresholds env-overridable (`MERGE_*`, incl. `MERGE_DUP_DOMINANT_RATE` 0.40). Unit tests: `comp-merge.test.ts` + `comp-profile.test.ts` (`npm test`) pin the /photos board-pair semantics. |
| `stages/trend-tier.ts` | **Stage 5 — trend-tier.** `TrendTierJob { setNumber? }`. One transaction: (A) upsert today's sufficient stats per comp into `comp_stat_trends` (ALL comps, idempotent per `CURRENT_DATE`) — the series patch velocity reads later; (B) regenerate `tier_list_entries` for comps with `n ≥ TIER_MIN_SAMPLE` (env, default 15): score via `comp-stats-math`, rank within each `(patch, region, rank_bucket)`, map to S/A/B/C/D. Deletes only `is_manual=false` rows first, then bulk-inserts with `ON CONFLICT DO NOTHING`, so **admin manual overrides survive and win**. |
| `stages/merge.ts` | **Stage 6 — merge.** `MergeJob { setNumber? }`. Exports `loadCompProfiles(client, setNumber?)` — bulk-fetches tier-relevant comps (`MAX(cs.n) >= MERGE_MIN_SAMPLE`, with `comp_stats.n` as boardCount weight), their boards' `participant_units` rows, and static unit costs (`units` table, for flex-slot detection), then builds one `CompProfile` per comp via `comp-profile.ts` — and `loadTailProfiles(client, setNumber?)` — light profiles (comps-table only, no participant_units fan-out) for every sub-floor comp with total n ≥ `MERGE_ASSIGN_MIN_SAMPLE` (1). Both shared with `scripts/merge-eval.ts`. `runMerge` = load → `mergeComps` over the floored comps → **assign-only tail pass** (`assignTail` vs the frozen archetype profiles, yielding to the event loop every 500 comps) → one short transaction that clears stale labels (comps not assigned this run) and writes changed labels only (`IS DISTINCT FROM` guard, so the hourly rerun doesn't churn tens of thousands of unchanged rows). Idempotent. Boot flag: `RUN_MERGE=1` (optional `MERGE_SET`). Schedule: `SCHED_MERGE_MIN` (default 60). |
| `scheduler.ts` | Repeatable-job plumbing (supervised, **not** unattended — dev key 24h expiry / ~20 rps). `registerSchedules()` upserts one BullMQ job scheduler per stage via `upsertJobScheduler`; `clearSchedules()` removes them. Cadences are env, in minutes: `SCHED_CRAWL_MIN` (30), `SCHED_CLUSTER_MIN` (60), `SCHED_ROLLUP_MIN` (60), `SCHED_MERGE_MIN` (60), `SCHED_TREND_TIER_MIN` (1440). Driven from `worker.ts` by `RUN_SCHEDULER` / `SCHED_CLEAR`. |

---

## API Routes (`src/app/api/`)

| Route | Method | Handler | Description |
|---|---|---|---|
| `/api/game-data` | GET | `game-data/route.ts` | `LibraryData` JSON, 1h ISR |
| `/api/profile/[region]/[gameName]/[tagLine]` | GET | … | `PlayerProfile` JSON |
| `/api/match/[region]/[matchId]` | GET | … | `MatchDetailVM` JSON |

`api/utils.ts` → `handleApiError(err)` maps `RiotApiError` status → `NextResponse`.

**Admin auth uses Server Actions, not API routes** (`src/app/admin/login/actions.ts` → `loginAction`, `logoutAction`).

---

## Pages (`src/app/`)

Existing: `page.tsx` (Home + `TopPlayers`), `layout.tsx` (RootLayout + `GameDataProvider`), `library/`, `planner/`, `leaderboard/[region]/`, `match/[region]/[matchId]/`, `[region]/[gameName]/[tagLine]/` (profile, with `loading`/`error`/`not-found`), `comps/` (comp tier list — server component, `force-dynamic`, `?patch=&region=&bucket=&niche=` URL state; no API route), `comps/[key]/` (archetype detail — `force-dynamic`; the key is the URL-encoded grouping key `m:<label>` / `c:<id>`, linked from tier rows with the selection as query params; 404s via `notFound()` when the group has no boards in the resolved bucket).

### Admin (`src/app/admin/`)

| Path | Export | Description |
|---|---|---|
| `login/page.tsx` | `AdminLoginPage` (default), `metadata`, `ERRORS` | No-JS sign-in form posting to `loginAction`; shows `?error=` message; redirects to `/admin` if already authed. **Outside** the guarded group (no redirect loop) |
| `login/actions.ts` | `loginAction(formData)`, `logoutAction()` | `'use server'` — verify password → `startSession` → redirect; logout clears session |
| `(panel)/layout.tsx` | `AdminPanelLayout` (default) | Calls `requireAdmin()`, renders the admin shell (`.admin-bar` + logout). `(panel)` is a route group, so its URL is `/admin/*` |
| `(panel)/page.tsx` | `AdminDashboardPage` (default), `metadata`, `rel()`, `STATUS_BADGE`, `dynamic = 'force-dynamic'` | Pipeline-health dashboard: usage cards, server-rendered SVG usage chart, by-endpoint table, ingestion-jobs section. Reads `getOpsOverview()` |
| `(panel)/inspector/page.tsx` | `ArchetypeInspectorPage` (default), `dynamic = 'force-dynamic'` | Merge archetype inspector — expandable rows (native `<details>`) per archetype, showing member comps, a `dup:`/`augment:` badge when applicable, and inline `★`/`[aug]` markers on individual units. Reads `loadArchetypeInspector()` |

---

## Components (`src/components/`)

Existing: `Header`, `Nav` (`'use client'`, links: Profiles/Leaderboards/Planner/Library/Comps — all `<Link>`), `SearchBar`, `RegionSelect`, `Board` (`PlacementBadge`/`UnitTile`/`TraitChip`/`BoardStrip`), `ProfileHeader`, `ProfileContent`, `MatchList`, `Library`, `Planner`, and the `/comps` tier-list set: `TierTable` (server, renders `CompRow` internally — no separate `CompIdentity` component; shows `Augment: 2× <units>` / `<champ> Hero Aug` badges from `identity.dupUnits`/`heroAugmentUnit`; row names link to `/comps/[key]` via `CompRowVM.groupKey` + the `detailQuery` prop), `CompDetail` (`'use client'` — the full `/comps/[key]` view: header, core/flex strips, a tabbed Placement/Hit-states panel (opens per `hitStatesDefault`), level bands, units table, builds, most-played boards; wires `useGameData` popups), `ExampleTeam` (`'use client'`, renders the trait strip + unit board, wired to `useGameData`), `StatCell` (shows avg/top-4/play/n + High/Med/Low badge; 95% CIs in hover tooltip), `TierControls` (URL-synced selectors + niche toggle).

### `admin/AutoRefresh.tsx`
`'use client'` — `AutoRefresh({ seconds })` calls `router.refresh()` on an interval (default 15s) + a manual button, to keep the ops panel live.

---

## Migrations & schema (`db/migrations/`)

Ordered, forward-only SQL, applied by `npm run db:migrate`.

| Migration | Adds |
|---|---|
| `0001_init.sql` | Static reference (`patches`, `units`, `traits`, `augments`, `items`); accounts/ranked (`accounts`, `summoners`, `league_entries`); normalized matches (`matches`, `match_participants`, `participant_units`/`_traits`/`_augments`) |
| `0002_icon_paths.sql` | `traits.icon_path`, `items.icon_path` |
| `0003_item_composition.sql` | `items.composition text[]` |
| `0004_patch_backfill.sql` | Unique constraints on participant sub-tables (idempotent ingest); backfill `patches` + `matches.patch_id` from `game_version` |
| `0005_descriptions.sql` | `units.ability_name/ability_desc/stats`, `traits.description`, `items.description`, `augments.description/icon_path` |
| `0006_unit_role.sql` | `units.role` |
| `0007_ops_tables.sql` | `ingestion_jobs`, `api_usage` (ops observability) |
| `0008_m4_derived.sql` | `comps`, `comp_stats`, `bucket_totals`, `comp_stat_trends`, `tier_list_entries` + FK `match_participants.comp_id → comps(id)` |
| `0009_rank_bucket.sql` | `match_participants.rank_bucket text NOT NULL DEFAULT 'challenger'` + index. Stopgap: apex-only crawl, so a constant default; drop it and write the per-match bucket when below-apex crawling lands (R8) |
| `0010_crawl_frontier.sql` | `accounts.last_crawled_at timestamptz` + drain-order index + backfill from match participants. Enables frontier-draining crawl (drain uncrawled accounts oldest-first instead of re-seeding the apex ladder each pass) |
| `0011_comp_archetype.sql` | `comps.archetype text` — intent archetype tag (e.g. `fast8`, `1cost_reroll`); currently always NULL (clusterer sets it to NULL; no stage populates it yet) |
| `0012_unit_copy_index.sql` | Drops `UNIQUE(participant_id, character_id)` on `participant_units`, adds `copy_index smallint NOT NULL DEFAULT 0` + new 3-column unique `(participant_id, character_id, copy_index)`. Allows multiple copies of the same unit (duplicate-copy augment) per board |
| `0013_meta_comp.sql` | `comps.meta_comp text` — carry-archetype label written by Stage 6 (merge); sorted `isBucketCarry` characterIds, pipe-joined. NULL until merge has run |

**Ops tables (0007):**
- `ingestion_jobs` — `(id, job_type, region, status, started_at, finished_at, items_done, error_count, cursor, created_at)`. Written by `withJobTracking`.
- `api_usage` — `(id, window_start, region, method, request_count, rate_429)`, `UNIQUE(window_start, region, method)`. Per-minute upsert from the Riot client.

**Derived tables (0008)** — store **sufficient statistics, not rates/bounds**; avg placement, top-4/win rate, and Wilson/SEM intervals are computed on read.
- `comps` — set-scoped, `UNIQUE(set_number, signature)`. Signature = sorted key traits + carries.
- `comp_stats` — `UNIQUE(comp_id, patch_id, region, rank_bucket)`; CI stats `n`, `placement_sum`, `placement_sumsq`, `top4_count`, `win_count`.
- `bucket_totals` — `PK(patch_id, region, rank_bucket)`, `total_boards` (play_rate denominator).
- `comp_stat_trends` — daily snapshots, `PK(comp_id, patch_id, region, rank_bucket, snapshot_date)`, carries `bucket_total` for play-rate-over-time.
- `tier_list_entries` — `UNIQUE(patch_id, region, rank_bucket, comp_id)`; `tier` S/A/B/C/D, `score`, `is_manual`/`override_note`/`editor` (text, no `admin_users` table).

**`rank_bucket` source (0009):** each board carries `match_participants.rank_bucket`, set by the column **default** `'challenger'` while the crawl is apex-only. The clusterer ignores it (identity is set-scoped); the rollup groups by it. When the crawl widens below apex (R8), drop the default and have the persist path write the per-match bucket — until then, profile-path boards also inherit `'challenger'` (a minor impurity on an apex-only sample).

`region` and `rank_bucket` are first-class **dimensions** in the derived tables (defined as a code constant at the crawler, stored as a label).

---

## Data Flow Summary

```
Read plane (user request)
  → Next.js page (server component)
      → server/* service → lib/riot/client (Riot + Redis) + lib/db (Postgres) + static-data
      → view model → server HTML + props to client components
  Client interaction (search / expand / tooltip / admin auto-refresh)
      → useGameData() or /api/* or router.refresh() → same services

Ingest plane (separate worker process — npm run worker)
  → BullMQ workers (ladder-crawl → match-fetch → cluster → rollup → trend-tier)
      → shared Riot client (auto-logs api_usage) + persistMatch (idempotent)
      → withJobTracking writes ingestion_jobs
  → admin panel reads ingestion_jobs + api_usage via ops-service
```

---

## Key Invariants

- **Server/client boundary:** never import `server/` files into `'use client'` components. Use `import type` for shared interfaces.
- **Game data popups:** any interactive unit/trait/item wires `showTooltip`/`hideTooltip`/`openModal` from `useGameData()`; `e.stopPropagation()` on item icons inside unit tiles.
- **CSS classes:** flat, globally unique (no CSS Modules). New selectors go in the most specific partial. `@keyframes` live in `base.css` only.
- **Icon URLs:** always via `iconUrl()` — never hand-built.
- **Cost colors:** `COST_CLASS(cost)` / `.c1-.c5`; canonical hex in `planner.css` + `board.css`.
- **Rarity gradient:** `--holo` (base.css) is the single source for the Prismatic-augment / Prismatic-trait (`s4`) treatment — a cool cyan/violet/white gradient, paired with `--holo-glow-cy`/`--holo-glow-vi` for the glow and a shared small clip-path facet cut. Reserved for genuinely rare tiers and the #1 leaderboard spot (`.top-rank.top1`/`.c-rank.top1`, via `:has()`) — never used as a general accent or on buttons.
- **Unique traits:** a trait with exactly one breakpoint (`breakpoints.length === 1`) has no bronze/silver/gold/prismatic scaling — it's Unique. Rendered with the `--unique`/`--unique-glow` tokens (outline + soft glow, never a full fill) via the `.unique` class on `.chip`/`.ex-trait`/`.tchip`/`.gd-bp-pill`/`.lib-bp-badge`. The `unique` boolean is precomputed server-side on `TraitVM` (view-models.ts), `ExampleTraitVM` (comps-example-team.ts), and `ActiveTrait` (lib/planner/core.ts) — never re-derived in components except the two breakpoint-list tooltips (game-data.tsx, Library.tsx) that render every breakpoint, not just the active one.
- **Riot rate limits:** all Riot calls go through `riot` from `lib/riot/client.ts`. `Priority.USER` for user-triggered, `Priority.BATCH` for background.
- **Account name resolution:** always through `resolveAccounts` (accounts-table-first) — never per-row `account.byPuuid`.
- **Patch derivation:** always through `resolvePatchId` (`patch.ts`) so crawl + profile agree on `patch_id`. One patch dimension; never group stats by two competing keys.
- **Match persistence:** always through `persistMatch` (`match-persist.ts`) — idempotent, shared by the profile path and the worker.
- **api_usage logging** is centralized in the Riot client `request()` — no per-caller logging code.
- **Admin guard:** `/admin/*` pages are protected by `requireAdmin()` in the (panel) layout; any future `/api/admin/*` route must call `requireAdmin()` itself.
- **Worker process:** `worker.ts` imports `./env` FIRST (loads `.env` before the pg pool). BullMQ uses connection **options**, not the shared `ioredis` instance.
- **Derived stats:** persist **sufficient statistics**, not rates/bounds — intervals are recomputed on read.
- **Clustering granularity:** tuned **only** in `comp-signature.ts` (env-overridable `SIG_MIN_BOARD_UNITS` knob). Re-clustering is a full re-sweep and prunes orphan comps, so `comps` always reflects the current algorithm.
- **Rollup recompute:** `runRollup` `DELETE`s then rebuilds `comp_stats` + `bucket_totals` in one transaction; `bucket_totals` counts clustered boards so play rates sum to 1.
- **Comp scoring is single-source:** every comp score, interval, and confidence label comes from `comp-stats-math.ts` — the writer (`trend-tier`) and the reader (`comps-service`) call the same functions, so the method can change with no re-rollup.
- **Manual tier overrides win:** `trend-tier` regenerates only `is_manual=false` rows (then `ON CONFLICT DO NOTHING`), so a manually pinned `tier_list_entries` survives a regenerate; the tier list applies a pin from any member at archetype grain (`comps-service.buildArchetypeRow`).
- **Comp identity display:** archetype rows are named from the **merge label** (dominant itemized carries, trait prefix backfilled from the example team); the rep's `comps.carries` (3★ set) is the fallback for unlabeled singletons. The raw signature is **debug-tooltip only**, and `comps.name` (a semantic title) stays null until the star-tier identity pass (see Deferred work).
- **Scheduler is supervised:** `scheduler.ts` repeatables run in supervised bursts, not 24/7 — the dev key expires every 24 h, and a production key gates continuous / low-ELO crawling.


---

## Deferred work (parked, with rationale)

- **#3 — Star-tier-aware comp identity** (the next identity refinement; build with real volume once the scheduler has accumulated data). The signature currently ranks carries by **completed item count** alone, which conflates two structurally different boards: a **reroll** comp (e.g. a 3-star low-cost carry like Fiora/Yi) whose identity *is* the 3-starred cheap unit — its 5-cost is a swappable cap, not identity — versus a **fast-9** comp whose 5-cost *is* the win condition. Item count can't tell them apart; identity = carries weighted by **intent (cost × star)**, which needs a board-level signal (board level / star-tier distribution) and likely **1–2 more columns out of `persistMatch`**. This same signal powers the comp-detail **core / optional / cap** breakdown and generated semantic titles ("Fiora Reroll", "Fast 9 Vex"). Until then, `comps.name` stays null and identity renders as carries + trait chips only.
- **Item alternatives** in unit popups are static "recommended" seeds; upgrade to data-driven "most common items on this carry" once there's volume (the popup is built to swap its source with no UI change).
- **Comp-detail page** and the **comp explorer** (full filter rail, niche toggle) reuse the M5 `StatCell` + identity primitives — not built yet.
- **Tier bands are seed values** (`S≥.55 …` in `comp-stats-math.ts`); recalibrate against the generated list once there's enough volume to spread (a thin sample shrinks everything toward 0.5).
