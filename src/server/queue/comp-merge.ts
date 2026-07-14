// comp-merge.ts — carry-archetype grouping for comps.
//
// Takes pre-built CompProfile records (one per exact-unit comp, built by
// comp-profile.ts from DB data + carry-classify) and groups them into carry
// archetypes using weighted unit-overlap + carry-overlap scoring.
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
// Strong carry agreement buys unit-overlap slack: two variants that agree on
// (nearly) all itemized carries are the same line even when their secondary
// units drift apart (e.g. the same Sona/LeBlanc/Leona core splashing Karma in
// one build and Nunu in the other). Applies to the score and jaccard bars
// only — hard class guards are never relaxed.
const STRONG_CARRY_OVERLAP = _n(process.env.MERGE_STRONG_CARRY_OVERLAP, 0.75);
const STRONG_CARRY_SLACK   = _n(process.env.MERGE_STRONG_CARRY_SLACK,   0.06);
const REQUIRE_CARRY       = process.env.MERGE_REQUIRE_CARRY      !== 'false';
// Conflict-only 3★ guard (see header). Set MERGE_REQUIRE_DUP_CLASS=false to
// disable entirely (any 3★ difference merges).
const REQUIRE_DUP_CLASS   = process.env.MERGE_REQUIRE_DUP_CLASS  !== 'false';
// Duplicate-copy augment: boards that run two copies of a unit (one 3-star, one
// lower) are a distinct archetype and must not merge with the classic single-copy
// build. On by default; set MERGE_REQUIRE_COPY_CLASS=false to disable.
const REQUIRE_COPY_CLASS  = process.env.MERGE_REQUIRE_COPY_CLASS !== 'false';
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
  /** Sorted worn trait-emblem item ids, pipe-joined; '' for a board with no
   *  emblem. Used as the "emblem class" guard — an emblem build (which can hit a
   *  trait breakpoint the plain build can't) stays a distinct archetype. */
  emblemSig: string;
  /** Total boards in this comp, used as weight in archetype freq accumulation. */
  boardCount: number;
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
  fails: string[];
}

// ── Internal accumulator ──────────────────────────────────────────────────────

interface ArchetypeAcc {
  compIds: number[];
  setNumber: number;
  /** Unit → Σ boardCount (unnormalized; normalize by totalWeight for freq). */
  weightedFreq: Map<string, number>;
  /** Unit → Σ (identity weight × boardCount) — divided by weightedFreq gives
   *  the archetype-side identity weight for that unit. */
  weightAcc: Map<string, number>;
  totalWeight: number;
  /** Carry unit → count of comps in this archetype that have it. */
  carryFreq: Map<string, number>;
  totalComps: number;
  /** Unit → count of members with it at carry-grade 3★. */
  grade3Freq: Map<string, number>;
  /** Members with a non-empty carryGrade3 (the denominator for grade3Freq —
   *  no-hit members must not dilute the dominant-hit election). */
  grade3Members: number;
  /** copySig → count, for electing the dominant copy signature. */
  copySigCounts: Map<string, number>;
  /** heroAugmentSig → count, for electing the dominant hero-augment champ. */
  heroAugmentSigCounts: Map<string, number>;
  /** emblemSig → count, for electing the dominant emblem signature. */
  emblemSigCounts: Map<string, number>;
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
 */
function weightedOverlap(
  comp: CompProfile,
  rep: Map<string, number>,
): { containment: number; jaccard: number } {
  let wa = 0;
  let inter = 0;
  for (const u of comp.units) {
    const w = unitWeight(comp, u);
    wa += w;
    const rw = rep.get(u);
    if (rw !== undefined) inter += (w + rw) / 2;
  }
  let wb = 0;
  for (const w of rep.values()) wb += w;

  if (wa === 0 && wb === 0) return { containment: 0, jaccard: 1 };
  if (wa === 0 || wb === 0) return { containment: 0, jaccard: 0 };

  const union = wa + wb - inter;
  return {
    containment: inter / Math.min(wa, wb),
    jaccard: union > 0 ? inter / union : 1,
  };
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
  if (acc.totalComps === 0) return dom;
  for (const [c, cnt] of acc.carryFreq) {
    if (cnt / acc.totalComps >= CARRY_DOMINANT_RATE) dom.add(c);
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

// ── Comparison ────────────────────────────────────────────────────────────────

function compareToArchetype(comp: CompProfile, acc: ArchetypeAcc): CompareResult {
  const repUnits   = getRepUnits(acc);
  const domCarries = getDomCarries(acc);
  const domGrade3  = getDomGrade3(acc);
  const domCopy    = electDominant(acc.copySigCounts);
  const domHeroAugment = electDominant(acc.heroAugmentSigCounts);
  const domEmblem  = electDominant(acc.emblemSigCounts);

  let carryOverlap: number;
  if (comp.carries.size === 0 && domCarries.size === 0) {
    carryOverlap = 1;
  } else if (comp.carries.size === 0 || domCarries.size === 0) {
    carryOverlap = 0;
  } else {
    let inter = 0;
    for (const c of comp.carries) if (domCarries.has(c)) inter++;
    carryOverlap = inter / Math.min(comp.carries.size, domCarries.size);
  }

  const { containment, jaccard } = weightedOverlap(comp, repUnits);
  const score = UNIT_WEIGHT * containment + JACCARD_WEIGHT * jaccard + CARRY_WEIGHT * carryOverlap;

  const fails: string[] = [];
  // Conflict-only: fail iff both sides roll for hits and the hit sets share
  // nothing. Subset/superset/overlap all pass (missed or extra hits pool).
  if (REQUIRE_DUP_CLASS && comp.carryGrade3.size > 0 && domGrade3.size > 0) {
    let shared = 0;
    for (const u of comp.carryGrade3) if (domGrade3.has(u)) shared++;
    if (shared === 0) fails.push('grade3_conflict');
  }
  if (REQUIRE_COPY_CLASS && comp.copySig !== domCopy) fails.push('copy_class');
  if (REQUIRE_HERO_AUGMENT_CLASS && comp.heroAugmentSig !== domHeroAugment) fails.push('hero_augment');
  if (REQUIRE_EMBLEM_CLASS && comp.emblemSig !== domEmblem) fails.push('emblem_class');
  if (REQUIRE_CARRY && carryOverlap < MIN_CARRY_OVERLAP) fails.push('carry_overlap');
  const slack = carryOverlap >= STRONG_CARRY_OVERLAP ? STRONG_CARRY_SLACK : 0;
  if (containment < MIN_CONTAINMENT) fails.push('containment');
  if (jaccard < MIN_JACCARD - slack) fails.push('jaccard');
  if (score < SCORE_THRESHOLD - slack) fails.push('score');

  return { shouldMerge: fails.length === 0, score, containment, jaccard, carryOverlap, fails };
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
    compIds: [],
    setNumber,
    weightedFreq: new Map(),
    weightAcc: new Map(),
    totalWeight: 0,
    carryFreq: new Map(),
    totalComps: 0,
    grade3Freq: new Map(),
    grade3Members: 0,
    copySigCounts: new Map(),
    heroAugmentSigCounts: new Map(),
    emblemSigCounts: new Map(),
  };
}

function addToAcc(acc: ArchetypeAcc, comp: CompProfile): void {
  acc.compIds.push(comp.compId);
  acc.totalComps += 1;
  const w = comp.boardCount > 0 ? comp.boardCount : 1;
  acc.totalWeight += w;
  for (const u of comp.units) {
    acc.weightedFreq.set(u, (acc.weightedFreq.get(u) ?? 0) + w);
    acc.weightAcc.set(u, (acc.weightAcc.get(u) ?? 0) + w * unitWeight(comp, u));
  }
  for (const c of comp.carries) {
    acc.carryFreq.set(c, (acc.carryFreq.get(c) ?? 0) + 1);
  }
  if (comp.carryGrade3.size > 0) {
    acc.grade3Members += 1;
    for (const u of comp.carryGrade3) {
      acc.grade3Freq.set(u, (acc.grade3Freq.get(u) ?? 0) + 1);
    }
  }
  acc.copySigCounts.set(comp.copySig, (acc.copySigCounts.get(comp.copySig) ?? 0) + 1);
  acc.heroAugmentSigCounts.set(
    comp.heroAugmentSig,
    (acc.heroAugmentSigCounts.get(comp.heroAugmentSig) ?? 0) + 1,
  );
  acc.emblemSigCounts.set(comp.emblemSig, (acc.emblemSigCounts.get(comp.emblemSig) ?? 0) + 1);
}

function mergeCounts(dst: Map<string, number>, src: Map<string, number>): void {
  for (const [k, v] of src) dst.set(k, (dst.get(k) ?? 0) + v);
}

/** Fold every aggregate of `src` into `dst` (fold pass). */
function mergeAccInto(dst: ArchetypeAcc, src: ArchetypeAcc): void {
  dst.compIds.push(...src.compIds);
  dst.totalComps += src.totalComps;
  dst.totalWeight += src.totalWeight;
  mergeCounts(dst.weightedFreq, src.weightedFreq);
  mergeCounts(dst.weightAcc, src.weightAcc);
  mergeCounts(dst.carryFreq, src.carryFreq);
  mergeCounts(dst.grade3Freq, src.grade3Freq);
  dst.grade3Members += src.grade3Members;
  mergeCounts(dst.copySigCounts, src.copySigCounts);
  mergeCounts(dst.heroAugmentSigCounts, src.heroAugmentSigCounts);
  mergeCounts(dst.emblemSigCounts, src.emblemSigCounts);
}

/** An archetype's accumulated state viewed as a comparable profile (fold pass). */
function accProfile(acc: ArchetypeAcc): CompProfile {
  const rep = getRepUnits(acc);
  return {
    compId: acc.compIds[0] ?? -1,
    setNumber: acc.setNumber,
    units: new Set(rep.keys()),
    unitWeights: rep,
    carries: getDomCarries(acc),
    carryGrade3: getDomGrade3(acc),
    copySig: electDominant(acc.copySigCounts),
    heroAugmentSig: electDominant(acc.heroAugmentSigCounts),
    emblemSig: electDominant(acc.emblemSigCounts),
    boardCount: acc.totalWeight,
  };
}

function archetypeLabel(acc: ArchetypeAcc): string {
  const dom = getDomCarries(acc);
  const base = [...dom].sort().join('|') || 'no_carry';
  // A duplicate-copy-augment or hero-augment archetype is distinct from the
  // classic build even with identical carries. Because meta_comp IS this label
  // and every downstream reader groups on it, both classes must be encoded HERE.
  // Marker stays parseable:
  // "<carries>##dup:<doubled-ids>##aug:<champId>##emb:<emblem-item-ids>".
  const domCopy = electDominant(acc.copySigCounts);
  const domHeroAugment = electDominant(acc.heroAugmentSigCounts);
  let label = base;
  if (domCopy) label += `##dup:${domCopy}`;
  if (domHeroAugment) label += `##aug:${domHeroAugment}`;
  return label;
}

// ── Main ──────────────────────────────────────────────────────────────────────

/**
 * Group comp profiles into carry archetypes.
 *
 * Comps are processed most-populated first so the most-observed variant anchors
 * each archetype. Each comp is assigned to the best-scoring archetype that
 * passes all hard-fail guards, or starts a new one; a fold pass then merges
 * archetypes that greedy ordering stranded, and colliding labels are
 * disambiguated (see file header).
 *
 * @returns `assignments` (compId → label) and `archetypes` (label → compIds).
 *   A comp always appears in exactly one archetype.
 */
export function mergeComps(profiles: CompProfile[]): MergeResult {
  if (profiles.length === 0) {
    return { assignments: new Map(), archetypes: new Map(), archetypeProfiles: new Map() };
  }

  const sorted = [...profiles].sort(
    (a, b) => b.boardCount - a.boardCount || a.compId - b.compId,
  );

  const accs: ArchetypeAcc[] = [];

  // ── Pass 1: greedy assignment to the best guard-passing archetype. ──────────
  for (const comp of sorted) {
    let bestIdx = -1;
    let bestScore = -Infinity;

    for (let i = 0; i < accs.length; i++) {
      if (accs[i].setNumber !== comp.setNumber) continue;
      const r = compareToArchetype(comp, accs[i]);
      if (r.shouldMerge && r.score > bestScore) {
        bestScore = r.score;
        bestIdx   = i;
      }
    }

    if (bestIdx >= 0) {
      addToAcc(accs[bestIdx], comp);
    } else {
      const acc = makeAcc(comp.setNumber);
      addToAcc(acc, comp);
      accs.push(acc);
    }
  }

  // ── Pass 2: fold stranded fragments into larger compatible archetypes. ──────
  const order = accs
    .map((_, i) => i)
    .sort((a, b) => accs[a].totalWeight - accs[b].totalWeight);
  const alive = accs.map(() => true);

  for (const i of order) {
    if (!alive[i]) continue;
    const self = accProfile(accs[i]);
    let bestIdx = -1;
    let bestScore = -Infinity;

    for (let j = 0; j < accs.length; j++) {
      if (j === i || !alive[j]) continue;
      if (accs[j].setNumber !== accs[i].setNumber) continue;
      if (accs[j].totalWeight < accs[i].totalWeight) continue; // fold small → large only
      const r = compareToArchetype(self, accs[j]);
      if (r.shouldMerge && r.score > bestScore) {
        bestScore = r.score;
        bestIdx   = j;
      }
    }

    if (bestIdx >= 0) {
      mergeAccInto(accs[bestIdx], accs[i]);
      alive[i] = false;
    }
  }

  // ── Pass 3: labels, disambiguating collisions. ──────────────────────────────
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
 */
export function assignTail(
  comp: CompProfile,
  archetypes: ReadonlyMap<string, CompProfile>,
): string | null {
  let bestLabel: string | null = null;
  let bestScore = -Infinity;

  for (const [label, arch] of archetypes) {
    if (arch.setNumber !== comp.setNumber) continue;

    // Carry proxy: containment of the archetype's dominant carries in the
    // board — restricted to carries the archetype itself fields in its UNIT
    // set. Off-board carriers (e.g. the Mecha summon holds the comp's items
    // but is excluded from unit signatures) prove nothing by their absence.
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

    if (REQUIRE_DUP_CLASS && comp.carryGrade3.size > 0 && arch.carryGrade3.size > 0) {
      let shared = 0;
      for (const u of comp.carryGrade3) if (arch.carryGrade3.has(u)) shared++;
      if (shared === 0) continue;
    }
    if (REQUIRE_COPY_CLASS && comp.copySig !== arch.copySig) continue;
    if (REQUIRE_HERO_AUGMENT_CLASS && comp.heroAugmentSig !== arch.heroAugmentSig) continue;
    if (REQUIRE_EMBLEM_CLASS && comp.emblemSig !== arch.emblemSig) continue;

    const { containment, jaccard } = weightedOverlap(comp, arch.unitWeights);
    if (containment < MIN_CONTAINMENT || jaccard < MIN_JACCARD) continue;

    const score = UNIT_WEIGHT * containment + JACCARD_WEIGHT * jaccard + CARRY_WEIGHT * carryOverlap;
    if (score < SCORE_THRESHOLD + ASSIGN_MARGIN) continue;

    if (score > bestScore) {
      bestScore = score;
      bestLabel = label;
    }
  }

  return bestLabel;
}
