# TFT Platform — Frontend Spec (Step: Profile Page + Frontend Foundation)

**Status:** Built — on disk and typechecks clean (`tsc --noEmit`, 0 errors);
pending live-data verification (Roman's run — see §7C). **Scope of this step:** the
public **profile page**, the shared frontend foundation every later page reuses,
**and match-detail** (the full 8-board lobby, reachable by clicking a match row).
Leaderboards, comp explorer, and the planner are still separate later steps — but
the primitives built here (unit tile, trait chip, board strip) are what those
pages are made of, so this step does most of the visual heavy lifting once.

This is a "how it should look and how it works" document. The profile API route
(`GET /api/profile/{region}/{gameName}/{tagLine}`) and the static-data loader
already exist and the profile slice is confirmed working against live Riot data.

---

## 1. What this page is

One concrete job: **answer "how is this player doing right now, and what are they
playing?" in a single glance.** The audience is competitive players scanning
dense data fast, not casual readers. That makes legibility-at-density the whole
game: a climber should be able to read a player's last ten boards without
clicking anything.

---

## 2. Design direction

A short, opinionated token system. The one idea everything hangs off:

> **The palette comes from TFT's own system, not a brand accent.** Cost tiers,
> trait styles, and placement are already a precise color language every TFT
> player has memorized. We use *that* as the page's color. Structural chrome
> stays a quiet deep-space charcoal so the game's colors do the talking.

This is deliberate: the lazy version of a dark gaming site is "near-black plus
one acid-green accent." We're not doing that. The chrome is desaturated and
cool; saturation only appears where it *means* something (a 5-cost gold border, a
prismatic trait, a 1st-place badge).

### 2.1 Color tokens

Structure (the quiet layer):

| Token | Hex | Use |
|---|---|---|
| `--bg` | `#0E1320` | page background (deep blue-charcoal, not pure black) |
| `--surface` | `#161C2D` | cards, header band |
| `--surface-2` | `#1F2638` | raised rows, hover |
| `--border` | `#2A3346` | hairlines, tile borders |
| `--text` | `#E6EAF2` | primary text |
| `--text-dim` | `#8C97AD` | labels, metadata |
| `--accent` | `#7C84F2` | links, focus rings, active nav only (periwinkle; used sparingly) |

Functional (the game's own language — this is where color lives):

| System | Values |
|---|---|
| Cost border | 1 `#9AA4B2` · 2 `#1FB562` · 3 `#3B9DFF` · 4 `#C156E0` · 5 `#F2C14E` |
| Trait style | bronze `#B06A3B` · silver `#B9C4CF` · gold `#F2C14E` · prismatic = light gradient + thin holo border |
| Placement | 1st `#F2C14E` · top-4 (2–4) `#46C0A0` · bottom (5–8) `#D9624A` |
| Rank tier | iron `#7B7B7B` · bronze `#B06A3B` · silver `#B9C4CF` · gold `#F2C14E` · plat `#4FD1C5` · emerald `#2ECC71` · diamond `#6FB7FF` · master+ `#B36FE0` · challenger special |

### 2.2 Type

Not the families you'd reach for on any dashboard. The set is "Space Gods," so:

- **Display / numbers — Space Grotesk.** Geometric, a little cosmic, has true
  tabular figures (critical: LP, placements, and percentages must align in
  columns). Used for the player name, big stats, placement numbers.
- **Body / UI — Hanken Grotesk.** Clean, slightly warmer than the default
  neutral, highly legible at small sizes for dense rows.
- **Data / mono — IBM Plex Mono** for tightly-aligned numeric columns where
  tabular figures alone aren't enough.

Set a real scale (e.g. 12 / 14 / 16 / 20 / 28 / 40) and lean on weight, not size,
for hierarchy in the dense rows. All stat numerals use `font-variant-numeric:
tabular-nums`.

### 2.3 Signature element

**The board strip + hex placement badge.** Each match row renders the player's
final board as a horizontal strip of cost-bordered unit tiles (star pips above,
item dots below) followed by style-colored trait chips — and it's anchored by a
**hexagonal placement badge** colored by result, with a thin spine of that same
placement color running down the row's left edge. The hex is TFT's board cell;
using it for the placement marker (not a generic circle or pill) is the one
motif that says "this is a TFT site" before you read a word. Everything else
stays rectangular and calm so the hex reads as intentional.

Spend boldness here and nowhere else.

### 2.4 Motion & quality floor

One orchestrated moment: match rows fade/slide in briefly on load, staggered.
That's it — no scattered hover animations. Respect `prefers-reduced-motion`.
Responsive to mobile, visible keyboard focus (the `--accent` ring), real empty
and error states (see §6).

---

## 3. How the frontend works (architecture)

```
 profile page (server component)
   ├─ getPlayerProfile(region, name, tag)   ← service, awaited on the server
   ├─ getCatalog()                          ← in-memory static-data cache, NOT per-row JOINs
   └─ buildProfileVM(profile, catalog)      ← presentational components render the VM

 lobby expand (client, on first open of a match row)
   └─ fetch /api/match/{region}/{matchId} → getMatchDetail() → MatchDetailVM
```

Key decisions:

- **Server components fetch.** The profile page is an async server component that
  awaits `getPlayerProfile()` directly — no client-side fetching, no spinner in
  the happy path. `loading.tsx` covers the wait; `not-found.tsx` and `error.tsx`
  cover the rest.
- **Static-data resolver (`src/server/static-data.ts`).** The set catalog is tiny
  (~60 units, ~30 traits, a few hundred items), so it loads **once** into a
  module-level SWR cache (lazy from Postgres) and resolves ids in-process via
  `getCatalog()` → `catalog.unit(id) / catalog.trait(id) / catalog.item(id)` →
  `{ name, iconUrl, cost? }`. No per-row JOINs against the static tables on load.
- **Icon URL util (`iconUrl(path)`).** Stored `icon_path` values are Community
  Dragon asset paths: lowercase, swap the extension to `.png`, prefix
  `https://raw.communitydragon.org/latest/game/`. **Verify against real stored
  paths** — asset-type prefixes vary; this is the likeliest thing to need a tweak.
  Unit icons resolve now; trait/item icons stay null until `icon_path` is added to
  those tables (small 0002 migration + loader change — see §8).
- **View-model layer (`src/server/view-models.ts`, pure).** Components never see
  raw ids or DTOs. `buildProfileVM` / `buildBoard` turn `(profile JSON + catalog)`
  into typed VMs (`ProfileVM`, `MatchSummaryVM`, `BoardVM`, `UnitVM`, `TraitVM`,
  `MatchDetailVM`, `LobbyParticipantVM`). It's safe to import for *types* from the
  client (type imports erase), which is how `MatchList` stays typed without pulling
  in any server code.
- **Match-detail / lobby expand.** `MatchList` is the one client component on the
  page. Clicking a row lazy-fetches `GET /api/match/{region}/{matchId}` →
  `getMatchDetail()` → `MatchDetailVM { participants[] }` (all 8 boards, sorted by
  placement), caches it per row, and renders the lobby with the viewed player
  highlighted. Names for all 8 puuids come from Account-V1 in parallel (cached,
  with a truncated-puuid fallback). **Optimization available:** read names from the
  `accounts` table first and only hit Account-V1 for unknown puuids, so most opens
  cost ~0 extra Riot calls. This is the match-detail feature folded into the profile.
- **Styling.** **Global CSS + the §2.1 tokens as CSS variables in `globals.css`
  (`:root`) — no Tailwind.** The bespoke system ports the approved preview 1:1 with
  nothing to misconfigure sight-unseen; Tailwind can be layered on later if wanted.
  Fonts via `next/font` (Space Grotesk, Hanken Grotesk, IBM Plex Mono).
- **Route naming.** The page and API share the **`[region]`** segment
  (`/[region]/[gameName]/[tagLine]`, `/api/match/[region]/[matchId]`); `region`
  accepts platform values like `euw1`. Locked — don't mix `region`/`platform`.

---

## 4. Page layout

### Desktop

```
┌─────────────────────────────────────────────────────────────┐
│  HEADER:  ◆ logo        [ Search Riot ID (Name#TAG) ]   nav   │
├─────────────────────────────────────────────────────────────┤
│  PROFILE HEADER (surface band)                                │
│  ┌────┐  yatora1 #wawa          ┌───────────────────────────┐ │
│  │icon│  Lv 21 · EUW            │ CHALLENGER I · 1705 LP     │ │
│  └────┘                         └───────────────────────────┘ │
│         Recent: 30 games · 2.4 avg · 63% top4 · 22% 1st       │
├───────────────────────────────────────────────┬─────────────┤
│  MATCH LIST (main column)                      │  (optional)  │
│  ┌─────────────────────────────────────────┐   │  Most played │
│  │⬡1│ ▦▦▦▦▦▦▦▦  ●Assassin ●DarkStar …  Lv10 │   │  units /     │
│  │  │ board strip + trait chips      35 · 2h │   │  traits      │
│  └─────────────────────────────────────────┘   │  (defer v1?) │
│  ┌─────────────────────────────────────────┐   │              │
│  │⬡4│ ▦▦▦▦▦▦▦▦  ●AS ●Primordian …    Lv8 …  │   │              │
│  └─────────────────────────────────────────┘   │              │
└───────────────────────────────────────────────┴─────────────┘
```

### Mobile

```
┌──────────────────────────┐
│ ◆   [ Search Name#TAG ]   │
├──────────────────────────┤
│ ┌──┐ yatora1#wawa  Lv21   │
│ │ic│ CHALLENGER · 1705 LP │
│ └──┘ 30g·2.4·63%·22%      │
├──────────────────────────┤
│ ⬡1  ▦▦▦▦▦▦▦  Lv10 · 2h   │
│     ●Assassin ●DarkStar   │
├──────────────────────────┤
│ ⬡4  ▦▦▦▦▦▦▦  Lv8 · 3h    │
└──────────────────────────┘
```

The right rail collapses away on mobile; match rows stack; the board strip
wraps or scrolls horizontally rather than shrinking tiles below legibility.

### Match row (the signature)

```
 ┌─┬──────────────────────────────────────────────────────────┐
 │ │  ⬡        ★★      ★          ★★★                          │
 │S│  4   ▦   ▦   ▦   ▦   ▦   ▦   ▦   ▦     Lv 10  · last 35   │
 │ │ pl   ●●● ─   ─   ●   ●●  ─   ●●●        2 hours ago        │
 │ │      ▸ Assassin 2  ▸ Dark Star 2  ▸ Timebreaker 4(◆)      │
 └─┴──────────────────────────────────────────────────────────┘
   S = placement-colored spine   ⬡ = hex placement badge
   ▦ = unit tile (cost-color border)   ★ = star pips   ● = item dots
   ▸ chip = trait (style-colored: ◆ = prismatic)
```

---

## 5. Component inventory

All built (dependency order, primitives first):

- **AppShell / Header** — logo, global `SearchBar`, nav placeholder. Wraps all pages.
- **SearchBar** — Riot ID input (`Name#TAG`), parses tag, routes to the profile URL.
- **RankBadge** — tier + division + LP, tinted by rank-tier color.
- **PlacementBadge** — the hex, filled by placement color, number in Space Grotesk.
- **UnitTile** — square icon, cost-color border, star pips above, item dots below.
- **TraitChip** — trait icon + active count, background by trait style.
- **BoardStrip** — a row of `UnitTile`s (sorted by cost desc, carry first) + `TraitChip`s. *Signature.*
- **MatchRow** — `PlacementBadge` + spine + `BoardStrip` + meta (level, last round, relative time).
- **MatchList** *(client)* — the stack with the staggered load reveal; owns the expand state and the lazy match-detail fetch (loading / error / loaded per row).
- **LobbyPanel** — the expanded all-8-boards view under a row; reuses `PlacementBadge` (`variant="lobby"`) + `BoardStrip` (`maxTraits=3`), highlights the viewed player by puuid.
- **ProfileHeader** — avatar, name#tag, level, region, `RankBadge`, `SummaryStats`.
- **SummaryStats** — games / avg placement / top-4% / 1st%, computed from the recent matches.
- **Skeletons / EmptyState / ErrorState** — see §6.
- *(optional, likely deferred)* **AggregatePanel** — most-played units & traits.

---

## 6. States & copy

Copy is plain, active, end-user language — never system terms, never apologies.

| State | Treatment | Copy |
|---|---|---|
| Loading | `loading.tsx` skeletons: header block + 5–6 ghost rows | — |
| Not found | full-page, `notFound()` | "No player called **{Name}#{TAG}** on {REGION}. Check the spelling and tag." |
| Unranked | profile renders, rank block replaced | "Unranked this set." |
| No matches | match list area | "No recent ranked games to show yet." |
| Augments empty | augment UI omitted entirely | — (the current set has no augment data; never render an empty augment slot) |
| API/upstream error | `error.tsx`, retryable | "Couldn't reach the match service. Try again." + Retry |
| Search placeholder | — | "Search Riot ID (Name#TAG)" |

`SummaryStats` should label that the numbers are over recent games, not lifetime,
until enough history is stored to say otherwise (e.g. "Last 30 games").

---

## 7. Build status & what's left

**A — Foundation — built.** Tokens + all component CSS in `globals.css` (global
CSS, no Tailwind); fonts via `next/font` (Space Grotesk / Hanken Grotesk / IBM
Plex Mono); `Header` + `SearchBar` + routing for `/[region]/[gameName]/[tagLine]`;
`static-data.ts` catalog cache (`getCatalog`); `iconUrl(path)`; pure view-model
layer (`buildProfileVM`, `buildBoard`); `loading.tsx` / `not-found.tsx` / `error.tsx`.

**B — Profile page + match-detail — built.** Primitives (`PlacementBadge`,
`UnitTile`, `TraitChip`, `RankBadge`) → `BoardStrip` → `MatchRow` / `MatchList`
(staggered reveal + click-to-expand) → `ProfileHeader` / `SummaryStats` →
`app/[region]/[gameName]/[tagLine]/page.tsx` (server component). Plus the
match-detail path: `match-service.getMatchDetail` + `GET /api/match/[region]/[matchId]`
+ `LobbyPanel`. The whole port **typechecks clean** (`tsc --noEmit`, 0 errors) and
the client/server boundary is verified — only `MatchList`, `SearchBar`, and
`error.tsx` are `'use client'`, and no client file imports server-only modules.

**C — Live-data verification — remaining (Roman's run).** From the repo:
`npm run db:migrate` → `npm run data:load` → `npm run dev`, then open
`/euw1/<Name>/<TAG>`. Confirm: catalog rows populated and **trait ids stored as
apiNames** (e.g. `TFT17_DarkStar`, not display names); unit **icon URLs resolve**
(fix `iconUrl` if any 404); clicking a match expands and the lobby fetch returns
all 8 boards; numbers align; the augment section stays hidden. Expect only small
"reviewed-not-run" tweaks — the icon-path mapping is the likeliest.

---

## 8. Out of scope (and why it's cheap later)

Match-detail (full 8 boards) is now **in** — folded into the profile as the row
expand. Still separate later steps: a **dedicated/shareable match page**; trait &
item icons (a 0002 migration adds `icon_path` to those tables + a loader change);
the real profile-icon image; patch backfill from `game_version`; **leaderboards**;
the **comp explorer + clustering pipeline** (the hard one — no Riot endpoint,
rate-limit bound); and the **planner**. All of them reuse `UnitTile`, `TraitChip`,
and `BoardStrip` directly, so this step already built ~70% of the visual system.

## 9. Open decisions

Resolved: dark-only for v1 (theme toggle later); defer the aggregate
"most-played" panel (additive, the data's already there); route segment locked to
**`region`** everywhere.

Still open:
1. **Match-detail presentation.** Inline expand is in now. A **modal** or a
   **dedicated match page** (its own shareable URL) is the likely eventual
   addition — a match page is worth having for sharing regardless. Which to
   prioritize, and do we keep inline expand alongside it?
2. **Lobby augment/anomaly info.** The lobby shows units + traits today. Surface
   per-player augment/anomaly once we confirm what Set 17 actually exposes (it has
   no Hextech augment data, so this needs checking before designing it in).
3. **Recent match count** — currently 10 from the API; keep, or raise to ~20.
