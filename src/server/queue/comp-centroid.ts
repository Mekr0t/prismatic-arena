// comp-centroid.ts — line identity as a presence profile (rebuild).
//
// A LINE is not a board. It is a map from unit → the rate at which that unit
// appears on boards of that line, and a board belongs to whichever line it most
// resembles. This replaces both halves of the old model: the exact-unit-multiset
// signature (comp-signature.ts) and the greedy archetype merge that ran after it
// (comp-merge.ts).
//
// Why the change, in one measurement (set 18, 2026-09-02). Under exact-multiset
// identity, a line's headline row is the biggest exact unit-set inside it — and
// that tracks BOARD SIZE, which tracks placement. In iron_gold the modal board
// is the finished 8–9 unit one, so headline top-4 read +13 to +24pp HIGH; in
// master_plus the modal board is the 7-unit board of a player who died at level
// 7, so the same lines read 23–48pp LOW. Same code, opposite lie. No merge
// threshold can fix that, because the bias is in the identity rule.
//
// Two properties are load-bearing and easy to lose:
//
//   1. ASSIGNMENT IS ORDER-INDEPENDENT. Every board is scored against the same
//      frozen set of profiles, so arrival order cannot change the answer. The
//      old merge needed a three-block ordering, a fold pass AND a refinement
//      sweep purely to patch order effects; none of that can recur here.
//   2. OVER-SEEDING IS SAFE. Convergence collapses profiles that land on the
//      same core, so k is not a tuning knob — seed high and let the data say how
//      many lines exist. Measured: 300 seeds converge to 189 lines on 8,978
//      master_plus boards, and to 106 on 76,132 iron_gold boards.
//
// No DB access, no set knowledge. Static trait/unit facts arrive as arguments,
// the way carry-classify.ts takes its per-set knowledge from the caller.

const num = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** Distinct unit-sets taken as seeds, before convergence collapses them. High on
 *  purpose: step 4 of convergence dissolves redundancy, so this is a ceiling on
 *  work rather than a guess at the number of lines. */
export const SEED_COUNT = num(process.env.CENTROID_SEED_COUNT, 300);

/** Two profiles closer than this (Jaccard over their cores) are the same line.
 *  Used twice: to reject a redundant seed, and to collapse converged profiles.
 *  Measured — at 0.70 the four `Monolith Malphite Ahri` lookalikes sit at
 *  0.29–0.57 and correctly stay apart. */
export const MIN_SEPARATION = num(process.env.CENTROID_MIN_SEPARATION, 0.7);

/** A board scoring below this against every profile is OFF-META and joins no
 *  line. Deliberately not lowered to absorb the tail: off-meta boards average
 *  5.10 placement against 4.33 for homed ones, so forcing them into the nearest
 *  line would import that average into the line's stats. */
export const ASSIGN_BAR = num(process.env.CENTROID_ASSIGN_BAR, 0.45);

/** Units appearing on fewer than this share of a line's boards are dropped from
 *  its profile — below it a unit is somebody's one-off, not part of the line. */
export const PROFILE_MIN_RATE = num(process.env.CENTROID_PROFILE_MIN_RATE, 0.15);

/** A unit at or above this rate is CORE: the line is not itself without it.
 *  Everything between this and PROFILE_MIN_RATE is a flex slot, which is the
 *  statement the old model could not make (it either merged a 58% unit in or
 *  split it off, and both were wrong). */
export const CORE_RATE = num(process.env.CENTROID_CORE_RATE, 0.8);

/** Backstop so a pathological input cannot spin the worker. Set above what the
 *  data needs: master_plus settles at 26 iterations, and a cap of 15 silently
 *  returned a half-settled election (197 lines instead of 192) that looked like
 *  a converged one. */
export const MAX_ITERATIONS = num(process.env.CENTROID_MAX_ITERATIONS, 60);

// ── inputs ───────────────────────────────────────────────────────────────────

/** One board, reduced to the units that decide identity. The caller has already
 *  filtered to real (cost 1–5) units and dropped short boards — identity is
 *  units only, so stars, items and emblems are deliberately absent. */
export interface CentroidBoard {
  units: readonly string[];
  /** Boards represented, for callers passing pre-grouped unit-sets. Default 1. */
  weight?: number;
}

/** A distinct unit-set and how many boards played it. Assignment runs per GROUP,
 *  not per board: 76,132 iron_gold boards are only 36,190 distinct unit-sets, so
 *  grouping first is a ~2x saving that costs nothing in accuracy. */
export interface BoardGroup {
  units: readonly string[];
  set: ReadonlySet<string>;
  boards: number;
}

export interface UnitRate {
  characterId: string;
  rate: number;
}

export interface Centroid {
  /** Index into the returned array. Stable within a run, NOT across runs — the
   *  caller owns durable ids and matches profiles onto them by core Jaccard. */
  index: number;
  /** Unit → appearance rate, sorted by rate desc then id, so a profile has one
   *  canonical rendering and two runs on the same data compare byte-for-byte. */
  units: UnitRate[];
  boards: number;
}

export interface ConvergeResult {
  centroids: Centroid[];
  /** Iterations actually run, for logging — convergence is data-dependent. */
  iterations: number;
  /** Boards that cleared ASSIGN_BAR against some profile. */
  homedBoards: number;
  totalBoards: number;
}

// ── grouping and similarity ──────────────────────────────────────────────────

/** Canonical key for a unit-set. Sorted, so unit order never matters. */
export function boardKey(units: readonly string[]): string {
  return [...new Set(units)].sort().join('|');
}

export function groupBoards(boards: readonly CentroidBoard[]): BoardGroup[] {
  const byKey = new Map<string, { units: string[]; set: Set<string>; boards: number }>();
  for (const b of boards) {
    const units = [...new Set(b.units)].sort();
    const key = units.join('|');
    const w = b.weight ?? 1;
    const hit = byKey.get(key);
    if (hit) hit.boards += w;
    else byKey.set(key, { units, set: new Set(units), boards: w });
  }
  // Volume-descending, id-tiebroken: seeding walks this order, so it must be
  // total. Ties broken on the key keep the election reproducible when two
  // unit-sets have identical board counts.
  return [...byKey.entries()]
    .sort((a, b) => b[1].boards - a[1].boards || (a[0] < b[0] ? -1 : 1))
    .map(([, v]) => v);
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  // Iterate the smaller side; the sets are board-sized, but this runs
  // groups × centroids times per iteration.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Weighted Jaccard of a board (a binary unit set) against a profile (rates):
 *
 *     Σ p_u for u ∈ board  /  ( |board| + Σ p_u for u ∉ board )
 *
 * A unit the line always fields contributes its full weight when present and
 * costs full weight when missing; a 40% flex unit costs almost nothing either
 * way. That is what lets a board that missed one unit stay in its line instead
 * of spawning a row.
 */
export function profileScore(board: ReadonlySet<string>, profile: readonly UnitRate[]): number {
  let inter = 0;
  let union = board.size;
  for (const { characterId, rate } of profile) {
    if (board.has(characterId)) inter += rate;
    else union += rate;
  }
  return union === 0 ? 0 : inter / union;
}

/** The units that make the line what it is (rate ≥ CORE_RATE). */
export function coreUnits(centroid: Centroid, at: number = CORE_RATE): Set<string> {
  const out = new Set<string>();
  for (const { characterId, rate } of centroid.units) if (rate >= at) out.add(characterId);
  return out;
}

// ── election ─────────────────────────────────────────────────────────────────

export interface ConvergeOptions {
  seedCount?: number;
  minSeparation?: number;
  assignBar?: number;
  profileMinRate?: number;
  maxIterations?: number;
}

const sortRates = (units: UnitRate[]): UnitRate[] =>
  units.sort((a, b) => b.rate - a.rate || (a.characterId < b.characterId ? -1 : 1));

/**
 * Seed profiles: walk unit-sets by volume, taking one only when it is at least
 * MIN_SEPARATION away from every seed already taken.
 *
 * The separation check is the whole point. Naively taking the top 60 by volume
 * gave 88 PAIRS at Jaccard ≥ 0.70 — sixty slots spent on nested variants of a
 * handful of lines, covering only 23% of boards, while real but less-played
 * lines got no seed at all.
 */
export function seedProfiles(groups: readonly BoardGroup[], opts: ConvergeOptions = {}): UnitRate[][] {
  const count = opts.seedCount ?? SEED_COUNT;
  const sep = opts.minSeparation ?? MIN_SEPARATION;
  const seeds: { set: Set<string>; units: readonly string[] }[] = [];
  for (const g of groups) {
    if (seeds.length >= count) break;
    if (seeds.every((s) => jaccard(s.set, g.set) < sep)) seeds.push({ set: new Set(g.set), units: g.units });
  }
  // A seed starts as its own board at rate 1; the first recompute replaces this
  // with the real distribution over everything that homed to it.
  return seeds.map((s) => s.units.map((characterId) => ({ characterId, rate: 1 })));
}

/** Best profile for a unit-set, or null when nothing clears the bar. */
export function bestProfile(
  set: ReadonlySet<string>,
  profiles: readonly (readonly UnitRate[])[],
  bar: number = ASSIGN_BAR,
): { index: number; score: number } | null {
  let best = -1;
  let bestScore = 0;
  for (let i = 0; i < profiles.length; i++) {
    const s = profileScore(set, profiles[i]);
    if (s > bestScore) {
      bestScore = s;
      best = i;
    }
  }
  return best >= 0 && bestScore >= bar ? { index: best, score: bestScore } : null;
}

/**
 * Elect the lines: seed, then iterate assign → recompute rates → collapse, until
 * the profile count stops moving.
 *
 * Collapse is what makes seed count a non-knob. Two seeds that were 0.65 apart
 * as boards converge onto the same core once they own their members, and the
 * separation check then merges them. Measured: 60 seeds settle to 54, 300 to 189
 * — and pushing the seed count higher lands on the same lines, just sooner.
 */
export function convergeCentroids(groups: readonly BoardGroup[], opts: ConvergeOptions = {}): ConvergeResult {
  const sep = opts.minSeparation ?? MIN_SEPARATION;
  const bar = opts.assignBar ?? ASSIGN_BAR;
  const minRate = opts.profileMinRate ?? PROFILE_MIN_RATE;
  const maxIter = opts.maxIterations ?? MAX_ITERATIONS;

  const totalBoards = groups.reduce((a, g) => a + g.boards, 0);
  let profiles: UnitRate[][] = seedProfiles(groups, opts);
  let homedBoards = 0;
  let iterations = 0;
  let lastSignature = '';

  for (let iter = 0; iter < maxIter; iter++) {
    iterations = iter + 1;

    const members: BoardGroup[][] = profiles.map(() => []);
    homedBoards = 0;
    for (const g of groups) {
      const hit = bestProfile(g.set, profiles, bar);
      if (!hit) continue;
      members[hit.index].push(g);
      homedBoards += g.boards;
    }

    // Recompute each profile from its members, board-weighted so a 400-board
    // unit-set outvotes a 1-board one. Empty profiles disappear here.
    const recomputed: UnitRate[][] = [];
    for (let i = 0; i < profiles.length; i++) {
      const mine = members[i];
      if (mine.length === 0) continue;
      const total = mine.reduce((a, g) => a + g.boards, 0);
      const tally = new Map<string, number>();
      for (const g of mine) for (const u of g.units) tally.set(u, (tally.get(u) ?? 0) + g.boards);
      const next: UnitRate[] = [];
      for (const [characterId, n] of tally) {
        const rate = n / total;
        if (rate >= minRate) next.push({ characterId, rate });
      }
      if (next.length > 0) recomputed.push(sortRates(next));
    }

    // Collapse: keep the first profile of each converged core. `recomputed` is
    // in seed order, which is volume order, so the survivor of a collapse is the
    // more-played line — not an arbitrary one.
    const collapsed: UnitRate[][] = [];
    const collapsedCores: Set<string>[] = [];
    for (const p of recomputed) {
      const core = new Set<string>();
      for (const { characterId, rate } of p) if (rate >= 0.5) core.add(characterId);
      if (collapsedCores.some((c) => jaccard(core, c) >= sep)) continue;
      collapsed.push(p);
      collapsedCores.push(core);
    }

    // Stability is compared on the CORES, not on the profile count. Counting
    // alone reports "stable" whenever two different configurations happen to
    // have the same length, and it also misses the opposite case — a set that is
    // genuinely settled but oscillating one member between two lines. Comparing
    // cores caught master_plus running to the iteration cap instead of settling.
    const signature = collapsedCores
      .map((c) => [...c].sort().join(','))
      .sort()
      .join('|');
    profiles = collapsed;
    if (signature === lastSignature) break;
    lastSignature = signature;
  }

  // Final assignment against the settled profiles, for the board counts.
  const finalCounts = profiles.map(() => 0);
  homedBoards = 0;
  for (const g of groups) {
    const hit = bestProfile(g.set, profiles, bar);
    if (!hit) continue;
    finalCounts[hit.index] += g.boards;
    homedBoards += g.boards;
  }

  const centroids: Centroid[] = profiles
    .map((units, i) => ({ index: i, units, boards: finalCounts[i] }))
    .filter((c) => c.boards > 0)
    .sort((a, b) => b.boards - a.boards || a.index - b.index)
    .map((c, i) => ({ ...c, index: i }));

  return { centroids, iterations, homedBoards, totalBoards };
}

/** Assign one board against frozen centroids. This is the read path: lower-rank
 *  boards are assigned into master-elected centroids and never move them. */
export function assignBoard(
  units: readonly string[],
  centroids: readonly Centroid[],
  bar: number = ASSIGN_BAR,
): { index: number; score: number } | null {
  return bestProfile(new Set(units), centroids.map((c) => c.units), bar);
}

// ── which lines to list ──────────────────────────────────────────────────────

/** Share of the bucket's boards the listed lines should account for. A COVERAGE
 *  target rather than a fixed count, because a fixed count lists 20 lines on day
 *  one of a patch and 200 by the end of it: coverage keys on the shape of the
 *  distribution, which barely moves, so the list stays the same length as the
 *  patch fills. */
export const LIST_COVERAGE = num(process.env.CENTROID_LIST_COVERAGE, 0.8);

/** Safety floor under the coverage target, so a near-empty early-patch bucket
 *  does not list lines with three boards just because they are the biggest. */
export const LIST_MIN_BOARDS = num(process.env.CENTROID_LIST_MIN_BOARDS, 20);

export function listableCentroids(
  centroids: readonly Centroid[],
  coverage: number = LIST_COVERAGE,
  minBoards: number = LIST_MIN_BOARDS,
): Centroid[] {
  const total = centroids.reduce((a, c) => a + c.boards, 0);
  if (total === 0) return [];
  const target = total * coverage;
  const out: Centroid[] = [];
  let acc = 0;
  for (const c of [...centroids].sort((a, b) => b.boards - a.boards)) {
    if (c.boards < minBoards) break;
    out.push(c);
    acc += c.boards;
    if (acc >= target) break;
  }
  return out;
}

// ── naming ───────────────────────────────────────────────────────────────────

export interface TraitBreakpoint {
  style: number;
  minUnits: number;
}

/** Per-set static facts the namer needs. Passed in, never looked up — this
 *  module stays set-agnostic (same contract as carry-classify.ts). */
export interface NameStatics {
  /** character id → trait ids. */
  unitTraits: ReadonlyMap<string, readonly string[]>;
  /** character id → display name. */
  unitNames: ReadonlyMap<string, string>;
  /** trait id → display name. */
  traitNames: ReadonlyMap<string, string>;
  /** trait id → breakpoints, any order. */
  traitBreakpoints: ReadonlyMap<string, readonly TraitBreakpoint[]>;
  /** character id → cost, for the collision tiebreak. */
  unitCosts?: ReadonlyMap<string, number>;
}

/**
 * A UNIQUE (marker) trait is one whose only breakpoint activates at a single
 * unit — Monolith, Lux's, Alune's. It is a property of a champion, not a
 * direction the board committed to, and it is worthless as a name: every board
 * fielding Malphite "has" Monolith.
 *
 * It also outranks real traits if you let it. Monolith is a single style-4
 * breakpoint at 1 unit, so a naive highest-style pick named four different
 * Malphite lines "Monolith" while ignoring the 3–4 Executioner they were
 * actually playing. Same exclusion the merge stage's trait frame already makes.
 */
export function isMarkerTrait(breakpoints: readonly TraitBreakpoint[] | undefined): boolean {
  return !breakpoints || breakpoints.length === 0 || (breakpoints.length === 1 && breakpoints[0].minUnits <= 1);
}

/**
 * Expected count of each trait on a board of this line.
 *
 * Summing RATES, not counting core units. A line whose Executioners are one core
 * unit plus three flex ones is still an Executioner line, and counting only
 * units above CORE_RATE misses it — which is exactly how the Malphite lines
 * ended up named after a marker trait instead of their real vertical.
 */
export function traitCounts(centroid: Centroid, statics: NameStatics): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { characterId, rate } of centroid.units) {
    for (const t of statics.unitTraits.get(characterId) ?? []) {
      counts.set(t, (counts.get(t) ?? 0) + rate);
    }
  }
  return counts;
}

/**
 * The line's headline trait, or null when it has none worth naming.
 *
 * Highest breakpoint style wins; ties go to the breakpoint that needed more
 * units, so a 3/3 beats a 2/2 and (with marker traits already excluded) a real
 * vertical always beats a splash.
 */
export function headlineTrait(centroid: Centroid, statics: NameStatics): string | null {
  let best: { id: string; style: number; minUnits: number; count: number } | null = null;
  for (const [id, expected] of traitCounts(centroid, statics)) {
    const bps = statics.traitBreakpoints.get(id);
    if (isMarkerTrait(bps)) continue;
    const n = Math.round(expected);
    let reached: TraitBreakpoint | null = null;
    for (const b of [...bps!].sort((x, y) => x.minUnits - y.minUnits)) {
      if (n >= b.minUnits) reached = b;
    }
    if (!reached) continue;
    const cand = { id, style: reached.style, minUnits: reached.minUnits, count: expected };
    if (
      !best ||
      cand.style > best.style ||
      (cand.style === best.style && cand.minUnits > best.minUnits) ||
      (cand.style === best.style && cand.minUnits === best.minUnits && cand.count > best.count) ||
      (cand.style === best.style &&
        cand.minUnits === best.minUnits &&
        cand.count === best.count &&
        cand.id < best.id)
    ) {
      best = cand;
    }
  }
  return best ? (statics.traitNames.get(best.id) ?? best.id) : null;
}

/** How often each unit of a line was itemised, as a share of the boards that
 *  FIELDED it. The denominator matters: a 58% flex unit can never clear a rate
 *  bar measured against every board in the line, however consistently the people
 *  who play it build items on it. */
export interface ItemisationRate {
  characterId: string;
  /** boards where this unit carried items ÷ boards where it was fielded */
  rate: number;
  boards: number;
}

/**
 * The two units that carry the line, for the name.
 *
 * Candidates are CORE units only. Drawing from every unit let a 45%-rate Ahri
 * win a carry slot on 5 itemised boards out of 11 — beating two other units on a
 * tiebreak — and put her name on a line she is not part of.
 */
export function nameCarries(
  centroid: Centroid,
  itemisation: readonly ItemisationRate[],
  statics: NameStatics,
  limit = 2,
): string[] {
  const core = coreUnits(centroid);
  return itemisation
    .filter((i) => core.has(i.characterId))
    .sort((a, b) => b.rate - a.rate || b.boards - a.boards || (a.characterId < b.characterId ? -1 : 1))
    .slice(0, limit)
    .map((i) => statics.unitNames.get(i.characterId) ?? i.characterId);
}

/** `<trait> <carry> <carry>`, e.g. "Executioner Malphite Ahri". The trait is
 *  dropped when the line has none worth naming (never observed in set 18 — every
 *  elected line activates something — but a set with fewer traits could). */
export function nameCentroid(
  centroid: Centroid,
  itemisation: readonly ItemisationRate[],
  statics: NameStatics,
): string {
  const trait = headlineTrait(centroid, statics);
  return [trait, ...nameCarries(centroid, itemisation, statics)].filter(Boolean).join(' ');
}

/**
 * The unit that distinguishes one collider from the rest: something in its
 * profile that appears in no other collider's profile at all.
 *
 * CORE units are preferred and tie-broken on cost — a line is best identified by
 * an expensive unit it always fields. But the search must not STOP at the core,
 * because two lines can share an identical core and still be different lines:
 * measured on master_plus, two Aphelios/Brambleback lines had the same six core
 * units and sat 20pp apart on top-4 (51.3% against 31.6%), separated only by
 * their flex band — Zyra 74% / Taric 72% against Rakan 51% / Elise 35%. A
 * core-only search finds nothing there and leaves both lines sharing a name,
 * which is how a 744-board line and a 190-board one become indistinguishable in
 * a list. Falling through to the flex band names them Zyra and Elise.
 *
 * Null only when the profiles are genuinely indistinguishable, which convergence
 * should already have collapsed.
 */
function differentiatingUnit(
  mine: Centroid,
  others: readonly Centroid[],
  statics: NameStatics,
): string | null {
  const elsewhere = new Set<string>();
  for (const o of others) for (const u of o.units) elsewhere.add(u.characterId);
  const mineOnly = mine.units.filter((u) => !elsewhere.has(u.characterId));
  if (mineOnly.length === 0) return null;

  const core = mineOnly.filter((u) => u.rate >= CORE_RATE);
  if (core.length > 0) {
    return core.sort(
      (a, b) =>
        (statics.unitCosts?.get(b.characterId) ?? 0) - (statics.unitCosts?.get(a.characterId) ?? 0) ||
        (a.characterId < b.characterId ? -1 : 1),
    )[0].characterId;
  }
  // Flex band: rate first, because the point is to name the slot that actually
  // separates the two lines, and a rare expensive unit separates them less than
  // a common cheap one.
  return mineOnly.sort(
    (a, b) =>
      b.rate - a.rate ||
      (statics.unitCosts?.get(b.characterId) ?? 0) - (statics.unitCosts?.get(a.characterId) ?? 0) ||
      (a.characterId < b.characterId ? -1 : 1),
  )[0].characterId;
}

/**
 * Disambiguate lines that generated the same name.
 *
 * Colliding lines are genuinely different — the four `Malphite Ahri` lookalikes
 * sat at 0.29–0.57 core Jaccard, and one of them placed 1.9 better than another
 * — so the fix is to say what differs, not to merge them. Each collider appends
 * its distinguishing unit (see `differentiatingUnit`); that is deterministic from
 * the profiles alone, unlike the old `##k:<compId>` suffix, which churned
 * whenever membership was rebuilt and 404'd every shared link.
 *
 * Returns names positionally aligned with `centroids`.
 */
export function resolveNameCollisions(
  names: readonly string[],
  centroids: readonly Centroid[],
  statics: NameStatics,
): string[] {
  const byName = new Map<string, number[]>();
  names.forEach((n, i) => {
    const arr = byName.get(n);
    if (arr) arr.push(i);
    else byName.set(n, [i]);
  });

  const out = [...names];
  for (const [, idxs] of byName) {
    if (idxs.length < 2) continue;
    idxs.forEach((i, k) => {
      const others = idxs.filter((_, j) => j !== k).map((j) => centroids[j]);
      const pick = differentiatingUnit(centroids[i], others, statics);
      if (pick === null) return; // indistinguishable profiles: nothing honest to add
      out[i] = `${names[i]} ${statics.unitNames.get(pick) ?? pick}`;
    });
  }
  return out;
}
