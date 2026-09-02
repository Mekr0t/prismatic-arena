# CLAUDE.md

Guidance for AI coding assistants working in this repository.

## What this project is

Prismatic Arena — a Teamfight Tactics stats site. It crawls the ranked ladder
through the Riot Games API, persists match boards to Postgres, and derives a
comp tier list, player profiles, leaderboards and a team planner from that data.

Two planes, two processes:

- **Read plane** — Next.js 15 App Router. Server component → `src/server/*`
  service → Postgres + Riot client + static catalog → view model → HTML.
- **Ingest plane** — a separate worker (`npm run worker`). A BullMQ chain:
  `ladder-crawl → match-fetch → cluster → rollup → merge → trend-tier`.

Stack: Next.js 15 · React 19 · TypeScript 5.7 · PostgreSQL (`pg`) · Redis
(`ioredis`) · BullMQ · plain global CSS, no framework.

## System manual

`SYSTEM_MANUAL.md` documents the full architecture: directory map, CSS
partials, every exported function, and the invariants they rely on.

**Before any change:** read the section covering what you are about to modify.
Flag any contradiction between the manual and the code before proceeding.

**After a structural change**, update the relevant section if you:

- Add, rename, or delete a file.
- Add, rename, or remove an exported function, type, or constant.
- Change a CSS class name or move styles to a different partial.
- Add a dependency, route, or API endpoint.

Do not update the manual for internal refactors that leave the public surface
and file structure unchanged.

## Invariants worth knowing before you touch anything

These are the ones most easily broken by a well-intentioned change:

- **The Riot client is the only egress.** Every call goes through
  `src/lib/riot/client.ts` — it enforces the app rate limit, tags calls
  `USER` / `BATCH` priority, and logs to `api_usage`. Never call the Riot API
  directly from a service or a route.
- **`persistMatch` must stay idempotent.** The crawler re-fetches; the profile
  page write-through path also writes. Both must be safe to run twice.
- **Migrations are forward-only.** Add a new numbered file in `db/migrations/`;
  never edit an applied one. CI proves they still apply from an empty database.
- **The derived stages are a chain, not a schedule.** Only the head is
  scheduled; each stage advances the next on success (`src/server/queue/chain.ts`).
- **The static loader is gated on roster size.** CommunityDragon publishes a
  stub for the next set weeks early; loading it would overwrite the live catalog.
- **Comp signatures decide clustering.** A change in
  `src/server/queue/comp-signature.ts` silently re-clusters the entire dataset.
  Treat its tests as a contract.

## How to interact

- Ask clarifying questions when requirements are ambiguous or missing.
- Prefer small, incremental changes over large rewrites.
- When editing files, show a brief explanation plus a unified diff or clearly
  marked code block.
- If you are unsure, state the uncertainty and suggest options.

## Coding style

- Follow existing style in the file you are editing.
- Comments in this codebase explain *why*, not *what* — often citing the
  incident or measurement that motivated the code. Match that register; do not
  add narration of what the next line does.
- Use clear, descriptive names for functions, classes, and variables.
- Keep functions focused; avoid very large, multi-purpose functions.

## File handling

- Never invent file paths or APIs; infer from the repository when possible,
  otherwise ask.
- When proposing new files, include the full relative path and a short
  description of the file's purpose.

## Testing and safety

- `npm test` is the pure unit suite — `node:test` via tsx, no database or
  network. `npm run typecheck` and `npm run lint` must also stay clean.
- DB-touching checks live in `scripts/_*-check.ts` and run by hand or in CI,
  not in `npm test`.
- When you modify code, suggest at least one test or manual check.
- Call out potential breaking changes and assumptions.

## Non-goals

- Do not introduce new external dependencies unless explicitly requested or
  clearly justified. The dependency list is deliberately short.
- Do not perform large refactors without first proposing a plan and waiting for
  confirmation.
