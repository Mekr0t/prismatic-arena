import test from 'node:test';
import assert from 'node:assert/strict';
import { pickVariants, type VariantTally } from './variant-resolve';

// The fold that turns per-comp variant tallies into "what face does this tile
// show". The SQL half needs a database; this half decides what the user sees,
// and getting it wrong shows a confidently wrong Lux.

const t = (compId: number, variantId: string, boards: number): VariantTally => ({
  compId,
  base: 'DA_Lux18_Base',
  variantId,
  boards,
});

test('the most-played variant wins', () => {
  const out = pickVariants([t(1, 'DA_18_Lux_Coven', 3), t(1, 'DA_18_Lux_Fae', 7)], [1]);
  assert.equal(out.get('DA_Lux18_Base'), 'DA_18_Lux_Fae');
});

test('boards are summed ACROSS a pooled row, not decided per comp', () => {
  // The whole reason resolveVariants returns tallies instead of a decision: comp
  // 2 alone prefers Coven, but the row it belongs to overwhelmingly plays Fae.
  const tallies = [t(1, 'DA_18_Lux_Fae', 40), t(2, 'DA_18_Lux_Coven', 5), t(2, 'DA_18_Lux_Fae', 3)];
  assert.equal(pickVariants(tallies, [1, 2]).get('DA_Lux18_Base'), 'DA_18_Lux_Fae');
  // ...and that comp on its own still reports its own answer.
  assert.equal(pickVariants(tallies, [2]).get('DA_Lux18_Base'), 'DA_18_Lux_Coven');
});

test('comps outside the row are ignored', () => {
  const tallies = [t(1, 'DA_18_Lux_Coven', 2), t(99, 'DA_18_Lux_Solar', 500)];
  assert.equal(pickVariants(tallies, [1]).get('DA_Lux18_Base'), 'DA_18_Lux_Coven');
});

test('a tie breaks on the id, so a row does not flicker between requests', () => {
  const a = pickVariants([t(1, 'DA_18_Lux_Solar', 4), t(1, 'DA_18_Lux_Coven', 4)], [1]);
  const b = pickVariants([t(1, 'DA_18_Lux_Coven', 4), t(1, 'DA_18_Lux_Solar', 4)], [1]);
  assert.equal(a.get('DA_Lux18_Base'), b.get('DA_Lux18_Base'), 'input order must not matter');
  assert.equal(a.get('DA_Lux18_Base'), 'DA_18_Lux_Coven');
});

test('no tallies means no override — the tile shows what Riot reported', () => {
  assert.equal(pickVariants([], [1]).size, 0);
  assert.equal(pickVariants([t(1, 'DA_18_Lux_Fae', 2)], []).size, 0);
});

test('separate families resolve independently', () => {
  const tallies: VariantTally[] = [
    t(1, 'DA_18_Lux_Fae', 5),
    { compId: 1, base: 'OtherBase', variantId: 'OtherVariant', boards: 2 },
  ];
  const out = pickVariants(tallies, [1]);
  assert.equal(out.get('DA_Lux18_Base'), 'DA_18_Lux_Fae');
  assert.equal(out.get('OtherBase'), 'OtherVariant');
});
