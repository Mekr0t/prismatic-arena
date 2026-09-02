# Comp clustering rework — design draft

**Status:** draft, not implemented. Revision 2 (2026-09-02), after review.
Measurements are from the live database, set 18, ranked queue only,
`player_count = 8`, boards of at least `MIN_BOARD_UNITS` (6) real cost-1–5 units.

**Replaces:** the exact-signature clustering in
`src/server/queue/comp-signature.ts` + `stages/cluster.ts`, the greedy archetype
merge in `comp-merge.ts` + `comp-profile.ts` + `stages/merge.ts`, and the disjoint
rank/region bucketing in `src/config/rank-buckets.ts`.

**What changed in revision 2:** centroids are elected from `master_plus` alone
and frozen (§5); rank buckets become cumulative sample dials rather than separate
metas (§5); regions become super-regions (§6); centroid identity is patch-scoped,
which removes the retirement machinery (§7); lines get a generated
trait + carry + carry name (§8); composition thresholds are pinned (§9). Three
prerequisites surfaced during review and are listed in §11.

---

## 1. Where the data actually is

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

### 5.1 Cumulative tiers replace disjoint buckets

`iron_gold` / `plat_emerald` / `master_plus` become **gold+, platinum+,
emerald+, diamond+, master+**, each containing everything above it. The dial says
"how far down am I willing to reach for sample", not "which meta am I looking at".

Note this needs the board's **actual tier**, which is not what
`match_participants.rank_bucket` stores today — see §11.

### 5.2 Centroids are elected from `master_plus` and frozen

Lower-rank boards are assigned into the master-elected profiles; they never
create a centroid and never move one. Measured:

| bucket | boards | into master-elected centroids | with its own centroids | cost |
|---|---:|---:|---:|---:|
| `plat_emerald` | 13,558 | **89.3% homed** | 93.3% (195 centroids) | −4.0pp |
| `iron_gold` | 91,957 | **79.8% homed** | 88.2% (110 centroids) | −8.4pp |

**And the boards master centroids reject are the bad boards.** In `iron_gold`,
boards homed into a master centroid average 4.25; the 18,574 rejected ones
average **5.31**. In `plat_emerald`, 4.36 vs **5.53**. The 8.4pp that
iron-elected centroids would have "recovered" is exactly the set of lines that
only exist in low ranks and place badly there. Rejecting them is the correct
behaviour, and the off-meta bucket is where they belong.

### 5.3 Not `gm+` — the sample does not exist

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

### 5.4 How many lines to list — a relative floor, not a fixed count

"Top 100 by games" is more rows than the data supports. Coverage of the 8,978
`master_plus` boards by the top-N elected centroids:

| top N | boards covered | share | Nth centroid's board count |
|---:|---:|---:|---:|
| 25 | 6,461 | 72.0% | 60 |
| 50 | 7,271 | 81.0% | 22 |
| 100 | 7,987 | 89.0% | **10** |
| 150 | 8,331 | 92.8% | 5 |
| 189 | 8,454 | 94.2% | 1 |

The 100th line has ten boards. But a fixed floor has the opposite failure — 20
lines on day one of a patch and 200 by the end of it. **Make the floor relative
to how much data the patch has.** Two forms, and I would use both:

- **A coverage target as the primary rule.** List the largest lines until they
  together account for `LIST_COVERAGE` of the bucket's boards — 80% is 50 lines
  today. This is self-regulating, because it keys on the *shape* of the
  distribution rather than on counts: as the patch fills, the same lines get
  bigger rather than new ones appearing, so the list length stays roughly stable
  from day two to day fourteen.
- **An absolute minimum as a safety floor.** `LIST_MIN_BOARDS` (≈20) stops a
  near-empty early-patch bucket from listing lines with three boards just because
  they are the biggest three.

Whichever rule bounds the list, show each line's sample size and the confidence
interval on its placement, so a thin line reads as thin instead of being silently
dropped or silently trusted.

### 5.5 What the rank dial changes on the detail page

Widening to gold+ to get a readable itemisation sample is exactly right. But
widening also changes *placement*, and low-rank placement for a master-defined
line reintroduces the bias §5 exists to remove.

**Recommendation: the dial widens composition, not the verdict.** Placement, top-4
and tier stay at `master+` and are labelled as such; the selector governs
itemisation, star rates, augment rates and example boards, with the sample size
shown next to whatever tier is selected.

This is where the dial earns its keep: "what does this item do on this unit in
this comp" can be n = 2 at `master+`, which is not data. Widening to `gold+`
turns it into a real distribution without ever letting low-elo placement touch
the comp's verdict.

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

**This depends on being able to detect a patch, which is currently broken — see
§11.**

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
2. **Append the distinguishing core unit on the remainder.** #26, #67 and #133
   genuinely do carry Malphite and Ahri; what separates them is Alune, Karma and
   the Fiddlesticks/Yunara shell. Appending the highest-cost core unit unique to
   each — only on collision, so unique names stay clean — is deterministic and
   does not reintroduce the `##k` suffix.

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

None of these is broken today; each one gates part of the design above and has to
exist before that part can ship.

### 11.1 Patch boundaries are not detectable from the data

Set 18 has not had a patch yet, so nothing is broken today — but the mechanism to
detect one does not exist. Riot reports
`game_version = "TFT Unreal Version ?.?.?.?"` for **every** set-18 match, and all
19,519 of them resolve to one synthetic patch row, `18.0` labelled `Unversioned`.

So per-patch election (§7) cannot key on `game_version`. It needs a **date-keyed
patch calendar** — `released_at` filled in on `patches`, and `patch_id` resolved
by comparing `matches.game_datetime` against it — maintained by hand, because the
data does not carry the patch. Same seam as the known `game_version` ≠ official
TFT patch mismatch. Not urgent, but it has to exist before the first patch lands,
or that patch's boards get pooled with this one's.

### 11.2 Per-board tier is not stored

Cumulative tiers (§5.1) need the board's actual tier. `match_participants.rank_bucket`
holds only the coarse legacy label; the real tier lives in `accounts.tier` for
crawled accounts and rides `MatchFetchJob.bucket` into `persistMatch`, which
downgrades it to a bucket on write. Needs: a `tier` column on
`match_participants` written from the same source, plus a decision about the
existing set-18 boards — backfillable only where the seed account's tier is still
known, and honest as `unknown` where it is not.

### 11.3 `master_plus` sample is thin, and crawl-limited

8,978 boards over 189 centroids is ~47 boards per line, and the profile *rates*
(the CORE/flex percentages) are estimated from that. Core units are safe; a "58%
flex" from 47 boards carries roughly ±14pp. The §5.4 floor handles the display
side, but the underlying constraint is that only 103 Master accounts have been
crawled. Re-run §4 and §5 once `master_plus` passes ~25k boards before fixing the
defaults.

---

## 12. What this deletes

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

## 13. Validation path

The 32 labelled pairs in `scripts/merge-eval-pairs.json` (25 `merge`, 7 `split`)
reference 52 comp ids — **all 52 are set 17**, and all still exist, as do
**515,010 set-17 boards**. That is a real regression corpus with human labels.

1. Build the new model as a pure module (`comp-centroid.ts`) with unit tests, the
   way `comp-signature.ts` is tested — seeding, scoring, convergence, collapse and
   naming are all pure functions.
2. Run it over the set-17 boards offline. For each labelled pair, check whether
   the two comps' boards land in the same centroid. Any disagreement is a finding
   about either the model or the label.
3. Run it over set 18 offline and eyeball the lines and their generated names
   against the game.
4. Resolve §11.1 and §11.2 — a patch calendar and a per-board tier column.
5. Write into new tables behind the existing chain, with the old clustering still
   populating the live read path.
6. Cut the read plane over once the numbers are inspected side by side.

Steps 1–3 are read-only and safe against the live database.

---

## 14. Risks

- **It is a full re-cluster.** Every comp id, every `/comps/[key]` URL and every
  `comp_stats` row is rebuilt. The staged path exists so this happens once.
- **The 32 pairs are set-17 semantics.** Passing them proves the model is not
  worse than today on cases someone already looked at; it does not prove it is
  right on set 18.
- **The whole model now rests on `master_plus`.** If the crawl loses apex seeds,
  the centroid set degrades and everything downstream degrades with it. The
  election should refuse to run below a minimum `master_plus` board count rather
  than quietly electing from noise.
- **Cost is fine:** 36,190 unit-sets × ~300 profiles ≈ 11M set operations per
  iteration, ~10 iterations. Seconds, and it scales with distinct unit-sets × k
  rather than with total boards.
