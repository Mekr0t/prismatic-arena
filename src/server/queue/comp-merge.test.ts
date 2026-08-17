// comp-merge.test.ts — pins the archetype-grouping semantics.
//
// The must-merge cases mirror the labeled board pairs in /photos (boardX-1 vs
// boardX-2 = same archetype): hit-state variants of one line pool, so a line's
// stats include the boards that went for it and missed. The must-NOT-merge
// cases pin the class guards (disjoint rerolls, duplicate-copy augment, hero
// augment) and the two defect fixes (best-eligible selection, label collision).
//
// Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeComps,
  assignTail,
  makeTailAssigner,
  debugCompare,
  type CompProfile,
  type MergeResult,
} from './comp-merge';

let nextId = 1;

interface Spec {
  id?: number;
  set?: number;
  units: string[];
  /** Per-unit identity weights; omitted units default to 1 inside comp-merge. */
  weights?: Record<string, number>;
  carries?: string[];
  /** Damage-carry subset of `carries`; omitted = none (falls back to full-set
   *  overlap, the pre-purity behavior every older test pins). */
  dmg?: string[];
  grade3?: string[];
  copySig?: string;
  aug?: string;
  /** Augment-gated-unit signature (e.g. 'TFT17_Zed'); omitted = none. */
  gated?: string;
  /** Continuous damage-item rates behind the aug sig (three-zone guard). */
  augRates?: Record<string, number>;
  emblem?: string;
  boards?: number;
  /** Average final board level; 0/omitted = unknown (level guard skipped). */
  avgLevel?: number;
  /** Active-trait frame (trait → activation index); omitted = unknown. */
  frame?: Record<string, number>;
}

function P(spec: Spec): CompProfile {
  return {
    compId: spec.id ?? nextId++,
    setNumber: spec.set ?? 17,
    units: new Set(spec.units),
    unitWeights: new Map(Object.entries(spec.weights ?? {})),
    carries: new Set(spec.carries ?? []),
    damageCarries: new Set(spec.dmg ?? []),
    carryGrade3: new Set(spec.grade3 ?? []),
    copySig: spec.copySig ?? '',
    heroAugmentSig: spec.aug ?? '',
    heroAugmentRates: new Map(Object.entries(spec.augRates ?? {})),
    emblemSig: spec.emblem ?? '',
    gatedSig: spec.gated ?? '',
    boardCount: spec.boards ?? 10,
    avgLevel: spec.avgLevel ?? 0,
    traitFrame: new Map(Object.entries(spec.frame ?? {})),
  };
}

const label = (res: MergeResult, c: CompProfile) => res.assignments.get(c.compId);

const SHELL = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

// ── Hit-state pooling (photo pairs 1, 2, 4, 5) ────────────────────────────────

test('missed-hit variants (3★ subset / no hits) merge into the full-hit line', async () => {
  const hit  = P({ units: SHELL, carries: ['A', 'B'], grade3: ['A', 'B'], boards: 100 });
  const part = P({ units: SHELL, carries: ['A', 'B'], grade3: ['A'], boards: 50 });
  const none = P({ units: SHELL, carries: ['A'], grade3: [], boards: 20 });
  const res = await mergeComps([hit, part, none]);
  assert.equal(label(res, part), label(res, hit));
  assert.equal(label(res, none), label(res, hit));
  assert.equal(res.archetypes.size, 1);
});

test('an extra hit (3★ superset) merges into the bigger no-hit line', async () => {
  // Photo pair 1: same board ± a 3★'d 1-cost with items; the no-hit variant is
  // the anchor (2,086 games vs 240).
  const base  = P({ units: SHELL, carries: ['A'], grade3: [], boards: 500 });
  const bonus = P({ units: [...SHELL, 'I'], carries: ['A', 'I'], grade3: ['I'], boards: 40 });
  const res = await mergeComps([base, bonus]);
  assert.equal(label(res, bonus), label(res, base));
});

test('variants that hit different secondary 3★s (overlapping sets) merge', async () => {
  // Photo pair 4: Lulu/Maokai/Milio reroll ± Pantheon vs ± Jax.
  const units = ['L', 'M', 'Mi', 'P', 'J', 'S1', 'S2', 'S3', 'S4'];
  const a = P({ units, carries: ['L', 'M', 'P'], grade3: ['L', 'M', 'P'], boards: 170 });
  const b = P({ units, carries: ['J', 'L', 'M'], grade3: ['J', 'L', 'M'], boards: 61 });
  const res = await mergeComps([a, b]);
  assert.equal(label(res, a), label(res, b));
});

// ── Damage-carry purity ───────────────────────────────────────────────────────

test('itemized tanks/supports must not split a line agreeing on its damage carry', async () => {
  // Sona/Bard-shaped review case: full carry sets {A,B,T1} vs {A,C,T2} overlap
  // 1/3 < the 0.34 bar (the exact boundary that split the Dark Star and
  // Sona/Bard pairs), but the damage carries agree on A — same line.
  const a = P({ units: SHELL, carries: ['A', 'B', 'T1'], dmg: ['A', 'B'], boards: 100 });
  const b = P({ units: SHELL, carries: ['A', 'C', 'T2'], dmg: ['A', 'C'], boards: 60 });
  const res = await mergeComps([a, b]);
  assert.equal(label(res, a), label(res, b));
});

test('disjoint damage carries still split, whatever the tanks say', async () => {
  // Same units — but the itemization identity disagrees completely (items on
  // A/B vs items on C/D, damage AND full sets disjoint): different comps.
  const a = P({ units: SHELL, carries: ['A', 'B'], dmg: ['A', 'B'], boards: 100 });
  const b = P({ units: SHELL, carries: ['C', 'D'], dmg: ['C', 'D'], boards: 60 });
  const res = await mergeComps([a, b]);
  assert.notEqual(label(res, a), label(res, b));
});

test('damage-disjoint falls back to full sets: item drift within one line pools', async () => {
  // The Akali-line case: hit-variants itemize different units (Akali/Jax vs
  // Kindred/Morgana) but the FULL carry sets still overlap — same line, the
  // damage-disjoint veto must not split it.
  const a = P({ units: SHELL, carries: ['A', 'J', 'K'], dmg: ['A', 'J'], boards: 195 });
  const b = P({ units: SHELL, carries: ['K', 'M', 'A'], dmg: ['K', 'M'], boards: 53 });
  const res = await mergeComps([a, b]);
  assert.equal(label(res, a), label(res, b));
});

// ── Trait-frame term ──────────────────────────────────────────────────────────

test('a matching trait frame bridges flex-slot drift the unit score alone rejects', async () => {
  // Dark-Star-pair shape: 7 shared of 9 units (score lands ~0.67 < 0.78), the
  // damage carries partially agree, and the FRAME is identical — same comp,
  // different flex. Without frames the exact same pair must stay split.
  const shared = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7'];
  const frame = { DarkStar: 3, Sorcerer: 1 };
  const a = P({ units: [...shared, 'X1', 'X2'], carries: ['S1', 'X1'], dmg: ['S1', 'X1'], frame, boards: 100 });
  const b = P({ units: [...shared, 'Y1', 'Y2'], carries: ['S1', 'Y1'], dmg: ['S1', 'Y1'], frame, boards: 60 });
  const res = await mergeComps([a, b]);
  assert.equal(label(res, a), label(res, b));

  const a2 = P({ units: [...shared, 'X1', 'X2'], carries: ['S1', 'X1'], dmg: ['S1', 'X1'], boards: 100 });
  const b2 = P({ units: [...shared, 'Y1', 'Y2'], carries: ['S1', 'Y1'], dmg: ['S1', 'Y1'], boards: 60 });
  const res2 = await mergeComps([a2, b2]);
  assert.notEqual(label(res2, a2), label(res2, b2));
});

test('a near-disjoint trait frame is a hard guard, whatever the units say', async () => {
  // Identical unit bags that resolve to different game plans (e.g. an emblem
  // flipping the frame) must not merge on unit coincidence.
  const a = P({ units: SHELL, carries: ['A'], dmg: ['A'], frame: { Vanguard: 2, Slayer: 2 }, boards: 100 });
  const b = P({ units: SHELL, carries: ['A'], dmg: ['A'], frame: { Sorcerer: 2, Stargazer: 2 }, boards: 60 });
  const res = await mergeComps([a, b]);
  assert.notEqual(label(res, a), label(res, b));
});

// ── Augment-gated units (Invader Zed) ─────────────────────────────────────────

test('a Zed board splits from the same line without Zed', async () => {
  // Zed only enters a game through the Invader augment — fielding him is a
  // different game class, whatever the rest of the board says.
  const clean = P({ units: SHELL, carries: ['A'], dmg: ['A'], boards: 120 });
  const zed = P({ units: [...SHELL, 'Zed'], carries: ['A'], dmg: ['A'], gated: 'Zed', boards: 30 });
  const res = await mergeComps([clean, zed]);
  assert.notEqual(label(res, clean), label(res, zed));
  assert.ok(label(res, zed)?.includes('##gate:Zed'));
});

test('two Zed boards of one line merge into the ##gate archetype', async () => {
  const a = P({ units: [...SHELL, 'Zed'], carries: ['A'], dmg: ['A'], gated: 'Zed', boards: 30 });
  const b = P({ units: [...SHELL, 'Zed'], carries: ['A'], dmg: ['A'], gated: 'Zed', boards: 20 });
  const res = await mergeComps([a, b]);
  assert.equal(label(res, a), label(res, b));
});

// ── Class guards still split what must stay split ─────────────────────────────

test('lines rolling for different 3★s (disjoint carry-grade sets) stay split', async () => {
  const units = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'J', 'F'];
  const jax = P({ units, carries: ['J', 'S1'], grade3: ['J'], boards: 100 });
  const fio = P({ units, carries: ['F', 'S1'], grade3: ['F'], boards: 90 });
  const res = await mergeComps([jax, fio]);
  assert.notEqual(label(res, jax), label(res, fio));
  assert.equal(res.archetypes.size, 2);
});

test('emblem and non-emblem builds of one line merge into a single archetype (split is read-side)', async () => {
  // The emblem-class guard is off by default: emblem variants are split and
  // folded at read time (comps-service), not at merge, so the line stays one
  // archetype here and the label carries no ##emb tag.
  const plain = P({ units: SHELL, carries: ['A'], boards: 100 });
  const emblem = P({ units: SHELL, carries: ['A'], emblem: 'TFT17_Item_DarkStarEmblemItem', boards: 40 });
  const res = await mergeComps([plain, emblem]);
  assert.equal(label(res, plain), label(res, emblem));
  assert.ok(!res.assignments.get(emblem.compId)!.includes('##emb:'));
});

test('duplicate-copy augment boards stay a distinct archetype', async () => {
  const classic = P({ units: SHELL, carries: ['A'], boards: 100 });
  const doubled = P({ units: SHELL, carries: ['A'], copySig: 'A', boards: 30 });
  const res = await mergeComps([classic, doubled]);
  assert.notEqual(label(res, classic), label(res, doubled));
});

test('comps from different sets never merge, even with identical labels', async () => {
  const a = P({ units: SHELL, carries: ['A'], set: 17, boards: 100 });
  const b = P({ units: SHELL, carries: ['A'], set: 16, boards: 90 });
  const res = await mergeComps([a, b]);
  assert.notEqual(label(res, a), label(res, b));
  assert.equal(res.archetypes.size, 2);
});

// ── Defect fixes ──────────────────────────────────────────────────────────────

test('best-eligible selection: a hero-augment comp joins its augment sibling even when the classic line scores higher', async () => {
  const U8 = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8'];
  const classic = P({ units: U8, carries: ['u1'], boards: 300 });
  const augSeed = P({
    units: ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'v8'],
    carries: ['u1'],
    aug: 'u2',
    boards: 100,
  });
  // Identical units to `classic` (pairwise score 1.0, but hero guard fails) —
  // the old best-scoring-only selection seeded a pointless third archetype here.
  const augTwin = P({ units: U8, carries: ['u1'], aug: 'u2', boards: 50 });
  const res = await mergeComps([classic, augSeed, augTwin]);
  assert.equal(label(res, augTwin), label(res, augSeed));
  assert.notEqual(label(res, augTwin), label(res, classic));
  assert.equal(res.archetypes.size, 2);
});

test('three-zone hero guard: an ##aug satellite pools into a mid-rate line', async () => {
  // The big line's members straddle the 0.5 detection threshold (sig '' but
  // rates ~0.35) — the satellite's sig mismatch is heuristic noise, not a
  // different comp (the Morde/Leona case).
  const U8 = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8'];
  const lineA = P({ units: U8, carries: ['u1'], augRates: { u2: 0.35 }, boards: 300 });
  const lineB = P({ units: U8, carries: ['u1'], augRates: { u2: 0.4 }, boards: 200 });
  const satellite = P({ units: U8, carries: ['u1'], aug: 'u2', augRates: { u2: 1 }, boards: 20 });
  const res = await mergeComps([lineA, lineB, satellite]);
  assert.equal(label(res, satellite), label(res, lineA));
  assert.equal(res.archetypes.size, 1);
});

test('three-zone hero guard: a confidently augment-free line still splits from the augment archetype', async () => {
  // The Jax case: the classic line's rate for the champ is near zero, so the
  // augment build is a genuinely different comp.
  const U8 = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8'];
  const classicA = P({ units: U8, carries: ['u1'], augRates: { u2: 0.05 }, boards: 300 });
  const classicB = P({ units: U8, carries: ['u1'], boards: 200 });
  const augment = P({ units: U8, carries: ['u1'], aug: 'u2', augRates: { u2: 0.9 }, boards: 100 });
  const res = await mergeComps([classicA, classicB, augment]);
  assert.equal(label(res, classicA), label(res, classicB));
  assert.notEqual(label(res, augment), label(res, classicA));
  assert.equal(res.archetypes.size, 2);
});

test('level gap: same units at different average levels are different game plans', async () => {
  const U8 = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8'];
  const fast9 = P({ units: U8, carries: ['u1'], avgLevel: 9.0, boards: 300 });
  const reroll = P({ units: U8, carries: ['u1'], avgLevel: 7.0, boards: 100 });
  const nearby = P({ units: U8, carries: ['u1'], avgLevel: 8.6, boards: 50 });
  const res = await mergeComps([fast9, reroll, nearby]);
  assert.notEqual(label(res, reroll), label(res, fast9)); // |7−9| ≥ gap → split
  assert.equal(label(res, nearby), label(res, fast9)); // |8.6−9| < gap → pools
  assert.equal(res.archetypes.size, 2);
});

test('label collision: distinct no-carry archetypes get disambiguated labels instead of pooling', async () => {
  const a = P({ units: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'], boards: 100 });
  const b = P({ units: ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8'], boards: 90 });
  const res = await mergeComps([a, b]);
  const la = label(res, a)!;
  const lb = label(res, b)!;
  assert.notEqual(la, lb);
  assert.equal(la, 'no_carry'); // the biggest keeps the bare label
  assert.ok(lb.startsWith('no_carry##k:'));
  assert.equal(res.archetypes.size, 2);
});

// ── Survivor effect (photo pair 3) ────────────────────────────────────────────

test('survivor effect: boards differing only in cap units merge when identity-weighted', async () => {
  const core = { A: 1, B: 1, C: 0.7, D: 0.7, E: 0.7, F: 0.7 };
  const died = P({
    units: ['A', 'B', 'C', 'D', 'E', 'F', 'X1', 'X2'],
    weights: { ...core, X1: 0.25, X2: 0.25 },
    carries: ['A', 'B'],
    boards: 100,
  });
  const survived = P({
    units: ['A', 'B', 'C', 'D', 'E', 'F', 'Y1', 'Y2'],
    weights: { ...core, Y1: 0.25, Y2: 0.25 },
    carries: ['A', 'B'],
    boards: 40,
  });
  const res = await mergeComps([died, survived]);
  assert.equal(label(res, died), label(res, survived));
});

test('strong carry agreement buys unit slack: cap-swap variants merge even unweighted', async () => {
  // Same itemized carries, same core, different last-two units — the Shepherd
  // Sona/LeBlanc/Leona case (Karma splash vs Nunu splash). Carry overlap 1.0
  // relaxes the score bar by MERGE_STRONG_CARRY_SLACK.
  const a = P({
    units: ['A', 'B', 'C', 'D', 'E', 'F', 'X1', 'X2'],
    carries: ['A', 'B'],
    boards: 100,
  });
  const b = P({
    units: ['A', 'B', 'C', 'D', 'E', 'F', 'Y1', 'Y2'],
    carries: ['A', 'B'],
    boards: 40,
  });
  const res = await mergeComps([a, b]);
  assert.equal(label(res, a), label(res, b));
});

test('control: carry agreement cannot rescue low unit overlap', async () => {
  // Identical carries but only half the board shared — containment hard-fails
  // no matter how strong the carry agreement is.
  const a = P({
    units: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
    carries: ['A', 'B'],
    boards: 100,
  });
  const b = P({
    units: ['A', 'B', 'C', 'D', 'W', 'X', 'Y', 'Z'],
    carries: ['A', 'B'],
    boards: 40,
  });
  const res = await mergeComps([a, b]);
  assert.notEqual(label(res, a), label(res, b));
});

// ── Fold pass ─────────────────────────────────────────────────────────────────

test('fold pass reunites a fragment stranded by greedy ordering', async () => {
  const core = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'];
  // c2 vs c1 alone scores below the threshold, so greedy order strands it in
  // its own archetype; the bridge comp then widens c1's archetype until c2's
  // accumulated profile merges cleanly in the fold pass.
  const c1     = P({ units: [...core, 'u7', 'u8'], carries: ['u1'], boards: 300 });
  const c2     = P({ units: [...core, 'f1', 'f2'], carries: ['u1'], boards: 250 });
  const bridge = P({ units: [...core, 'u7', 'u8', 'f1', 'f2'], carries: ['u1'], boards: 200 });
  const res = await mergeComps([c1, c2, bridge]);
  assert.equal(res.archetypes.size, 1);
  assert.equal(label(res, c2), label(res, c1));
  assert.equal(label(res, bridge), label(res, c1));
});

// ── Tail assignment (sub-floor comps, no itemization data) ────────────────────

test('assignTail: a missed-hit tail board joins its line via carry presence', async () => {
  const anchor = P({ units: SHELL, carries: ['A', 'B'], grade3: ['A', 'B'], boards: 100 });
  const res = await mergeComps([anchor]);
  // Died at 7 units, subset of the line, no 3★s hit, itemization unknown.
  const tail = P({ units: ['A', 'B', 'C', 'D', 'E', 'F', 'G'], boards: 3 });
  assert.equal(assignTail(tail, res.archetypeProfiles), res.assignments.get(anchor.compId));
});

test('assignTail: refuses a board that does not field the line carries', async () => {
  const anchor = P({ units: SHELL, carries: ['A', 'B'], boards: 100 });
  const res = await mergeComps([anchor]);
  const tail = P({ units: ['C', 'D', 'E', 'F', 'G', 'H', 'X', 'Y'], boards: 3 });
  assert.equal(assignTail(tail, res.archetypeProfiles), null);
});

test('assignTail: a conflicting 3★ blocks at sample; anecdotes and missing hits do not', async () => {
  const anchor = P({ units: SHELL, carries: ['A'], grade3: ['A'], boards: 100 });
  const res = await mergeComps([anchor]);
  // Tail carryGrade3 = its FULL 3★ set (itemization unknown). A sampled
  // disjoint hit set is a different reroll target → blocked; the same set on
  // a GRADE3_MIN_N-sub sample is anecdote (an incidental 3★ on a couple of
  // boards) → pools, like a missing hit.
  const conflicted = P({ units: SHELL, grade3: ['H'], boards: 20 });
  const anecdote = P({ units: SHELL, grade3: ['H'], boards: 2 });
  const missed = P({ units: SHELL, grade3: [], boards: 2 });
  assert.equal(assignTail(conflicted, res.archetypeProfiles), null);
  assert.equal(assignTail(anecdote, res.archetypeProfiles), res.assignments.get(anchor.compId));
  assert.equal(assignTail(missed, res.archetypeProfiles), res.assignments.get(anchor.compId));
});

test('assignTail: an off-board carrier (summon) does not weaken the carry proxy', async () => {
  // MECH holds the comp's items (dominant carry) but never appears in unit
  // signatures — its absence from a tail board proves nothing.
  const anchor = P({ units: SHELL, carries: ['MECH'], boards: 100 });
  const res = await mergeComps([anchor]);
  const tail = P({ units: ['A', 'B', 'C', 'D', 'E', 'F', 'G'], boards: 3 });
  assert.equal(assignTail(tail, res.archetypeProfiles), res.assignments.get(anchor.compId));
});

test('assignTail: never joins a hero-augment archetype', async () => {
  const aug = P({ units: SHELL, carries: ['A'], aug: 'B', boards: 100 });
  const res = await mergeComps([aug]);
  const tail = P({ units: SHELL, boards: 2 }); // aug unknowable → ''
  assert.equal(assignTail(tail, res.archetypeProfiles), null);
});

test('mergeComps exposes frozen archetype profiles keyed by final label', async () => {
  const a = P({ units: SHELL, carries: ['A'], boards: 100 });
  const res = await mergeComps([a]);
  const prof = res.archetypeProfiles.get(res.assignments.get(a.compId)!);
  assert.ok(prof);
  assert.deepEqual([...prof!.carries], ['A']);
  assert.equal(prof!.setNumber, 17);
});

// ── Universal merge (presence profiles participate) ──────────────────────────

test('two evidence-less hit-state variants of one line seed a shared micro-archetype', async () => {
  // buildTailProfile shape: carries EMPTY (no itemization evidence), carryGrade3
  // = full 3★ set, neutral weights. Identical units, different hits — the
  // Conduit/N.O.V.A. case that assign-only tail labeling could never pool.
  const U8 = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'];
  const hitA = P({ units: U8, grade3: ['t1', 't2'], boards: 14 });
  const hitB = P({ units: U8, grade3: ['t1', 't3'], boards: 10 });
  const miss = P({ units: U8, grade3: [], boards: 6 });
  const res = await mergeComps([hitA, hitB, miss]);
  assert.equal(res.archetypes.size, 1);
  assert.equal(label(res, hitB), label(res, hitA));
  assert.equal(label(res, miss), label(res, hitA));
  // Micro-archetype labels come from the dominant 3★ set, not 'no_carry'.
  assert.ok(label(res, hitA)!.startsWith('t1'));
});

test('an evidence-less mid-tier comp joins an evidence-rich line via carry presence', async () => {
  const anchor = P({ units: SHELL, carries: ['A', 'B'], grade3: ['A'], boards: 100 });
  // Fields both line carries at 1–2★ (missed-hit board), one cap unit swapped.
  const midTier = P({ units: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'X'], boards: 8 });
  const res = await mergeComps([anchor, midTier]);
  assert.equal(res.archetypes.size, 1);
  assert.equal(label(res, midTier), label(res, anchor));
});

test('an evidence-less comp NOT fielding the line carries stays separate', async () => {
  const anchor = P({ units: SHELL, carries: ['A', 'B'], boards: 100 });
  // Shares 6 of 8 units but fields neither carry — different line.
  const stray = P({ units: ['C', 'D', 'E', 'F', 'G', 'H', 'X', 'Y'], boards: 8 });
  const res = await mergeComps([anchor, stray]);
  assert.equal(res.archetypes.size, 2);
  assert.notEqual(label(res, stray), label(res, anchor));
});

test('grade3 conflict still splits sampled evidence-less reroll lines', async () => {
  // Two sub-floor reroll families over the same units rolling for DIFFERENT
  // units: the conflict-only guard must keep them apart once sampled.
  const U8 = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8'];
  const jaxLine = P({ units: U8, grade3: ['r1'], boards: 20 });
  const fioLine = P({ units: U8, grade3: ['r2'], boards: 15 });
  const res = await mergeComps([jaxLine, fioLine]);
  assert.equal(res.archetypes.size, 2);
});

test('makeTailAssigner returns exactly what assignTail returns', async () => {
  const anchorA = P({ units: SHELL, carries: ['A', 'B'], grade3: ['A', 'B'], boards: 100 });
  const anchorB = P({
    units: ['P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W'],
    carries: ['P'],
    boards: 90,
  });
  const res = await mergeComps([anchorA, anchorB]);
  const assign = makeTailAssigner(res.archetypeProfiles);
  const probes = [
    P({ units: ['A', 'B', 'C', 'D', 'E', 'F', 'G'], boards: 1 }), // joins A's line
    P({ units: ['P', 'Q', 'R', 'S', 'T', 'U', 'V'], boards: 1 }), // joins B's line
    P({ units: ['A', 'B', 'C', 'D', 'E', 'F', 'G'], grade3: ['Z'], boards: 1 }),
    P({ units: ['z1', 'z2', 'z3', 'z4', 'z5', 'z6', 'z7'], boards: 1 }), // nothing
  ];
  for (const probe of probes) {
    assert.equal(assign(probe), assignTail(probe, res.archetypeProfiles));
  }
});

// ── Misc ──────────────────────────────────────────────────────────────────────

test('debugCompare reports the failed guards', async () => {
  const units = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'J', 'F'];
  const jax = P({ units, carries: ['J'], grade3: ['J'] });
  const fio = P({ units, carries: ['F'], grade3: ['F'] });
  const r = debugCompare(jax, fio);
  assert.equal(r.shouldMerge, false);
  assert.ok(r.fails.includes('grade3_conflict'));
  assert.ok(r.fails.includes('carry_overlap'));
});

test('empty input → empty result', async () => {
  const res = await mergeComps([]);
  assert.equal(res.assignments.size, 0);
  assert.equal(res.archetypes.size, 0);
});
