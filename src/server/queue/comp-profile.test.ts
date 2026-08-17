// comp-profile.test.ts — pins CompProfile construction from raw board data:
// the top-itemized carry fallback (missed-hit boards keep carry identity),
// carry-grade 3★ selection (incidental 3★s excluded), identity/flex weights,
// and the classifyCarries zero-item regression.
//
// Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCompProfile, buildTailProfile } from './comp-profile';
import { classifyCarries, type RawUnitItem } from './carry-classify';

/** boards[i] = { characterId: itemIds } → flat RawUnitItem rows (boardId = i+1).
 *  Item ids here are arbitrary non-component strings, so every item counts as
 *  completed. */
function rows(boards: Record<string, string[]>[]): RawUnitItem[] {
  const out: RawUnitItem[] = [];
  boards.forEach((board, i) => {
    for (const [characterId, items] of Object.entries(board)) {
      out.push({ boardId: i + 1, characterId, items });
    }
  });
  return out;
}

test('itemized carry, top-itemized identity, and flex weights', () => {
  const raw = rows([
    { A: ['i1', 'i2', 'i3'], B: ['i4'], C: [], X: [] },
    { A: ['i1', 'i2', 'i3'], B: ['i4', 'i5'], C: [], X: [] },
  ]);
  const p = buildCompProfile({
    compId: 1,
    setNumber: 17,
    coreUnits: ['A', 'B', 'C', 'X'],
    threeStars: [],
    statTotal: 2,
    rawRows: raw,
    costOf: (id) => (id === 'X' ? 5 : id === 'C' ? 4 : 2),
  });
  assert.deepEqual([...p.carries], ['A']); // fully itemized on every board
  assert.equal(p.unitWeights.get('A'), 1); // bucket carry → identity
  assert.equal(p.unitWeights.get('B'), 1); // reliably top-itemized → identity
  assert.equal(p.unitWeights.get('C'), 0.25); // cost 4, itemless → flex/cap slot
  assert.equal(p.unitWeights.get('X'), 0.25); // cost 5, itemless → flex/cap slot
  assert.equal(p.carryGrade3.size, 0);
});

test('top-itemized fallback keeps carry identity on missed-hit boards', () => {
  // Nobody ever completes 3 items (dead boards), but the items that DO exist
  // sit on L and M every game — the fallback must surface them as carries so
  // the comp doesn't hard-fail the merge carry guard.
  const raw = rows([
    { L: ['i1', 'i2'], M: ['i3'], S: [], T: [] },
    { L: ['i1'], M: ['i3', 'i4'], S: [], T: [] },
  ]);
  const p = buildCompProfile({
    compId: 2,
    setNumber: 17,
    coreUnits: ['L', 'M', 'S', 'T'],
    threeStars: [],
    statTotal: 2,
    rawRows: raw,
    costOf: () => 1,
  });
  assert.deepEqual([...p.carries].sort(), ['L', 'M']);
});

test('incidental 3★ (itemless) is not carry-grade; an itemized 3★ is', () => {
  const raw = rows([
    { A: ['i1', 'i2', 'i3'], P: [], Q: ['i4', 'i5'] },
    { A: ['i1', 'i2', 'i3'], P: [], Q: ['i4'] },
  ]);
  const p = buildCompProfile({
    compId: 3,
    setNumber: 17,
    coreUnits: ['A', 'P', 'Q'],
    threeStars: ['P', 'Q'],
    statTotal: 2,
    rawRows: raw,
    costOf: () => 1,
  });
  assert.equal(p.carryGrade3.has('P'), false); // 3★ from augment copies, nobody items it
  assert.equal(p.carryGrade3.has('Q'), true); // 3★ and reliably top-itemized
  assert.equal(p.unitWeights.get('P'), 1); // still identity weight — 3★ is cluster identity
});

test('doubled units form copySig; multiset collapses to distinct units', () => {
  const p = buildCompProfile({
    compId: 4,
    setNumber: 17,
    coreUnits: ['A', 'A', 'B', 'C'],
    threeStars: ['A'],
    statTotal: 5,
    rawRows: [],
    costOf: () => 1,
  });
  assert.equal(p.copySig, 'A');
  assert.deepEqual([...p.units].sort(), ['A', 'B', 'C']);
  assert.equal(p.boardCount, 5);
  assert.equal(p.carries.size, 0); // no board data → no carries, no fallback
});

test('copySig: doubled 4/5-costs are bench copies, not the duplicate augment', () => {
  const cheap = buildCompProfile({
    compId: 5,
    setNumber: 17,
    coreUnits: ['O', 'O', 'S', 'S', 'B'],
    threeStars: ['O', 'S'],
    statTotal: 3,
    rawRows: [],
    costOf: (id) => (id === 'B' ? 5 : 3),
  });
  assert.equal(cheap.copySig, 'O|S'); // doubled 3-costs → augment class
  const expensive = buildCompProfile({
    compId: 6,
    setNumber: 17,
    coreUnits: ['Y', 'Y', 'A', 'B'],
    threeStars: [],
    statTotal: 3,
    rawRows: [],
    costOf: (id) => (id === 'Y' ? 4 : 2),
  });
  assert.equal(expensive.copySig, ''); // doubled 4-cost → classic board state
});

test('buildTailProfile: light profile from comps-table data only', () => {
  const p = buildTailProfile({
    compId: 9,
    setNumber: 17,
    coreUnits: ['A', 'A', 'B', 'C'],
    threeStars: ['A', 'B'],
    statTotal: 4,
    costOf: () => 1,
  });
  assert.equal(p.copySig, 'A');
  assert.deepEqual([...p.units].sort(), ['A', 'B', 'C']);
  assert.deepEqual([...p.carryGrade3].sort(), ['A', 'B']); // FULL 3★ set
  assert.equal(p.carries.size, 0); // itemization unknown
  assert.equal(p.heroAugmentSig, '');
  assert.equal(p.unitWeights.size, 0); // neutral weights
  assert.equal(p.boardCount, 4);
});

test('classifyCarries: zero completed items never counts as top-itemized', () => {
  const raw = rows([
    { A: [], B: [], C: [] },
    { A: [], B: [], C: [] },
  ]);
  const out = classifyCarries(raw, 2, new Set());
  assert.ok(out.length > 0);
  for (const c of out) {
    assert.equal(c.topItemizedRate, 0);
    assert.equal(c.isBucketCarry, false);
  }
});
