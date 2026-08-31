import test from 'node:test';
import assert from 'node:assert/strict';
import { STAT_ICONS } from '@/lib/stat-icons';
import {
  isSetItem, itemIdPrefixes, traitContribution, traitValueIcons, traitDescriptionExtra,
} from './set-config';

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

test('traits whose rows publish a bare number get their stat glyphs', () => {
  // Defender's row is literally "(@MinUnits@) @DefenderDefenseGain@" — the game
  // draws the icons itself, so read alone the row is just "25".
  assert.deepEqual(traitValueIcons(18, 'DA_18_Defender'), [['armor', 'mr']]);
  // Placement differs per trait, which is why these are GROUPS per slot.
  // Adaptor splits around "OR"; Fae keeps both together mid-sentence.
  assert.deepEqual(traitValueIcons(18, 'DA_18_Adaptor'), [['ad'], ['ap']]);
  assert.deepEqual(traitValueIcons(18, 'DA_18_Fae'), [['ad', 'ap']]);
});

test('traits that name their own stats are left alone', () => {
  // Inferring from intro prose was measured and gets these wrong: Ravager's
  // intro says Omnivamp while its rows are about Bonus Damage, and Fae's names
  // three stats for a two-value row. Both must stay empty.
  assert.deepEqual(traitValueIcons(18, 'DA_18_Slayer'), [], 'Ravager');
  assert.deepEqual(traitValueIcons(18, 'DA_18_Solar'), [], 'already carries explicit icons');
  assert.deepEqual(traitValueIcons(18, 'DA_Riftbeast18'), [], 'already carries explicit icons');
});

test('an unconfigured trait or set injects nothing', () => {
  assert.deepEqual(traitValueIcons(18, 'DA_18_NotATrait'), []);
  assert.deepEqual(traitValueIcons(17, 'TFT17_AssassinTrait'), []);
  assert.deepEqual(traitValueIcons(99, 'DA_18_Defender'), []);
});

test('every configured icon key is a real one', () => {
  for (const id of ['DA_18_Defender', 'DA_18_Adaptor', 'DA_18_Fae']) {
    for (const group of traitValueIcons(18, id)) {
      assert.ok(group.length > 0, `${id}: an empty group would consume a slot for nothing`);
      for (const k of group) assert.ok(k in STAT_ICONS, `${id}: ${k} is not a defined stat icon`);
    }
  }
});

test('Primal carries the four Blessings CDragon never lists', () => {
  // Its published description is only "Choose one of four Primal Blessings.",
  // and its breakpoints have no text — so the tooltip asked the reader to pick
  // between options it did not show.
  const extra = traitDescriptionExtra(18, 'DA_Primal18');
  const lines = extra.split('\n').filter(Boolean);
  assert.equal(lines.length, 4, 'four Blessings, one per line');
  assert.match(lines[0], /executes enemies below 12% Health/);
  assert.match(lines[1], /Every 15 Primal takedowns/);
  assert.match(lines[2], /35% Attack Speed/);
  assert.match(lines[3], /heals for 4%/);
});

test('the extra never repeats the description it is appended to', () => {
  // It is joined onto the published text, so a copy of it would read twice —
  // the bug that made Solar render its paragraph twice.
  assert.doesNotMatch(traitDescriptionExtra(18, 'DA_Primal18'), /Choose one of four/i);
});

test('traits and sets with nothing extra get an empty string', () => {
  assert.equal(traitDescriptionExtra(18, 'DA_18_Defender'), '');
  assert.equal(traitDescriptionExtra(17, 'TFT17_AssassinTrait'), '');
  assert.equal(traitDescriptionExtra(99, 'DA_Primal18'), '');
});
