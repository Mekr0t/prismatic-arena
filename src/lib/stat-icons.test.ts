import test from 'node:test';
import assert from 'node:assert/strict';
import { STAT_ICONS, ATLAS_W, ATLAS_H, statIconKey, type StatIconKey } from './stat-icons';

// Stat icons fail QUIETLY: a wrong rect shows a real glyph, just the wrong one,
// and a missing alias shows bare text next to stats that have an icon. Neither
// throws, so both need pinning.

test('every rect lies inside the atlas', () => {
  for (const [key, i] of Object.entries(STAT_ICONS)) {
    assert.ok(i.x >= 0 && i.y >= 0, `${key}: negative origin`);
    assert.ok(i.x + i.n <= ATLAS_W, `${key}: overruns atlas width`);
    assert.ok(i.y + i.n <= ATLAS_H, `${key}: overruns atlas height`);
  }
});

test('native sizes are the three the atlas actually uses', () => {
  // Not cosmetic: the CSS scales by size/n, so a wrong n renders a crop of the
  // neighbouring glyph rather than the icon.
  for (const [key, i] of Object.entries(STAT_ICONS)) {
    assert.ok([18, 20, 24].includes(i.n), `${key}: unexpected native size ${i.n}`);
  }
});

test('no two stats point at the same rect', () => {
  const seen = new Map<string, string>();
  for (const [key, i] of Object.entries(STAT_ICONS)) {
    const at = `${i.x},${i.y}`;
    assert.equal(seen.get(at), undefined, `${key} shares a rect with ${seen.get(at)}`);
    seen.set(at, key);
  }
});

test('every icon has a spoken label — it is the accessible name', () => {
  for (const [key, i] of Object.entries(STAT_ICONS)) {
    assert.ok(i.label.trim().length > 0, `${key}: empty label`);
  }
});

test('all three vocabularies converge on the same key', () => {
  // CDragon token · unit-grid label · item-stat label
  assert.equal(statIconKey('scaleap'), 'ap');
  assert.equal(statIconKey('AP'), 'ap');
  assert.equal(statIconKey('Ability Power'), 'ap');

  assert.equal(statIconKey('scalemr'), 'mr');
  assert.equal(statIconKey('MR'), 'mr');
  assert.equal(statIconKey('Magic Resist'), 'mr');

  assert.equal(statIconKey('scalehealth'), 'health');
  assert.equal(statIconKey('HP'), 'health');
  assert.equal(statIconKey('Health'), 'health');
});

test('lookup ignores case and surrounding space', () => {
  assert.equal(statIconKey('  ability POWER '), 'ap');
  assert.equal(statIconKey('ScaleAD'), 'ad');
});

test('every alias resolves to a defined icon', () => {
  const names = [
    'scalead', 'tftbasead', 'scaleap', 'scaleas', 'scalehealth', 'scalearmor',
    'scalemr', 'scalerange', 'scaleda', 'scalesv', 'scaledr', 'scalehpregen',
    'tftmanaregen', 'AD', 'AP', 'AS', 'HP', 'Armor', 'MR', 'Range', 'Mana',
    'Crit Chance', 'Attack Damage', 'Ability Power', 'Attack Speed', 'Health',
    'Magic Resist', 'Crit Damage', 'Life Steal', 'Omnivamp', 'Damage Amp',
    'Damage Reduction', 'Durability', 'HP Regen', 'Mana Regen',
  ];
  for (const n of names) {
    const key = statIconKey(n);
    assert.ok(key, `"${n}" resolves to no icon`);
    assert.ok(key! in STAT_ICONS, `"${n}" -> ${key}, which is not defined`);
  }
});

test('an unknown stat resolves to null rather than a wrong icon', () => {
  assert.equal(statIconKey('Durability Rating'), null);
  assert.equal(statIconKey('Meeps'), null, 'no glyph for it — must fall back to text');
  assert.equal(statIconKey(''), null);
  assert.equal(statIconKey(null), null);
  assert.equal(statIconKey(undefined), null);
});

test('the label of an icon resolves back to that same icon', () => {
  // Keeps labels and aliases from drifting: richToPlain substitutes the label,
  // and a label nothing maps back to would round-trip into bare text.
  for (const key of Object.keys(STAT_ICONS) as StatIconKey[]) {
    const back = statIconKey(STAT_ICONS[key].label);
    assert.equal(back, key, `label "${STAT_ICONS[key].label}" maps to ${back}, not ${key}`);
  }
});
