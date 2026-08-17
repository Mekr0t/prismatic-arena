// comp-merge.ts — carry-archetype grouping for comps.
//
// Takes pre-built CompProfile records (one per exact-unit comp, built by
// comp-profile.ts from DB data + carry-classify) and groups them into carry
// archetypes using weighted unit-overlap + carry-overlap scoring.
//
// UNIVERSAL MERGE — the input mixes two evidence grades:
//   - floored comps (buildCompProfile): itemization evidence → real carries,
//     identity weights, hero-augment rates;
//   - presence comps (buildTailProfile, `carries` EMPTY): units + 3★ sets are
//     the whole evidence. They join via a carry-PRESENCE proxy (they must field
//     the archetype's dominant carries; same rule assignTail always used), pay
//     ASSIGN_MARGIN on the score bar when joining an evidence-rich archetype,
//     and may seed/join micro-archetypes with each other on unit overlap alone
//     — this is what lets a niche line fragmented across sub-floor hit-state
//     signatures consolidate at all (the old assign-only tail never could).
//
// SCALE — the universal input is tens of thousands of comps, and the naive
// loop (every comp × every archetype, derived sets rebuilt per comparison) is
// what made the early universal-merge attempt block the event loop until the
// BullMQ lock lapsed and the job "timed out". Three defenses, all
// semantics-neutral:
//   - each accumulator caches its derived profile (rep units, dominant sets),
//     invalidated on membership change, instead of rebuilding per comparison;
//   - a unit→archetype inverted index prunes candidates: an archetype sharing
//     too few units to possibly reach the jaccard floor is skipped without
//     scoring (provable bound — see UnitIndex);
//   - mergeComps is async and yields to the event loop every YIELD_EVERY
//     comps so worker locks renew (callers: worker stage, eval script, tests).
//
// Algorithm (three passes):
//   1. Greedy online grouping, most-populated comps first so archetypes are
//      anchored by the most-observed variant. Each comp joins the best-scoring
//      archetype AMONG THOSE THAT PASS every hard guard (a guard-failing
//      archetype is a different class — it must not veto joining a compatible
//      one just because it scores higher), else seeds a new archetype.
//   2. Fold pass: greedy ordering can strand a smaller archetype that, with its
//      full membership accumulated, now cleanly merges into a bigger one.
//      Each archetype's accumulated profile (smallest first) is compared
//      against the larger survivors under the exact same guards; fold on pass.
//   3. Labeling: two archetypes that stay separate can still produce the same
//      carry label. meta_comp IS the downstream grouping key (comps-service
//      pools stats by it), so a colliding label would silently re-merge what
//      the guards split — all but the biggest get a stable ##k:<anchorCompId>
//      disambiguator (label parsers ignore unknown ## segments).
//
// Similarity score = UNIT_WEIGHT * containment + JACCARD_WEIGHT * jaccard
//                  + CARRY_WEIGHT * carryOverlap
//
// Containment/jaccard are WEIGHTED: each unit counts by its identity weight
// (itemized carries / 3★ = 1, ordinary core ≈ 0.7, un-itemized 4/5-cost cap
// slots ≈ 0.25 — assigned in comp-profile.ts). Two boards that differ only in
// late-game cap units score as the same line (the "survivor effect": one board
// lived long enough to swap filler for legendaries), while disagreeing on
// carries still separates them.
//
// Hard-fail guards (independently configurable):
//   - grade3_conflict : conflict-only 3★ guard. Compares carry-grade 3★ sets
//                       (3★ units that are also itemized — an incidental 3★
//                       from augment copies doesn't count) and fails ONLY when
//                       both sides are non-empty and DISJOINT: rolling for
//                       different units (Jax reroll vs Fiora reroll) splits.
//                       A missed hit (subset), an extra hit (superset), or a
//                       different secondary hit (overlap) merges — hit-states
//                       of one line pool, so the line's stats include the
//                       boards that went for it and missed.
//   - copy_class      : duplicate-copy set must match (dup-copy augment boards
//                       stay a distinct archetype from classic single-copy ones)
//   - hero_augment    : hero-augment champ (if any) must match the archetype's
//                       dominant one (see carry-classify.ts) — a hero-augmented
//                       board never merges with a non-augment board
//   - carry_overlap   : carry overlap must be >= MIN_CARRY_OVERLAP
//   - containment     : weighted containment must be >= MIN_CONTAINMENT
//   - jaccard         : weighted jaccard must be >= MIN_JACCARD
//
// All thresholds are env-overridable.

const _n = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

const SCORE_THRESHOLD     = _n(process.env.MERGE_SCORE_THRESHOLD,     0.78);
const MIN_CONTAINMENT     = _n(process.env.MERGE_MIN_CONTAINMENT,     0.75);
const MIN_JACCARD         = _n(process.env.MERGE_MIN_JACCARD,         0.60);
const MIN_CARRY_OVERLAP   = _n(process.env.MERGE_MIN_CARRY_OVERLAP,   0.34);
const UNIT_WEIGHT         = _n(process.env.MERGE_UNIT_WEIGHT,         0.45);
const JACCARD_WEIGHT      = _n(process.env.MERGE_JACCARD_WEIGHT,      0.35);
const CARRY_WEIGHT        = _n(process.env.MERGE_CARRY_WEIGHT,        0.20);
const OPTIONAL_THRESHOLD  = _n(process.env.MERGE_OPTIONAL_THRESHOLD,  0.35);
const CARRY_DOMINANT_RATE = _n(process.env.MERGE_CARRY_DOMINANT_RATE, 0.40);
// Share of an archetype's HIT members (members with any carry-grade 3★) that
// must field a unit at carry-grade 3★ for it to count as the archetype's
// dominant hit. Denominator excludes no-hit members so pooling misses into the
// line can't erode the conflict guard.
const DUP_DOMINANT_RATE   = _n(process.env.MERGE_DUP_DOMINANT_RATE,   0.40);
// Extra score demanded of a carry-blind tail assignment (see assignTail) on
// top of SCORE_THRESHOLD — the tail has no itemization evidence, so the unit
// overlap has to work a little harder.
const ASSIGN_MARGIN       = _n(process.env.MERGE_ASSIGN_MARGIN,       0.02);
// Refinement sweep: how decisively another archetype must out-score a comp's
// own home before the comp moves (see the pass-3 comment in mergeComps). The
// margin is deliberately LARGE: the sweep exists to rescue misfits (own home
// fails guards, or an alternative wins by a mile), never to shuffle near-ties
// — collective near-tie moves repolarize elections and split lines that were
// fine (observed 2026-07-17: the Vex fast-9 line's two biggest members pulled
// into grade3-disjoint halves at margin 0.02).
const REFINE_MARGIN       = _n(process.env.MERGE_REFINE_MARGIN,       0.10);
// Trait-frame term. The frame is the board's active traits at their activation
// index (1 = first breakpoint, higher = deeper vertical), computed from static
// data by the merge stage; similarity is Σmin/Σmax over the union (weighted
// jaccard on activation vectors), or -1 when either side is unknown (the term
// stays neutral). A matching frame is what makes two boards "the same comp" to
// a human when the flex slots drift (the Dark Star pair at unit-jaccard 0.44,
// the Stargazer micro at 0.40 — user-ruled must-merges no unit threshold can
// reach): strong agreement buys jaccard + score slack. A near-disjoint frame
// is a hard guard — unit coincidence must not merge two different game plans.
const TRAIT_STRONG_SIM    = _n(process.env.MERGE_TRAIT_STRONG_SIM,    0.65);
const TRAIT_SLACK_JAC     = _n(process.env.MERGE_TRAIT_SLACK_JAC,     0.12);
const TRAIT_SLACK_SCORE   = _n(process.env.MERGE_TRAIT_SLACK_SCORE,   0.15);
const TRAIT_MIN_SIM       = _n(process.env.MERGE_TRAIT_MIN_SIM,       0.20);
// The grade3 conflict needs a real sample behind it: a comp below this board
// count carries anecdotal 3★ evidence (a level-9 board that incidentally hit a
// 1-cost trait bot must not hard-veto joining its line). Units/carries still
// gate such comps normally.
const GRADE3_MIN_N        = _n(process.env.MERGE_GRADE3_MIN_N,        10);
// Yield to the event loop every N comps (pass 1) / N archetypes (fold pass) so
// the BullMQ worker lock renews under a large universal-merge input.
const YIELD_EVERY         = _n(process.env.MERGE_YIELD_EVERY,         250);
// Strong carry agreement buys unit-overlap slack: two variants that agree on
// (nearly) all itemized carries are the same line even when their secondary
// units drift apart (e.g. the same Sona/LeBlanc/Leona core splashing Karma in
// one build and Nunu in the other). Applies to the score and jaccard bars
// only — hard class guards are never relaxed.
const STRONG_CARRY_OVERLAP = _n(process.env.MERGE_STRONG_CARRY_OVERLAP, 0.75);
const STRONG_CARRY_SLACK   = _n(process.env.MERGE_STRONG_CARRY_SLACK,   0.06);
// Three-zone hero-augment rule: a sig mismatch ('' vs champ X) is a REAL
// conflict only when the sig-less side is confidently augment-free for X —
// its damage-item rate for X at or below this floor. A mid-range rate just
// means the 0.5 detection threshold straddled one line (the Morde/Leona
// satellites: big line at rate ~0.25 vs its 21-board ##aug twin at 1.0),
// while a confidently-low side (the Lulu line's Jax at ~0.17) still splits.
const HERO_AUG_LOW         = _n(process.env.MERGE_HERO_AUG_LOW, 0.2);
// Board-level intent guard: two comps whose average final levels differ by at
// least this gap are different game plans (a level-7 reroll vs a level-9
// line), whatever their unit overlap says. Skipped when either side is
// unknown (avgLevel 0 — e.g. profiles built without level data).
const LEVEL_CONFLICT_GAP   = _n(process.env.MERGE_LEVEL_CONFLICT_GAP, 1.75);
const REQUIRE_CARRY       = process.env.MERGE_REQUIRE_CARRY      !== 'false';
// Conflict-only 3★ guard (see header). Set MERGE_REQUIRE_DUP_CLASS=false to
// disable entirely (any 3★ difference merges).
const REQUIRE_DUP_CLASS   = process.env.MERGE_REQUIRE_DUP_CLASS  !== 'false';
// Duplicate-copy augment: boards that run two copies of a unit (one 3-star, one
// lower) are a distinct archetype and must not merge with the classic single-copy
// build. On by default; set MERGE_REQUIRE_COPY_CLASS=false to disable.
const REQUIRE_COPY_CLASS  = process.env.MERGE_REQUIRE_COPY_CLASS !== 'false';
// Augment-gated units (Invader Zed): a board fielding one is a distinct class
// from the same board without it. On by default; MERGE_REQUIRE_GATED_CLASS=false
// to disable.
const REQUIRE_GATED_CLASS = process.env.MERGE_REQUIRE_GATED_CLASS !== 'false';
// Hero augment: a board running an active hero augment (3-star eligible tank
// + itemized as a second carry — see carry-classify.ts) is a distinct
// archetype from the same units without the augment, even when unit overlap
// otherwise looks identical. On by default; set
// MERGE_REQUIRE_HERO_AUGMENT_CLASS=false to disable.
const REQUIRE_HERO_AUGMENT_CLASS = process.env.MERGE_REQUIRE_HERO_AUGMENT_CLASS !== 'false';
// Emblem class guard — OFF by default. Emblem variants are split and folded at
// READ time (comps-service), grouping by the merge archetype (the "family") and
// sub-splitting by each comp's signature emblems, so emblem and non-emblem
// builds of one line MERGE here into a single archetype (a merge-level split
// gives them independent carry labels that can't be reliably reunited). Set
// MERGE_REQUIRE_EMBLEM_CLASS=true to restore the merge-level split.
const REQUIRE_EMBLEM_CLASS = process.env.MERGE_REQUIRE_EMBLEM_CLASS === 'true';

/** Weight assumed for units missing from CompProfile.unitWeights. */
const DEFAULT_UNIT_WEIGHT = 1;

// ── Public types ──────────────────────────────────────────────────────────────

/**
 * Per-comp profile, built by comp-profile.ts from DB data + carry-classify.
 * Because every board in a comp has the *exact* same unit set (cluster.ts
 * groups by identity), all units are at implicit frequency 1.0 within the comp.
 * Frequency accumulation happens at the archetype level across comps.
 */
export interface CompProfile {
  compId: number;
  setNumber: number;
  /** Distinct unit ids (copies collapsed) — used for overlap scoring. */
  units: Set<string>;
  /** Per-unit identity weight in (0..1] for overlap scoring. Units absent from
   *  the map count at DEFAULT_UNIT_WEIGHT (1). Assigned by comp-profile.ts:
   *  itemized carries / 3★ = 1, core ≈ 0.7, un-itemized 4/5-cost caps ≈ 0.25. */
  unitWeights: Map<string, number>;
  /** Carry units for overlap: isBucketCarry from carry-classify, with a
   *  top-itemized fallback for comps that never fully itemize (dead / missed
   *  boards) — see comp-profile.ts. */
  carries: Set<string>;
  /** Subset of `carries` with damage-flavored itemization (≥2 DAMAGE_ITEMS on
   *  enough boards — comp-profile.ts). Carry agreement compares THESE when both
   *  sides have them: an itemized tank/support (Sunfire Leona, Warmog Nunu) is
   *  a carry for labeling but not what the line builds around, and it's what
   *  drove same-line pairs to 1-of-3 carry overlap (< the 0.34 bar). Empty for
   *  tail profiles and for comps whose items never lean damage. */
  damageCarries: Set<string>;
  /** Carry-grade 3★ units: fielded at 3★ AND itemized (carry or reliably
   *  top-itemized). Incidental 3★s — augment copies landing on a unit nobody
   *  items — are excluded. Drives the conflict-only grade3 guard. */
  carryGrade3: Set<string>;
  /** Sorted character IDs that appear 2+ times on the board (duplicate-copy
   *  augment), pipe-joined; '' for a classic single-copy board. Used as the "copy
   *  class" guard — a board that doubles a unit shouldn't merge with one that
   *  doesn't, even when their distinct-unit sets overlap heavily. */
  copySig: string;
  /** Character ID of the champ carrying an active hero augment in this comp
   *  (see carry-classify.ts's classifyHeroAugments); '' if none. A board can
   *  only run one hero augment, so this is a single ID, not a joined list.
   *  Used as the "hero augment class" guard. */
  heroAugmentSig: string;
  /** Continuous damage-item rate per ELIGIBLE champ (3★ hero-augment champs),
   *  0..1 — the signal behind heroAugmentSig, kept so the guard can tell
   *  "confidently augment-free" (rate ≤ HERO_AUG_LOW) from "the detection
   *  threshold straddled this comp". Empty for tail profiles (no item data). */
  heroAugmentRates: Map<string, number>;
  /** Sorted worn trait-emblem item ids, pipe-joined; '' for a board with no
   *  emblem. Used as the "emblem class" guard — an emblem build (which can hit a
   *  trait breakpoint the plain build can't) stays a distinct archetype. */
  emblemSig: string;
  /** Sorted augment-gated units fielded (set 17: Invader Zed), pipe-joined;
   *  '' = none. Hard class guard — a board with an augment-only unit is a
   *  different game from the same board without it (user ruling 2026-07-17:
   *  "zed boards are special variants like emblem or dup"). Presence-based, so
   *  tail profiles carry it too. */
  gatedSig: string;
  /** Total boards in this comp, used as weight in archetype freq accumulation. */
  boardCount: number;
  /** Average final board level across this comp's ranked boards; 0 = unknown
   *  (level data unavailable). Drives the LEVEL_CONFLICT_GAP intent guard. */
  avgLevel: number;
  /** Active-trait frame: trait id → activation index (1 = first breakpoint,
   *  higher = deeper vertical). Empty = unknown; the trait term stays neutral.
   *  Built from static data by the merge stage (see buildTraitFrame). */
  traitFrame: Map<string, number>;
}

export interface MergeResult {
  /** compId → archetype label for every input comp. */
  assignments: Map<number, string>;
  /** archetype label → compIds in that archetype. */
  archetypes: Map<string, number[]>;
  /** Frozen post-merge archetype profiles keyed by final label — the input
   *  for `assignTail` (sub-floor tail labeling in the merge stage). */
  archetypeProfiles: Map<string, CompProfile>;
}

/** Verdict of comparing one comp against one archetype. `fails` lists every
 *  reason it can't join ('score' included) — empty ⇔ shouldMerge. */
export interface CompareResult {
  shouldMerge: boolean;
  score: number;
  containment: number;
  jaccard: number;
  carryOverlap: number;
  /** Trait-frame similarity (Σmin/Σmax over activation vectors); -1 = unknown. */
  traitSim: number;
  fails: string[];
}

// ── Internal accumulator ──────────────────────────────────────────────────────

/** Cached view of an accumulator's derived sets — rebuilt lazily after any
 *  membership change instead of per comparison (the per-comparison rebuild is
 *  what made large inputs O(n·k·units) with map churn). */
interface DerivedAcc {
  repUnits: Map<string, number>;
  /** Σ of repUnits weights — the `wb` side of weightedOverlap, and the prune
   *  bound input. */
  repWeightSum: number;
  domCarries: Set<string>;
  domDamageCarries: Set<string>;
  domGrade3: Set<string>;
  domCopy: string;
  domHeroAugment: string;
  domEmblem: string;
  domGated: string;
  /** Board-weighted average level; 0 = unknown. */
  archLevel: number;
  /** Board-weighted mean activation per trait; empty = unknown. */
  archFrame: Map<string, number>;
}

interface ArchetypeAcc {
  /** Lazily rebuilt derived profile; null after any membership change. */
  derived: DerivedAcc | null;
  /** Every unit ever posted to the candidate index for this acc (the index is
   *  append-only; this set keeps join/fold postings deduplicated). */
  indexedUnits: Set<string>;
  compIds: number[];
  setNumber: number;
  /** Unit → Σ boardCount (unnormalized; normalize by totalWeight for freq). */
  weightedFreq: Map<string, number>;
  /** Unit → Σ (identity weight × boardCount) — divided by weightedFreq gives
   *  the archetype-side identity weight for that unit. */
  weightAcc: Map<string, number>;
  totalWeight: number;
  /** Carry unit → Σ boardCount of members that have it (board-weighted: a
   *  15-board member must not out-vote a 900-board anchor in the election). */
  carryFreq: Map<string, number>;
  /** Damage-carry unit → Σ boardCount of members that have it (board-weighted,
   *  evidenceWeight denominator — mirrors carryFreq). */
  damageCarryFreq: Map<string, number>;
  /** Σ boardCount of members WITH itemization evidence (non-empty carries) —
   *  the denominator for carry-share and hero-rate math. Evidence-less
   *  (presence-profile) members must not dilute those elections: they carry no
   *  vote either way, exactly like no-hit members in the grade3 election. */
  evidenceWeight: number;
  totalComps: number;
  /** Unit → Σ boardCount of members with it at carry-grade 3★ (board-weighted,
   *  like carryFreq — a 4-board oddity must not out-vote a 900-board anchor). */
  grade3Freq: Map<string, number>;
  /** Σ boardCount of members with a non-empty carryGrade3 (the denominator for
   *  grade3Freq — no-hit members must not dilute the dominant-hit election). */
  grade3Members: number;
  /** copySig → count, for electing the dominant copy signature. */
  copySigCounts: Map<string, number>;
  /** heroAugmentSig → count, for electing the dominant hero-augment champ. */
  heroAugmentSigCounts: Map<string, number>;
  /** Champ → Σ (damage-item rate × boardCount) — divided by totalWeight gives
   *  the archetype-side rate for the three-zone hero guard (absent = 0).
   *  Deliberately diluted by ALL members: an eligible-only denominator was
   *  tried 2026-07-15 and false-merged the labeled Jax pair (a hit-shaped
   *  line's 3★ tank legitimately carries damage items — indistinguishable
   *  from the augment at this grain). */
  heroRateSums: Map<string, number>;
  /** emblemSig → count, for electing the dominant emblem signature. */
  emblemSigCounts: Map<string, number>;
  /** gatedSig → count, for electing the dominant gated-unit signature. */
  gatedSigCounts: Map<string, number>;
  /** Σ (avgLevel × boardCount) over members with a known level, and the
   *  matching Σ boardCount — the archetype's board-level intent. */
  levelSum: number;
  levelWeight: number;
  /** Trait → Σ (activation index × boardCount) over members with a known
   *  frame, and the matching Σ boardCount — divided, the archetype's mean
   *  activation per trait (a trait half the members run weighs half). */
  traitSums: Map<string, number>;
  traitWeight: number;
}

// ── Similarity helpers ────────────────────────────────────────────────────────

function unitWeight(comp: CompProfile, id: string): number {
  return comp.unitWeights.get(id) ?? DEFAULT_UNIT_WEIGHT;
}

/**
 * Weighted containment + jaccard between a comp's units and an archetype's
 * representative units. Each unit contributes its identity weight; a unit on
 * both sides contributes the average of the two weights to the intersection.
 * Empty-set conventions match the old unweighted versions: jaccard(∅,∅)=1,
 * containment with either side empty = 0.
 *
 * `repSum` is the precomputed Σ of `rep` weights (DerivedAcc.repWeightSum) —
 * passing it avoids re-summing the rep side on every comparison.
 */
function weightedOverlap(
  comp: CompProfile,
  rep: Map<string, number>,
  repSum?: number,
): { containment: number; jaccard: number } {
  let wa = 0;
  let inter = 0;
  for (const u of comp.units) {
    const w = unitWeight(comp, u);
    wa += w;
    const rw = rep.get(u);
    if (rw !== undefined) inter += (w + rw) / 2;
  }
  let wb = repSum ?? 0;
  if (repSum === undefined) for (const w of rep.values()) wb += w;

  if (wa === 0 && wb === 0) return { containment: 0, jaccard: 1 };
  if (wa === 0 || wb === 0) return { containment: 0, jaccard: 0 };

  const union = wa + wb - inter;
  return {
    containment: inter / Math.min(wa, wb),
    jaccard: union > 0 ? inter / union : 1,
  };
}

/** Σ of a comp's unit identity weights — the `wa` side of weightedOverlap,
 *  used by the candidate-prune bound. */
function unitWeightSum(comp: CompProfile): number {
  let wa = 0;
  for (const u of comp.units) wa += unitWeight(comp, u);
  return wa;
}

// ── Candidate index ───────────────────────────────────────────────────────────

// The most lenient jaccard bar any comparison can face (the strong-carry slack
// is the only relaxation). Every shared unit contributes at most (w+rw)/2 ≤ 1
// to the intersection, so jaccard = inter/(wa+wb−inter) ≥ J requires at least
// inter ≥ J/(1+J)·(wa+wb) — an archetype sharing fewer units than that bound
// can NEVER pass the jaccard guard and is skipped without scoring. If someone
// env-tunes the jaccard floor to ≤ 0 the bound proves nothing, so pruning
// disables itself and every archetype is scored (correct, just slower).
const JACCARD_FLOOR = MIN_JACCARD - STRONG_CARRY_SLACK;
const PRUNE_ENABLED = JACCARD_FLOOR > 0;
const PRUNE_COEF    = JACCARD_FLOOR / (1 + JACCARD_FLOOR);

/**
 * Append-only inverted index unit → member ids, for candidate pruning.
 * Members are archetype indices (pass 1 / fold) or frozen-profile indices
 * (tail assignment). `sharedCounts` returns every member sharing ≥ 1 unit
 * with the probe along with the shared-unit count; the caller applies the
 * PRUNE_COEF bound per member (the bound needs the member's rep weight sum).
 */
class UnitIndex {
  private postings = new Map<string, number[]>();

  post(id: number, units: Iterable<string>): void {
    for (const u of units) {
      const list = this.postings.get(u);
      if (list) list.push(id);
      else this.postings.set(u, [id]);
    }
  }

  sharedCounts(units: Iterable<string>): Map<number, number> {
    const counts = new Map<number, number>();
    for (const u of units) {
      const list = this.postings.get(u);
      if (!list) continue;
      for (const id of list) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }
}

/** True when `shared` common units can possibly reach the jaccard floor
 *  against sides weighing `wa` and `wb` (see PRUNE_COEF derivation). */
function canPassJaccard(shared: number, wa: number, wb: number): boolean {
  return shared >= PRUNE_COEF * (wa + wb) - 1e-9;
}

/** Trait-frame similarity: Σ(min·max)/Σ(max²) over the union of two
 *  activation vectors. Each trait weighs max² (a deep vertical dominates
 *  bronze-splash noise 9:1) but agreement within a trait is LINEAR (min/max):
 *  the same vertical at different depths — the 7→5 Meeple cap transition the
 *  user ruled same-line — scores 0.67 on that trait, not the 0.44 a fully
 *  quadratic form gave, while a vertical the other side lacks still scores 0.
 *  -1 when either side is unknown — the term is neutral. */
function traitSimilarity(
  a: ReadonlyMap<string, number>,
  b: ReadonlyMap<string, number>,
): number {
  if (a.size === 0 || b.size === 0) return -1;
  let agreeSum = 0;
  let weightSum = 0;
  for (const [t, av] of a) {
    const bv = b.get(t) ?? 0;
    const lo = Math.min(av, bv);
    const hi = Math.max(av, bv);
    agreeSum += lo * hi;
    weightSum += hi * hi;
  }
  for (const [t, bv] of b) if (!a.has(t)) weightSum += bv * bv;
  return weightSum > 0 ? agreeSum / weightSum : -1;
}

// ── Archetype-profile accessors ───────────────────────────────────────────────

/** Representative units (freq share >= OPTIONAL_THRESHOLD) → avg identity weight. */
function getRepUnits(acc: ArchetypeAcc): Map<string, number> {
  const units = new Map<string, number>();
  if (acc.totalWeight === 0) return units;
  for (const [id, w] of acc.weightedFreq) {
    if (w / acc.totalWeight >= OPTIONAL_THRESHOLD) {
      units.set(id, (acc.weightAcc.get(id) ?? w) / w);
    }
  }
  return units;
}

function getDomCarries(acc: ArchetypeAcc): Set<string> {
  const dom = new Set<string>();
  if (acc.evidenceWeight === 0) return dom;
  for (const [c, cnt] of acc.carryFreq) {
    if (cnt / acc.evidenceWeight >= CARRY_DOMINANT_RATE) dom.add(c);
  }
  if (dom.size > 0) return dom;
  // Fallback: most-frequent carry (ensures the label is non-empty when any
  // comp in the archetype had a carry at all).
  let best = '';
  let bestCnt = 0;
  for (const [c, cnt] of acc.carryFreq) {
    if (cnt > bestCnt) { bestCnt = cnt; best = c; }
  }
  if (best) dom.add(best);
  return dom;
}

/** Dominant DAMAGE carries — same election as getDomCarries but no single-best
 *  fallback: an empty set means "no damage identity" and carry agreement falls
 *  back to the full carry sets. */
function getDomDamageCarries(acc: ArchetypeAcc): Set<string> {
  const dom = new Set<string>();
  if (acc.evidenceWeight === 0) return dom;
  for (const [c, cnt] of acc.damageCarryFreq) {
    if (cnt / acc.evidenceWeight >= CARRY_DOMINANT_RATE) dom.add(c);
  }
  return dom;
}

/** Dominant carry-grade 3★ set, elected among HIT members only. */
function getDomGrade3(acc: ArchetypeAcc): Set<string> {
  const dom = new Set<string>();
  if (acc.grade3Members === 0) return dom;
  for (const [u, cnt] of acc.grade3Freq) {
    if (cnt / acc.grade3Members >= DUP_DOMINANT_RATE) dom.add(u);
  }
  return dom;
}

function electDominant(counts: Map<string, number>): string {
  let best = '';
  let bestCnt = 0;
  for (const [sig, cnt] of counts) {
    if (cnt > bestCnt) { bestCnt = cnt; best = sig; }
  }
  return best;
}

/** The acc's derived profile, rebuilt only after membership changes. */
function derivedOf(acc: ArchetypeAcc): DerivedAcc {
  if (acc.derived) return acc.derived;
  const repUnits = getRepUnits(acc);
  let repWeightSum = 0;
  for (const w of repUnits.values()) repWeightSum += w;
  acc.derived = {
    repUnits,
    repWeightSum,
    domCarries: getDomCarries(acc),
    domDamageCarries: getDomDamageCarries(acc),
    domGrade3: getDomGrade3(acc),
    domCopy: electDominant(acc.copySigCounts),
    domHeroAugment: electDominant(acc.heroAugmentSigCounts),
    domEmblem: electDominant(acc.emblemSigCounts),
    domGated: electDominant(acc.gatedSigCounts),
    archLevel: acc.levelWeight > 0 ? acc.levelSum / acc.levelWeight : 0,
    archFrame: getArchFrame(acc),
  };
  return acc.derived;
}

/** Board-weighted mean activation per trait; empty when no member has a frame. */
function getArchFrame(acc: ArchetypeAcc): Map<string, number> {
  const frame = new Map<string, number>();
  if (acc.traitWeight === 0) return frame;
  for (const [t, sum] of acc.traitSums) frame.set(t, sum / acc.traitWeight);
  return frame;
}

// ── Comparison ────────────────────────────────────────────────────────────────

function compareToArchetype(comp: CompProfile, acc: ArchetypeAcc): CompareResult {
  const d = derivedOf(acc);
  const { repUnits, domCarries, domGrade3, domCopy, domHeroAugment, domEmblem } = d;

  // An empty carry set means NO itemization evidence (buildTailProfile), not
  // "carries nothing" — buildCompProfile's fallback guarantees evidence-rich
  // comps a non-empty set. Evidence-less sides use the PRESENCE proxy that
  // assignTail always applied: the board must FIELD the other side's carries.
  //
  // DAMAGE-FIRST: when both sides have a damage-carry identity, agreement is
  // measured on THOSE — itemized tanks/supports (a carry for labeling) must
  // not dilute the overlap of the units the line actually builds around.
  // The PRESENCE proxies deliberately keep the FULL carry sets: an
  // evidence-less comp distinguishes itself by units alone, and narrowing its
  // proxy to 1-2 damage carries made the proxy trivially 1.0 (→ strong-carry
  // slack) for any board splashing the line's carry — observed live absorbing
  // the Stargazer Vex micro into the Stargazer Xayah line (2026-07-17).
  let carryOverlap: number;
  const domDamage = d.domDamageCarries;
  if (comp.damageCarries.size > 0 && domDamage.size > 0) {
    let inter = 0;
    for (const c of comp.damageCarries) if (domDamage.has(c)) inter++;
    if (inter === 0) {
      // Damage sets share nothing — fall back to the FULL carry sets before
      // splitting. Within one line the damage items drift across hit-variants
      // (a 195-board Akali-line member itemizing Kindred/Morgana instead of
      // Akali/Jax — observed live 2026-07-17); a hard damage-disjoint veto
      // split such variants off their own line. Genuinely different lines
      // disagree on the full sets too and still fail here.
      let full = 0;
      for (const c of comp.carries) if (domCarries.has(c)) full++;
      carryOverlap = full / Math.min(comp.carries.size, domCarries.size);
    } else {
      carryOverlap = inter / Math.min(comp.damageCarries.size, domDamage.size);
    }
  } else if (comp.carries.size === 0 && domCarries.size === 0) {
    carryOverlap = 1;
  } else if (comp.carries.size === 0) {
    // Restricted to carries the archetype itself fields — an off-board carrier
    // (e.g. an item-holding summon absent from unit signatures) proves nothing
    // by its absence from the comp.
    let checkable = 0;
    let present = 0;
    for (const c of domCarries) {
      if (!repUnits.has(c)) continue;
      checkable++;
      if (comp.units.has(c)) present++;
    }
    carryOverlap = checkable > 0 ? present / checkable : 1;
  } else if (domCarries.size === 0) {
    // Reverse proxy (evidence-less archetype side): its rep board must field
    // the comp's carries.
    let present = 0;
    for (const c of comp.carries) if (repUnits.has(c)) present++;
    carryOverlap = present / comp.carries.size;
  } else {
    let inter = 0;
    for (const c of comp.carries) if (domCarries.has(c)) inter++;
    carryOverlap = inter / Math.min(comp.carries.size, domCarries.size);
  }

  const { containment, jaccard } = weightedOverlap(comp, repUnits, d.repWeightSum);
  const score = UNIT_WEIGHT * containment + JACCARD_WEIGHT * jaccard + CARRY_WEIGHT * carryOverlap;

  const fails: string[] = [];
  // Conflict-only: fail iff both sides roll for hits and the hit sets share
  // nothing. Subset/superset/overlap all pass (missed or extra hits pool).
  // Small samples are exempt — their 3★ set is anecdote (GRADE3_MIN_N).
  if (
    REQUIRE_DUP_CLASS &&
    comp.carryGrade3.size > 0 &&
    domGrade3.size > 0 &&
    comp.boardCount >= GRADE3_MIN_N
  ) {
    let shared = 0;
    for (const u of comp.carryGrade3) if (domGrade3.has(u)) shared++;
    if (shared === 0) fails.push('grade3_conflict');
  }
  if (REQUIRE_COPY_CLASS && comp.copySig !== domCopy) fails.push('copy_class');
  // Three-zone hero-augment rule (see HERO_AUG_LOW). Two DIFFERENT champs
  // always conflict; a sig-vs-'' mismatch conflicts only when the sig-less
  // side is confidently augment-free for that champ. An unconditional
  // conflict-only version was tried 2026-07-15 and regressed the labeled Jax
  // pair; unconditional strict equality splintered the Morde/Leona satellites.
  if (REQUIRE_HERO_AUGMENT_CLASS && comp.heroAugmentSig !== domHeroAugment) {
    let conflict = true;
    if (comp.heroAugmentSig === '' && domHeroAugment !== '') {
      conflict = (comp.heroAugmentRates.get(domHeroAugment) ?? 0) <= HERO_AUG_LOW;
    } else if (comp.heroAugmentSig !== '' && domHeroAugment === '') {
      // Rate denominator = evidence weight only: presence-profile members have
      // no item data, so they can't testify to the champ being augment-free.
      const archRate =
        acc.evidenceWeight > 0
          ? (acc.heroRateSums.get(comp.heroAugmentSig) ?? 0) / acc.evidenceWeight
          : 0;
      conflict = archRate <= HERO_AUG_LOW;
    }
    if (conflict) fails.push('hero_augment');
  }
  // Board-level intent: a level-7 line and a level-9 line are different game
  // plans even when their unit sets overlap. Skipped when either side lacks
  // level data (avgLevel 0).
  if (
    comp.avgLevel > 0 &&
    d.archLevel > 0 &&
    Math.abs(comp.avgLevel - d.archLevel) >= LEVEL_CONFLICT_GAP
  ) {
    fails.push('level_gap');
  }
  if (REQUIRE_EMBLEM_CLASS && comp.emblemSig !== domEmblem) fails.push('emblem_class');
  // Augment-gated units: strict equality, like the copy class — a Zed board
  // and the same board without Zed are different games (Zed is augment-only).
  if (REQUIRE_GATED_CLASS && comp.gatedSig !== d.domGated) fails.push('gated_class');
  if (REQUIRE_CARRY && carryOverlap < MIN_CARRY_OVERLAP) fails.push('carry_overlap');
  // Trait frame: a near-disjoint frame hard-fails (unit coincidence must not
  // merge two game plans); strong agreement buys jaccard + score slack — the
  // human "same comp, different flex" signal (see the knob block). The slack
  // is EVIDENCE-RICH ONLY: an evidence-less comp shares its line's vertical by
  // construction (a Stargazer Vex board is mostly Stargazer units), so frame
  // agreement proves nothing about which line it is — trait slack absorbed the
  // Stargazer Vex micro into the Stargazer Xayah line the moment it landed
  // (2026-07-17), re-opening exactly the hole the full-set presence proxy had
  // closed. Weaker evidence gets stricter bars, never looser.
  const traitSim = traitSimilarity(comp.traitFrame, d.archFrame);
  if (traitSim >= 0 && traitSim < TRAIT_MIN_SIM) fails.push('trait_frame');
  const traitStrong = comp.carries.size > 0 && traitSim >= TRAIT_STRONG_SIM;
  const carrySlack = carryOverlap >= STRONG_CARRY_OVERLAP ? STRONG_CARRY_SLACK : 0;
  const slackJac = carrySlack + (traitStrong ? TRAIT_SLACK_JAC : 0);
  const slackScore = carrySlack + (traitStrong ? TRAIT_SLACK_SCORE : 0);
  // An evidence-less comp joining an evidence-rich archetype pays the same
  // margin assignTail charged: its carry agreement is presence-proxied, so the
  // unit overlap has to work a little harder. Evidence-less vs evidence-less
  // pays nothing — units ARE the whole evidence on both sides there.
  const margin = comp.carries.size === 0 && domCarries.size > 0 ? ASSIGN_MARGIN : 0;
  if (containment < MIN_CONTAINMENT) fails.push('containment');
  if (jaccard < MIN_JACCARD - slackJac) fails.push('jaccard');
  if (score < SCORE_THRESHOLD + margin - slackScore) fails.push('score');

  return {
    shouldMerge: fails.length === 0,
    score,
    containment,
    jaccard,
    carryOverlap,
    traitSim,
    fails,
  };
}

/**
 * Explain a pairwise comparison: score parts + failed guards of `a` against a
 * single-member archetype seeded by `b`. Debug/eval helper ("why don't these
 * two comps merge?") — the production path compares against accumulated
 * archetypes, but a pairwise verdict is what a human is usually asking about.
 */
export function debugCompare(a: CompProfile, b: CompProfile): CompareResult {
  const acc = makeAcc(b.setNumber);
  addToAcc(acc, b);
  return compareToArchetype(a, acc);
}

// ── Accumulator ops ───────────────────────────────────────────────────────────

function makeAcc(setNumber: number): ArchetypeAcc {
  return {
    derived: null,
    indexedUnits: new Set(),
    compIds: [],
    setNumber,
    weightedFreq: new Map(),
    weightAcc: new Map(),
    totalWeight: 0,
    carryFreq: new Map(),
    damageCarryFreq: new Map(),
    evidenceWeight: 0,
    totalComps: 0,
    grade3Freq: new Map(),
    grade3Members: 0,
    copySigCounts: new Map(),
    heroAugmentSigCounts: new Map(),
    heroRateSums: new Map(),
    emblemSigCounts: new Map(),
    gatedSigCounts: new Map(),
    levelSum: 0,
    levelWeight: 0,
    traitSums: new Map(),
    traitWeight: 0,
  };
}

function addToAcc(acc: ArchetypeAcc, comp: CompProfile): void {
  acc.derived = null; // membership changed — derived profile is stale
  acc.compIds.push(comp.compId);
  acc.totalComps += 1;
  const w = comp.boardCount > 0 ? comp.boardCount : 1;
  acc.totalWeight += w;
  for (const u of comp.units) {
    acc.weightedFreq.set(u, (acc.weightedFreq.get(u) ?? 0) + w);
    acc.weightAcc.set(u, (acc.weightAcc.get(u) ?? 0) + w * unitWeight(comp, u));
  }
  if (comp.carries.size > 0) {
    acc.evidenceWeight += w;
    for (const c of comp.carries) {
      acc.carryFreq.set(c, (acc.carryFreq.get(c) ?? 0) + w);
    }
    for (const c of comp.damageCarries) {
      acc.damageCarryFreq.set(c, (acc.damageCarryFreq.get(c) ?? 0) + w);
    }
  }
  if (comp.carryGrade3.size > 0) {
    acc.grade3Members += w;
    for (const u of comp.carryGrade3) {
      acc.grade3Freq.set(u, (acc.grade3Freq.get(u) ?? 0) + w);
    }
  }
  // Class-signature elections are BOARD-weighted, like every other election
  // here: under universal merge hundreds of tiny members join big lines, and
  // one-comp-one-vote let a handful of n=2 boards out-vote a 900-board anchor
  // (observed live: an archetype's ##aug label flipping from accumulated small
  // members, splitting it from its own line).
  acc.copySigCounts.set(comp.copySig, (acc.copySigCounts.get(comp.copySig) ?? 0) + w);
  acc.heroAugmentSigCounts.set(
    comp.heroAugmentSig,
    (acc.heroAugmentSigCounts.get(comp.heroAugmentSig) ?? 0) + w,
  );
  for (const [champ, rate] of comp.heroAugmentRates) {
    acc.heroRateSums.set(champ, (acc.heroRateSums.get(champ) ?? 0) + rate * w);
  }
  acc.emblemSigCounts.set(comp.emblemSig, (acc.emblemSigCounts.get(comp.emblemSig) ?? 0) + w);
  acc.gatedSigCounts.set(comp.gatedSig, (acc.gatedSigCounts.get(comp.gatedSig) ?? 0) + w);
  if (comp.avgLevel > 0) {
    acc.levelSum += comp.avgLevel * w;
    acc.levelWeight += w;
  }
  if (comp.traitFrame.size > 0) {
    acc.traitWeight += w;
    for (const [t, idx] of comp.traitFrame) {
      acc.traitSums.set(t, (acc.traitSums.get(t) ?? 0) + idx * w);
    }
  }
}

function mergeCounts(dst: Map<string, number>, src: Map<string, number>): void {
  for (const [k, v] of src) dst.set(k, (dst.get(k) ?? 0) + v);
}

/** Fold every aggregate of `src` into `dst` (fold pass). */
function mergeAccInto(dst: ArchetypeAcc, src: ArchetypeAcc): void {
  dst.derived = null; // membership changed — derived profile is stale
  dst.compIds.push(...src.compIds);
  dst.totalComps += src.totalComps;
  dst.totalWeight += src.totalWeight;
  mergeCounts(dst.weightedFreq, src.weightedFreq);
  mergeCounts(dst.weightAcc, src.weightAcc);
  mergeCounts(dst.carryFreq, src.carryFreq);
  mergeCounts(dst.damageCarryFreq, src.damageCarryFreq);
  dst.evidenceWeight += src.evidenceWeight;
  mergeCounts(dst.grade3Freq, src.grade3Freq);
  dst.grade3Members += src.grade3Members;
  mergeCounts(dst.copySigCounts, src.copySigCounts);
  mergeCounts(dst.heroAugmentSigCounts, src.heroAugmentSigCounts);
  mergeCounts(dst.heroRateSums, src.heroRateSums);
  mergeCounts(dst.emblemSigCounts, src.emblemSigCounts);
  mergeCounts(dst.gatedSigCounts, src.gatedSigCounts);
  dst.levelSum += src.levelSum;
  dst.levelWeight += src.levelWeight;
  mergeCounts(dst.traitSums, src.traitSums);
  dst.traitWeight += src.traitWeight;
}

/** An archetype's accumulated state viewed as a comparable profile (fold pass). */
function accProfile(acc: ArchetypeAcc): CompProfile {
  const rep = getRepUnits(acc);
  const heroAugmentRates = new Map<string, number>();
  if (acc.evidenceWeight > 0) {
    for (const [champ, sum] of acc.heroRateSums) {
      heroAugmentRates.set(champ, sum / acc.evidenceWeight);
    }
  }
  return {
    compId: acc.compIds[0] ?? -1,
    setNumber: acc.setNumber,
    units: new Set(rep.keys()),
    unitWeights: rep,
    carries: getDomCarries(acc),
    damageCarries: getDomDamageCarries(acc),
    carryGrade3: getDomGrade3(acc),
    copySig: electDominant(acc.copySigCounts),
    heroAugmentSig: electDominant(acc.heroAugmentSigCounts),
    heroAugmentRates,
    emblemSig: electDominant(acc.emblemSigCounts),
    gatedSig: electDominant(acc.gatedSigCounts),
    boardCount: acc.totalWeight,
    avgLevel: acc.levelWeight > 0 ? acc.levelSum / acc.levelWeight : 0,
    traitFrame: getArchFrame(acc),
  };
}

function archetypeLabel(acc: ArchetypeAcc): string {
  const dom = getDomCarries(acc);
  // Evidence-less (micro) archetypes have no carry election to label from —
  // fall back to the dominant 3★ set, which for the reroll lines that actually
  // fragment sub-floor IS the human name of the line ("Conduit Leona/Morde/Zoe").
  // Pass 3 disambiguates any collision with a real carry label via ##k.
  const fallback = dom.size === 0 ? getDomGrade3(acc) : dom;
  const base = [...fallback].sort().join('|') || 'no_carry';
  // A duplicate-copy-augment or hero-augment archetype is distinct from the
  // classic build even with identical carries. Because meta_comp IS this label
  // and every downstream reader groups on it, both classes must be encoded HERE.
  // Marker stays parseable:
  // "<carries>##dup:<doubled-ids>##aug:<champId>##emb:<emblem-item-ids>".
  const domCopy = electDominant(acc.copySigCounts);
  const domHeroAugment = electDominant(acc.heroAugmentSigCounts);
  const domGated = electDominant(acc.gatedSigCounts);
  let label = base;
  if (domCopy) label += `##dup:${domCopy}`;
  if (domHeroAugment) label += `##aug:${domHeroAugment}`;
  if (domGated) label += `##gate:${domGated}`;
  return label;
}

// ── Main ──────────────────────────────────────────────────────────────────────

/** Post the comp's not-yet-indexed units under acc index `idx`. */
function indexAccUnits(index: UnitIndex, idx: number, acc: ArchetypeAcc, units: Iterable<string>): void {
  const fresh: string[] = [];
  for (const u of units) {
    if (!acc.indexedUnits.has(u)) {
      acc.indexedUnits.add(u);
      fresh.push(u);
    }
  }
  if (fresh.length > 0) index.post(idx, fresh);
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Group comp profiles into carry archetypes.
 *
 * Comps are processed most-populated first so the most-observed variant anchors
 * each archetype. Each comp is assigned to the best-scoring archetype that
 * passes all hard-fail guards, or starts a new one; a fold pass then merges
 * archetypes that greedy ordering stranded, and colliding labels are
 * disambiguated (see file header).
 *
 * Async: yields to the event loop every YIELD_EVERY comparisons-owners so the
 * worker's job lock renews under universal-merge input sizes.
 *
 * @returns `assignments` (compId → label) and `archetypes` (label → compIds).
 *   A comp always appears in exactly one archetype.
 */
export async function mergeComps(profiles: CompProfile[]): Promise<MergeResult> {
  if (profiles.length === 0) {
    return { assignments: new Map(), archetypes: new Map(), archetypeProfiles: new Map() };
  }

  // THREE-BLOCK ordering: evidence-rich CLASSIC comps first, then evidence-rich
  // HERO-AUGMENT comps, then evidence-less presence profiles (boardCount desc
  // within each block).
  //   - Classic-before-hero keeps the hero elections DETERMINISTIC: a classic
  //     acc's hero-rate is pure-classic when hero-sig comps arrive, so the
  //     three-zone guard resolves both documented outcomes (the Jax-hero arch
  //     splits from the Lulu line at rate ~0.17 ≤ HERO_AUG_LOW; the Morde
  //     satellite pools into its mid-rate line at 0.247 > HERO_AUG_LOW).
  //     Hero comps joining early skewed heroRateSums and washed the ##aug
  //     election out to '' — observed live 2026-07-17 when damage-carry purity
  //     shifted the greedy trajectory and false-merged the labeled Jax pair.
  //   - Evidence-before-presence: during the evidence blocks no presence
  //     accumulator exists yet, so floored comps group exactly as the
  //     floored-only merge always did — without this, a floored board's own
  //     hit-state twins (identical units, score ~1.0) could siphon it away
  //     from its real line into a stranded micro-archetype.
  const evidenceRank = (p: CompProfile) =>
    p.carries.size === 0 ? 2 : p.heroAugmentSig !== '' ? 1 : 0;
  const sorted = [...profiles].sort(
    (a, b) =>
      evidenceRank(a) - evidenceRank(b) ||
      b.boardCount - a.boardCount ||
      a.compId - b.compId,
  );

  const accs: ArchetypeAcc[] = [];
  const index = new UnitIndex();

  // ── Pass 1: greedy assignment to the best guard-passing archetype. ──────────
  for (let n = 0; n < sorted.length; n++) {
    if (n > 0 && n % YIELD_EVERY === 0) await yieldToEventLoop();
    const comp = sorted[n];
    let bestIdx = -1;
    let bestScore = -Infinity;
    let bestEvidence = false;

    // Among guard-passing candidates an EVIDENCE-RICH archetype always beats
    // an evidence-less micro-archetype; score breaks ties within a class. A
    // sub-floor hit-variant's exact twins score ~1.0 (identical units) against
    // its real line's ~0.95 — pure best-score let the twins siphon such boards
    // out of their line into stranded micro-archetypes. Micro-archetypes are
    // the fallback for comps no line claims, not competitors to lines.
    const consider = (i: number, r: CompareResult): void => {
      if (!r.shouldMerge) return;
      const evidence = accs[i].evidenceWeight > 0;
      if (bestIdx >= 0 && bestEvidence && !evidence) return;
      const upgrade = evidence && !bestEvidence && bestIdx >= 0;
      if (upgrade || r.score > bestScore || bestIdx < 0) {
        bestScore    = r.score;
        bestIdx      = i;
        bestEvidence = evidence;
      }
    };

    if (PRUNE_ENABLED) {
      // Candidates: accs sharing enough units to possibly clear the jaccard
      // floor (see UnitIndex). Zero-shared accs can't pass containment either
      // way, so skipping non-candidates never changes the outcome.
      const wa = unitWeightSum(comp);
      for (const [i, shared] of index.sharedCounts(comp.units)) {
        if (accs[i].setNumber !== comp.setNumber) continue;
        if (!canPassJaccard(shared, wa, derivedOf(accs[i]).repWeightSum)) continue;
        consider(i, compareToArchetype(comp, accs[i]));
      }
    } else {
      for (let i = 0; i < accs.length; i++) {
        if (accs[i].setNumber !== comp.setNumber) continue;
        consider(i, compareToArchetype(comp, accs[i]));
      }
    }

    if (bestIdx >= 0) {
      addToAcc(accs[bestIdx], comp);
      indexAccUnits(index, bestIdx, accs[bestIdx], comp.units);
    } else {
      const acc = makeAcc(comp.setNumber);
      addToAcc(acc, comp);
      accs.push(acc);
      indexAccUnits(index, accs.length - 1, acc, comp.units);
    }
  }

  // ── Pass 2: fold stranded fragments into larger compatible archetypes. ──────
  const order = accs
    .map((_, i) => i)
    .sort((a, b) => accs[a].totalWeight - accs[b].totalWeight);
  const alive = accs.map(() => true);

  for (let n = 0; n < order.length; n++) {
    if (n > 0 && n % YIELD_EVERY === 0) await yieldToEventLoop();
    const i = order[n];
    if (!alive[i]) continue;
    const self = accProfile(accs[i]);
    let bestIdx = -1;
    let bestScore = -Infinity;

    const consider = (j: number, shared?: number): void => {
      if (j === i || !alive[j]) return;
      if (accs[j].setNumber !== accs[i].setNumber) return;
      if (accs[j].totalWeight < accs[i].totalWeight) return; // fold small → large only
      if (
        shared !== undefined &&
        !canPassJaccard(shared, derivedOf(accs[i]).repWeightSum, derivedOf(accs[j]).repWeightSum)
      ) {
        return;
      }
      const r = compareToArchetype(self, accs[j]);
      if (r.shouldMerge && r.score > bestScore) {
        bestScore = r.score;
        bestIdx   = j;
      }
    };

    if (PRUNE_ENABLED) {
      for (const [j, shared] of index.sharedCounts(self.units)) consider(j, shared);
    } else {
      for (let j = 0; j < accs.length; j++) consider(j);
    }

    if (bestIdx >= 0) {
      mergeAccInto(accs[bestIdx], accs[i]);
      indexAccUnits(index, bestIdx, accs[bestIdx], accs[i].indexedUnits);
      alive[i] = false;
    }
  }

  // ── Pass 3: single refinement sweep (greedy path-dependence correction). ────
  // A comp that legitimately passes several archetypes is claimed by whichever
  // looked best at ITS moment in the greedy order; near-twin comps processed
  // at different moments can land apart (observed live 2026-07-17: two
  // pairwise-0.96 Akali-line members split across two archetypes). Every comp
  // is re-scored against the POST-FOLD archetypes — frozen: all moves are
  // decided before any is applied, so the outcome is order-independent — and
  // moves when another archetype passes every guard with a strictly better
  // score than its own home (by REFINE_MARGIN; the home score includes the
  // comp itself, which already biases toward staying). A same-set
  // evidence-rich home is never abandoned for a micro-archetype (the same
  // preference pass 1 applies). Accumulators rebuild once afterwards —
  // accumulation is commutative sums, so rebuild order doesn't matter.
  const accIdxByComp = new Map<number, number>();
  for (let i = 0; i < accs.length; i++) {
    if (!alive[i]) continue;
    for (const id of accs[i].compIds) accIdxByComp.set(id, i);
  }
  const moves: Array<{ comp: CompProfile; from: number; to: number }> = [];
  for (let n = 0; n < sorted.length; n++) {
    if (n > 0 && n % YIELD_EVERY === 0) await yieldToEventLoop();
    const comp = sorted[n];
    const ownIdx = accIdxByComp.get(comp.compId);
    if (ownIdx === undefined) continue;
    const own = compareToArchetype(comp, accs[ownIdx]);
    let bestIdx = ownIdx;
    let bestScore = own.shouldMerge ? own.score + REFINE_MARGIN : -Infinity;
    let bestEvidence = accs[ownIdx].evidenceWeight > 0;

    const consider = (i: number, r: CompareResult): void => {
      if (!r.shouldMerge) return;
      const evidence = accs[i].evidenceWeight > 0;
      if (bestEvidence && !evidence) return;
      const upgrade = evidence && !bestEvidence;
      if (upgrade || r.score > bestScore) {
        bestScore    = r.score;
        bestIdx      = i;
        bestEvidence = evidence;
      }
    };

    if (PRUNE_ENABLED) {
      const wa = unitWeightSum(comp);
      for (const [i, shared] of index.sharedCounts(comp.units)) {
        if (i === ownIdx || !alive[i]) continue;
        if (accs[i].setNumber !== comp.setNumber) continue;
        if (!canPassJaccard(shared, wa, derivedOf(accs[i]).repWeightSum)) continue;
        consider(i, compareToArchetype(comp, accs[i]));
      }
    } else {
      for (let i = 0; i < accs.length; i++) {
        if (i === ownIdx || !alive[i]) continue;
        if (accs[i].setNumber !== comp.setNumber) continue;
        consider(i, compareToArchetype(comp, accs[i]));
      }
    }
    if (bestIdx !== ownIdx) moves.push({ comp, from: ownIdx, to: bestIdx });
  }
  if (moves.length > 0) {
    const byId = new Map(sorted.map((p) => [p.compId, p] as const));
    const membership = new Map<number, CompProfile[]>();
    for (let i = 0; i < accs.length; i++) {
      if (!alive[i]) continue;
      const members: CompProfile[] = [];
      for (const id of accs[i].compIds) {
        const p = byId.get(id);
        if (p) members.push(p);
      }
      membership.set(i, members);
    }
    for (const m of moves) {
      const from = membership.get(m.from);
      if (from) {
        const at = from.findIndex((p) => p.compId === m.comp.compId);
        if (at >= 0) from.splice(at, 1);
      }
      membership.get(m.to)?.push(m.comp);
    }
    for (const [i, members] of membership) {
      if (members.length === 0) {
        alive[i] = false;
        continue;
      }
      const fresh = makeAcc(accs[i].setNumber);
      for (const p of members) addToAcc(fresh, p);
      accs[i] = fresh;
    }
  }

  // ── Pass 4: labels, disambiguating collisions. ──────────────────────────────
  const byLabel = new Map<string, ArchetypeAcc[]>();
  for (let i = 0; i < accs.length; i++) {
    if (!alive[i]) continue;
    const label = archetypeLabel(accs[i]);
    const group = byLabel.get(label);
    if (group) group.push(accs[i]);
    else byLabel.set(label, [accs[i]]);
  }

  const assignments = new Map<number, string>();
  const archetypes  = new Map<string, number[]>();
  const archetypeProfiles = new Map<string, CompProfile>();

  for (const [label, group] of byLabel) {
    group.sort(
      (a, b) => b.totalWeight - a.totalWeight || (a.compIds[0] ?? 0) - (b.compIds[0] ?? 0),
    );
    for (let idx = 0; idx < group.length; idx++) {
      const acc = group[idx];
      const final = idx === 0 ? label : `${label}##k:${acc.compIds[0]}`;
      for (const compId of acc.compIds) assignments.set(compId, final);
      archetypes.set(final, [...acc.compIds]);
      archetypeProfiles.set(final, accProfile(acc));
    }
  }

  return { assignments, archetypes, archetypeProfiles };
}

// ── Tail assignment ───────────────────────────────────────────────────────────

/**
 * Assign-only labeling for sub-floor comps ("the tail"). Missed-hit boards
 * fragment across many exact signatures, so they disproportionately sit below
 * the merge sample floor — excluding them survivorship-tilts every archetype's
 * pooled stats. This labels them against the FROZEN post-merge profiles
 * (`MergeResult.archetypeProfiles`): it can never create an archetype or shift
 * one's profile, so a wrong null just leaves a comp unlabeled.
 *
 * A tail comp has no itemization data (fetching participant_units for tens of
 * thousands of tiny comps is what the merge floor exists to avoid), so:
 *   - carries are proxied by PRESENCE: the board must field the archetype's
 *     dominant carries (a missed-hit board still fields Lulu/Jax at 1–2★; a
 *     different line doesn't) — same MIN_CARRY_OVERLAP bar;
 *   - `comp.carryGrade3` should hold the comp's FULL 3★ set (itemization
 *     unknown); the conflict-only rule still applies;
 *   - `comp.heroAugmentSig` is '' — the tail only ever joins classic
 *     archetypes, never a hero-augment one;
 *   - the score bar is SCORE_THRESHOLD + MERGE_ASSIGN_MARGIN to offset the
 *     weaker carry evidence.
 *
 * @returns the best passing archetype label, or null to leave unlabeled.
 *
 * `candidateLabels` optionally restricts which archetypes are considered —
 * callers with many comps to assign should use `makeTailAssigner`, which
 * prefilters through the unit index instead of scanning every archetype per
 * comp. Semantics are identical either way.
 */
export function assignTail(
  comp: CompProfile,
  archetypes: ReadonlyMap<string, CompProfile>,
  candidateLabels?: Iterable<string>,
): string | null {
  let bestLabel: string | null = null;
  let bestScore = -Infinity;
  let bestEvidence = false;

  const labels = candidateLabels ?? archetypes.keys();
  for (const label of labels) {
    const arch = archetypes.get(label);
    if (!arch) continue;
    if (arch.setNumber !== comp.setNumber) continue;
    // Evidence-rich archetypes outrank micro-archetypes (same preference as
    // the main pass — see mergeComps): a singleton must not be siphoned into
    // a hit-state micro-archetype when a real line claims it.
    const evidence = arch.carries.size > 0;
    if (bestEvidence && !evidence) continue;

    // Carry proxy: containment of the archetype's dominant carries in the
    // board — restricted to carries the archetype itself fields in its UNIT
    // set. Off-board carriers (e.g. the Mecha summon holds the comp's items
    // but is excluded from unit signatures) prove nothing by their absence.
    // Full carry set on purpose — see the presence-proxy note in
    // compareToArchetype (a damage-narrowed proxy over-attracts).
    let carryOverlap = 1;
    let checkable = 0;
    let present = 0;
    for (const c of arch.carries) {
      if (!arch.units.has(c)) continue;
      checkable++;
      if (comp.units.has(c)) present++;
    }
    if (checkable > 0) carryOverlap = present / checkable;
    if (REQUIRE_CARRY && carryOverlap < MIN_CARRY_OVERLAP) continue;

    if (
      REQUIRE_DUP_CLASS &&
      comp.carryGrade3.size > 0 &&
      arch.carryGrade3.size > 0 &&
      comp.boardCount >= GRADE3_MIN_N
    ) {
      let shared = 0;
      for (const u of comp.carryGrade3) if (arch.carryGrade3.has(u)) shared++;
      if (shared === 0) continue;
    }
    if (REQUIRE_COPY_CLASS && comp.copySig !== arch.copySig) continue;
    if (REQUIRE_GATED_CLASS && comp.gatedSig !== arch.gatedSig) continue;
    // Same three-zone hero rule as the main pass. Tail profiles carry no
    // itemization, so their rates are empty (0 = confidently none) — a tail
    // board still never joins a hero-augment archetype.
    if (REQUIRE_HERO_AUGMENT_CLASS && comp.heroAugmentSig !== arch.heroAugmentSig) {
      let conflict = true;
      if (comp.heroAugmentSig === '' && arch.heroAugmentSig !== '') {
        conflict = (comp.heroAugmentRates.get(arch.heroAugmentSig) ?? 0) <= HERO_AUG_LOW;
      } else if (comp.heroAugmentSig !== '' && arch.heroAugmentSig === '') {
        conflict = (arch.heroAugmentRates.get(comp.heroAugmentSig) ?? 0) <= HERO_AUG_LOW;
      }
      if (conflict) continue;
    }
    if (REQUIRE_EMBLEM_CLASS && comp.emblemSig !== arch.emblemSig) continue;
    // Board-level intent gap (skipped when either side lacks level data).
    if (
      comp.avgLevel > 0 &&
      arch.avgLevel > 0 &&
      Math.abs(comp.avgLevel - arch.avgLevel) >= LEVEL_CONFLICT_GAP
    ) {
      continue;
    }

    // Strong carry agreement buys the same unit slack the main path grants
    // (jaccard + score bars only — containment and class guards never relax).
    // Tail profiles carry NEUTRAL unit weights (no itemization evidence), so a
    // couple of swapped cap units hit the jaccard at full weight; without this
    // slack a board that fields every carry the line demands — same doubles,
    // same 3★s — was left unlabeled over a hundredth of jaccard (the niche
    // "Space Groove Ornn Samira" case: jaccard 0.598 vs the 0.60 floor).
    // Trait frame: the near-disjoint GUARD applies, but no trait slack — tail
    // comps are evidence-less, and frame agreement proves nothing about which
    // line an evidence-less board is (see the slack note in compareToArchetype).
    const traitSim = traitSimilarity(comp.traitFrame, arch.traitFrame);
    if (traitSim >= 0 && traitSim < TRAIT_MIN_SIM) continue;
    const slack = carryOverlap >= STRONG_CARRY_OVERLAP ? STRONG_CARRY_SLACK : 0;

    const { containment, jaccard } = weightedOverlap(comp, arch.unitWeights);
    if (containment < MIN_CONTAINMENT || jaccard < MIN_JACCARD - slack) continue;

    const score = UNIT_WEIGHT * containment + JACCARD_WEIGHT * jaccard + CARRY_WEIGHT * carryOverlap;
    if (score < SCORE_THRESHOLD + ASSIGN_MARGIN - slack) continue;

    if ((evidence && !bestEvidence) || score > bestScore) {
      bestScore = score;
      bestLabel = label;
      bestEvidence = evidence;
    }
  }

  return bestLabel;
}

/**
 * Index-backed batch form of `assignTail` — builds the unit index over the
 * frozen archetype profiles ONCE, then each call prefilters to archetypes that
 * can possibly clear the jaccard floor (see UnitIndex). With universal merge
 * the archetype count is thousands, and the per-comp full scan across a
 * 100k-comp singleton tail is exactly the shape that used to starve the event
 * loop. Returns the same labels assignTail would.
 */
export function makeTailAssigner(
  archetypes: ReadonlyMap<string, CompProfile>,
): (comp: CompProfile) => string | null {
  if (!PRUNE_ENABLED) return (comp) => assignTail(comp, archetypes);

  const labels: string[] = [];
  const weightSums: number[] = [];
  const index = new UnitIndex();
  for (const [label, arch] of archetypes) {
    const id = labels.length;
    labels.push(label);
    weightSums.push(unitWeightSum(arch));
    index.post(id, arch.units);
  }

  return (comp) => {
    const wa = unitWeightSum(comp);
    const candidates: string[] = [];
    for (const [id, shared] of index.sharedCounts(comp.units)) {
      if (canPassJaccard(shared, wa, weightSums[id])) candidates.push(labels[id]);
    }
    if (candidates.length === 0) return null;
    return assignTail(comp, archetypes, candidates);
  };
}
