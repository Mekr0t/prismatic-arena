import test from 'node:test';
import assert from 'node:assert/strict';
import { isSetItem, itemIdPrefixes, traitContribution } from './set-config';

// The registry holds per-set knowledge that cannot be derived from CDragon.
// Two things here are load-bearing enough to pin:
//
//   1. The item-id namespace. Sets 1-17 all used TFT{n}_Item_, so the prefix
//      was hardcoded — and set 18 shipping as DA_18_* made 156 emblems
//      invisible to both the library and the planner. A fallback that silently
//      returned the old convention for set 18 would reintroduce exactly that.
//   2. Trait multipliers. Riot publishes them only in trait prose, so they are
//      transcribed; a wrong id here is a silently wrong trait count.

test('set 18 items live under DA_18_, not the TFT{n}_Item_ convention', () => {
  assert.ok(itemIdPrefixes(18).includes('DA_18_'));
  assert.ok(isSetItem(18, 'DA_18_EmblemCoven'), 'the emblem class that was invisible');
  assert.ok(isSetItem(18, 'DA_18_EmblemBlackthorn'));
});

test('the cross-set item pool belongs to every set', () => {
  assert.ok(isSetItem(18, 'TFT_Item_BFSword'));
  assert.ok(isSetItem(17, 'TFT_Item_BFSword'));
});

test("one set's own items do not leak into another", () => {
  assert.ok(!isSetItem(17, 'DA_18_EmblemCoven'), 'set 18 ids are not set-17 items');
  assert.ok(!isSetItem(18, 'TFT17_Item_ArtifactAnvil'), 'and the reverse');
});

test('an unconfigured set falls back to the pre-set-18 convention', () => {
  assert.deepEqual(itemIdPrefixes(99), ['TFT99_Item_']);
  assert.ok(isSetItem(99, 'TFT99_Item_Whatever'));
  assert.ok(isSetItem(99, 'TFT_Item_BFSword'));
});

test('Elder Dragon counts as two Riftbeasts', () => {
  assert.equal(traitContribution(18, 'DA_18_ElderDragon', 'DA_Riftbeast18'), 2);
});

test('Elder Dragon counts once for its OTHER trait', () => {
  assert.equal(traitContribution(18, 'DA_18_ElderDragon', 'DA_18_ApexPredator'), 1);
});

test('every Lux variant doubles her chosen trait, across both id spellings', () => {
  // Set 18 spells the family two ways — DA_18_Lux_* and DA_Lux18_* — which is
  // why the rule is a pattern and not a list of ids.
  assert.equal(traitContribution(18, 'DA_18_Lux_Coven', 'DA_18_Coven'), 2);
  assert.equal(traitContribution(18, 'DA_18_Lux_Sunbeam', 'DA_18_Solar'), 2);
  assert.equal(traitContribution(18, 'DA_Lux18_Blossom', 'DA_18_Blossom'), 2);
  assert.equal(traitContribution(18, 'DA_Lux18_Blackthorn', 'DA_18_Blackthorn'), 2);
});

test('Avatar itself is never the doubled trait', () => {
  assert.equal(traitContribution(18, 'DA_18_Lux_Coven', 'DA_18_LuxUniqueTrait'), 1);
  // Base Lux carries ONLY Avatar, so she doubles nothing — she has not chosen.
  assert.equal(traitContribution(18, 'DA_Lux18_Base', 'DA_18_LuxUniqueTrait'), 1);
});

test('an ordinary unit counts once, and set 17 has no multipliers at all', () => {
  assert.equal(traitContribution(18, 'DA_18_Ahri', 'DA_18_Blossom'), 1);
  assert.equal(traitContribution(17, 'TFT17_Poppy', 'TFT17_AssassinTrait'), 1);
});

test('an unconfigured set never multiplies', () => {
  assert.equal(traitContribution(99, 'DA_18_ElderDragon', 'DA_Riftbeast18'), 1);
});
