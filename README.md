# Prismatic Arena

A Teamfight Tactics stats site: it crawls the ranked ladder through the Riot
Games API, persists match boards to Postgres, and derives a comp tier list,
player profiles, leaderboards and a team planner from that data.

Built as a personal project to work through the whole shape of a data platform —
rate-limited ingest, a background job pipeline, derived aggregates, and a
server-rendered read plane — rather than just the UI on top of someone else's API.

> **Note on data:** this repo is the application, not the dataset. It ships no
> match data. A fresh install starts with an empty database and fills as the
> crawler runs against your own Riot API key.

---

## What it does

| Area | Detail |
|---|---|
| **Comp tier list** (`/comps`) | Boards are clustered into archetypes, rolled up into placement stats, then merged across near-identical variants. Filterable by patch, region and rank bucket. |
| **Comp detail** (`/comps/[key]`) | Per-archetype breakdown: example team, unit frequency, item builds, trend over time. |
| **Player profiles** (`/[region]/[gameName]/[tagLine]`) | Live Riot lookup with Redis caching, recent matches, per-match boards. |
| **Leaderboards** (`/leaderboard/[region]`) | Apex tiers per platform. |
| **Match detail** (`/match/[region]/[matchId]`) | Full eight-player board view. |
| **Library** (`/library`) | Browsable catalog of units, traits and items for the live set. |
| **Planner** (`/planner`) | Build a board, see trait breakpoints resolve live. |
| **Admin panel** (`/admin`) | Password-gated pipeline health: Riot API usage, per-endpoint breakdown, ingestion job history, archetype merge inspector. |

## Architecture

Two planes, two processes.

```
Read plane (Next.js)
  page (server component)
    → server/* service → Riot client (Riot API + Redis) + Postgres + static catalog
    → view model → server HTML + props to client components

Ingest plane (separate worker process — npm run worker)
  BullMQ chain: ladder-crawl → match-fetch → cluster → rollup → merge → trend-tier
    → shared rate-limited Riot client, idempotent persistMatch
    → every stage wrapped in an ingestion_jobs lifecycle row
```

Points worth calling out:

- **The Riot client is the only egress.** Every call goes through
  `src/lib/riot/client.ts`, which enforces the app rate limit, tags calls
  `USER` or `BATCH` priority, and logs usage to `api_usage` — which is what the
  admin panel reads.
- **The worker is a separate process.** BullMQ gets its own connection options;
  it never shares the app's `ioredis` instance.
- **The derived stages are a chain, not a schedule.** Only the head is
  scheduled; each stage advances the next on success.
- **Static game data comes from CommunityDragon**, loaded by
  `npm run data:load` behind a roster gate — CDragon publishes a stub for the
  next set weeks early, and loading it would overwrite the live catalog.

Full architecture notes, every exported function, and the invariants live in
[`SYSTEM_MANUAL.md`](SYSTEM_MANUAL.md).

## Stack

Next.js 15 (App Router) · React 19 · TypeScript 5.7 · PostgreSQL (`pg`) ·
Redis (`ioredis`) · BullMQ · plain global CSS, no framework

## Getting started

**Requires** Node 24+, PostgreSQL 16+, Redis 7+, and a
[Riot API key](https://developer.riotgames.com) (development keys expire every
24 hours).

```bash
npm install
cp .env.example .env      # then fill in RIOT_API_KEY, DATABASE_URL, REDIS_URL
npm run db:migrate        # apply migrations to an empty database
npm run data:load         # load the static unit/trait/item catalog from CDragon
npm run dev               # http://localhost:3000
```

To collect match data, run the worker alongside the app in a second terminal:

```bash
npm run worker
```

The crawl starts narrow on purpose (`CRAWL_TIERS=challenger`, small per-pass
caps) so a development key survives it. Widen it via the `CRAWL_*` variables in
`.env` — they're all config, no code changes.

### Scripts

| Command | Purpose |
|---|---|
| `npm run dev` / `build` / `start` | Next.js |
| `npm run worker` | Background ingest process |
| `npm run db:migrate` | Apply `db/migrations/*.sql` (forward-only) |
| `npm run data:load` | Load static game catalog from CommunityDragon |
| `npm test` | `node:test` suite via tsx |
| `npm run typecheck` / `lint` | `tsc --noEmit` / ESLint 9 |
| `npm run merge:eval` | Score the archetype merger against labelled pairs |

## Testing

`npm test` runs the pure unit suite — no database or network required. CI
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs typecheck, lint
and tests on every push, plus a second job that stands up real Postgres and
Redis, applies the migrations to an **empty** database, and runs a behavioural
persistence check. That second job is what proves the forward-only migrations
still apply from scratch.

## Project status

Active personal project, not a product. The read plane and the ingest pipeline
both work end to end; the comp scoring and archetype merge logic are the parts
still being iterated on. `AUDIT-2026-08-17.md` is a live record of known
weaknesses and measured behaviour, kept honest rather than tidy.

## Disclaimer

Prismatic Arena isn’t endorsed by Riot Games. Riot Games and all associated properties are
trademarks or registered trademarks of Riot Games, Inc. Game assets are served
from CommunityDragon.
