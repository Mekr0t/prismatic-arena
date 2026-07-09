# TFT Platform — Progress & Roadmap (Updated)

**Date:** 2026-06-20
**References:** `TFT-Platform-Foundation-Plan.md`, `TFT-Frontend-Spec.md`, implementation status report (2026-06-20)
**Set context:** Set 17 "Space Gods" (the static loader auto-selects the current set by highest set number, so nothing below hardcodes a patch).

This document does three things: (1) snapshots where the build actually is today, (2) records the new feature wishlist and maps each item to what it needs, and (3) lays out everything left to do in **dependency order** — the sequence that avoids building things twice or building them on a foundation that can't support them yet.

---

## 1. Where we are now

### 1.1 Status snapshot

| Area | Status | Notes |
|---|---|---|
| Shared Riot API client | ✅ Done | Throttle, header-aware backoff, Redis cache, USER/BATCH priority lanes |
| Static data loader | ✅ Done | CommunityDragon; units/traits/items/augments with icon paths |
| Player profile page | ✅ Done | Rank, LP, recent matches, avg placement, top-4 rate, first rate; per-mode recalc (Ranked/Double Up/Unranked) |
| Match detail page | ✅ Done | All 8 boards: units, stars, items, active traits, augments, placement, level, last round |
| Leaderboards | ✅ Done | Challenger/GM/Master apex + ladder, paged |
| Postgres schema (static + accounts + matches) | ✅ Done | Normalized match observations persisting correctly |
| **Team planner** | ✅ Done (ahead of schedule) | Board grid, unit picker, live trait activation, drag & drop, items per unit, export code, shareable URL |
| Trait/item icons in planner & match history | ✅ Done | Beyond original plan |
| **Admin dashboard** | ❌ Not started | Pipeline health, tier overrides, featured content, tracked comps, analytics |
| Saved/named planner builds | ❌ Not started | `saved_planners` table not created; deferred (needs auth) |
| **Phase 3 pipeline (entire)** | ❌ Not started | Ingest workers, clustering, rollups, tier-gen, comp explorer, stats pages — all unbuilt |

**Plain reading:** Phase 1 is fully shipped. Phase 2 is half shipped — the planner is done and polished, the admin side is untouched. Phase 3 is a blank slate. Everything interesting on the new wishlist lives in or on top of Phase 3.

### 1.2 Accepted deltas from the original plan

These are intentional divergences already in the codebase. Most are fine; two create debt that must be paid before stats can be trusted (flagged 🔧).

| Plan said | Reality | Verdict |
|---|---|---|
| `matches.patch_id` FK → `patches` | `matches` uses `set_number` + `game_version` text, no FK | 🔧 **Debt** — patch-scoped rollups and patch velocity need one clean patch key to group by |
| `league_entries.snapshot_at` for LP graphs | Snapshots inserted, but no graphs and no dedup logic | 🔧 **Debt** — LP progression + personal tracking need deduped snapshots first |
| Match writes happen in ingest workers (Phase 3) | Write-through happens synchronously on profile load | OK now — but worker writes must be idempotent so the two paths don't collide |
| `items` = id/set/item_id/name | Extended with `icon_path` + `composition text[]` | Good — keep; `composition` already supports component/craftable classification |
| Trait style from raw DB values | Normalized in app layer to 1–4; unique/single-breakpoint → prismatic | Good — keep; document the rule |
| Game mode filter | Added (Ranked/Double Up/Unranked, per-mode stats) | Good — keep |

---

## 2. Guiding principles (the north stars)

Two of your wishlist items aren't features — they're philosophy that shapes every screen. Stating them here so they don't get lost in a backlog.

- **Beginner ↔ Advanced, aimed at the middle.** Most sites are either too basic or a wall of numbers. Every data surface uses **progressive disclosure**: a plain-language summary on top ("strong, easy to play, flexible items"), the deep numbers one expand away. The click-through popups (§3, M2) exist largely to serve this — a newer player can click any unit or trait and learn what it does without leaving the page.
- **Transparency-first stats.** Every single stat shown carries its **sample size**, its **rank band**, and a **confidence signal**. No naked averages. This is why confidence intervals are built into the pipeline from day one rather than added later — small-sample comps must *visibly* read as uncertain, which is also what makes the niche toggle (M5) honest instead of misleading.

---

## 3. New feature wishlist → mapped

Each item mapped to what it actually requires, its dependency on the Phase 3 pipeline, the milestone it lands in, and the priority **as you framed it**.

| # | Feature | What it needs | Pipeline dep? | Milestone | Your stated priority |
|---|---|---|---|---|---|
| F1 | **Per-ELO filtering** (Plat/Emerald, not just Challenger) | Crawl frontier widened below Diamond+; finer `rank_bucket` granularity; rollups per bucket | **Yes** (heavy) | M4 + M5 | Core |
| F2 | **Beginner↔Advanced balance** | Progressive disclosure across all data surfaces | Cross-cutting | Principle (all) | Core focus |
| F3 | **Transparency-first stats** (sample size + confidence intervals + rank band on every stat) | CI math in rollups (Wilson + SEM); reusable "stat-with-confidence" UI primitive | **Yes** | M4 (math) + M5 (UI) | Core |
| F4 | **Niche toggle** (surface small-sample early-patch comps instead of burying them) | Min-sample gating + CIs, then a toggle that reveals below-threshold comps clearly marked | **Yes** | M5 | Wanted |
| F5 | **Click-through unit/trait popups** (ability, stats, item alternatives) | Extended static data (ability text, stats, trait descriptions); modal component | **No** (static-data) | M2 | Wanted |
| F6 | **Unit/item/augment library** (browse everything with icon + description) | Extended static data (descriptions); browse UI | **No** (static-data) | M2 | Wanted |
| F7 | **Basic stats pages** (unit/trait/augment performance tables) | Rollups over participant data | **Yes** | M5 | Wanted |
| F8 | **Patch velocity tracker** (rising vs declining across the week) | `comp_stat_trends` populated + week-over-week delta computation + UI | **Yes** | M5 | Wanted |
| F9 | **LP progression + "what comps cost me LP"** | LP snapshot dedup + graph; per-player comp labeling; LP-delta-by-comp correlation | **Yes** | M6 | Mid ("possibly one of the features") |
| F10 | **Play-style-aware comp recommender** | Per-player history + recommendation logic over the meta | **Yes** | M7 | Bonus ("next, as bonus") |
| F11 | **Mobile app** (native) | Separate client; the web is already responsive | Parallel track | M7 | "Next step" (own track) |

---

## 4. The build order

Seven milestones, sequenced so each one stands on a foundation the previous one finished. The ordering logic, stated once: **pay down the debt that would corrupt stats → ship the high-value static-data features that need no pipeline → get ops eyes on the pipeline before building it → build the pipeline with transparency and per-ELO baked in → land every data-consuming surface together → then personal intelligence → then bonus/mobile.**

### M1 — Foundation reconciliation (debt paydown)
**Goal:** make the data model trustworthy before any stats are computed on it. Small, unglamorous, blocks everything downstream.
- Introduce **one clean patch dimension** the rollups can group by. Either add `matches.patch_id` (FK → `patches`) and backfill from `game_version`, or formalize a deterministic `game_version → patch` derivation used everywhere. Pick one; never group stats by two competing keys.
- Add **LP snapshot deduplication** (only persist a `league_entries` row when LP/rank actually changed) so LP graphs and personal tracking later read clean series.
- Make the match write path **idempotent** (upsert on `match_id` / `(match_id, puuid)`) so Phase 3 workers and the existing synchronous write-through never double-insert.
- Formally close out the accepted deltas from §1.2 (document the trait-style rule and the `composition` classification).

**Exit:** every match row resolves to exactly one patch key; re-running an ingest produces zero duplicates; LP history for a player is a clean deduped series.

### M2 — Rich static data + Library + click-throughs
**Goal:** ship visible, high-value features that need **no pipeline at all**, and directly serve the beginner↔advanced principle.
- **Extend the static loader** to pull descriptions and detail beyond icons: unit ability text + key stats, trait bonus descriptions per breakpoint, item descriptions, augment descriptions. (Augments stay gracefully omitted anywhere data is genuinely absent.)
- Build the **Library** (F6): browsable, searchable reference of every unit / item / augment / trait for the current set, each with icon + description. This is also the canonical detail source the popups reuse.
- Build the **click-through popups** (F5): clicking any unit or trait anywhere (match history, planner, later the comp pages) opens a modal with ability/stats/description.
- **Item alternatives** in the unit popup: seed from static "recommended items" for now; upgrade to data-driven "most common items on this carry" once the pipeline exists (M5).

**Exit:** a user can click any unit or trait on the site and learn what it does; the Library lists everything in the set with descriptions.

### M3 — Admin foundation + ops observability
**Goal:** stand up admin auth and the **ops view you'll need to watch the pipeline while building it** — running a ladder crawl blind is painful.
- Admin auth (admin accounts only) + admin shell/navigation.
- **Pipeline-health / ops panel first:** `ingestion_jobs` status table, last-success timestamps, error counts, `api_usage` + 429 charts, stale-data alerts ("no fresh matches in N hours"). Build this *before* M4 so the pipeline surfaces health into an existing frame.
- Featured-content editor and tracked-comps watchlist can ride along here or follow.
- The **tier-list override editor is stubbed** — it has nothing to override until tiers exist (M5).

**Exit:** an admin can log in and see live job/API health; the pipeline built in M4 reports into this panel from its first run.

### M4 — Phase 3 pipeline core (the unlock)
**Goal:** the centerpiece. Mine match data into derived comp metrics — built with transparency and per-ELO as first-class concerns, not afterthoughts.
- **BullMQ workers:** ladder crawl → match fetch → normalize → rollup → cluster → tier-gen, on repeatable schedules (crawl continuously, roll up hourly, regenerate tiers daily/per-patch).
- **Comp clustering** (signature = key active traits + carries; hash → `comps.signature`; backfill `match_participants.comp_id`). Treat granularity as iterative (Risk R4) — too coarse merges distinct lines, too fine fragments one comp into noise.
- **Metric rollups per `(comp, patch, region, rank_bucket)`** — and bake in:
  - **Confidence intervals (F3) from the start.** Store **sufficient statistics** (`n`, placement mean + stdev/sumsq, `top4_count`, `win_count`) so any interval can be computed on read and re-derived if the method changes. Use **Wilson score intervals** for top-4 / win rate (correct for small n) and **standard error of the mean** for average placement.
  - **Per-ELO rank buckets (F1)** as a real dimension (e.g. `iron_gold` / `plat_emerald` / `diamond` / `master_plus` / `challenger` / `all`). Start the crawl rank-gated narrow to validate on a small sample, then widen coverage downward as the key allows (see Risk R1/R8).
- Populate **`comp_stat_trends`** (the daily time series) — this is what M5's patch velocity reads.
- **Auto tier-list generation:** tier score = avg placement + top-4 rate, **down-weighted by interval width / sample confidence**; map score bands → S/A/B/C/D; admin `is_manual` overrides win on display.
- Create the still-missing tables: `comps`, `comp_stats` (+ the CI sufficient-stats columns), `comp_stat_trends`, `tier_list_entries`.

**Exit:** for the seed region, comps cluster, every comp has metrics + a confidence interval + a rank bucket, trends accumulate daily, and a tier list generates automatically.

### M5 — Meta surfaces (consume the pipeline)
**Goal:** everything that reads the derived data, landed together so each shares the transparency UI primitive.
- **Comp explorer** with the full filter rail (rank bucket, region, patch, traits, units, placement band, min sample) + the **niche toggle (F4)**: default hides below-threshold comps; toggle reveals them clearly marked "low sample / experimental" (honest because the CIs make uncertainty visible).
- **Comp detail page:** canonical board, items per carry, stat block **with confidence intervals**, placement distribution, trend chart, sample size + patch + bucket labeled.
- **Tier-list page** (per patch/region/rank bucket) with override badges visible — and the M3 override-editor stub now gets real data.
- **Stats pages (F7):** unit / trait / augment performance tables, each stat carrying sample size + rank band + confidence.
- **Patch velocity (F8):** week-over-week (or daily) delta of play rate / placement off `comp_stat_trends`, surfaced as rising/declining indicators + sparklines on the explorer and tier list.
- **Per-ELO filter UI (F1)** becomes a first-class, persistent control on all of the above.
- **Upgrade item-alternatives** in the M2 popups from static seed to data-driven "most common items on this carry."

**Exit:** a user can filter the meta by their own rank, see comps with honest confidence, toggle in niche picks, read unit/trait/augment stats, and see what's rising or falling this week.

### M6 — Personal intelligence
**Goal:** make the data about *you*. Needs per-player comp labeling from M4 and the deduped LP series from M1.
- **LP progression graph (F9a):** plot the deduped `league_entries` series per player.
- **"What comps are costing me LP" (F9b):** label the player's own recent boards with their clustered comp, correlate placement / LP delta per comp, and surface which comps help vs hurt their climb.

**Exit:** a player can see their LP over time and a per-comp breakdown of which lines are gaining or bleeding LP for them specifically.

### M7 — Bonus & new platforms (parallel / later)
**Goal:** the explicitly-lower-priority track. Can start in parallel once M4 exists, but does not block anything.
- **Play-style-aware comp recommender (F10):** read the player's recent history, infer tendencies, recommend meta comps that fit — instead of showing the flat global meta.
- **Native mobile app (F11):** separate client track; the responsive web already covers mobile browsers in the meantime.
- Multi-region expansion beyond the seed region also belongs here (config + crawl scaling, not a rewrite).

---

## 5. Cross-cutting technical notes

- **One patch key, everywhere.** The single most important M1 item: rollups, trends, velocity, and "current patch" defaults all assume one unambiguous patch dimension. The current `set_number` + `game_version` text columns must resolve to that one key.
- **Store CI sufficient statistics, not just bounds.** Persisting `n`, mean, stdev/sumsq, `top4_count`, `win_count` lets the interval method change without a re-crawl and lets the UI recompute on read. This is what makes both transparency-first stats (F3) and the niche toggle (F4) cheap and honest.
- **Rank buckets are a dimension, not a filter applied late.** Define the bucket boundaries once and roll up per bucket in M4; the per-ELO UI in M5 is then just selecting a bucket, not re-aggregating.
- **Item alternatives source.** Static "recommended items" is a placeholder; the real signal is "most common items observed on this carry in this comp," which only exists after M4. Build the popup to swap its source without a UI change.
- **Beginner↔Advanced is a component contract.** Every stat-bearing component should accept both a summary and a details slot, so progressive disclosure is uniform rather than re-invented per page.

---

## 6. Risks (carried forward + new)

The original R1–R7 still hold. The new wishlist adds two.

- **R1 — Dev-key throughput.** ~20 req/s + 100/2min cannot mine a region. The entire M4 pipeline is effectively gated on a **production key**. *Mitigation:* validate the pipeline on a tiny rank-gated sample, apply for production early, keep the crawl dedupe-heavy.
- **R2 — Dev-key 24h expiry.** Keys die daily in dev. *Mitigation:* rotation tooling, key from env/secret store, never committed.
- **R3 — Production approval + commercial policy.** A public stats site needs Riot approval and must follow developer/commercial terms. *Mitigation:* check eligibility and apply before launch hardens.
- **R4 — Comp clustering quality.** Signature granularity decides whether comps/tiers are trustworthy. *Mitigation:* iterative tuning, enforce min sample sizes, validate against known meta.
- **R5 — "Team code" / in-game import.** Paste-into-live-game is not assumed to exist; export code is a portable share encoding. *Mitigation:* keep it share-URL + code round-trip within our own tools.
- **R6 — Set/patch rotation breaks static data.** IDs change each set. *Mitigation:* version by set+patch, keep the loader re-runnable, never hardcode Set 17.
- **R7 — Stale-data illusion.** Precomputed data goes stale silently. *Mitigation:* label every stat with patch/region/bucket + freshness; alert when ingest stalls (M3 ops panel).
- **R8 — Per-ELO crawl volume (new).** Extending coverage below Diamond+ to support F1 multiplies crawl volume and rate-limit pressure sharply — low ranks are where most of the player base is. *Mitigation:* widen rank coverage downward incrementally as the production key allows; consider sampling rather than exhaustively crawling low ranks; keep buckets coarse enough to hit sample-size thresholds.
- **R9 — Confidence-interval correctness (new).** Naive normal-approximation intervals mislead at the small samples F4 deliberately surfaces. *Mitigation:* use Wilson intervals for proportions, SEM for placement means, and make the UI show width honestly rather than a single point.

---

## 7. Suggested immediate next step

Per the usual workflow (review the doc, then build): if this ordering looks right, **M1 (foundation reconciliation)** is the place to start — specifically the patch-key decision, since it gates every stat M4 produces. It's a small, contained piece of work with a large blast radius.

One decision worth settling before M1: **add a real `matches.patch_id` FK and backfill it, or formalize a `game_version → patch` derivation function used everywhere?** The FK is cleaner long-term; the derivation is less migration now. My recommendation is the FK + backfill — it makes patch velocity and patch-scoped defaults unambiguous, and it's a one-time cost paid before the data volume grows. If you're good with that, the natural deliverable to start M1 is the migration plus the backfill script, delivered as new/edited files only.
