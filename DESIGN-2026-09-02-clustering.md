# Comp clustering rework — design draft

**Status:** revision 5 (2026-09-03). The model is implemented as a pure, tested
module and is NOT wired into the pipeline — see §12. Measurements are from the
live database, set 18, ranked queue only, `player_count = 8`, boards of at least
`MIN_BOARD_UNITS` (6) real cost-1–5 units.

**Replaces:** the exact-signature clustering in
`src/server/queue/comp-signature.ts` + `stages/cluster.ts`, the greedy archetype
merge in `comp-merge.ts` + `comp-profile.ts` + `stages/merge.ts`, and the disjoint
rank/region bucketing in `src/config/rank-buckets.ts`.

**What changed in revision 5:** the rank dial moves off the tier list entirely
and onto the comp detail page, where it recalculates every stat rather than only
composition (§5.6) — superseding the revision-3 recommendation. Gated on the
rework landing, because under exact-signature identity the comp list genuinely
differs per bucket.

**What changed in revision 3:** the rank model turned out to rest on a false
premise. `rank_bucket` is the tier of the player the crawler *drained*, not of
the player who played the board, and at the top of the ladder those are not the
same population — **~44% of the "Master+" sample is Diamond or below** (§5.1).
`match_participants.tier` now records the board's own player (migration 0021),
which resolves the §11.2 prerequisite, unlocks the cumulative scopes, and means
every measurement in revisions 1–2 quoted against `master_plus` was taken on a
mixed population. §4, §5.3 and §5.5 are re-measured against the true `master+`.
The pure module exists: `src/server/queue/comp-centroid.ts`, 33 tests, driven by
`scripts/_centroid-check.ts`.

**Revision 2 established:** centroids elected from the top of the ladder and
frozen (§5); rank buckets as cumulative sample dials; super-regions (§6);
patch-scoped centroid identity, which deleted the retirement machinery (§7);
generated trait + carry + carry names (§8); pinned composition thresholds (§9).

---

## 1. Where the data actually is

> **Read the bucket names with §5.1 in mind.** `iron_gold` and `master_plus` are
> *sampling frames* — the tier of the player the crawler drained — not the ranks
> of the players who played the boards. The figures in §1, §2 and §4 are quoted
> against those frames because that is what they were measured on; §5 onward uses
> the real per-board tier.

| | `iron_gold` | `master_plus` |
|---|---:|---:|
| clusterable boards | 76,132 | 8,978 |
| distinct unit-sets (stars/items dropped) | 36,190 | 4,880 |
| comps today (exact signature) | 54,564 | 6,636 |
| boards wearing at least one emblem | 23,576 (31.0%) | 3,920 (43.7%) |

Unit-set size distribution — how many boards sit in unit-sets of each size:

| unit-set size | `iron_gold` keys | boards | | `master_plus` keys | boards |
|---|---:|---:|---|---:|---:|
| 100+ | 61 | 17,132 (22.5%) | | 6 | 975 (10.9%) |
| 25–99 | 169 | 8,158 (10.7%) | | 22 | 1,073 (12.0%) |
| 10–24 | 369 | 5,490 (7.2%) | | 53 | 770 (8.6%) |
| 2–9 | 4,474 | 14,235 (18.7%) | | 616 | 1,977 (22.0%) |
| **1** | **31,117** | **31,117 (40.9%)** | | **4,183** | **4,183 (46.6%)** |

Two things follow, and they point in opposite directions:

- **Dropping stars and items is worth doing but does not collapse the tail.**
  54,564 comps → 36,190 unit-sets is a 34% reduction, not an order of magnitude.
- **41–47% of boards are in a unit-set that occurs exactly once.** The tail is
  *combinatorial* — genuinely different 8- and 9-unit combinations. No identity
  rule that keys on the exact set of units can ever group it. Grouping has to be
  by *similarity to a reference*.

---

## 2. The bug worth fixing: the headline row is a biased sample

Today a comp row is one exact unit multiset, and its stats are the stats of the
boards that fielded *exactly* those units. Every board that missed a unit, or
picked up an extra one, is a different row. So the number on the tier list is not
the line's performance — it is the performance of *one particular board size*
within the line.

Grouping each line by presence profile (§3) and comparing what the biggest exact
unit-set inside it reports against what the whole line reports:

**`iron_gold`** — the headline is *optimistic*:

| line (core units) | line boards | line top4 | headline boards | headline top4 | Δ |
|---|---:|---:|---:|---:|---:|
| Sentry Brambleback Krug Murkwolf Scuttlecrab Sentinel | 6,917 | 54.9% | 378 | 68.0% | **+13.1pp** |
| Cassiopeia Leona Lillia Ornn Rammus Shen Fiddlesticks | 5,846 | 58.8% | 2,047 | 72.1% | **+13.2pp** |
| Alistar Ezreal Hecarim LeBlanc Ornn Xayah | 3,000 | 50.0% | 76 | 73.7% | **+23.7pp** |
| Ahri Ashe Sett Sivir Yorick Karma Vi | 1,862 | 61.9% | 462 | 85.9% | **+24.0pp** |

**`master_plus`** — the same measurement, and the sign **flips**:

| line (core units) | line boards | line top4 | headline boards | headline top4 | Δ |
|---|---:|---:|---:|---:|---:|
| Sentry Brambleback Cinderling Krug Murkwolf Scuttlecrab Sentinel | 805 | 54.0% | 93 | 26.9% | **−27.2pp** |
| Cassiopeia Leona Lillia Ornn Rammus Shen Fiddlesticks | 721 | 53.3% | 315 | 26.3% | **−26.9pp** |
| MasterYi Sett Yorick Krug Nidalee Vi | 457 | 54.5% | 84 | 31.0% | **−23.5pp** |
| Lillia Rakan Rammus Sivir Tristana Vi | 237 | 47.7% | 23 | 0.0% | **−47.7pp** |

### Why it flips

The headline is whichever exact unit-set is most common — and that tracks
**board size**, which tracks placement:

| | line mean units | headline units |
|---|---:|---:|
| `iron_gold` · Cassiopeia line | 7.83 | **8** |
| `iron_gold` · Sentry/Krug line | 8.26 | **9** |
| `master_plus` · Cassiopeia line | 7.52 | **7** |
| `master_plus` · Sentry/Krug line | 8.23 | **7** |

In `iron_gold` the modal board is the *finished* one, so the headline reads high.
In `master_plus` the modal board is the *short* one — a player who died at level 7
— so the headline reads low. Same code, same line, opposite lie.

**This is not a tuning problem.** No threshold in `comp-merge.ts` addresses it,
because the bias is in the identity rule, not in the merge that runs after it.

---

## 3. The model

### 3.1 Identity is a presence profile, not a board

A line is **a map from unit → the rate at which that unit appears on boards of
that line**.

```
CORE 100%  Fiddlesticks     CORE  96%  Ornn
CORE  99%  Rammus           CORE  94%  Leona
CORE  97%  Shen             CORE  89%  Lillia
CORE  97%  Cassiopeia       flex  58%  Soraka
```

Seven core units and a coin-flip on Soraka. That is a statement the current model
cannot make: it either merges Soraka in or splits her off, and both are wrong.

### 3.2 Assignment

A board's score against a profile is the **weighted Jaccard** of the board's
binary unit set against the profile's rates:

```
score(board, profile) =  Σ_{u ∈ board} p_u
                        ─────────────────────────────
                        |board| + Σ_{u ∉ board} p_u
```

Assign to the highest-scoring profile if that score clears `ASSIGN_BAR`;
otherwise the board is **off-meta** and belongs to no line. Order-independent by
construction — every board is scored against the same fixed set of profiles, so
arrival order cannot change the answer. That single property removes the reason
the current system has a three-block ordering, a fold pass *and* a refinement
sweep.

### 3.3 Convergence: you do not have to pick k

1. **Seed** — walk distinct unit-sets by board volume; take a candidate as a seed
   only if its Jaccard against every already-taken seed is below `MIN_SEPARATION`
   (0.70).
2. **Assign** every unit-set to its best seed (§3.2).
3. **Recompute** each profile as unit → board-weighted rate over its members;
   drop units below `PROFILE_MIN_RATE` (0.15).
4. **Collapse** profiles whose ≥50% cores are within `MIN_SEPARATION` of each
   other — profiles that converged onto the same line merge automatically.
5. Repeat until the profile count is stable (measured: 4–15 iterations).

Because step 4 dissolves redundancy, **over-seeding is safe**. You do not tune k.

### 3.4 Three layers, not one key

| layer | what is in it | what it does |
|---|---|---|
| **Identity** | which units are on the board | picks the line — this is the centroid |
| **Composition** | star tiers, items, board size, level | reported *within* the line (§9), never splits it |
| **Context** | augments, emblems | reported as conditional performance; splits only under §10 |

---

## 4. Measured behaviour of the election

`MIN_SEPARATION` 0.70 throughout. "Homed" is the share of boards that clear the
assign bar:

**`iron_gold`** (76,132 boards)

| seed | bar | centroids | homed | off-meta |
|---:|---:|---:|---:|---:|
| 60 | 0.60 | 42 | 63.9% | 36.1% |
| 120 | 0.50 | 67 | 79.8% | 20.2% |
| 300 | 0.50 | 98 | 82.4% | 17.6% |
| **300** | **0.45** | **106** | **88.6%** | **11.4%** |

**`master_plus`** (8,978 boards)

| seed | bar | centroids | homed | off-meta |
|---:|---:|---:|---:|---:|
| 60 | 0.60 | 43 | 70.2% | 29.8% |
| 120 | 0.50 | 77 | 84.3% | 15.7% |
| 300 | 0.50 | 186 | 89.8% | 10.2% |
| **300** | **0.45** | **189** | **94.1%** | **5.9%** |

Seed 300 / separation 0.70 / bar 0.45 is the default for both. `master_plus`
supports nearly twice the lines on a tenth of the data (189 vs 106): `iron_gold`
boards pile onto fewer real lines with more variation around each.

These are the revision-2 figures, taken on the sampling frames. Re-measured on
the real tier (§5.1), the true `master+` population is 7,216 clusterable boards
and elects **202 lines at 93.5% homed** — more lines from half the data, which
sharpens rather than contradicts the point above.

### Off-meta boards are genuinely worse, so do not force them in

| | boards | avg placement | top 4 | win |
|---|---:|---:|---:|---:|
| `iron_gold` homed | 63,621 | 4.33 | 53.0% | 13.7% |
| `iron_gold` off-meta | 13,246 | **5.10** | 38.7% | 7.6% |
| `master_plus` homed | 8,068 | 4.44 | 51.0% | 12.9% |
| `master_plus` off-meta | 910 | **4.91** | 42.7% | 9.9% |

Off-meta boards are not a missing line — they are boards that did not play a
line. Keep them in an explicit bucket and never let them into a line's stats.

---

## 5. Rank is a sample dial, not a separate meta

A board that wins in Iron and loses in Master is not a different meta; Iron is
simply less punishing, so it tolerates plays that do not work. The strongest
available evidence is the truth, and weaker ranks only ever widen the sample —
they never redefine what a good board is.

### 5.1 First: the bucket is not the rank

`rank_bucket` is the tier of the player the crawler **drained to reach** a match,
stamped onto all eight boards, on the stated grounds that TFT lobbies are
rank-homogeneous. Measured against `accounts.tier`, that does not hold where it
matters most:

| boards labelled `master_plus`, by the tier of the player who played them | |
|---|---:|
| MASTER | 6,124 |
| DIAMOND | **3,087** |
| EMERALD | **2,274** |
| GRANDMASTER | 919 |
| PLATINUM | **61** |

Roughly **44% of the "Master+" sample is Diamond or below**. That is not a crawl
bug — the EUW Master population is ~120 accounts this early in a set, so
matchmaking widens and pulls Diamond and Emerald players into those lobbies. But
it means `master_plus` describes *where a board was sampled*, not who played it,
and the two were being read as the same thing.

So the true `master+` population is **7,283 boards, not the 14,616** the bucket
claimed, and every measurement in revisions 1–2 taken "on master_plus" was taken
on a mixed population.

**Migration 0021** adds `match_participants.tier`: the board's own player's tier,
*as sampled* and never updated afterwards — a board played in Gold stays a Gold
board when its player climbs, because a stats site that retroactively re-ranks
its own history cannot be aggregated. NULL means "could not establish" and is
never folded into a named tier. `rank_bucket` stays in place; the bucket is the
sampling frame, the tier is the player, and they answer different questions.

### 5.2 Cumulative tiers replace disjoint buckets

`iron_gold` / `plat_emerald` / `master_plus` become **gold+, platinum+,
emerald+, diamond+, master+**, each containing everything above it, selected on
`tier` rather than on the bucket. The dial says "how far down am I willing to
reach for sample", not "which meta am I looking at". Live sizes:

| scope | boards |
|---|---:|
| gold+ | 32,698 |
| platinum+ | 18,734 |
| emerald+ | 13,348 |
| diamond+ | 10,433 |
| **master+** | **7,283** |

### 5.3 Centroids are elected from `master+` and frozen

Wider-scope boards are assigned into the master-elected profiles; they never
create a centroid and never move one. Re-measured on true tier scopes:

| scope | boards | into `master+` centroids | with its own centroids | cost |
|---|---:|---:|---:|---:|
| diamond+ | 10,342 | **93.1% homed** | 93.3% (182) | −0.2pp |
| emerald+ | 13,207 | **93.0% homed** | 93.3% (173) | −0.3pp |
| platinum+ | 18,489 | **92.1% homed** | 93.3% (186) | −1.2pp |
| gold+ | 32,017 | **88.7% homed** | 91.4% (150) | −2.7pp |

This is a much better result than revision 2 measured, and for two reasons: the
centroids are now elected from a clean population rather than a 44%-Diamond one,
and `gold+` excludes the Iron–Silver boards where the off-meta tail lived. The
cost of freezing the top-of-ladder centroids is **2.7pp at gold+ and under 1.3pp
everywhere above it** — against revision 2's 8.4pp.

**And the boards master+ centroids reject are still the bad boards.** At gold+,
homed boards average 4.19 placement against **5.12** for the 3,630 rejected ones;
the same gap holds at every scope. Rejecting them is correct, and the off-meta
bucket is where they belong.

### 5.4 Not `gm+` — the sample does not exist

`gm+` is the right instinct and is not currently reachable:

| crawled accounts by tier | |
|---|---:|
| GOLD | 4,002 |
| PLATINUM | 3,418 |
| SILVER | 2,110 |
| EMERALD | 1,055 |
| BRONZE | 744 |
| DIAMOND | 137 |
| MASTER | 103 |
| GRANDMASTER | 15 |
| CHALLENGER | 2 |

17 accounts above Master, and the legacy `challenger` bucket holds 168 boards
total. **Elect from `master_plus`.** Revisit `gm+` only if the crawler is
re-pointed to seed from the apex leagues directly.

### 5.5 How many lines to list — a relative floor, not a fixed count

Coverage of the 7,216 true `master+` boards by the top-N elected centroids:

| top N | share of all boards | Nth centroid's board count |
|---:|---:|---:|
| 10 | 53.9% | 154 |
| 25 | 69.9% | 45 |
| **36** | **75.0%** | **28** |
| 50 | 79.6% | 20 |
| 100 | 88.4% | 7 |
| 202 | 93.5% | 1 |

A fixed count of 100 lists lines with seven boards. But a fixed floor has the
opposite failure — 20 lines on day one of a patch and 200 by the end of it.
**Make the floor relative to how much data the patch has.** Two rules, and I
would use both:

- **A coverage target as the primary rule.** List the largest lines until they
  together account for `LIST_COVERAGE` of the boards that *found a line* — 80% of
  homed boards, which is 36 lines and 75% of all boards today. The denominator is
  deliberately the homed population rather than every board: off-meta boards are
  not a line, so counting them would make the target unreachable and quietly turn
  the coverage rule back into "list everything". This is self-regulating, because it keys on the *shape* of the
  distribution rather than on counts: as the patch fills, the same lines get
  bigger rather than new ones appearing, so the list length stays roughly stable
  from day two to day fourteen. Observed directly: going from 8,978 to 14,485
  boards moved the listed count from 28 to 31 while coverage stayed at 75%.
- **An absolute minimum as a safety floor.** `LIST_MIN_BOARDS` (≈20) stops a
  near-empty early-patch scope from listing lines with three boards just because
  they are the biggest three.

Whichever rule bounds the list, show each line's sample size and the confidence
interval on its placement, so a thin line reads as thin instead of being silently
dropped or silently trusted.

### 5.6 Where the rank dial lives — the list loses it, the detail page gains it

Revision 3 recommended that the dial "widen composition, not the verdict":
placement, top-4 and tier pinned to `master+`, with the selector governing only
itemisation and star rates. **That was the wrong shape, and it is superseded.**

The concern behind it was real — low-elo placement must not decide which comps
are S-tier — but pinning the stats was the wrong place to fix it. The right fix
is structural:

- **The tier list has no rank picker at all.** Lines are elected from `master+`
  and their ranking is always the `master+` verdict. There is nothing to corrupt,
  because there is no dial on the page that produces the verdict.
- **The detail page has the picker, and it recalculates everything.** Avg place,
  top-4, win, play rate, games, placement distribution, hit state, trend, final
  level, carry items, unit frequencies and most-played boards all recompute for
  the selected scope. Asking "how does this line actually perform in gold+" is a
  legitimate question with an honest answer, and the user asked it explicitly by
  moving the selector.

This is better than the revision-3 version because it removes the failure mode
instead of labelling around it. It also stops the page telling two stories at
once — a revision-3 detail page would have shown `master+` placement above
`gold+` itemisation, which is a comparison nobody asked for.

**The example board does NOT follow the dial.** It is the line's canonical board,
elected with the line, and it stays the same at every scope. A per-scope example
would quietly turn the page into "here is a different comp" as you widen.

**This is gated on the rework landing.** Under exact-signature identity the comp
LIST genuinely differs per bucket — which comps clear the sample floor is
completely different in `iron_gold` and `master_plus` — so removing the picker
today would hide a real disagreement rather than express a real equivalence. The
picker stays on the list page until centroids are master+-elected and frozen,
and it is worth keeping meanwhile: it is the clearest view of how the buckets
currently diverge.

**The honest counterpart: not every line has a sample in every scope.** A
master-only line barely played in gold has a handful of gold+ boards, and the
detail page must say so rather than render a confident number over n = 4. Every
recalculated figure needs its sample size and interval beside it, and a scope
with too little data needs an explicit empty state — the same discipline §5.5
applies to the list.

Later, the same mechanism carries an **explorer**: per-item and per-unit stats
within a line, filterable. That is exactly the case the dial was invented for —
"what does this item do on this unit in this comp" is n = 2 at `master+` and a
real distribution at `gold+` — and it is why the picker belongs on the detail
page rather than nowhere.

---

## 6. Regions become super-regions

The game's rules are identical everywhere; only playstyle and field strength
differ. So platform-level regions fold into the three super-regions the
competitive scene is actually split into:

| super-region | platforms |
|---|---|
| **AMER** | NA · BR · LAN · LAS |
| **EMEA** | EUW · EUNE · TR · RU · ME |
| **APAC** | KR · JP · OCE · TW · VN · SEA |

Mainland China is not included: it runs on Tencent's infrastructure and is not
served by the public Riot API, so it can never be a bucket this crawler fills.

**There is no region data yet** — all 120,702 set-18 boards are `EUW1`
(`DEFAULT_PLATFORM=euw1`), so super-regions are correct in principle and
currently cosmetic. They start mattering when the crawler seeds more than one
platform.

Worth noting for the rollup: cumulative rank tiers **overlap**, so `comp_stats`
cannot simply be keyed by them the way disjoint buckets were. Store per-tier rows
and sum on read — the smaller change, and it keeps the grid
`(centroid × patch × super-region × tier)` honest.

---

## 7. Patch scoping — centroids do not outlive a patch

The meta changes at a patch boundary, old-patch numbers are not useful, and
nobody opens a link to last patch's comp. So centroid identity is scoped to
`(set_number, patch_id)` and re-elected per patch. That removes the retirement
machinery, the cross-patch matching pass and the "dead line lingering" problem
from revision 1 entirely.

Stickiness still matters **within** a patch: people share `/comps/[key]` links
mid-patch. So within a patch, a re-election matches new profiles against the
existing persisted centroids by core Jaccard and keeps the id on a match
≥ `MIN_SEPARATION`; only genuinely new lines get new ids.

**This depends on being able to detect a patch**, which is now possible — but by
declaration rather than detection, because TFT on Unreal follows no release
train. See §11.1.

Feasibility: `master_plus` accumulated 9,056 boards between 2026-08-27 and
2026-09-01, about 1,800/day. Over a two-week patch that is roughly 25,000 boards
— around 250 per line at 100 lines, which supports a per-patch election
comfortably. Early in a patch the list will be short and should say so.

---

## 8. Naming: trait + carry + carry

Every line gets a generated name: the line's headline **trait**, then the two
units **itemised in the most boards**.

- **Trait** — computed from the centroid's core units (rate ≥ 0.8), never from a
  single board. Take the active trait at the highest breakpoint style; tie-break
  on the breakpoint requiring the most units, so a 3/3 beats a 2/2 and a unique
  1/1 loses to both.
- **Carries** — the two units carrying ≥ 2 non-emblem items on the most boards in
  the line.

Measured on the 189 `master_plus` centroids, the names read well:

```
860  Riftbeast Cinderling Pebbles          245  Defender Tristana Rammus
729  Defender Cassiopeia Fiddlesticks      239  Apex Predator Pebbles Elder Dragon
706  Invoker Ahri Morgana                  182  Old Growth Draven Ezreal
586  Solar Kayle Xayah                     159  Elderwood Aphelios Lillia
577  Summoner Malphite Soraka              142  Rival Kha'Zix Rengar
472  Blossom Master Yi Vi                  141  Monolith Sivir Nidalee
```

Two findings:

- **The "no trait" branch never fires.** All 189 core sets activate at least one
  trait, so the fallback is dead code for set 18 — keep it as a guard, not as a
  designed case.
- **Names collide, and need a tie-break.** 26 names cover 64 of the 189
  centroids. It improves sharply with the §5.4 floor, because most collisions are
  in the noise tail:

| floor | lines | distinct names | colliding names | lines affected |
|---:|---:|---:|---:|---:|
| n ≥ 10 | 102 | 82 | 16 | 36 |
| n ≥ 22 | 50 | 40 | 7 | 17 |
| n ≥ 40 | 30 | 26 | 3 | 7 |
| n ≥ 60 | 25 | 22 | 3 | 6 |

### What the collisions actually are

Dumping the four centroids that all name themselves `Monolith Malphite Ahri`:

| centroid | boards | avg | top 4 | core beyond Malphite |
|---|---:|---:|---:|---|
| #26 | 34 | 5.06 | 35.3% | Azir · Ahri · Yorick · Yunara · Fiddlesticks |
| #67 | 15 | 5.13 | 40.0% | **Alune** · Azir · Ahri · Yorick |
| #61 | 11 | 3.18 | 72.7% | Azir · **Sett** · Yorick · Yunara |
| #133 | 3 | 6.33 | 0.0% | Ahri · Yunara · **Karma** |

Pairwise core Jaccard runs 0.29–0.57 — all well under the 0.70 separation, so
**these are genuinely four different lines** and the model is right to keep them
apart. Three of the four have a distinct core anchor: Alune, Sett, Karma. #61 in
particular places a full 1.9 better than #26; folding them together would hide a
strong variant inside a mediocre one.

So the grouping is sound and the *naming* is what fails. Two fixes:

1. **Draw carries from core units only.** #61's name says Ahri, but Ahri is a 45%
   flex unit there — she won the carry slot on 5 itemised boards out of 11,
   beating Ezreal and Yunara on a tie-break. Restricting candidates to units at
   rate ≥ 0.8 and ranking by itemisation rate (not raw count) renames #61 to
   *Monolith Malphite Yunara* and removes it from the collision.
2. **Append the distinguishing unit on the remainder.** #26, #67 and #133
   genuinely do carry Malphite and Ahri; what separates them is Alune, Karma and
   the Fiddlesticks/Yunara shell. Appending the unit unique to each — only on
   collision, so unique names stay clean — is deterministic and does not
   reintroduce the `##k` suffix. **The search must not stop at the core.** Two
   lines can share an identical core and still be different lines: at 14.5k
   `master_plus` boards, two Aphelios/Brambleback lines had the same six core
   units and sat **20pp apart on top-4** (51.3% against 31.6%), separated only by
   their flex band — Zyra 74% / Taric 72% against Rakan 51% / Elise 35%. Prefer a
   core unit, tie-broken on cost; fall through to the highest-rate flex unit no
   other collider fields at all. That names them *Zyra* and *Elise*, and merging
   them instead would have hidden a 554-board difference in placement.

Note also that three of these four sit below any sensible floor (15, 11 and 3
boards). At the §5 coverage target only #26 is listed, so most of the collision
count is a tail artifact rather than a display problem.

---

## 9. Where composition attaches

Within a line, a unit is shown at 3★ in the example board if it is 3★ on at least
`EX_STAR_MIN_RATE` of boards, and shown with items if it is itemised on at least
`EX_ITEM_MIN_RATE` of boards.

**One correction: the denominator must be the boards that fielded the unit, not
every board in the line.** Otherwise a 58%-flex unit can never clear a 60% bar no
matter how consistently the people who play it itemise it — the flex rate caps
the item rate. Two numbers, both worth showing: "played on 58% of boards; of
those, itemised on 91%".

For items specifically, the threshold picks *whether* to show a build; *which*
build is the modal item set among boards where that unit was itemised, shown with
its own frequency.

---

## 10. Emblems split a line only when they earn it

Emblems are on 31% of `iron_gold` boards and 44% of `master_plus`. Making the
emblem set a raw key component would re-fragment everything:

| | `iron_gold` | `master_plus` |
|---|---:|---:|
| distinct emblem signatures | 1,880 | 664 |
| carried by ≥ 100 boards | 22 | 12 |
| carried by ≥ 25 boards | 77 | 21 |
| carried by exactly 1 board | **971** | **401** |

**Rule:** assign on units alone; group a line's boards by emblem signature; a
group becomes a named variant only if it clears `EMBLEM_MIN_BOARDS` **and** shows
a placement separation outside the line's confidence interval. Everything else
stays in the parent line as an "emblems seen" distribution.

**Augments** are a conditional performance dimension, not identity: per-line,
per-augment placement against the line's baseline. There are no hero augments and
no augment-gated units in set 18, so `REQUIRE_HERO_AUGMENT_CLASS` and
`REQUIRE_GATED_CLASS` simply go away.

---

## 11. Prerequisites found during review

Both of the blocking ones are now closed. What remains is a sample-size caveat,
not a gate.

### 11.1 Patch boundaries are not detectable — **RESOLVED, by declaring them**

Riot reports `game_version = "TFT Unreal Version ?.?.?.?"` for every set-18
match, so all of them resolve to one synthetic patch row, `18.0` labelled
`Unversioned`. Revision 2 proposed a date-keyed patch calendar. That was the
right shape and the wrong mechanism: **TFT on Unreal is no longer tied to the
League client's release train**, so there is no cadence to key a calendar on —
Riot ships 18.1, then 18.1a out of band when something breaks the meta, then
18.2, whenever they choose.

Nothing in the payload distinguishes those, so the boundary cannot be inferred
or predicted. The only honest source is someone who watched it land, which makes
it a declaration rather than a derivation:

```
npm run patch:open -- 18.1
npm run patch:open -- 18.1a --at "2026-09-10T11:00:00Z"
```

It writes `patches.released_at`, moves `is_current`, and **re-resolves the
matches already stored past the boundary** — the part that matters, because in
practice it is run hours after the patch dropped, and without it "run it when I
notice" mislabels everything in between. `comp_stats` needs no repair: the
rollup is a full recompute, so the next pipeline pass picks the new `patch_id`
up.

`resolvePatchId` prefers a declared boundary when the set has one and otherwise
falls through to the existing `game_version` derivation unchanged, so the 515k
set-17 matches keep resolving exactly as they do now.

**Not an env var.** A variable records *which* patch, never *when* it started, so
it cannot place matches already ingested and cannot be re-derived; it needs a
restart to take effect; and it goes stale the moment nobody remembers to update
it — the failure `advanceCurrentPatch`'s own header warns about. A boundary is a
fact about a moment in time, so it belongs in a row.

**Hotfix patches are first-class.** `18.1a` and `18.1b` are separate metas and
so separate patches. The previous ordering guard (`^[0-9]+[.][0-9]+$`) excluded
them outright, which would have left a hotfix unable to take the current-patch
flag; the suffix is now split out of the minor component so `18.1 < 18.1a <
18.1b < 18.2` and the `::int` cast never sees `"1a"`.

### 11.2 Per-board tier is not stored — **RESOLVED**

Closed by migration 0021 (§5.1). `match_participants.tier` carries the board's
own player's tier, written three ways so the column does not decay: `persistMatch`
stamps it from `accounts` in the same transaction (one indexed read, no Riot
calls); `ladder-crawl` fills boards whose player has since been resolved, bounded
by `CRAWL_TIER_STAMP_LIMIT`; and the migration backfills what was already known.

Coverage is 25% of all set-18 boards but **86% of the `master_plus` ones**, which
is exactly where the correction matters. It rises on its own as the crawl
resolves more accounts.

### 11.3 The `master+` sample is thinner than revision 2 thought

Revision 2 recorded 8,978 `master_plus` boards over 189 lines, ~47 each. With the
bucket resolved into a real tier, the honest figure is worse: **7,216 boards over
202 lines, ~36 each**. Core units are safe at that sample; a "58% flex" from 36
boards carries roughly ±16pp, so the flex *rates* should be read as indicative
until the sample grows.

The constraint behind it was the crawl, and that has changed materially. After
the 2026-09-02 ingest fixes, `master_plus` gained more boards in 45 minutes than
in the previous three days, so this resolves on its own within days rather than
weeks. **Re-run §4, §5.3 and §5.5 against `master+` — not `master_plus` — once
the scope passes ~25k boards, before fixing any defaults.**

---

## 12. Implementation status

The pure module exists and is not wired into the chain:

- `src/server/queue/comp-centroid.ts` — seeding, scoring, convergence, collapse,
  listing and naming. No DB access, no set knowledge; statics are passed in, the
  same contract as `carry-classify.ts`.
- `src/server/queue/comp-centroid.test.ts` — 33 tests pinning the load-bearing
  properties (order-independence, safe over-seeding, the marker-trait exclusion,
  the flex-band collision tiebreak).
- `scripts/_centroid-check.ts` — read-only run against the live database, taking
  either a rank bucket or a cumulative tier scope. Fails on three invariants: a
  centroid with no boards, two listed lines sharing a name, and any line named
  after a marker trait. It is what caught both naming defects.

Nothing in the live read path has changed.

---

## 13. What this deletes

From `comp-merge.ts` (1,362 lines) and its 28 env knobs:

- the three-block ordering, fold pass and refinement sweep — order independence is
  structural now (`MERGE_ASSIGN_MARGIN`, `MERGE_REFINE_MARGIN`);
- the score-weight system (`MERGE_UNIT_WEIGHT`, `MERGE_JACCARD_WEIGHT`,
  `MERGE_CARRY_WEIGHT`, `MERGE_SCORE_THRESHOLD`, `MERGE_MIN_CONTAINMENT`,
  `MERGE_MIN_JACCARD`) — one weighted-Jaccard score replaces it;
- the carry system end to end (`REQUIRE_CARRY`, `MERGE_MIN_CARRY_OVERLAP`,
  `MERGE_CARRY_DOMINANT_RATE`, `MERGE_STRONG_CARRY_OVERLAP`,
  `MERGE_STRONG_CARRY_SLACK`, `getDomCarries`, `getDomDamageCarries`,
  `carry-classify.ts`) — including the Dice-vs-overlap cliff. Note the *concept*
  survives in the naming scheme (§8), but as a display fact, not a merge guard;
- `REQUIRE_HERO_AUGMENT_CLASS` / `MERGE_HERO_AUG_LOW` and `REQUIRE_GATED_CLASS`;
- the trait slack system (`MERGE_TRAIT_STRONG_SIM`, `MERGE_TRAIT_SLACK_JAC`,
  `MERGE_TRAIT_SLACK_SCORE`, `MERGE_TRAIT_MIN_SIM`) — traits are derived from
  units and carry no information the unit profile does not already have;
- `REQUIRE_DUP_CLASS` / `REQUIRE_COPY_CLASS` / `MERGE_GRADE3_MIN_N` /
  `MERGE_LEVEL_CONFLICT_GAP`;
- the disjoint `RankBucket` union and `apex_mixed` legacy label in
  `src/config/rank-buckets.ts`.

**Survives:** the sample floors, the chunked scan and bounded-memory discipline in
`cluster.ts`, the clear-first / FK-safe-prune transaction shape, `MIN_BOARD_UNITS`.

**New knobs, all with measured defaults:** `SEED_COUNT` (300), `MIN_SEPARATION`
(0.70), `ASSIGN_BAR` (0.45), `PROFILE_MIN_RATE` (0.15), `LIST_MIN_BOARDS` (≈22),
`EMBLEM_MIN_BOARDS`, `EX_STAR_MIN_RATE`, `EX_ITEM_MIN_RATE`.

---

## 14. Validation path

The 32 labelled pairs in `scripts/merge-eval-pairs.json` (25 `merge`, 7 `split`)
reference 52 comp ids — **all 52 are set 17**, and all still exist, as do
**515,010 set-17 boards**. That is a real regression corpus with human labels.

1. ~~Build the new model as a pure module with unit tests.~~ **Done** — §12.
2. **Downgraded from a gate to an optional floor.** Running the set-17 pairs
   sounded stronger than it is: 25 of the 32 are `merge` labels, and the new model
   merges far more aggressively by construction, so those pass close to trivially.
   The 7 `split` pairs are the only ones that could genuinely fail, and they encode
   set-17 semantics — hero augments, gated units, reroll targets — that do not
   exist in set 18. Worth one run as a regression floor; not worth blocking on.
3. Run it over set 18 and eyeball the lines and their generated names against the
   game. **This is the real test**, and it is what caught both naming defects
   (§8) — not any pair file.
4. Resolve the patch calendar (§11.1). The per-board tier column is done (§11.2).
5. Write into new tables behind the existing chain, with the old clustering still
   populating the live read path.
6. Cut the read plane over once the numbers are inspected side by side.

Steps 1–3 are read-only and safe against the live database.

---

## 15. Risks

- **It is a full re-cluster.** Every comp id, every `/comps/[key]` URL and every
  `comp_stats` row is rebuilt. The staged path exists so this happens once.
- **The 32 pairs are set-17 semantics.** Passing them proves the model is not
  worse than today on cases someone already looked at; it does not prove it is
  right on set 18.
- **The whole model now rests on `master+`.** If the crawl loses apex seeds, the
  centroid set degrades and everything downstream degrades with it. The election
  should refuse to run below a minimum board count rather than quietly electing
  from noise — and it must count boards by TIER, not by bucket, or a lobby full of
  Diamond players keeps the count looking healthy while the population it
  describes drifts (§5.1).
- **Cost is fine:** 36,190 unit-sets × ~300 profiles ≈ 11M set operations per
  iteration, ~10 iterations. Seconds, and it scales with distinct unit-sets × k
  rather than with total boards.
