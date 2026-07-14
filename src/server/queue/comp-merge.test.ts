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
  grade3?: string[];
  copySig?: string;
  aug?: string;
  emblem?: string;
  boards?: number;
}

function P(spec: Spec): CompProfile {
  return {
    compId: spec.id ?? nextId++,
    setNumber: spec.set ?? 17,
    units: new Set(spec.units),
    unitWeights: new Map(Object.entries(spec.weights ?? {})),
    carries: new Set(spec.carries ?? []),
    carryGrade3: new Set(spec.grade3 ?? []),
    copySig: spec.copySig ?? '',
    heroAugmentSig: spec.aug ?? '',
    emblemSig: spec.emblem ?? '',
    boardCount: spec.boards ?? 10,
  };
}

const label = (res: MergeResult, c: CompProfile) => res.assignments.get(c.compId);

const SHELL = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

// ── Hit-state pooling (photo pairs 1, 2, 4, 5) ────────────────────────────────

test('missed-hit variants (3★ subset / no hits) merge into the full-hit line', () => {
  const hit  = P({ units: SHELL, carries: ['A', 'B'], grade3: ['A', 'B'], boards: 100 });
  const part = P({ units: SHELL, carries: ['A', 'B'], grade3: ['A'], boards: 50 });
  const none = P({ units: SHELL, carries: ['A'], grade3: [], boards: 20 });
  const res = mergeComps([hit, part, none]);
  assert.equal(label(res, part), label(res, hit));
  assert.equal(label(res, none), label(res, hit));
  assert.equal(res.archetypes.size, 1);
});

test('an extra hit (3★ superset) merges into the bigger no-hit line', () => {
  // Photo pair 1: same board ± a 3★'d 1-cost with items; the no-hit variant is
  // the anchor (2,086 games vs 240).
  const base  = P({ units: SHELL, carries: ['A'], grade3: [], boards: 500 });
  const bonus = P({ units: [...SHELL, 'I'], carries: ['A', 'I'], grade3: ['I'], boards: 40 });
  const res = mergeComps([base, bonus]);
  assert.equal(label(res, bonus), label(res, base));
});

test('variants that hit different secondary 3★s (overlapping sets) merge', () => {
  // Photo pair 4: Lulu/Maokai/Milio reroll ± Pantheon vs ± Jax.
  const units = ['L', 'M', 'Mi', 'P', 'J', 'S1', 'S2', 'S3', 'S4'];
  const a = P({ units, carries: ['L', 'M', 'P'], grade3: ['L', 'M', 'P'], boards: 170 });
  const b = P({ units, carries: ['J', 'L', 'M'], grade3: ['J', 'L', 'M'], boards: 61 });
  const res = mergeComps([a, b]);
  assert.equal(label(res, a), label(res, b));
});

// ── Class guards still split what must stay split ─────────────────────────────

test('lines rolling for different 3★s (disjoint carry-grade sets) stay split', () => {
  const units = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'J', 'F'];
  const jax = P({ units, carries: ['J', 'S1'], grade3: ['J'], boards: 100 });
  const fio = P({ units, carries: ['F', 'S1'], grade3: ['F'], boards: 90 });
  const res = mergeComps([jax, fio]);
  assert.notEqual(label(res, jax), label(res, fio));
  assert.equal(res.archetypes.size, 2);
});

test('emblem and non-emblem builds of one line merge into a single archetype (split is read-side)', () => {
  // The emblem-class guard is off by default: emblem variants are split and
  // folded at read time (comps-service), not at merge, so the line stays one
  // archetype here and the label carries no ##emb tag.
  const plain = P({ units: SHELL, carries: ['A'], boards: 100 });
  const emblem = P({ units: SHELL, carries: ['A'], emblem: 'TFT17_Item_DarkStarEmblemItem', boards: 40 });
  const res = mergeComps([plain, emblem]);
  assert.equal(label(res, plain), label(res, emblem));
  assert.ok(!res.assignments.get(emblem.compId)!.includes('##emb:'));
});

test('duplicate-copy augment boards stay a distinct archetype', () => {
  const classic = P({ units: SHELL, carries: ['A'], boards: 100 });
  const doubled = P({ units: SHELL, carries: ['A'], copySig: 'A', boards: 30 });
  const res = mergeComps([classic, doubled]);
  assert.notEqual(label(res, classic), label(res, doubled));
});

test('comps from different sets never merge, even with identical labels', () => {
  const a = P({ units: SHELL, carries: ['A'], set: 17, boards: 100 });
  const b = P({ units: SHELL, carries: ['A'], set: 16, boards: 90 });
  const res = mergeComps([a, b]);
  assert.notEqual(label(res, a), label(res, b));
  assert.equal(res.archetypes.size, 2);
});

// ── Defect fixes ──────────────────────────────────────────────────────────────

test('best-eligible selection: a hero-augment comp joins its augment sibling even when the classic line scores higher', () => {
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
  const res = mergeComps([classic, augSeed, augTwin]);
  assert.equal(label(res, augTwin), label(res, augSeed));
  assert.notEqual(label(res, augTwin), label(res, classic));
  assert.equal(res.archetypes.size, 2);
});

test('label collision: distinct no-carry archetypes get disambiguated labels instead of pooling', () => {
  const a = P({ units: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'], boards: 100 });
  const b = P({ units: ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8'], boards: 90 });
  const res = mergeComps([a, b]);
  const la = label(res, a)!;
  const lb = label(res, b)!;
  assert.notEqual(la, lb);
  assert.equal(la, 'no_carry'); // the biggest keeps the bare label
  assert.ok(lb.startsWith('no_carry##k:'));
  assert.equal(res.archetypes.size, 2);
});

// ── Survivor effect (photo pair 3) ────────────────────────────────────────────

test('survivor effect: boards differing only in cap units merge when identity-weighted', () => {
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
  const res = mergeComps([died, survived]);
  assert.equal(label(res, died), label(res, survived));
});

test('strong carry agreement buys unit slack: cap-swap variants merge even unweighted', () => {
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
  const res = mergeComps([a, b]);
  assert.equal(label(res, a), label(res, b));
});

test('control: carry agreement cannot rescue low unit overlap', () => {
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
  const res = mergeComps([a, b]);
  assert.notEqual(label(res, a), label(res, b));
});

// ── Fold pass ─────────────────────────────────────────────────────────────────

test('fold pass reunites a fragment stranded by greedy ordering', () => {
  const core = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'];
  // c2 vs c1 alone scores below the threshold, so greedy order strands it in
  // its own archetype; the bridge comp then widens c1's archetype until c2's
  // accumulated profile merges cleanly in the fold pass.
  const c1     = P({ units: [...core, 'u7', 'u8'], carries: ['u1'], boards: 300 });
  const c2     = P({ units: [...core, 'f1', 'f2'], carries: ['u1'], boards: 250 });
  const bridge = P({ units: [...core, 'u7', 'u8', 'f1', 'f2'], carries: ['u1'], boards: 200 });
  const res = mergeComps([c1, c2, bridge]);
  assert.equal(res.archetypes.size, 1);
  assert.equal(label(res, c2), label(res, c1));
  assert.equal(label(res, bridge), label(res, c1));
});

// ── Tail assignment (sub-floor comps, no itemization data) ────────────────────

test('assignTail: a missed-hit tail board joins its line via carry presence', () => {
  const anchor = P({ units: SHELL, carries: ['A', 'B'], grade3: ['A', 'B'], boards: 100 });
  const res = mergeComps([anchor]);
  // Died at 7 units, subset of the line, no 3★s hit, itemization unknown.
  const tail = P({ units: ['A', 'B', 'C', 'D', 'E', 'F', 'G'], boards: 3 });
  assert.equal(assignTail(tail, res.archetypeProfiles), res.assignments.get(anchor.compId));
});

test('assignTail: refuses a board that does not field the line carries', () => {
  const anchor = P({ units: SHELL, carries: ['A', 'B'], boards: 100 });
  const res = mergeComps([anchor]);
  const tail = P({ units: ['C', 'D', 'E', 'F', 'G', 'H', 'X', 'Y'], boards: 3 });
  assert.equal(assignTail(tail, res.archetypeProfiles), null);
});

test('assignTail: a conflicting 3★ blocks; missing hits do not', () => {
  const anchor = P({ units: SHELL, carries: ['A'], grade3: ['A'], boards: 100 });
  const res = mergeComps([anchor]);
  // Tail carryGrade3 = its FULL 3★ set (itemization unknown).
  const conflicted = P({ units: SHELL, grade3: ['H'], boards: 2 });
  const missed = P({ units: SHELL, grade3: [], boards: 2 });
  assert.equal(assignTail(conflicted, res.archetypeProfiles), null);
  assert.equal(assignTail(missed, res.archetypeProfiles), res.assignments.get(anchor.compId));
});

test('assignTail: an off-board carrier (summon) does not weaken the carry proxy', () => {
  // MECH holds the comp's items (dominant carry) but never appears in unit
  // signatures — its absence from a tail board proves nothing.
  const anchor = P({ units: SHELL, carries: ['MECH'], boards: 100 });
  const res = mergeComps([anchor]);
  const tail = P({ units: ['A', 'B', 'C', 'D', 'E', 'F', 'G'], boards: 3 });
  assert.equal(assignTail(tail, res.archetypeProfiles), res.assignments.get(anchor.compId));
});

test('assignTail: never joins a hero-augment archetype', () => {
  const aug = P({ units: SHELL, carries: ['A'], aug: 'B', boards: 100 });
  const res = mergeComps([aug]);
  const tail = P({ units: SHELL, boards: 2 }); // aug unknowable → ''
  assert.equal(assignTail(tail, res.archetypeProfiles), null);
});

test('mergeComps exposes frozen archetype profiles keyed by final label', () => {
  const a = P({ units: SHELL, carries: ['A'], boards: 100 });
  const res = mergeComps([a]);
  const prof = res.archetypeProfiles.get(res.assignments.get(a.compId)!);
  assert.ok(prof);
  assert.deepEqual([...prof!.carries], ['A']);
  assert.equal(prof!.setNumber, 17);
});

// ── Misc ──────────────────────────────────────────────────────────────────────

test('debugCompare reports the failed guards', () => {
  const units = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'J', 'F'];
  const jax = P({ units, carries: ['J'], grade3: ['J'] });
  const fio = P({ units, carries: ['F'], grade3: ['F'] });
  const r = debugCompare(jax, fio);
  assert.equal(r.shouldMerge, false);
  assert.ok(r.fails.includes('grade3_conflict'));
  assert.ok(r.fails.includes('carry_overlap'));
});

test('empty input → empty result', () => {
  const res = mergeComps([]);
  assert.equal(res.assignments.size, 0);
  assert.equal(res.archetypes.size, 0);
});
