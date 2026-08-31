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
| Lint | ESLint 9 flat config (`eslint.config.mjs`, extends `next/core-web-vitals` + `next/typescript`), `npm run lint` |

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
.github/
  workflows/ci.yml       typecheck · lint · test on every push and PR, plus a
                         Postgres+Redis job that migrates an EMPTY database
                         and runs the persistMatch check
db/
  migrations/            Ordered *.sql, applied by `npm run db:migrate`
scripts/
  load-static-data.ts    CDragon static-catalog loader (`npm run data:load`).
                         ROSTER GATE: a set is only loaded once it has >= 20
                         champions that are playable (cost 1-5) AND carry a
                         trait. CDragon publishes a TFTSet{n} stub weeks early
                         with traits, augments and a few jungle camps; loading
                         it overwrites the live catalog. Auto-detect SKIPS an
                         unpopulated set and says so; SET_NUMBER=<n> REFUSES
                         (ALLOW_EMPTY_SET=1 overrides), so leaving SET_NUMBER
                         set ahead of launch and re-running daily is safe.
  cdragon-set.ts         The roster gate (MIN_REAL_ROSTER, rosterSize,
                         canonicalEntry), shared by the loader and the readiness
                         checker so they cannot disagree — the loader self-runs
                         on import, so nothing can import the threshold from it
  _set-readiness.ts      "Can I load the new set yet?" Probes cdragon/latest,
                         cdragon/pbe and Riot's Data Dragon (the control: does
                         the roster EXIST?), reports last-modified, and exits
                         0 when loadable / 1 when not:
                           until npx tsx scripts/_set-readiness.ts; do sleep 600;
                           done && npm run data:load
                         When ready it also checks the item classifiers against
                         the new set's ids — calibrated so set 17 reports clean,
                         because a checker that cries wolf gets ignored
  merge-eval.ts          Read-only Stage-6 merge replay + labeled-pairs eval (`npm run merge:eval`)
  merge-eval-pairs.json  Hand-labeled must-merge / must-split comp pairs (the /photos golden set)
  drain-active.ts        Post-crash cleanup: clears stale BullMQ "active" jobs + running ingestion_jobs rows
  reset-queue.ts         Obliterates every BullMQ queue (dev reset)
  _persist-check.ts      persistMatch integration check against a SYNTHETIC match —
                         copy_index on duplicate units, the carry heuristic, empty
                         and multi item arrays, idempotency on a second call, and
                         the RANKED-ONLY BOARD GATE (1100 writes boards; Double Up
                         and a NULL queue_id write the matches row only, and the
                         dedup check still finds them).
                         Touches the DB (self-cleaning), so it is NOT in `npm test`;
                         run with `npx tsx scripts/_persist-check.ts`
  _patch-check.ts        Patch-flag check against the LIVE db — advanceCurrentPatch picks the
                         newest patch WITH MATCHES (not the newest row), is idempotent,
                         orders numerically, self-heals a stolen flag; and resolvePatchId
                         reads before inserting and burns no sequence values. Mutates the
                         flag while running and restores it; NOT in `npm test`.
                         Run with `npx tsx scripts/_patch-check.ts`
  _key-check.ts          Stale-URL check against the LIVE db — a `/comps/[key]` link whose
                         `##k:` anchor or `##` tags have gone stale still resolves to the
                         live archetype, a live key does NOT redirect, and genuinely bogus
                         keys still 404. Read-only. Run with `npx tsx scripts/_key-check.ts`
```

### Testing & CI
`npm test` is `tsx --test "src/**/*.test.ts"` — a GLOB since 2026-08-22, so a new `*.test.ts` anywhere under `src/` is picked up instead of being silently skipped (it used to name two files explicitly). **152 tests:**

| file | covers |
|---|---|
| `queue/comp-merge.test.ts` + `comp-profile.test.ts` | the merge: /photos board-pair semantics and named regressions |
| `config/env.test.ts` | boot validation — fatal vs warning tiers, per-runtime scoping, all-problems-in-one-throw |
| `lib/riot/rate-limiter.test.ts` | window enforcement, multi-window, priority ordering, FIFO within a level — and one test that PINS THE KNOWN LIMITATION that two instances do not share a budget (audit §4, "One key, two budgets") |
| `queue/comp-stats-math.test.ts` | every displayed number: Wilson bounds, SEM, shrinkage (a 1-game win must not outscore a 400-game comp), tier bands, dynamic cutoffs |
| `lib/planner/core.test.ts` | the trait engine and BOTH codecs. Traits: unique-unit counting (a duplicate copy adds nothing), breakpoint/style resolution, `nextAt`, emblems granting a trait — including that an emblem on a unit that already has it does NOT double-count — unknown units and undefined traits degrading gracefully, and the sort order. **Trait multipliers** (set 18): a unit with `traitCounts` contributes its count rather than 1; the same unit placed twice still counts once (2, not 4); an emblem does NOT stack on a unit that already counts twice — `max(innate, 1)`, pinned deliberately because the pre-numeric `Set` gave that answer for free; and a multiplier applies only to the trait it names. Codecs: our board code round-tripping positions and items, version prefix, URL-safety, item clamping, out-of-range entries dropped, garbage → null; Riot's team-planner string exact to the byte (`02` + ten 3-digit hex slots + `TFTSetN`), dedupe-first-wins, the 10-champion cap, unencodeable units skipped, lowercase hex and whitespace tolerated, and unknown codes skipped rather than rendered as gaps |
| `queue/comp-signature.test.ts` | comp IDENTITY, the rule every board in the database is reduced through: unit order and emblem order never matter, a duplicate copy IS a different comp, 1★/2★ collapse while 3★ splits — but only at or below `SIG_STAR_MAX_COST`, so a lottery 3★ 5-cost does not cluster a board away from the same comp without the hit. Also summon/unknown-cost filtering (including that filtered units cannot pad a short board), the `MIN_BOARD_UNITS` floor, and the `emb:` round-trip. Asserts against the EXPORTED knobs, not the literals, so an env override retunes the tests with the module. Assumptions validated against 20,000 live signatures: zero token-format violations, zero `:3` tokens above the cost gate |
| `lib/riot/client.test.ts` | the retry / backoff / cache contract: 404 → null (not an error), 429 and 5xx and TRANSPORT failures retried then thrown as `RiotApiError`, `Retry-After` winning over exponential backoff, a non-retryable 4xx not burning the budget, cache hit skipping the network, errors never cached, the SSRF segment guard, and a missing key failing before the network. Neutralises Redis and Postgres by pointing them at a closed port BEFORE the client loads (hence dynamic imports) and stubbing the two redis methods, so it runs in CI where neither service exists; `setTimeout` is collapsed to ~0 while RECORDING the delay the client asked for, which is the part worth asserting. **Each test takes a UNIQUE route**, which is load-bearing: the client keys one limiter per regionKey, so a shared route let the limiter start pacing after ~20 calls, and its waits landed in the same `delays` array as the retry backoff. Two writers, one channel — green locally, red on a slower CI runner. A private bucket per test cannot be exhausted in four calls, so `delays` has one writer and the backoff assertions stay exact |
| `server/variant-resolve.test.ts` | the pure fold that decides which face a tile shows. The most-played variant wins; boards sum ACROSS a pooled row rather than being decided per comp (the reason `resolveVariants` returns tallies, not a decision) while a single comp still reports its own answer; comps outside the row are ignored; a tie breaks on the id so input order cannot change the render; no tallies means no override; separate families resolve independently |
| `server/set-config.test.ts` | the per-set registry, where a wrong value is silently wrong rather than loud. Item namespace: set 18's `DA_18_*` emblems classify as set items, the cross-set `TFT_Item_` pool belongs to every set, one set's ids never leak into another, and an unconfigured set falls back to the pre-set-18 `TFT{n}_Item_` convention. Trait multipliers: Elder Dragon counts 2 Riftbeast but 1 of its other trait; every Lux variant doubles her chosen trait across BOTH id spellings (`DA_18_Lux_*` and `DA_Lux18_*`); Avatar itself is never the doubled trait and base Lux doubles nothing; ordinary units and unconfigured sets never multiply |
| `server/admin-auth.test.ts` | the token contract: forgery (a valid signature is NOT enough without a numeric `exp`), tampering, malformed input, expiry, secret rotation, and password compare. One test PINS THE KNOWN GAP that a password change does not revoke live sessions (audit §2.1) — if that is ever fixed, that test SHOULD fail |

`.github/workflows/ci.yml` runs two jobs. **check** — `typecheck`, `lint`, `test`, each with `if: always()` so one lint error still reveals whether the tests pass rather than costing a round-trip. **db-check** — Postgres 16 + Redis 7 service containers, applies every migration to an EMPTY database, then runs `scripts/_persist-check.ts` (synthetic and self-cleaning, so it needs no fixtures). That second job is what lets a DB-touching check run automatically at all, and it incidentally proves the forward-only migrations still apply from zero — verified 2026-08-22 against a throwaway database: 20/20 migrations applied, 19/19 checks passed. The `RIOT_API_KEY` there is a dummy that only satisfies the boot validator; the check makes no Riot calls.

---

## CSS Files (`src/app/styles/`)

All loaded via `@import` in `src/app/globals.css` in cascade order.

| File | What it styles |
|---|---|
| `base.css` | `:root` tokens, reset, `body`, the global `:focus-visible` ring, `.skeleton`, `.notice`, `@keyframes rise/shimmer` |
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
| `rich.css` | `.rt-*` coloured description tokens (phys/magic/ap/hp/bonus/…), `.ustat-*` champion stat grid, `.bp-row`/`.bp-eff` trait-breakpoint rows, `.istat` item stat bonuses |
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
Rank-bucket dimension for derived stats. A board is bucketed by the **tier of the player the crawl drained to reach that match**, resolved with one `league.byPuuid` call at drain time and cached on `accounts.tier`. TFT matchmaking is rank-homogeneous, so the seed's tier is a sound label for all eight boards — per-participant rank would cost eight league calls per match.

`'unknown'` is a real value, not a placeholder: it is what a board gets when no tier could be established, and it must never be folded into a named bucket. Every board previously defaulted to `'challenger'` regardless of who played it, which is what made the rank dimension fiction.

| Export | Type / Description |
|---|---|
| `RankBucket` | `'iron_gold' \| 'plat_emerald' \| 'diamond' \| 'master_plus' \| 'challenger' \| 'unknown' \| 'all'` |
| `bucketForTier(tier)` | Maps a Riot tier string (case-insensitive) → `RankBucket`. Null/unrecognised → `'unknown'` |
| `tierInScope(tier, scope)` | Whether a tier is inside `CRAWL_TIERS`; compared on the Riot tier name so the env stays human-readable |

---

## Library Files (`src/lib/`)

### `db.ts`
PostgreSQL singleton pool. Exports `pool` (`pg.Pool`), `query<T>(text, params?)` → `T[]`, `one<T>(text, params?)` → `T | null`.

### `redis.ts`
Redis singleton. Exports `redis` (`ioredis`). **Note:** BullMQ does *not* share this instance — it uses its own connection options (`src/server/queue/connection.ts`).

### `icon-url.ts`
`iconUrl(path)` — converts an `ASSETS/...` game path to a `https://raw.communitydragon.org/latest/game/...` CDN URL.

### `game-data.tsx`
`'use client'` — global context for the popup/modal system (`GameDataProvider`, `useGameData()`, `useEntityTrigger()`, `EntityType`, popup components). Fetches `/api/game-data` once on mount. Descriptions render through `rich-text.tsx`; stats through `UnitStatsGrid`.

**`useEntityTrigger({ type, id, name, label?, stopPropagation? })`** returns the full spreadable prop set for a unit/trait/item trigger: `role="button"`, `tabIndex`, `aria-label`, `aria-haspopup`, mouse handlers, **`onFocus`/`onBlur`**, and an Enter/Space `onKeyDown`. Triggers stay styled `div`/`span`/`img` rather than real `<button>`s because the global CSS would need appearance resets in eight partials; the ARIA button pattern is equivalent as long as role + tab stop + key handler ship together, which is exactly what centralizing them here guarantees. Before this, every trigger was `onMouseEnter`/`onClick` only — no keyboard or touch user could open any unit, trait, or item detail anywhere in the app (WCAG 2.1.1, and 1.4.13 for the hover-only tooltip).

The modal puts `role="dialog"`/`aria-modal`/`aria-label` on the **panel** (the backdrop is the click-to-dismiss surface), focuses it on open, traps Tab inside it, and restores focus to the opener on close.

### `rich-text.tsx`
`'use client'` — renders the `«class:text»` token format that `load-static-data.ts` emits (CDragon semantic tags → colours). `RichText` PARSES the nesting-capable grammar into React spans (never innerHTML — no injection surface); `richToPlain` / `richFirstLine` flatten tokens for tooltips. Class names map 1:1 to `.rt-<class>` in `rich.css`. Plain (token-free) text renders unchanged.

### `planner/core.ts`
Pure planner types + algorithms (`PlannerUnit/Trait/Item/Data`, `Cell`, `ActiveTrait`, `BOARD_*`, `emptyBoard`, `computeActiveTraits`, `encodeBoard`/`decodeBoard`, `encodeRiotCode`/`decodeRiotCode`).

`computeActiveTraits` accumulates a contribution PER UNIT (`Map<traitId, Map<unitId, n>>`) rather than a flat tally, then sums. That shape is what lets the same unit placed twice still count once while a unit that counts as two of a trait counts as two — see `PlannerUnit.traitCounts`, an optional `{ traitId: n }` carrying only the entries that differ from 1. It is resolved server-side in `planner-data.ts` from `set-config.traitContribution`, so this module stays pure and the client never ships the registry. Emblem grants take `max(innate, 1)` instead of adding: an emblem on a unit that already has the trait is wasted in game, which the previous `Set`-based dedupe gave for free and numeric contributions would otherwise break.

### `riot/types.ts`
Riot API DTO type definitions (`AccountDto`, `SummonerDto`, `LeagueEntryDto`, `LeagueItemDto`, `LeagueListDto`, `MatchUnitDto`, `MatchTraitDto`, `MatchParticipantDto`, `MatchDto`).

### `riot/rate-limiter.ts`
Sliding-window-log rate limiter (`RateWindow`, `DEV_APP_WINDOWS` = 20/1s + 100/2min, `SlidingWindowQueue` with priority `acquire`).

### `riot/client.ts`
Typed Riot API client. All methods cached in Redis and rate-limited.

**Path-segment safety:** every caller-supplied id (`matchId`, `puuid`, `summonerId`) goes through `encodeURIComponent` plus a format guard (`MATCH_ID_RE`, `ID_TOKEN_RE`) before it reaches the URL, throwing `RiotApiError(400, 'Malformed …')` on a mismatch. Un-encoded segments let a caller inject `../` or `?` — the WHATWG URL parser then normalizes them into a **different** Riot endpoint, turning the client into an authenticated proxy on our own API key. The guard lives here (not only at the route) so a future caller that forgets to validate is still safe.

| Export | Description |
|---|---|
| `Priority` | Enum: `USER = 10`, `BATCH = 0` |
| `RiotApiError` | Error subclass with `.status: number` |
| `riot.account.byRiotId / byPuuid` | → `AccountDto` (regional host; SEA routed via ASIA) |
| `riot.summoner.byPuuid / byId` | → `SummonerDto` (platform host) |
| `riot.league.byPuuid / bySummoner / apex` | → entries / list (platform host). `bySummoner` is **deprecated** (Riot removed `/by-summoner` June 2025); use `byPuuid` |
| `riot.match.idsByPuuid / byId` | → match IDs / `MatchDto` (regional host). `idsByPuuid` opts: `start`, `count`, `startTime` (epoch seconds — excludes games started earlier; the crawler's current-patch-only filter) |

**Transport-failure handling:** a network-layer failure (DNS, reset, timeout) makes `fetch` **throw** rather than return a response — undici reports it as a bare `TypeError('fetch failed')` with the real reason on `.cause`. `request()` catches it, retries on the same exponential backoff as 429/5xx, and on final failure raises `RiotApiError(503, '… (ECONNRESET): <url>')` via `transportCause()`, so the cause reaches the worker log instead of the useless outer message. Unhandled, these escaped the retry loop entirely (it only inspected `res.status`) and killed the calling job.

**API-usage instrumentation:** the internal `request()` records every real HTTP call into `api_usage` (per-minute bucket, keyed by routing target + a stable `methodLabel(path)`, 429s tracked separately). It's **fire-and-forget** and never awaited, so it can't add latency to or break a call. Centralized here, so any caller — including the workers — is instrumented automatically with no per-caller logging.

### `riot/index.ts`
Barrel — re-exports `riot/client.ts`, `riot/types.ts`, and `routeForPlatform`.

---

## Server Services (`src/server/`)

All files are **server-only** (never import into client components).

### `static-data.ts`
`getCatalog()` → `Catalog` (units/traits/items), stale-while-revalidate, 1h TTL (a failed background refresh is swallowed — stale data keeps serving). Also exports `currentSet()` → current set number, shared by `library-data.ts` and `planner-data.ts`. It trusts the `is_current` patch **only when that set actually has rows in `units`**, else falls back to the newest set with units — the reader-side backstop to `patch.ts`'s live-set gate, so neither is a single point of failure.

### `view-models.ts`
View-model types + builders (`ItemVM`, `UnitVM`, `TraitVM`, `BoardVM`, `MatchSummaryVM`, `ProfileVM`, `LobbyParticipantVM`, `MatchDetailVM`, `LeaderboardRowVM`, `LeaderboardVM`, `Catalog`, `bucketOf`, `ordinal`, `buildBoard`, `buildProfileVM`).

### `accounts.ts`
Shared puuid → display-name resolver. **Accounts-table-first:** one DB read for a batch, Riot only for misses (bounded, persisted back). The single path leaderboard, match-lobby, and the crawler use — never per-row `account.byPuuid`.

| Export | Description |
|---|---|
| `ResolvedName` | `{ gameName: string \| null; tagLine: string \| null }` |
| `resolveAccounts(puuids, route, priority?)` | → `Map<puuid, ResolvedName>`. `priority` defaults to `BATCH` (foreground callers pass `USER`). Misses are upserted into `accounts`. A stored row with a **NULL game_name counts as a miss** (frontier stubs registered by the crawler are name-less) so its name still resolves and persists. Caller must tolerate a null name (truncated-puuid fallback) |

### `instrumentation.ts` (src root)
Next's one guaranteed server-startup hook. `register()` runs once when the server boots and calls `assertEnv('web')` — the only place in the App Router where "check this before serving anything" is possible, since no other module is guaranteed to be imported first on every request path. Verified to log before `Ready`. Node runtime only (`NEXT_RUNTIME === 'nodejs'`); the Edge runtime has neither the Postgres nor the Redis connection this validates.

### `comp-gkey.ts`
The archetype **grouping key**, as SQL, in one place: `GKEY_SQL` = `COALESCE('m:' || NULLIF(c.meta_comp, ''), 'c:' || c.id::text)` (requires `comps` aliased as `c`). Its own module because BOTH PLANES need it and must not drift — the read plane groups the tier list and detail page by it, the ingest plane groups the daily trend snapshot by it, and the read-plane modules import `next/cache` at module level so a worker stage cannot reach the constant through them. `comps-service.ts` re-exports it, so every existing call site is unchanged. Indexed by `0016_comps_gkey_index.sql` — keep the expressions identical or the index stops being used.

### `config/env.ts`
`assertEnv(runtime: 'web' | 'worker')` — boot-time configuration validation. Two tiers: **FATAL** (the variable is absent, or still holds the literal `.env.example` placeholder) throws ONE error listing *every* problem at once, each with what breaks without it; **WARN** (present but weak or oddly shaped — a short admin password, a sub-32-char session secret, a `DATABASE_URL` that is not `postgres://`) is reported and never fatal, because those are judgement calls about someone else's deployment. Requirements are **scoped per runtime**: the worker needs `DATABASE_URL` / `REDIS_URL` / `RIOT_API_KEY`, the web app additionally needs `ADMIN_PASSWORD` / `ADMIN_SESSION_SECRET`. Replaces three ad-hoc `NODE_ENV === 'production'` throws that covered neither admin secret — a missing `ADMIN_SESSION_SECRET` used to fail per-request inside `getSecret()`, and a missing `ADMIN_PASSWORD` was worse: `passwordMatches()` logged and returned false, which reads as "wrong password" to whoever is logging in. The point-of-use guards in `lib/*` stay as the backstop for scripts, which import those modules without a boot path. Covered by `src/config/env.test.ts`.

### `config/queue-ids.ts`
`RANKED_TFT_QUEUE_ID` (1100) — the only queue the meta is built from. Its own module because the filter is no longer read-side-only: `match-persist` now uses it to decide whether to store boards at all, so a drift between copies would stop merely wasting space and start silently omitting boards a reader is looking for — unrecoverable without a re-crawl. Imported by `stages/cluster`, `stages/rollup`, `stages/merge` and `match-persist`. **Still inlined by hand** in `comp-detail-service.ts` and `comps-example-team.ts` (the id sits inside the SQL text); grep `queue_id = ` if it ever changes.

### `patch.ts`
Single source of truth for deriving a patch from `game_version`. Shared by the profile write-path and the M4 match-fetch worker so both land matches on the same `patch_id`.

| Export | Description |
|---|---|
| `patchFromVersion(gameVersion)` | `"Version 14.11.633…"` → `"14.11"` (or null) |
| `resolvePatchId(client, setNumber, gameVersion)` | Resolves the `patches` row id for (set, derived patch), creating it on first sight; returns `id` (or null when the version has no parseable patch). Runs on a transaction-scoped `PoolClient`. **READ-FIRST, `DO NOTHING` on conflict** — it runs once per persisted match inside the caller's transaction, so it must not hold a `patches` row lock until COMMIT. The old `ON CONFLICT DO UPDATE SET patch = EXCLUDED.patch` was a no-op write that locked the row anyway and burned a sequence value + dead tuple per match (`patches.id` reached 77,700 for 70 rows). Steady state is now ONE statement and zero row locks. A third statement covers the insert-race |
| `advanceCurrentPatch()` | Advances the single global `is_current` flag to the newest patch observed for the **live set**, in one statement outside any transaction. Returns `{ patch, changed }`, or null when there is nothing to flag (no catalog, or no matches yet) — in which case the flag is left alone, not cleared. Called once per **ladder-crawl** pass. **Moved out of `resolvePatchId` 2026-08-21:** the flag write took row locks chosen by a table-wide predicate while the same transaction held `matches`/`match_participants` locks, at `matchWorker` concurrency 3 — a real lock-ordering cycle that deadlocked a `chain-merge` on 2026-08-18 and wedged the pipeline for hours. A patch flips ~fortnightly; paying per match bought nothing. **LIVE-SET GATE:** patch strings are only comparable WITHIN a set — rotating game modes replay old sets on today's client version, so `"16.14"` exists for sets 1, 16 and 17 in real data. The winner is chosen only among live-set patches (`MAX(set_number)` from `units`), numerically (`16.10` > `16.9`), **and only among patches that actually have matches** — `patches` mixes two numbering systems in one column: match-derived rows from `game_version` (label NULL, `"16.16"` — the CLIENT version) and catalog rows written by `load-static-data.ts` (label set, `"17.6"` — the OFFICIAL TFT patch). Both sit on set 17 and the official number sorts HIGHER, so ordering the table alone flags a row with zero matches behind it, which empties ladder-crawl's current-patch boundary (`MIN()` over no rows is NULL = no filter) and points the patch selector at a patch with no `comp_stats`. Caught by `_patch-check.ts` 2026-08-21. Choosing absolutely rather than comparing against the flagged row also self-heals a flag already stolen by another set |
### `match-persist.ts`
`persistMatch(match, bucket = 'unknown')` — idempotent match persistence (early-exit on existing `match_id`, all sub-inserts `ON CONFLICT DO NOTHING`, carry heuristic, `patch_id` via `resolvePatchId`). Shared by the profile path **and** the match-fetch worker. Extracted from `profile-service.ts`. Returns `PersistOutcome` = `'skipped'` | `'stored'` | `'meta-only'`.

**RANKED-ONLY BOARDS (2026-08-21).** The `matches` row is always written; the participant fan-out (boards, units, traits, augments) only when `queue_id === RANKED_TFT_QUEUE_ID` (1100, from `@/config/queue-ids`). Every downstream stage and every read query already filters on that queue, so for the other half of the crawl — Double Up, Normals, event modes — the fan-out wrote ~190 rows per match that nothing has ever read. Measured 2026-08-21: **50,754 of 104,342 stored matches (48.6%) are non-ranked**, accounting for roughly half of `participant_units` (1441 MB), `participant_traits` (1302 MB) and `match_participants` (1161 MB). Two things this deliberately does NOT do: it does not drop the `matches` row (the crawl's dedup check reads it — without it the crawler would re-fetch every non-ranked match every pass and spend MORE Riot budget), and it does not save API quota at all (`queue_id` is only known AFTER the fetch). What it saves is write throughput and disk. A match with a NULL `queue_id` counts as non-ranked, since readers filtering `queue_id = 1100` could never reach its boards anyway. The child-row shaping loop is skipped too, not just the inserts. **Historical rows are untouched** — deleting the ~2.7 M already-stored non-ranked unit rows is a separate, irreversible step.

**BOTS ARE NOT PLAYERS (2026-08-22).** Participants with the literal puuid `'BOT'` are dropped, and `matches.player_count` records how many REAL players were in the lobby. AI-filled lobbies report **every** bot under that same puuid, and the participant insert is `ON CONFLICT (match_id, puuid) DO NOTHING` — so a lobby's bots used to collapse into ONE stored row. That was the entire cause of what the audit had logged as a "short lobby" data-quality problem and recorded as a genuine Riot-payload characteristic. Measured 2026-08-22: **all 955 ranked matches with fewer than 8 stored boards contain a bot row, and none is short for any other reason**; 3,064 bot boards existed (exactly one per affected match, which is the proof) and **1,825 of them had been clustered into 1,161 real comps** at avg placement 6.34. Remove them and full lobbies sit at avg **4.500 / 50.00%** — the theoretical values, which is the tell that lobby composition and not luck was the whole effect.

**BATCHED (2026-08-18):** each child table is ONE multi-row `INSERT … SELECT … FROM unnest(...)`, so a match costs ~10 statements instead of ~190 sequentially-awaited single-row inserts (8 participants × (1 + ~10 units + ~10 traits + ~3 augments)) — at a 400-match crawl pass that was ~76 k round-trips of pure latency with the transaction held open throughout. Two details the batching depends on: the participant insert is `ON CONFLICT DO NOTHING … RETURNING id, puuid`, which returns rows **only** for participants this call actually inserted (so a concurrent duplicate persist writes no children, exactly as the old per-row loop skipped them on an empty `RETURNING`); and `item_ids` travels as a JSON string per row, expanded back with `ARRAY(SELECT jsonb_array_elements_text(...))`, because a ragged array-of-arrays cannot pass through `unnest` — Postgres multidimensional arrays must be rectangular.

### `profile-service.ts`
Fetches player profile, hydrates from Riot, persists via `persistMatch`. Exports `ProfileMatch`, `PlayerProfile`, `ProfileNotFoundError`, `getPlayerProfile(platform, gameName, tagLine)`. (Match persistence + patch derivation now live in `match-persist.ts` / `patch.ts`.)

### `leaderboard-service.ts`
Apex ladder, sorted + paginated. Names for the visible page resolve through `resolveAccounts` (one batched call). Exports `LEADERBOARD_TIERS`, `TIER_LABELS`, `isLeaderboardTier`, `getLeaderboard(platform, tier, page, pageSize)`.

### `match-service.ts`
`getMatchDetail(platform, matchId)` → `MatchDetailVM`. All 8 lobby names resolve through one `resolveAccounts` call.

### `library-data.ts`
`getLibraryData()` → `LibraryData` (units/traits/items/augments) for the library + popups. Item rows are gated by `set-config.isSetItem(set, id)` — the cross-set `TFT_Item_` pool plus the set's own namespace — NOT a hardcoded `TFT{n}_Item_` prefix.  Descriptions carry `«class:…»` rich tokens (from `load-static-data.ts`); `LibItem.stats: ItemStat[]` holds item stat bonuses; trait `Breakpoint.effect` holds each breakpoint's resolved effect text.

**Static-data loader (`scripts/load-static-data.ts`, `npm run data:load`):** `resolveDesc` interpolates `@Var@` values then converts CDragon semantic tags → `«class:…»` tokens (colour), drops `<ShowIf.…>` augment-conditional blocks and unresolvable/empty tokens, and maps `%i:…%` stat icons (damage-scaling ones dropped to avoid confusing bare "(AP)" fragments). `buildTraitContent` splits a trait into intro + per-breakpoint effect text; `itemStats` extracts curated stat bonuses from `effects`. `TFT_DATA_FILE=<path>` loads a local `en_us.json` instead of fetching latest.

### `planner-data.ts`
`getPlannerData()` → `PlannerData` (units with plannerCodes, traits, items). Items are gated by `set-config.isSetItem` (same rule as `library-data.ts` — a hardcoded prefix here is what hid set 18's emblems from the trait engine). Each `PlannerUnit` also gets `traitCounts` resolved from `set-config.traitContribution`, carrying only the traits where the unit counts as more than one.

### `variant-resolve.ts`
Recovers a unit variant Riot's match payload does not report. Set 18 reports every Lux as `DA_Lux18_Base` whichever Avatar element she chose (231 boards, zero variant ids), so an example board would always render a generic Lux. Avatar DOUBLES the chosen trait, so that trait is over-counted in `participant_traits` against what the board's units alone explain — one over-counted trait, one answer. `resolveVariants(setNumber, compIds, scope)` runs one query per configured family (set 18 has one; sets with none skip entirely, so this costs nothing on set 17) and returns raw `VariantTally[]` rather than a decision, because a displayed row often pools several comps and folding per comp first would let a 3-board comp outvote a 300-board one. `pickVariants(tallies, compIds)` is the pure fold → `reported id -> id to display`, summing boards across the row and breaking ties on the id so a row does not flicker between requests. Called from `comps-example-team.ts`, which swaps only the tile's face — the aggregation still keys on the id Riot reported. An emblem inflates a trait by 1, below the `minDelta` of 2, so it cannot produce a false positive. **DISPLAY ONLY, deliberately:** which Lux you hit is mostly luck rather than a planned line, and she clears several breakpoints alone, so letting it into comp signatures would fragment the data for a distinction players do not plan around. Measured on live data: 40 of 41 clustered Lux boards resolved, across 8 variants.

### `set-config.ts`
**The ONE place per-set curated game knowledge lives** — everything else is set-agnostic or set-versioned in the DB. `SET_CONFIGS: Record<number, SetConfig>` keyed by set number; old blocks stay forever (historic sets keep classifying exactly as they did — comps/merges/displays are all set-scoped), and a new set's block can be added ahead of release (PBE prep) without touching the live set. `SetConfig` = `heroAugmentChampions` (empty = mechanic absent, ##aug no-ops), `damageItems` (per-set on purpose — ids are cross-set `TFT_Item_*` names whose ROLE changes between sets; never union), `augmentGatedUnits` (Invader-Zed-style augment-only units → ##gate class), `mechanicItemPatterns` (cashout weapons/anomalies — counted as completed items, display-preference only). Accessors (memoized, warn-once for unconfigured sets, which degrade gracefully): `damageItems(set)`, `heroAugmentChampions(set)`, `augmentGatedUnits(set)` (∪ `MERGE_GATED_UNITS` env extras — additive debug override), `isMechanicItem(id)` (union across sets — ids are set-prefixed so patterns can't cross-match). **Set 18 added two fields.** `itemIdPrefixes` — the id namespace for the set's OWN items, beyond the cross-set `TFT_Item_` pool. Sets 1–17 all used `TFT{n}_Item_`, so it was hardcoded at the two call sites; set 18 ships `DA_18_*`, which made all 156 of its emblem rows invisible to both the Library and the planner (and silently disabled the planner's emblem branch). Accessors `itemIdPrefixes(set)` and `isSetItem(set, itemId)`; an unconfigured set falls back to `TFT{n}_Item_`, so pre-set-18 behaviour is unchanged. `traitMultipliers: TraitMultiplier[]` — units that contribute MORE THAN ONE to a trait, read via `traitContribution(set, unitId, traitId)` (default 1). `TraitMultiplier` = `{ unit: RegExp; traits: string[] | '*'; exceptTraits?: string[]; count: number }`; the pattern exists because variant families share a rule but not a prefix (set 18 spells Lux both `DA_18_Lux_*` and `DA_Lux18_*`), and `'*' minus exceptTraits` is how Avatar is expressed — each Lux carries Avatar plus the one element she chose, and it is the element that doubles. Set 18: Elder Dragon → 2 Riftbeast, any Lux → 2 of her chosen trait. Not derivable from CDragon (the multiplier appears only in trait prose), so both are transcribed and verified against Riot's per-board `participant_traits` counts. Covered by `set-config.test.ts`.

### `item-filters.ts`
`COMPONENT_IDS`, `COMPONENT_ITEMS` (components + EmptyBag — the shared "excluded when counting completed items" set used by carry-classify, comps-example-team, and comp-detail-service), `ARTIFACT_ID_RE` / `isArtifactItem(id)` (artifact-class RNG items: `TFT_Item_Artifact_*` **plus** the legacy `TFT4_/TFT9_Item_Ornn*` families — e.g. Gold Collector — and `TFTEventPM_Item_Artifact_*`; classifies Library/planner kinds), `isMechanicItem(id)` (re-exported from `set-config.ts` — set-mechanic specials, e.g. set 17's Anima Squad cashout weapons + Ekko Offering anomaly; they stay COUNTED as completed items everywhere per the 2026-07-17 user ruling, the class only steers display preference), `RADIANT_ID_RE` / `isRadiantItem(id)` (upgraded radiant variants, id carries a "Radiant" token — mechanic items excluded, `Tier2/3_RadiantField` is a cashout weapon), `isRngAcquiredItem(id)` (artifact ∪ radiant ∪ mechanic — the "never a plannable build" predicate example boards prefer to avoid), `ITEM_JUNK`, `ITEM_NAME_JUNK` — filter junk items out of match data.

### `admin-auth.ts`
Minimal single-operator admin auth. **No user table** — one password in `ADMIN_PASSWORD`, a signed (HMAC-SHA256) httpOnly cookie carries the session. Upgrading to multiple admins is localized here.

| Export | Description |
|---|---|
| `issueToken()` / `verifyToken(token)` | **The token contract** — `base64url({exp}).hmac`, 7-day TTL. Exported (2026-08-22) because together they ARE the admin auth surface and everything else here is cookie plumbing; private, the cases that matter (forgery, tampering, expiry, secret rotation) could not be tested at all. `verifyToken` THROWS when `ADMIN_SESSION_SECRET` is unset — a missing secret is a deployment fault, not a failed login — so `isAuthed` catches it and reads as unauthenticated. Boot validation makes that unreachable in practice |
| `passwordMatches(submitted)` | Constant-time compare against `ADMIN_PASSWORD`. Hashes both sides to a fixed length FIRST, so an attacker-controlled length can never make `timingSafeEqual` throw |
| `startSession()` / `endSession()` | Set/clear the signed cookie (call only from a Server Action / Route Handler) |
| `isAuthed()` | True if the request carries a valid, unexpired session |
| `requireAdmin()` | `redirect('/admin/login')` unless authed — called by the (panel) layout, and **must** be called by any future `/api/admin/*` handler (a layout guard does not cover API routes) |

Env required: `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`.

### `rate-limit.ts`
Redis-backed request throttling for the endpoints that spend the Riot API budget. **Two layers on purpose:** per-IP (fairness; derived from `x-forwarded-for`, so spoofable and NOT a security boundary) and global (budget protection; holds even when the per-IP key is forged). **Fail-open** — a Redis outage allows requests and logs, because the failure it prevents (a spent key) is recoverable and the one it would cause (the whole site 500ing) is not.

| Export | Description |
|---|---|
| `LIMITS` | Named limits, all env-overridable: `riotRead` (`RL_RIOT_PER_IP` 30, `RL_RIOT_GLOBAL` 120, `RL_RIOT_WINDOW_S` 60), `adminLogin` (`RL_LOGIN_PER_IP` 5, `RL_LOGIN_GLOBAL` 20, `RL_LOGIN_WINDOW_S` 300) |
| `clientIp()` | Leftmost `x-forwarded-for` entry, else `x-real-ip`, else `'unknown'` |
| `rateLimit(bucket, limit)` | → `RateLimitVerdict { ok, retryAfter, scope }`. Fixed-window counters; both layers share one window id so a caller can't straddle two windows |
| `limitRiotRead(bucket)` | Convenience wrapper applying `LIMITS.riotRead` |

Callers: the profile/match/leaderboard pages and their API routes (`limitRiotRead`), and `loginAction` (`LIMITS.adminLogin`, checked **before** the password compare so a wrong guess still costs a slot).

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
| `loadExampleTeams(groups: ExampleGroup[], patchId, region, rankBucket, cat)` | **GROUP-SCOPED (2026-07-17)**: a group = the member comps behind one displayed row (`{ key, compIds, n, hitTargetIds? }`), so the example board/traits/stars aggregate over the POOLED members instead of one representative comp (the fix for every rep-vs-pool mismatch class from the manual review). A comp may back several groups at once (detail page: variant strip + most-played board). Item SETS are grouped SQL-side (no per-board row shipping at pooled scale); `n` is the group's pooled board count (frequency denominator). `hitTargetIds` (reroll-cost label carries) render their **hit-state star** when the 3★ share among fielders ≥ `EX_STAR_HIT_MIN_SHARE` (0.15) — the modal star of a 40%-hit reroll target is 2★, but 3★ is what the row's name promises. `EX_POOL_MEMBER_CAP` (12, exported) bounds each group to its biggest members. Zero-breakpoint traits filtered as before; the modal item set prefers the most-played set with **no RNG-acquired item** (`isRngAcquiredItem`: artifacts + radiants + set-mechanic specials) — a drop never headlines the example build; such a set shows only when the unit has nothing else (the anima-cashout line's carries legitimately show anima weapons) |

### `comps-service.ts`
Read-side service for the **M5 comp tier list**. Drives from `comp_stats` + `bucket_totals` grouped by `comps.meta_comp` (unlabeled comps stand alone on their own id); `tier_list_entries` only supplies **manual pins** now (an `is_manual` row on any member pins the archetype's tier — highest-n pinned member wins). **The tier floor is POOLED**: an archetype qualifies when Σ n across its members (including merge's assigned sub-floor tail) reaches `TIER_MIN_SAMPLE` — a per-member floor survivorship-dropped exactly the missed-hit boards. Representative (identity + example board) = the member with the most 3★s **on the label's carries** (a lottery 3★ on a fast-8/9 line is luck, not identity) with a usable sample (n ≥ max(5, 5% of pooled)), then highest n — **and 3★s count only for hit-shaped lines** (≥ `HITS_DEFAULT_MIN_SHARE` (0.35, exported, same knob as the detail page's default tab) of pooled games hit a label carry): a 3%-hit line shows its most-played board, never the rare-hit board. Reroll lines show the board they're trying to hit; lines that don't roll for 3★s show their most-played board. **Identity comes from the merge label**: carry portraits/names are the label's dominant itemized carries (cost-desc; rep's 3★ set only for unlabeled singletons / no-carry archetypes), `##dup:`/`##aug:`/`##gate:` segments surface as `CompIdentityVM.dupUnits`/`heroAugmentUnit`/`gatedUnits` (badges in `TierTable`; `##gate:` = augment-gated units, e.g. Invader Zed variants), and `keyTraits` ALWAYS come from the POOLED example team's top non-unique traits (2026-07-17 — one source of truth with the strip, so a badge can never promise a trait tier the pooled boards don't hit; stored key_traits only when the group has no board data) before `displayName` ("[trait] [carries]") is recomputed. **Example/identity scope is the representative VARIANT's own members** (base variant excludes folded-in emblem comps), capped to the biggest `EX_POOL_MEMBER_CAP` members, passed to group-scoped `loadExampleTeams`. **EMBLEM VARIANT FAMILIES**: each archetype is a family — `resolveFamily` (exported, shared with the detail page) splits its members by worn emblem set (from each comp's `emb:` signature tokens) and *folds worse/equal emblem variants into base* (a random emblem you had to take belongs in base's honest distribution), keeping only *meaningfully-better* ones — the edge must be **practically** real (swing ≥ `EMBLEM_SPLIT_MIN_SWING` 0.15), **statistically** real (swing ≥ `EMBLEM_SPLIT_SIG_K` (1.5) × combined placement SEM — the adaptive part: a small well-sampled edge counts, a big thin one doesn't), and not a micro-sample that could headline (n ≥ `max(EMBLEM_SPLIT_MIN_N_FLOOR 50, EMBLEM_SPLIT_MIN_N_FRAC 0.05 × family boards)`). The best-scoring survivor is the tier row (badged emblem, family-total play rate, `CompRowVM.variantCount` marker); the **example board for the base variant is sourced from its no-emblem comps** so a folded-in emblem board never appears on an unbadged row. Tiers are **dynamic** (`bucketTierCutoffs`/`loadArchetypeScores` → `tierForScore`), shared by the tier list and the detail page. The emblem-class merge guard is OFF — the split is read-side and retunable. Loads example teams via `comps-example-team`, and runs `computeMetrics` per pooled group on read (same `comp-stats-math` the writer uses). All VM types live in `comps-types.ts` and are re-exported here.

| Export | Description |
|---|---|
| `getTierListCached(q)` | **Use this from pages.** `unstable_cache` wrapper over `getTierList`, `revalidate` = `COMPS_CACHE_TTL_S` (300 s), tag `comps`. Arguments are flattened to primitives so the cache key is deterministic. TIME-based rather than tag-based because the pipeline runs in a separate process and `revalidateTag` only reaches the Next runtime from inside it; the tag is declared so a revalidate route can be added later without touching call sites. Measured production effect: `/comps` 3.80 s → 0.25 s. The uncached export stays for the merge tooling and because `unstable_cache` needs a request context |
| `getTierList(q: TierListQuery)` | → `TierListVM`. Probes available `(patch, region, rank_bucket)` combos to drive the three selectors and resolve/validate the selection (default = current patch → highest volume); pools each group's sufficient stats, tiers S→D by pooled score; the niche flag appends the below-pooled-floor groups (biggest first, capped). Returns `null` selection when nothing is clustered yet |
| VM types (re-exported) | `TierListVM`, `TierGroupVM`, `CompRowVM`, `CompIdentityVM`, `CarryPortraitVM`, `KeyTraitChipVM`, `ExampleTeamVM`, `ExampleUnitVM`, `ExampleTraitVM`, `ExampleItemVM`, `SelectorOptions`, `PatchOption`, `TierListSelection`, `TierListQuery` |

### `comp-detail-service.ts`
Read model for the **comp-detail page (M6)** — one archetype drilled down. `getCompDetail(groupKey, q)` → `CompDetailVM | null`: resolves the (patch, region, bucket) via the same combos probe as the tier list, loads the family's member rows, and runs `resolveFamily` (shared with comps-service) to build the **emblem-variant switcher** (`variantOptions` + `selectedVariant`, driven by `q.variant`); ALL aggregations below scope to the selected variant's members. Shared exports used: `loadCombos`, `resolveSelection`, `resolveFamily`, `asCarries`, `CompStatRow`. Adds board-level aggregations (SQL-side, scoped to the bucket + ranked queue): core/flex unit strips (**label carries are pinned into core** regardless of frequency — a unit that names the comp never renders under "Flex") + per-unit table with star split and a placement **delta** vs the archetype average; final-level distribution (7-/8/9+); **hit-state variants** (members grouped by exact 3★ set, pooled — the "when you hit vs when you don't" numbers); a 1st–8th **placement histogram**; carry item builds (modal completed sets); most-played exact boards via `loadExampleTeams`. The core/flex strips **mirror the VARIANT-POOLED team** (2026-07-17 — same group scope as the tier list row: build-evidence members, biggest first, `EX_POOL_MEMBER_CAP`-bounded) so the two pages can never disagree; the overlay carries `modalCopies`/`copyStars` onto `DetailUnitVM`, so a `##dup` line's strip renders BOTH copies (spare keeps its star pip, no items — `stripTiles` in `CompDetail.tsx`); units the pooled team doesn't field keep their builds-derived set, and the units table keeps the aggregate per-star split. Header trait chips also come from the pooled team traits (stored key_traits only as fallback). **Carry-item builds for the base variant scope to emblem-free members only** — folded-in emblem comps pool into base's stats but their builds must not surface a worn emblem as a "best item" on the unbadged row (emblem variants keep all members; the emblem is their identity). Variant links always carry an explicit `?variant=` (empty = base) — with the param omitted the server resolves the representative variant, so the base pill would go nowhere. `hitStatesDefault` marks hit-shaped lines (≥ `DETAIL_HITS_DEFAULT_MIN_SHARE` (0.35) of games hit a 3★) — the view opens those on the Hit states tab, everything else on Placement. Tunables: `DETAIL_CORE_MIN_FREQ` (0.75), `DETAIL_FLEX_MIN_FREQ` (0.25); core+flex together cap at `STRIP_MAX_UNITS` (10) so the strips stay board-plausible; the per-unit noise floor adapts down for small samples (`min(10, ceil(n/2))` — a 7-game niche comp renders instead of an empty units table). A stale `c:<id>` link (comp labeled by a later merge run) re-resolves to the comp's current group key instead of 404ing. Derived on read; no new tables.

`getCompDetailCached(groupKey, q)` is the page-facing wrapper — same TTL knob and rationale as `getTierListCached`, keyed on the full selection plus variant so each variant caches independently. Measured production effect: `/comps/[key]` 0.30 s → 0.012 s.


**TREND, BY REAL PLAY DATE (2026-08-22).** The detail trend is grouped on `matches.game_datetime`, not differenced from `comp_stat_trends` snapshots. The old version measured **when the crawler ran**: the rollup recomputes `comp_stats` from every stored board, so each snapshot is cumulative-over-INGESTION and a backfilled old match lands in today's delta. Measured on 16.13, whose last real match was 07-16, the chart drew bars on **08-17 and 08-18** (312 games nobody played then), compressed the genuinely-played 07-09..07-12 out of existence, and put the peak on the wrong day. Two queries now replace the snapshot read: the archetype's boards grouped by play date (~131 ms), and a bucket-wide daily denominator for `playRate` (~142 ms). `DetailTrendPointVM` is unchanged, so `TrendChart` needed only corrected copy. `getCompDetail` goes 392 ms — ~650 ms uncached, behind the same `COMPS_CACHE_TTL_S` cache. The denominator is identical for every comp in a `(patch, region, bucket)` and is deliberately NOT wrapped in `unstable_cache` — that would make `getCompDetail` implicitly cached and break its "uncached one from scripts" contract; materialising it per-day during the rollup is the proper fix if it ever matters.

**STALE-KEY RESOLUTION (2026-08-22).** `/comps/[key]` is `m:<meta_comp>`, and `meta_comp` is DERIVED — the merge recomputes it hourly from dominant carries, `##dup:`/`##aug:`/`##gate:` tags and a `##k:<compId>` collision anchor. Any of those moving used to 404 every bookmark and shared link. `resolveStaleKey()` now runs ONLY after an exact match fails (the happy path pays nothing) and tries three strategies, most precise first: **(1)** `c:<id>` — a singleton the merge has since labelled; **(2)** `##k:<id>` — **exact**, because the collision anchor is a real member comp's id (`min(compIds)` since Rev 10), so following it is a fact rather than a guess (22,565 current labels carry one); **(3)** the carry base with the `##` segments stripped, taking the biggest pooled group in that bucket — heuristic and therefore last, since bases collide (`no_carry` spans 124 distinct labels). Capped at `MAX_KEY_HOPS` (3) so two keys that resolve to each other cannot loop. `CompDetailVM.groupKey` reports whichever key actually matched, and `/comps/[key]/page.tsx` **redirects** to it when it differs from the request, so the bookmark heals instead of silently serving the right comp under a dead address. The redirect is TEMPORARY on purpose — the label can move again, so promising permanence would be a lie a browser would cache. Miss path measured at 111 ms (resolves to nothing) / 528 ms (resolves and renders).
### `comp-inspector.ts`
Admin/debug read model for the merge stage (Stage 6). `loadArchetypeInspector(setNumber?)` → `InspectorVM`: lists every `meta_comp` archetype and, for each, its member comps — floored to `MERGE_MIN_SAMPLE`/`TIER_MIN_SAMPLE` so it mirrors exactly what merge grouped, not the historical long tail. Parses the archetype label's `##dup:`/`##aug:` tag segments into `dupUnits` (doubled-copy augment units) and `heroAugmentUnit` (resolved hero-augment carry name, from `comp-merge.ts`'s `heroAugmentSig`); unknown segments (e.g. the `##k:` collision disambiguator) are ignored; each `InspectorUnitVM` also carries `isHeroAugment` so the specific champ is tagged inline, not just the archetype as a whole.

### Queue / Workers (`src/server/queue/`)

Background ingest runs in a **separate Node process** (`npm run worker`), not the Next runtime. BullMQ uses **connection options**, never the app's shared `ioredis` instance (BullMQ bundles its own ioredis; sharing an instance causes a version mismatch).

| File | Exports / role |
|---|---|
| `env.ts` | **Side-effect module, imported FIRST in `worker.ts`.** Runs `loadEnvConfig` (`@next/env`) so `.env*` loads before `@/lib/db` builds its pool. (A `loadEnvConfig()` call in the worker body runs too late — ESM hoists imports.) |
| `connection.ts` | `bullConnection: ConnectionOptions` — parsed from `REDIS_URL` (default `localhost:6379`), `maxRetriesPerRequest: null` |
| `job-tracking.ts` | `withJobTracking(jobType, region, fn)` — wraps work in an `ingestion_jobs` lifecycle row (`running` → `success`/`failed`, `error_count`, `items_done`). `JobContext.setItems(n)` reports progress. The single seam every stage runs through. `reconcileStuckJobs(olderThanMinutes)` — marks orphaned `running` rows failed, called once at worker boot with `JOB_STUCK_MINUTES` (env, default 30). A worker killed mid-job leaves its row `running` forever (60 had accumulated by 2026-08-21, oldest 2026-07-01, making the admin panel's health view meaningless). Safe against false positives two ways: the threshold far exceeds any real stage (slowest measured sweep is cluster at ~48 s), and the write is **advisory** — if the job is actually alive, `withJobTracking`'s own final UPDATE overwrites the row with the true outcome |
| `queues.ts` | `QUEUE` (stage names: `ladder-crawl`, `match-fetch`, `cluster`, `rollup`, `merge`, `trend-tier` — also used as `ingestion_jobs.job_type`), `QueueName`, `makeQueue(name)` |
| `chain.ts` | **Pipeline chaining.** `CHAIN_HEAD` (= `cluster`), `CHAIN_ENABLED` (`PIPELINE_CHAIN=false` to disable), `advanceChain(from, setNumber?)`, `closeChain()`. cluster → rollup → merge → trend-tier advance on **success only**, so a failed stage stops the chain instead of feeding garbage forward. `setNumber` propagates so a set-scoped cluster doesn't silently widen downstream. JobId `chain-<stage>` + `removeOnComplete`, so a head firing again mid-drain DEDUPES rather than queueing a redundant full recompute (the id avoids `:` — BullMQ only accepts colons in a custom id when it splits into exactly 3 parts). Producer queues are created once and reused; a Queue per completion would leak a Redis connection per pass |
| `worker.ts` | Worker entrypoint. Chains the derived stages via `advanceChain` on each `completed` event (so `RUN_CLUSTER=1` now runs the whole pipeline). **Six real BullMQ workers** in one process: `ladderWorker` (1), `matchWorker` (3), `clusterWorker` (1), `rollupWorker` (1), `mergeWorker` (1), `trendTierWorker` (1). Boot triggers, each behind its own env flag — run as **separate** `npm run worker` invocations so ordering holds: `RUN_CRAWL`, `RUN_CLUSTER` (optional `CLUSTER_SET`), `RUN_ROLLUP`, `RUN_MERGE` (optional `MERGE_SET`), `RUN_TREND_TIER`, `RUN_SCHEDULER` (register repeatables), `SCHED_CLEAR` (remove them). Graceful shutdown closes all six. |
| `stages/ladder-crawl.ts` | **Stage 1 — producer, FRONTIER-DRAINING.** `LadderCrawlJob { platform }`. `accounts` is the frontier registry. Each pass: (1) **DISCOVER** — pull the apex ladder(s), upsert their puuids into `accounts` as uncrawled candidates (entries missing a puuid are skipped — they surface as match participants anyway); (2) **DRAIN** — pull candidates, **rank-gate** them, then enqueue one `MatchFetchJob` per in-scope player.

**RANK GATE.** Each candidate costs one `league.byPuuid` call to resolve its tier (cached on `accounts.tier`, trusted for `CRAWL_TIER_TTL_HOURS`, default 72) — roughly 5 % overhead against the ~20 match calls that player is about to cost. Out-of-scope players are marked crawled and skipped **without** spending the match budget, and the resolved tier rides `MatchFetchJob.bucket` into `persistMatch`. Apex-ladder discovery records tier for free, so those accounts skip the lookup entirely.

**DRAIN ORDER matters as much as the gate**: the frontier is ~280 k accounts snowballed from match participants, of which only a few hundred are apex. Oldest-first would spend a lookup per candidate and enqueue nothing, so the ORDER BY puts cached-in-scope tiers first, unknown tiers next (the frontier still gets explored), and known-out-of-scope last, where the LIMIT drops them. `SEED_OVERSELECT` (4) gives headroom, since a skipped candidate consumes no enqueue slot. **Current-patch-only** (`CRAWL_CURRENT_PATCH_ONLY`, default on): every ids pull passes `startTime` = first observed current-patch match − `CRAWL_SINCE_MARGIN_HOURS` (12) — post-flip, old-patch games are history the budget shouldn't buy. The boundary is derived from data (never hand-set), self-advances when `advanceCurrentPatch()` moves `is_current` at the top of that same pass, and disappears at bootstrap (no current-patch match yet → unfiltered). Seeds are marked crawled **at enqueue** (a failing seed can't wedge the drain; one bad puuid is skipped, not fatal). Bounded by `maxPuuidsPerRun` / `maxMatchFetchesPerPass`. JobId keyed on `mf:{platform}:{puuid}`, `removeOnComplete: true` so a later re-crawl can re-enqueue. Below-apex ladders still unsupported (Risk R8 — needs paginated iteration). |
| `stages/match-fetch.ts` | **Stage 2 — consumer.** `MatchFetchJob { platform, puuid, matchIds, bucket }`. `runMatchFetch` iterates match IDs: existence-checked against `matches` first (skips the Riot call entirely for already-stored matches), then calls `riot.match.byId` + `persistMatch` for new ones. **Each id is wrapped in its own try/catch** — one bad id or one dropped connection must not discard the rest of a 20–30 id batch, which is what the unguarded loop did. Failures are counted and logged; the job throws only when **every** id failed, so a genuine outage still surfaces as a failed job rather than a clean pass that stored nothing. **Expands the frontier**: every participant seen in a stored match (except the literal puuid `"BOT"`) is upserted into `accounts` as an uncrawled candidate for the next drain. `ctx.setItems` reports how many matches were actually stored. `bucket` (the seed player's resolved tier) is passed to `persistMatch`, which writes it onto every board — this is what makes `rank_bucket` real rather than the `0009` column default. |
| `comp-signature.ts` | Pure comp-identity logic — the **only** place clustering granularity is tuned. Exports `buildIdentity(units: SigUnit[], emblems?: string[]): CompIdentity | null`, `isEmblemItem(itemId)` (id contains "Emblem"), `emblemsFromSignature(signature)` (parses `emb:` tokens back out, sorted — the single parser, shared by comps-service and the merge stage), `CompIdentity` (interface: `{ signature, coreUnits, threeStars, emblems }`), `SigUnit`, `MIN_BOARD_UNITS`, `SIG_STAR_MAX_COST`. Env knobs: `SIG_MIN_BOARD_UNITS` (default 6 — boards below this drop as surrenders/DCs) and `SIG_STAR_MAX_COST` (default 3). Exact-unit multiset identity: 3★ is its own star bucket **only for units at cost ≤ `SIG_STAR_MAX_COST`** — a 3★ 4/5-cost is a lottery hit or a set mechanic (Arbiter "print", 7-piece Meeple duplication) landing on a fast-8/9 board, so it collapses to the low bucket and merges with the same board without the hit; 1★ and 2★ always collapse. The same cost gate applies to `threeStars`, so comps.carries stays deterministic per signature and expensive "hits" never reach hit states, labels, or the grade3 merge guard. Signature = sorted `characterId:starBucket` tokens **plus sorted `emb:<emblemItemId>` tokens** for worn trait emblems (a board that runs an emblem clusters apart — an emblem can cross a trait breakpoint), pipe-joined. `threeStars` is surfaced for display labelling only. |
| `stages/cluster.ts` | **Stage 3 — clusterer.** `ClusterJob { setNumber? }`. `runCluster` sweeps every eligible board (standard ranked `queue_id` 1100, `set_number` known), signatures each via `comp-signature.ts`, upserts distinct `comps` (`ON CONFLICT (set_number, signature)`), stamps `match_participants.comp_id`, and **prunes orphan comps** in the processed sets. Writes remain ONE transaction (readers see the old clustering or the new, never a mix). Full re-cluster every run (idempotent on signature), so granularity is tuned by re-running. Bucket/patch-blind: comp identity is set-scoped. **CHUNKED (2026-08-18):** the scan is keyset-paginated over `match_participants.id` in `CLUSTER_SCAN_CHUNK` (25 k) board batches, each reduced to a signature immediately, so peak heap scales with DISTINCT COMPS (~180 k) rather than total unit rows — it previously loaded all 5.6 M `participant_units` rows at once (~2.2 GB, at the default old-space limit). Writes are multi-row `unnest` batches of `CLUSTER_WRITE_CHUNK` (5 k) and the clear step is set-based, so the transaction runs ~110 statements instead of one round-trip per distinct comp. character_ids are interned during the scan so the seed unit arrays share one string per champion. Measured 2026-08-18: 336 k boards scanned in 47.9 s, peak heap 513 MB / RSS 726 MB, assignments byte-identical to the pre-refactor state (0 changed across 330,859 boards).  **RANKED, FULL-LOBBY SCOPE (2026-08-22):** the scan takes only `m.player_count = 8`, so boards from bot-filled lobbies are never stamped — a board that only had to beat bots is not evidence about the meta (10,010 such boards averaged 3.638 / 67.4% top-4 against 4.500 / 50.00%). The **CLEAR step is deliberately broader than the scan**: it clears every ranked board's `comp_id`, including out-of-scope ones, so a board that leaves scope loses its stamp instead of keeping a stale one forever. Rollup needs no change — it already filters `comp_id IS NOT NULL`, so the exclusion propagates to `comp_stats` AND `bucket_totals`, keeping the play-rate numerator and denominator on the same population. The stage also **self-heals `player_count`** before scanning (deriving it for any match the writer left NULL), which closes the gap where a worker on a pre-0020 build keeps ingesting matches that would otherwise be excluded from the meta permanently. |
| `stages/rollup.ts` | **Stage 4 — rollup.** `RollupJob` (no params; full recompute). `runRollup` rebuilds `comp_stats` + `bucket_totals` from clustered ranked boards (`comp_id` + `patch_id` present, `queue_id` 1100), grouped by `(comp, patch, region, rank_bucket)`. Stores **sufficient statistics only** (`n`, `placement_sum`, `placement_sumsq`, `top4_count`, `win_count`); rates + Wilson/SEM intervals derived on read. `bucket_totals` counts clustered boards so play rates sum to 1. `DELETE`+`INSERT` in one transaction — readers never catch an empty table. |
| `comp-stats-math.ts` | Pure stats over `comp_stats` sufficient stats — the **single source** of scoring/intervals/confidence, called by **both** `trend-tier` (write) and `comps-service` (read), so the method can change with no re-rollup. Exports `computeMetrics`, `wilson`, `placementSem`, `confidenceLabel`, `scoreToTier`, `tierCutoffs`/`tierForScore` (**dynamic tiering** — S = the top `TIER_PCT_S` (0.10) of a bucket's archetype scores, etc.; fixes the static `TIER_BANDS` compressing the top so a 2.96- and a 4.0-avg comp both cleared S), and `SufficientStats`/`Interval`/`Confidence`/`CompMetrics`/`TierCutoffs`. Score = **shrinkage** toward the lobby prior (placement 4.5 / top-4 0.5) by `n/(n+SCORE_PRIOR_WEIGHT)` so a thin sample can't post a flashy score; **display** intervals stay 95% (Wilson for top-4, SEM for placement). Knobs: `SCORE_PRIOR_WEIGHT` (40), `LOW_SAMPLE_N` (30), `TIER_BANDS` (static fallback when <8 comps), `TIER_PCT_S/A/B/C` (0.10/0.27/0.50/0.75), confidence cutoffs. |
| `carry-classify.ts` | Pure carry classification (no DB). `classifyCarries(rows, totalBoards)` → `BucketCarry[]`: takes flat `RawUnitItem[]` (boardId, characterId, items), deduplicates copies per (board, unit), ranks units by completed-item count per board, accumulates `fullyItemizedRate` + `topItemizedRate` (a top slot only counts with ≥ 1 completed item — the rate feeds comp-profile's fallback-carry path) + modal item set per unit. `isBucketCarry = fullyItemizedRate >= CARRY_FULL_RATE` (env, default 0.5). `bucketCarryIds(carries)` extracts confirmed carry characterIds. Tunables: `CARRY_FULLY_ITEMIZED` (3), `CARRY_FULL_RATE` (0.5), `CARRY_TOP_ITEM_SLOTS` (2). Also classifies **hero augments** — the eligible-champion list and the damage-item pool are PER-SET knowledge resolved from `set-config.ts` by the caller and passed in (`classifyCarries(rows, totalBoards, damageItems)`; this module has no set awareness). `classifyHeroAugments(rows, totalBoards, eligibleIds, damageItems)` → `HeroAugmentCarry[]`: for champs the caller has already confirmed are 3-star (comp-wide, so checked by the caller), rate of boards where the champ holds ≥ `HERO_AUGMENT_MIN_DAMAGE_ITEMS` (2) damage items; `isHeroAugment = damageItemRate >= HERO_AUGMENT_RATE` (env, default = `CARRY_FULL_RATE`). Each `BucketCarry` also carries **`damageItemRate`** (share of boards whose best copy holds ≥ `CARRY_DAMAGE_MIN_ITEMS` (2) DAMAGE_ITEMS) — the damage-vs-tank itemization signal behind `CompProfile.damageCarries`. |
| `comp-profile.ts` | Pure `CompProfile` construction (no DB) — bridges carry-classify and comp-merge; extracted from the merge stage so tests and `scripts/merge-eval.ts` exercise the production path. `buildCompProfile(CompRowInput)` → `CompProfile`: `copySig` (doubled units, **cost-gated to 1–3-costs** via `MERGE_COPY_MAX_COST` — a doubled 4/5-cost is a late-game bench copy, not the duplicate augment; unknown costs never classify); `carries` = isBucketCarry with a **top-itemized fallback** when a comp never fully itemizes (dead / missed-hit boards keep their carry identity; `MERGE_FALLBACK_TOP_RATE` 0.5, max 2); `carryGrade3` = 3★ ∩ itemized (incidental 3★s from augment copies excluded); per-unit **identity weights** for overlap scoring (carries/3★ 1.0, core `MERGE_WEIGHT_CORE` 0.7, flex `MERGE_WEIGHT_FLEX` 0.25 for cost ≥ `MERGE_FLEX_MIN_COST` (4) units with item rates < `MERGE_FLEX_MAX_ITEM_RATE` (0.25)); `heroAugmentSig` plus `heroAugmentRates` (the continuous damage-item rate per eligible champ behind the sig — the merge guard's three-zone input) and `avgLevel` (from `CompRowInput.avgLevel`, the board-level intent signal; 0 = unknown). **2026-07-17 additions**: `damageCarries` (carries with `damageItemRate ≥ MERGE_DAMAGE_CARRY_MIN_RATE` (0.25) — the damage-vs-tank purity signal), `gatedSig` (sorted augment-gated units present — per-set via `set-config.augmentGatedUnits(set)` + `MERGE_GATED_UNITS` env extras; presence-based so tail profiles carry it), and `traitFrame` pass-through (built by the merge stage). Hero/damage/gated knowledge all resolves per set from `set-config.ts`. Also `buildTailProfile(TailRowInput)` — light profile for a sub-floor comp from comps-table data alone (no itemization): empty carries + empty damageCarries, FULL 3★ set as `carryGrade3`, neutral weights, `heroAugmentSig` '' with empty rates (a tail board never joins a hero-augment archetype), `avgLevel`/`traitFrame`/`gatedSig` populated — input for `assignTail`. |
| `comp-merge.ts` | Pure carry-archetype merge (no DB). `mergeComps(profiles)` → `Promise<MergeResult>` (**async** — yields to the event loop every `MERGE_YIELD_EVERY` (250) comps/archetypes so the worker's BullMQ lock renews; the sync-blocking loop is what made the early universal-merge attempt "time out"), in three passes: (1) greedy, **evidence-rich comps first, then evidence-less** (boardCount desc within each block — during block 1 no presence-profile accumulator exists, so floored comps group exactly as the floored-only merge did), each comp joining the best archetype among those that pass every guard, where an **evidence-rich archetype always outranks an evidence-less micro-archetype** (score breaks ties within a class; pure best-score let a sub-floor hit-variant's exact twins at score ~1.0 siphon it out of its real line); (2) a guard-respecting **fold pass** reuniting fragments stranded by greedy ordering; (3) labeling, where an evidence-less (micro) archetype labels from its **dominant 3★ set** (the human name of a fragmented reroll line) and colliding labels get a `##k:<anchorCompId>` disambiguator, where the anchor is the **smallest member comp id** (not the first-added one — `compIds[0]` churns when the pass-3 rebuild reorders membership, and since `meta_comp` is the `/comps/[key]` URL, a churned anchor silently 404s every shared link to that archetype) — `meta_comp` is the downstream grouping key, so two distinct archetypes must never share a label. **UNIVERSAL MERGE**: the input mixes floored profiles (item evidence) and presence profiles (`buildTailProfile`, empty carries) — an empty carry side uses the **presence proxy** (the board must field the other side's dominant carries, both directions) and an evidence-less comp joining an evidence-rich archetype pays `MERGE_ASSIGN_MARGIN` on the score bar; evidence-less vs evidence-less merges on units + guards alone (that consolidation is the point — niche lines fragmented across sub-floor hit-state signatures could never pool under assign-only labeling). **Perf** (semantics-neutral): each accumulator caches its derived profile (invalidated on membership change), and a unit→archetype **inverted index** (`UnitIndex`) prunes candidates via a provable jaccard-floor bound (`shared ≥ Jmin/(1+Jmin)·(wa+wb)`, Jmin = MIN_JACCARD − STRONG_CARRY_SLACK; pruning disables itself if Jmin ≤ 0). Score = UNIT_WEIGHT·containment + JACCARD_WEIGHT·jaccard + CARRY_WEIGHT·carryOverlap. **`carryOverlap` is a DICE coefficient** (`2·|A∩B|/(|A|+|B|)`, `diceOverlap`), not the overlap coefficient it used to be: `|A∩B|/min(|A|,|B|)` interacts pathologically with `getDomCarries`' single-carry fallback, where `min(|A|,1)=1` made the term BINARY — share that one carry and score 1.0, which also cleared `MERGE_STRONG_CARRY_OVERLAP` and unlocked the jaccard + score slack, so one unit flipped a comp from hard-fail to merge-with-relaxed-bars. Dice degrades gracefully (1-of-3 → 0.5: over the 0.34 carry bar, under the 0.75 slack bar) and is **identical whenever the two sets are the same size**, so well-behaved cases are unchanged. The presence PROXIES (evidence-less sides) deliberately stay containment-style. Measured 2026-08-19: no golden-pair change (28 pass / 4 known), 407 → 417 archetypes, +1,790 tail comps recovered, with containment/jaccard **weighted by per-unit identity weights** (from `comp-profile.ts`) so cap-unit swaps don't split a line (survivor effect). Hard-fail guards: `grade3_conflict` (**conflict-only 3★ guard** — fails only when both sides' carry-grade 3★ sets are non-empty and disjoint AND the comp has a real sample behind it (`MERGE_GRADE3_MIN_N` 10 — a 4-board comp's incidental 3★ is anecdote, not a reroll target); missed hits, extra hits, and different secondary hits pool into one line, genuinely different reroll targets split), `copy_class`, `hero_augment` (**three-zone**: two different augment champs always conflict; a sig-vs-'' mismatch conflicts only when the sig-less side is confidently augment-free for that champ — its damage-item rate ≤ `MERGE_HERO_AUG_LOW` (0.2); rates ride on `CompProfile.heroAugmentRates`, archetype-side diluted by **evidence weight** — every item-bearing member ON PURPOSE (an eligible-only denominator false-merges the labeled Jax pair), but never by presence-profile members, which carry no item testimony), `level_gap` (**board-level intent** — average final levels differing by ≥ `MERGE_LEVEL_CONFLICT_GAP` (1.75) are different game plans whatever the unit overlap; skipped when either side lacks level data), `emblem_class` (`emblemSig` must match — a trait-emblem build stays a distinct archetype from the plain line; `MERGE_REQUIRE_EMBLEM_CLASS`), `carry_overlap` (≥ MIN_CARRY_OVERLAP), `containment` (≥ MIN_CONTAINMENT), `jaccard` (≥ MIN_JACCARD). **Every** dominance election is **board-weighted** — carry, grade3, copy/hero/emblem sigs (a 15-board member can't out-vote a 900-board anchor; per-comp voting let accumulated small members flip a big archetype's `##aug` label live) — and the carry-share + hero-rate denominators are **evidence weight** (Σ boards of item-bearing members), so presence members can't dilute elections below their dominance bars. Also exports `debugCompare(a, b)` → `CompareResult` (score parts + failed-guard names), `makeTailAssigner(archetypeProfiles)` (index-backed batch form of assignTail — builds the `UnitIndex` once; required at singleton-tail × universal-archetype scale) and `assignTail(comp, archetypeProfiles, candidateLabels?)` — assign-only labeling of sub-floor comps against the **frozen** post-merge profiles (`MergeResult.archetypeProfiles`): carry evidence proxied by *presence* of the archetype's carries on the board (restricted to carries the archetype fields in its own unit set — off-board carriers like the Mecha summon prove nothing by their absence), conflict rule on the comp's full 3★ set, never joins a hero-augment archetype, score bar raised by `MERGE_ASSIGN_MARGIN` (0.02), and the same evidence-over-micro preference as the main pass. The strong-carry slack applies here too (proxy ≥ `MERGE_STRONG_CARRY_OVERLAP` relaxes the jaccard + score bars by `MERGE_STRONG_CARRY_SLACK`; containment and class guards never relax) — tail profiles carry neutral unit weights, so without it a couple of swapped cap units left same-line boards unlabeled over hundredths of jaccard. **Strong carry agreement buys unit slack**: when carry overlap ≥ `MERGE_STRONG_CARRY_OVERLAP` (0.75), the score and jaccard bars relax by `MERGE_STRONG_CARRY_SLACK` (0.06) — variants that agree on the itemized carries merge despite secondary-unit drift; hard class guards and containment never relax. **2026-07-17 (phase 10)**: (a) **damage-carry purity** — when BOTH sides have `damageCarries`, carry agreement compares those (itemized tanks/supports stop diluting the overlap; the 1/3-vs-0.34 boundary class), falling back to the FULL sets when the damage sets share nothing (item drift across one line's hit-variants must not split it); presence proxies deliberately keep full sets (a damage-narrowed proxy over-attracted evidence-less micros into same-vertical lines). (b) **THREE-block ordering** — evidence-rich classic → evidence-rich hero-sig → evidence-less: hero elections stay deterministic (arch rates are pure-classic when hero comps arrive, so the three-zone guard resolves both documented outcomes). (c) **Refinement sweep (pass 3)** — every comp re-scored against the frozen post-fold archetypes; moves only when another archetype passes every guard AND out-scores its home by `MERGE_REFINE_MARGIN` (0.10 — deliberately large: rescue misfits, never shuffle near-ties, which repolarized elections at 0.02); accumulators rebuild once (commutative sums). (d) **Trait-frame term** — `CompProfile.traitFrame` (trait → activation index, from `buildTraitFrame` in the merge stage); similarity Σ(min·max)/Σ(max²) (weight max² so verticals dominate splash noise; agreement linear so the 7→5 Meeple cap transition scores 0.67 on its vertical, not 0.44); strong sim (≥ `MERGE_TRAIT_STRONG_SIM` 0.65) buys `MERGE_TRAIT_SLACK_JAC` (0.12) + `MERGE_TRAIT_SLACK_SCORE` (0.15) — **evidence-rich comps only** (frame agreement proves nothing about which line an evidence-less board is); near-disjoint sim (< `MERGE_TRAIT_MIN_SIM` 0.20) hard-fails `trait_frame` for everyone. Single-[1]-breakpoint marker traits are excluded from frames. (e) **`gated_class` guard** — strict `gatedSig` equality (`MERGE_REQUIRE_GATED_CLASS`): a board fielding an augment-gated unit (Invader Zed) is a distinct class; labels append `##gate:<ids>`. Label = `<sorted dominant-carry ids>[##dup:…][##aug:…][##gate:…][##emb:<emblem-item-ids>][##k:…]`. Thresholds env-overridable (`MERGE_*`, incl. `MERGE_DUP_DOMINANT_RATE` 0.40). Unit tests: `comp-merge.test.ts` + `comp-profile.test.ts` pin the /photos board-pair semantics + the 2026-07-17 review rulings. **`npm test` is now a glob** (`tsx --test "src/**/*.test.ts"`, 2026-08-22) rather than two hard-coded paths, so a new `*.test.ts` anywhere under `src/` is picked up instead of being silently skipped — 53 tests currently. |
| `stages/trend-tier.ts` | **Stage 5 — trend-tier.** `TrendTierJob { setNumber? }`. One transaction: (A) snapshot today's sufficient stats into `comp_stat_trends`, **ONE AGGREGATE ROW PER ARCHETYPE** (grouped by `GKEY_SQL`, idempotent per `CURRENT_DATE` via delete-then-insert), for groups whose POOLED `n ≥ TREND_MIN_SAMPLE` (env, default 3); (B) regenerate `tier_list_entries` for comps with `n ≥ TIER_MIN_SAMPLE` (env, default 15): score via `comp-stats-math`, rank within each `(patch, region, rank_bucket)`, map to S/A/B/C/D. Deletes only `is_manual=false` rows first, then bulk-inserts with `ON CONFLICT DO NOTHING`, so **admin manual overrides survive and win**. After the commit (deliberately outside that transaction, which holds `tier_list_entries` locks) it prunes snapshots older than `TREND_RETENTION_DAYS` (env, default 90); a prune failure is logged, not fatal. **BOUNDED 2026-08-21:** (A) used to insert every `comp_stats` row verbatim — 257,053 per pass — and the table hit 2.26 M rows / 592 MB in 19 days. Aggregating instead of filtering took it to ~2,558 rows/day, a 100× cut, **with chart values unchanged** (verified: identical n / placement_sum / top4 / bucket_total before and after). Filtering per comp would NOT have been safe — the floor is pooled and a rendering archetype averages ~152 members, so a per-comp `n ≥ 15` keeps only 29.2% of its boards. The aggregate is anchored on `min(comp_id)` of the group, keeping the PK, the FK and the reader's `comp_id = ANY(members)` predicate working untouched; historical per-comp rows re-derive the same totals under the same `SUM`, so the series is continuous across the changeover. **Caveat:** a row's `comp_id` now means the series for the archetype anchored there, not that comp's own stats. |
| `stages/merge.ts` | **Stage 6 — merge, UNIVERSAL (three evidence tiers).** `MergeJob { setNumber? }`. Exports `loadMergeStatic(client, setNumber?)` → `MergeStatic { costs, levels, traits }` (static unit costs + `loadAvgLevels`' grouped pass over `mp_comp_idx` + `TraitStatics` (unit → trait ids, trait → breakpoint minUnits with single-[1] marker traits dropped, emblem item → trait by verified naming convention) — loaded ONCE per run and passed to every loader; `buildTraitFrame(set, coreUnits, emblems, statics)` derives each comp's active-trait frame for the merge's trait term), `loadCompProfiles(client, setNumber?, preloaded?)` — bulk-fetches **floored** comps (`MAX(cs.n) >= MERGE_MIN_SAMPLE`, with `comp_stats.n` as boardCount weight) plus their boards' `participant_units` rows (the fan-out the floor keeps bounded) and builds full `CompProfile`s via `comp-profile.ts` — and `loadTailProfiles(client, setNumber?, bounds?, preloaded?)` — light presence profiles (comps-table only) for sub-floor comps in a total-board range `minTotal ≤ SUM(cs.n) < maxTotal`. All shared with `scripts/merge-eval.ts`. `runMerge` = load floored + **mid-tier** (total ≥ `MERGE_SEED_MIN_TOTAL`, default 2) → `await mergeComps` over BOTH (mid-tier comps join floored archetypes via the presence proxy or seed micro-archetypes with each other — the fix for niche reroll families fragmented across sub-floor hit-state signatures) → **assign-only singleton pass** (total < seed floor) via `makeTailAssigner` against the frozen archetype profiles (yields every 500 comps) → one short transaction that clears stale labels (comps not assigned this run) and writes changed labels only (`IS DISTINCT FROM` guard, so the hourly rerun doesn't churn tens of thousands of unchanged rows). Idempotent; measured 2026-07-16 at ~9.5s for set 17 (953 floored + 16.4k mid-tier + 130k singletons). Boot flag: `RUN_MERGE=1` (optional `MERGE_SET`). Schedule: `SCHED_MERGE_MIN` (default 60). |
| `scheduler.ts` | Repeatable-job plumbing (supervised, **not** unattended — dev key 24h expiry / ~20 rps). Registers exactly **two** schedules: `ladder-crawl` (the independent producer) and the **pipeline head** (`cluster`); everything downstream follows via `chain.ts`. Cadences are env, in minutes: `SCHED_CRAWL_MIN` (30) and `SCHED_PIPELINE_MIN` (60, falling back to the legacy `SCHED_CLUSTER_MIN` so an existing `.env` keeps working). `registerSchedules()` also **removes the legacy per-stage schedulers** (`sched:rollup`/`sched:merge`/`sched:trend-tier`) — they persist in Redis, so upgrading without this would leave them firing alongside the chain. `clearSchedules()` removes current and legacy ids. Driven from `worker.ts` by `RUN_SCHEDULER` / `SCHED_CLEAR`. |

---

## API Routes (`src/app/api/`)

| Route | Method | Handler | Description |
|---|---|---|---|
| `/api/game-data` | GET | `game-data/route.ts` | `LibraryData` JSON, 1h ISR |
| `/api/profile/[region]/[gameName]/[tagLine]` | GET | … | `PlayerProfile` JSON |
| `/api/match/[region]/[matchId]` | GET | … | `MatchDetailVM` JSON |

`api/utils.ts` → `handleApiError(err)` maps `RiotApiError` status → `NextResponse`.

The Riot-backed routes return **400** for a malformed id (validated at the boundary before any upstream call) and **429 + `Retry-After`** when `limitRiotRead` rejects. The equivalent page routes render `<RateLimited>` instead.

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

### `UnitStatsGrid.tsx`
`'use client'` — champion stat block shared by the game-data popup and Library. CDragon stores 1★ base stats; HP (×1.8) and AD (×1.5, key `damage` not `attackDamage`) render per-star as `base/2★/3★`, the rest single-value. AP defaults to 100 when absent.

### `RateLimited.tsx`
Server component shown in place of a page body when the Riot-backed limiter rejects a request. Plain-language copy per the frontend spec's states convention.

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
| `0014_item_stats.sql` | `items.stats jsonb` — curated stat bonuses (`[{label,value}]`) from the CDragon `effects` map, for the Library/popup stat line |
| `0020_matches_player_count.sql` | Adds `matches.player_count` (real, non-bot participants) and backfills it. The column is what keeps bot-filled lobbies out of the meta — see the `match-persist` and `stages/cluster` notes. NULL means "not known", and `= 8` excludes NULL, which is the safe direction |
| `0019_comp_stat_trends_date_idx.sql` | Index on `comp_stat_trends (snapshot_date)`. The existing `comp_stat_trends_bucket_date_idx` leads with `patch_id`, so it cannot serve a predicate on `snapshot_date` alone — exactly what trend-tier's per-day rewrite and its retention prune both need. Without it both are sequential scans of the whole table every pass |
| `0018_apex_mixed_backfill.sql` | Data-only: relabels the 724,496 pre-R1 boards from `'challenger'` to `'apex_mixed'` across `match_participants`, `comp_stats`, `bucket_totals`, `comp_stat_trends` and `tier_list_entries`. Those boards were apex-SEEDED but never rank-verified (they carried the 0009 column default), so leaving them labelled Challenger put an artifact next to the now-verified `master_plus` bucket. `comp_stat_trends` is included so detail-page trend charts stay continuous across the rename. Reversible — every affected row held the same constant |
| `0017_account_tier.sql` | `accounts.tier` + `accounts.tier_checked_at` (the lazily-resolved, cached crawl-gate tier) and flips the `match_participants.rank_bucket` default from `'challenger'` to `'unknown'` — a board whose rank we could not establish must say so rather than claim the top of the ladder. **Existing rows are deliberately left at `'challenger'`**: rewriting 706 k historical boards would empty the live tier list in one statement, and the honest label for apex-seeded mixed data is a product decision, not a migration decision |
| `0016_comps_gkey_index.sql` | Expression index on the read path's grouping key (`COALESCE('m:' || NULLIF(meta_comp, ''), 'c:' || id::text)` — every function in it is IMMUTABLE, so it is indexable). The tier list JOINs on that expression and the detail page filters on it; without the index both sequentially scanned 175 k comps per render (measured 55 ms → 27 ms on the detail filter, 2.6 MB index). Also **drops `mp_rank_bucket_idx`** — it indexed a column that is `'challenger'` for 100 % of rows, so it could never be selective: 19 lifetime scans against 21 MB plus a write per insert. Re-create it (ideally as `(comp_id, rank_bucket)`) when R8 makes the bucket real |
| `0015_patch_current_live_set.sql` | Data-only cleanup: clears `patches.is_current` when it sits on a set with no rows in `units`. No-op when correct; the code-side fix is the live-set gate in `patch.ts` + the guard in `static-data.ts` |

**Ops tables (0007):**
- `ingestion_jobs` — `(id, job_type, region, status, started_at, finished_at, items_done, error_count, cursor, created_at)`. Written by `withJobTracking`.
- `api_usage` — `(id, window_start, region, method, request_count, rate_429)`, `UNIQUE(window_start, region, method)`. Per-minute upsert from the Riot client.

**Derived tables (0008)** — store **sufficient statistics, not rates/bounds**; avg placement, top-4/win rate, and Wilson/SEM intervals are computed on read.
- `comps` — set-scoped, `UNIQUE(set_number, signature)`. Signature = sorted key traits + carries.
- `comp_stats` — `UNIQUE(comp_id, patch_id, region, rank_bucket)`; CI stats `n`, `placement_sum`, `placement_sumsq`, `top4_count`, `win_count`.
- `bucket_totals` — `PK(patch_id, region, rank_bucket)`, `total_boards` (play_rate denominator).
- `comp_stat_trends` — daily snapshots, `PK(comp_id, patch_id, region, rank_bucket, snapshot_date)`, carries `bucket_total` for play-rate-over-time. Since 2026-08-21 a row is **one archetype's pooled series anchored on its `min(comp_id)`**, not one comp's own stats (rows written before that date are still per-comp; both re-derive the same totals under the reader's `SUM`). Bounded by `TREND_MIN_SAMPLE` + `TREND_RETENTION_DAYS`. **As of 2026-08-22 nothing reads this table** — the detail trend moved to real play dates off `matches.game_datetime`. Still written: it is cheap now, and it is the only record that would survive if boards were ever pruned.
- `tier_list_entries` — `UNIQUE(patch_id, region, rank_bucket, comp_id)`; `tier` S/A/B/C/D, `score`, `is_manual`/`override_note`/`editor` (text, no `admin_users` table).

**`rank_bucket` source (0009 → 0017):** each board carries `match_participants.rank_bucket`. It used to be the column default `'challenger'` for *every* board regardless of who played it. Since 0017 the crawl resolves the seed player's tier and `persistMatch` writes the real bucket; the default is now `'unknown'`, which is also what the profile write-path records (it has no crawl context). The clusterer ignores the column (identity is set-scoped); the rollup groups by it. **Boards written before 0017 still say `'challenger'`** — see the migration note.

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
  → BullMQ workers (ladder-crawl → match-fetch → cluster → rollup → merge → trend-tier)
      → shared Riot client (auto-logs api_usage) + persistMatch (idempotent)
      → withJobTracking writes ingestion_jobs
  → admin panel reads ingestion_jobs + api_usage via ops-service
```

---

## Key Invariants

- **Server/client boundary:** never import `server/` files into `'use client'` components. Use `import type` for shared interfaces.
- **Game data popups:** any interactive unit/trait/item spreads **`useEntityTrigger()`** from `game-data.tsx` — never hand-wired `onClick`/`onMouseEnter`, which is how the app ended up with 33 mouse-only triggers and zero tab stops. Pass `stopPropagation` for item icons sitting beside a unit tile, and `label` wherever the visible content is an icon plus a bare number (trait chips) so the accessible name is not just "4".
- **Focus is visible by default:** `base.css` defines one global `:focus-visible` ring (the `--accent` colour the frontend spec specifies). Never `outline: none` without providing a replacement indicator.
- **CSS classes:** flat, globally unique (no CSS Modules). New selectors go in the most specific partial. `@keyframes` live in `base.css` only.
- **Icon URLs:** always via `iconUrl()` — never hand-built.
- **Cost colors:** `COST_CLASS(cost)` / `.c1-.c5`; canonical hex in `planner.css` + `board.css`.
- **Rarity gradient:** `--holo` (base.css) is the single source for the Prismatic-augment / Prismatic-trait (`s4`) treatment — a cool cyan/violet/white gradient, paired with `--holo-glow-cy`/`--holo-glow-vi` for the glow and a shared small clip-path facet cut. Reserved for genuinely rare tiers and the #1 leaderboard spot (`.top-rank.top1`/`.c-rank.top1`, via `:has()`) — never used as a general accent or on buttons.
- **Unique traits:** a trait with exactly one breakpoint (`breakpoints.length === 1`) has no bronze/silver/gold/prismatic scaling — it's Unique. Rendered with the `--unique`/`--unique-glow` tokens (outline + soft glow, never a full fill) via the `.unique` class on `.chip`/`.ex-trait`/`.tchip`/`.gd-bp-pill`/`.lib-bp-badge`. The `unique` boolean is precomputed server-side on `TraitVM` (view-models.ts), `ExampleTraitVM` (comps-example-team.ts), and `ActiveTrait` (lib/planner/core.ts) — never re-derived in components except the two breakpoint-list tooltips (game-data.tsx, Library.tsx) that render every breakpoint, not just the active one.
- **Riot rate limits:** all Riot calls go through `riot` from `lib/riot/client.ts`. `Priority.USER` for user-triggered, `Priority.BATCH` for background.
- **Account name resolution:** always through `resolveAccounts` (accounts-table-first) — never per-row `account.byPuuid`.
- **Only full, human lobbies feed the meta:** `persistMatch` drops `'BOT'` participants and records `matches.player_count`; the cluster stage stamps `comp_id` only where `player_count = 8`. Never narrow cluster's CLEAR step to match its scan — out-of-scope boards must lose their stamp.
- **A `/comps/[key]` link is allowed to go stale, never to 404 silently:** `meta_comp` is derived and moves on any re-merge, so `resolveStaleKey` chases it and the page redirects to the canonical key. Never make that redirect permanent.
- **Boards are ranked-only:** `persistMatch` writes the participant fan-out only for `queue_id = 1100`. The `matches` row is still written for every queue — it is the dedup key, and dropping it would make the crawler re-fetch non-ranked matches forever.
- **Patch derivation:** always through `resolvePatchId` (`patch.ts`) so crawl + profile agree on `patch_id`. One patch dimension; never group stats by two competing keys.
- **Match persistence:** always through `persistMatch` (`match-persist.ts`) — idempotent, shared by the profile path and the worker.
- **api_usage logging** is centralized in the Riot client `request()` — no per-caller logging code.
- **Admin guard:** `/admin/*` pages are protected by `requireAdmin()` in the (panel) layout; any future `/api/admin/*` route must call `requireAdmin()` itself.
- **Riot path segments:** never interpolate a caller-supplied id into a Riot path by hand — the `*Seg()` helpers in `riot/client.ts` encode and validate it. An un-encoded segment is an SSRF-class hole that spends our API key.
- **Riot budget guard:** any NEW route that can reach `lib/riot/client` on an anonymous request must call `limitRiotRead()` first. The global layer is what keeps the key alive when the per-IP key is spoofed.
- **Security headers:** set centrally in `next.config.mjs` (`headers()`); `img-src` must keep allowing `raw.communitydragon.org` or every icon breaks.
- **Worker process:** `worker.ts` imports `./env` FIRST (loads `.env` before the pg pool). BullMQ uses connection **options**, not the shared `ioredis` instance.
- **Rank buckets come from data, never from config:** a board's bucket is the crawl seed's *resolved* tier, or `'unknown'`. Never default an unbucketed board into a named tier — that is exactly how the rank dimension became fiction.
- **Derived stats:** persist **sufficient statistics**, not rates/bounds — intervals are recomputed on read.
- **Clustering granularity:** tuned **only** in `comp-signature.ts` (env-overridable `SIG_MIN_BOARD_UNITS` and `SIG_STAR_MAX_COST` knobs). Re-clustering is a full re-sweep and prunes orphan comps, so `comps` always reflects the current algorithm.
- **Rollup recompute:** `runRollup` `DELETE`s then rebuilds `comp_stats` + `bucket_totals` in one transaction; `bucket_totals` counts clustered boards so play rates sum to 1.
- **Comp scoring is single-source:** every comp score, interval, and confidence label comes from `comp-stats-math.ts` — the writer (`trend-tier`) and the reader (`comps-service`) call the same functions, so the method can change with no re-rollup.
- **Manual tier overrides win:** `trend-tier` regenerates only `is_manual=false` rows (then `ON CONFLICT DO NOTHING`), so a manually pinned `tier_list_entries` survives a regenerate; the tier list applies a pin from any member at archetype grain (`comps-service.buildArchetypeRow`).
- **Comp identity display:** archetype rows are named from the **merge label** (dominant itemized carries, trait prefix backfilled from the example team); the rep's `comps.carries` (3★ set) is the fallback for unlabeled singletons. The raw signature is **debug-tooltip only**, and `comps.name` (a semantic title) stays null until the star-tier identity pass (see Deferred work).
- **Scheduler is supervised:** `scheduler.ts` repeatables run in supervised bursts, not 24/7 — the dev key expires every 24 h, and a production key gates continuous / low-ELO crawling.
- **Pages read through the CACHED service wrappers** (`getTierListCached` / `getCompDetailCached`), never the raw ones — a `force-dynamic` comps page recomputing per request cost ~1 s of DB work against a 10-connection pool. Scripts and tooling use the uncached exports.
- **Trend snapshots are archetype-grained and bounded:** one row per pooled group above `TREND_MIN_SAMPLE`, pruned past `TREND_RETENTION_DAYS`. Never reintroduce a per-comp snapshot (it was 257 k rows a pass), and never filter this table by a PER-COMP sample floor — the floor is pooled, so a per-comp cut silently drops ~70% of a rendered archetype's boards.
- **The derived stages are a CHAIN, not independent schedules:** cluster → rollup → merge → trend-tier, advanced by `chain.ts` on success. Never re-register a per-stage repeatable — cluster prunes comps whose `comp_stats` rollup is concurrently rebuilding, and overlapping runs left the read path serving stats for comps that no longer existed.
- **`is_current` is advanced periodically, never per match:** `advanceCurrentPatch()` runs once per ladder-crawl pass. The per-match version deadlocked against the pipeline stages — see `patch.ts`.
- **Only the live set advances `is_current`:** patch strings repeat across sets (rotating game modes), so a set-16 revival match must never define "current" for a set-17 site. Writer gate in `patch.ts`, reader backstop in `static-data.ts`.


---

## Deferred work (parked, with rationale)

- **#3 — Star-tier-aware comp identity** (the next identity refinement; build with real volume once the scheduler has accumulated data). The signature currently ranks carries by **completed item count** alone, which conflates two structurally different boards: a **reroll** comp (e.g. a 3-star low-cost carry like Fiora/Yi) whose identity *is* the 3-starred cheap unit — its 5-cost is a swappable cap, not identity — versus a **fast-9** comp whose 5-cost *is* the win condition. Item count can't tell them apart; identity = carries weighted by **intent (cost × star)**, which needs a board-level signal (board level / star-tier distribution) and likely **1–2 more columns out of `persistMatch`**. This same signal powers the comp-detail **core / optional / cap** breakdown and generated semantic titles ("Fiora Reroll", "Fast 9 Vex"). Until then, `comps.name` stays null and identity renders as carries + trait chips only.
- **Item alternatives** in unit popups are static "recommended" seeds; upgrade to data-driven "most common items on this carry" once there's volume (the popup is built to swap its source with no UI change).
- **Comp-detail page** and the **comp explorer** (full filter rail, niche toggle) reuse the M5 `StatCell` + identity primitives — not built yet.
- **Tier bands are seed values** (`S≥.55 …` in `comp-stats-math.ts`); recalibrate against the generated list once there's enough volume to spread (a thin sample shrinks everything toward 0.5).
