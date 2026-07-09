// comp-merge.ts — carry-archetype grouping for comps.
//
// Ports tft_comp_merge.py to TypeScript. Takes pre-built CompProfile records
// (one per exact-unit comp, with its item-carry set from carry-classify) and
// groups them into carry archetypes using unit-overlap + carry-overlap scoring.
//
// Algorithm (online, processes most-populated comps first so archetypes are
// anchored by the most-observed variant):
//   for each comp (sorted by boardCount desc):
//     find the existing archetype with the highest similarity score
//     if score >= SCORE_THRESHOLD AND no hard-fail: add to that archetype
//     else: start a new archetype seeded by this comp
//
// Similarity score = UNIT_WEIGHT * containmentSmall + JACCARD_WEIGHT * jaccard
//                  + CARRY_WEIGHT * carryOverlap
//
// Hard-fail guards (independently configurable):
//   - duplicate_pattern  : 3-star signature must match the archetype's dominant
//   - copy_pattern       : duplicate-copy set must match (dup-copy augment boards
//                          stay a distinct archetype from classic single-copy ones)
//   - hero_augment       : hero-augment champ (if any) must match the archetype's
//                          dominant one (see carry-classify.ts's classifyHeroAugments) —
//                          a hero-augmented board stays a distinct archetype from the
//                          same units without the augment
//   - carry_mismatch     : carry overlap must be >= MIN_CARRY_OVERLAP
//   - containment        : containmentSmall must be >= MIN_CONTAINMENT
//   - jaccard            : jaccard must be >= MIN_JACCARD
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
const REQUIRE_CARRY       = process.env.MERGE_REQUIRE_CARRY      !== 'false';
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

// ── Public types ──────────────────────────────────────────────────────────────

/**
 * Per-comp profile, built by the merge stage from DB data + carry-classify.
 * Because every board in a comp has the *exact* same unit set (cluster.ts
 * groups by identity), all units are at implicit frequency 1.0 within the comp.
 * Frequency accumulation happens at the archetype level across comps.
 */
export interface CompProfile {
  compId: number;
  setNumber: number;
  /** Distinct unit ids (copies collapsed) — used for overlap scoring. */
  units: Set<string>;
  /** Confirmed carry units (isBucketCarry=true) from carry-classify. */
  carries: Set<string>;
  /** Sorted 3-star character IDs, pipe-joined; '' if no 3-stars. Used as the
   *  "duplicate class" guard — reroll comps with different starred units shouldn't
   *  merge, even when they overlap heavily on the rest of the board. */
  duplicateSig: string;
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
  /** Total boards in this comp, used as weight in archetype freq accumulation. */
  boardCount: number;
}

export interface MergeResult {
  /** compId → archetype label for every input comp. */
  assignments: Map<number, string>;
  /** archetype label → compIds in that archetype. */
  archetypes: Map<string, number[]>;
}

// ── Internal accumulator ──────────────────────────────────────────────────────

interface ArchetypeAcc {
  compIds: number[];
  setNumber: number;
  /** Unit → Σ boardCount (unnormalized; normalize by totalWeight for freq). */
  weightedFreq: Map<string, number>;
  totalWeight: number;
  /** Carry unit → count of comps in this archetype that have it. */
  carryFreq: Map<string, number>;
  totalComps: number;
  /** duplicateSig → count, for electing the dominant signature. */
  dupSigCounts: Map<string, number>;
  /** copySig → count, for electing the dominant copy signature. */
  copySigCounts: Map<string, number>;
  /** heroAugmentSig → count, for electing the dominant hero-augment champ. */
  heroAugmentSigCounts: Map<string, number>;
}

// ── Similarity helpers ────────────────────────────────────────────────────────

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function containmentSmall(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / Math.min(a.size, b.size);
}

// ── Archetype-profile accessors ───────────────────────────────────────────────

function getRepUnits(acc: ArchetypeAcc): Set<string> {
  const units = new Set<string>();
  if (acc.totalWeight === 0) return units;
  for (const [id, w] of acc.weightedFreq) {
    if (w / acc.totalWeight >= OPTIONAL_THRESHOLD) units.add(id);
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

function electDominant(counts: Map<string, number>): string {
  let best = '';
  let bestCnt = 0;
  for (const [sig, cnt] of counts) {
    if (cnt > bestCnt) { bestCnt = cnt; best = sig; }
  }
  return best;
}

// ── Comparison ────────────────────────────────────────────────────────────────

function compareToArchetype(
  comp: CompProfile,
  acc: ArchetypeAcc,
): { shouldMerge: boolean; score: number } {
  const repUnits   = getRepUnits(acc);
  const domCarries = getDomCarries(acc);
  const domDup     = electDominant(acc.dupSigCounts);
  const domCopy    = electDominant(acc.copySigCounts);
  const domHeroAugment = electDominant(acc.heroAugmentSigCounts);

  const dupMatch  = !REQUIRE_DUP_CLASS  || comp.duplicateSig === domDup;
  const copyMatch = !REQUIRE_COPY_CLASS || comp.copySig === domCopy;
  const heroAugmentMatch = !REQUIRE_HERO_AUGMENT_CLASS || comp.heroAugmentSig === domHeroAugment;

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

  const cont  = containmentSmall(comp.units, repUnits);
  const jac   = jaccard(comp.units, repUnits);
  const score = UNIT_WEIGHT * cont + JACCARD_WEIGHT * jac + CARRY_WEIGHT * carryOverlap;

  const hardFails =
    (REQUIRE_DUP_CLASS         && !dupMatch                        ? 1 : 0) +
    (REQUIRE_COPY_CLASS        && !copyMatch                       ? 1 : 0) +
    (REQUIRE_HERO_AUGMENT_CLASS && !heroAugmentMatch                ? 1 : 0) +
    (REQUIRE_CARRY             && carryOverlap < MIN_CARRY_OVERLAP ? 1 : 0) +
    (cont < MIN_CONTAINMENT                                        ? 1 : 0) +
    (jac  < MIN_JACCARD                                            ? 1 : 0);

  return { shouldMerge: score >= SCORE_THRESHOLD && hardFails === 0, score };
}

// ── Accumulator ops ───────────────────────────────────────────────────────────

function makeAcc(setNumber: number): ArchetypeAcc {
  return {
    compIds: [],
    setNumber,
    weightedFreq: new Map(),
    totalWeight: 0,
    carryFreq: new Map(),
    totalComps: 0,
    dupSigCounts: new Map(),
    copySigCounts: new Map(),
    heroAugmentSigCounts: new Map(),
  };
}

function addToAcc(acc: ArchetypeAcc, comp: CompProfile): void {
  acc.compIds.push(comp.compId);
  acc.totalComps += 1;
  const w = comp.boardCount > 0 ? comp.boardCount : 1;
  acc.totalWeight += w;
  for (const u of comp.units) {
    acc.weightedFreq.set(u, (acc.weightedFreq.get(u) ?? 0) + w);
  }
  for (const c of comp.carries) {
    acc.carryFreq.set(c, (acc.carryFreq.get(c) ?? 0) + 1);
  }
  acc.dupSigCounts.set(comp.duplicateSig, (acc.dupSigCounts.get(comp.duplicateSig) ?? 0) + 1);
  acc.copySigCounts.set(comp.copySig, (acc.copySigCounts.get(comp.copySig) ?? 0) + 1);
  acc.heroAugmentSigCounts.set(
    comp.heroAugmentSig,
    (acc.heroAugmentSigCounts.get(comp.heroAugmentSig) ?? 0) + 1,
  );
}

function archetypeLabel(acc: ArchetypeAcc): string {
  const dom = getDomCarries(acc);
  const base = [...dom].sort().join('|') || 'no_carry';
  // A duplicate-copy-augment or hero-augment archetype is distinct from the
  // classic build even with identical carries. Because meta_comp IS this label
  // and every downstream reader groups on it, both classes must be encoded HERE
  // — the guards keep them in separate accumulators during clustering, but if
  // two accumulators produce the same carry label they'd collapse back into one
  // archetype on display otherwise.
  // Marker stays parseable: "<carries>##dup:<doubled-unit-ids>##aug:<champId>".
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
 * each archetype. Each comp is assigned to the best-scoring existing archetype
 * that passes all hard-fail guards, or starts a new one.
 *
 * @returns `assignments` (compId → label) and `archetypes` (label → compIds).
 *   A comp always appears in exactly one archetype.
 */
export function mergeComps(profiles: CompProfile[]): MergeResult {
  if (profiles.length === 0) return { assignments: new Map(), archetypes: new Map() };

  const sorted = [...profiles].sort(
    (a, b) => b.boardCount - a.boardCount || a.compId - b.compId,
  );

  const accs: ArchetypeAcc[] = [];

  for (const comp of sorted) {
    let bestIdx = -1;
    let bestScore = -Infinity;
    let bestShouldMerge = false;

    for (let i = 0; i < accs.length; i++) {
      if (accs[i].setNumber !== comp.setNumber) continue;
      const { shouldMerge, score } = compareToArchetype(comp, accs[i]);
      if (score > bestScore) {
        bestScore = score;
        bestIdx   = i;
        bestShouldMerge = shouldMerge;
      }
    }

    if (bestShouldMerge && bestIdx >= 0) {
      addToAcc(accs[bestIdx], comp);
    } else {
      const acc = makeAcc(comp.setNumber);
      addToAcc(acc, comp);
      accs.push(acc);
    }
  }

  const assignments = new Map<number, string>();
  const archetypes  = new Map<string, number[]>();

  for (const acc of accs) {
    const label = archetypeLabel(acc);
    for (const compId of acc.compIds) assignments.set(compId, label);
    const existing = archetypes.get(label);
    if (existing) existing.push(...acc.compIds);
    else archetypes.set(label, [...acc.compIds]);
  }

  return { assignments, archetypes };
}