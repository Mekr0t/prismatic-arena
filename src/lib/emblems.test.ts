import test from 'node:test';
import assert from 'node:assert/strict';
import { traitNameFromEmblem, emblemGrantDescription, EMBLEM_BONUSES } from './emblems';

// The rule is "read the trait off the DISPLAY name", and set 18 is the reason:
// DA_18_EmblemSlayer is named "Ravager Emblem" and grants Ravager, so anything
// keying on the id gets that one wrong.

const SET18 = new Set([
  'invoker', 'ravager', 'blossom', 'flora fatalis', 'juggernaut', 'primal',
]);

test('the trait is the name with " Emblem" removed', () => {
  assert.equal(traitNameFromEmblem('Invoker Emblem'), 'Invoker');
  assert.equal(traitNameFromEmblem('Ravager Emblem'), 'Ravager');
});

test('multi-word trait names survive intact', () => {
  assert.equal(traitNameFromEmblem('Flora Fatalis Emblem'), 'Flora Fatalis');
});

test('an item that is not an emblem yields nothing', () => {
  assert.equal(traitNameFromEmblem("Rabadon's Deathcap"), null);
  assert.equal(traitNameFromEmblem('Emblem'), null, 'no trait name in front of it');
  assert.equal(traitNameFromEmblem(''), null);
  assert.equal(traitNameFromEmblem(null), null);
  assert.equal(traitNameFromEmblem(undefined), null);
});

test('the grant line matches the wording every other set uses', () => {
  // Blossom rather than Invoker: Invoker has a transcribed bonus appended, and
  // this test is about the grant line's wording on its own.
  assert.equal(
    emblemGrantDescription('Blossom Emblem', SET18),
    'The holder gains the Blossom trait.',
  );
});

test('the grant follows the NAME, not the id', () => {
  // DA_18_EmblemSlayer is "Ravager Emblem". Ravager is the right answer; an
  // id-based rule would have said Slayer. Matched as a prefix because Ravager
  // also carries a transcribed bonus.
  assert.match(
    emblemGrantDescription('Ravager Emblem', SET18)!,
    /^The holder gains the Ravager trait\./,
  );
});

test('an emblem for a trait this set does not have is refused', () => {
  // Guards against inventing a grant from another set's emblem — the items
  // table holds CDragon's whole global catalog under the live set number.
  assert.equal(emblemGrantDescription('Academy Emblem', SET18), null);
  assert.equal(emblemGrantDescription('Duelist Emblem', SET18), null);
});

test('a non-emblem item never gets a grant line', () => {
  assert.equal(emblemGrantDescription('Spatula', SET18), null);
  assert.equal(emblemGrantDescription(null, SET18), null);
});

test('trait matching ignores case', () => {
  const out = emblemGrantDescription('INVOKER Emblem', SET18)!;
  assert.match(
    out,
    /^The holder gains the INVOKER trait\./,
    'the sentence keeps the name as written, but the lookup is case-insensitive',
  );
});

test('a transcribed bonus is appended after the grant line', () => {
  const out = emblemGrantDescription('Invoker Emblem', SET18)!;
  const [grant, blank, bonus] = out.split('\n');
  assert.equal(grant, 'The holder gains the Invoker trait.');
  assert.equal(blank, '', 'blank line between them, as the game separates them');
  assert.equal(bonus, EMBLEM_BONUSES.invoker);
});

test('an emblem with no transcribed bonus gets the grant line alone', () => {
  // Half the set's emblems genuinely have no extra effect. That is an answer,
  // not a gap, and must not read as a truncated sentence.
  assert.equal(EMBLEM_BONUSES.blossom, undefined, 'fixture assumption');
  assert.equal(
    emblemGrantDescription('Blossom Emblem', SET18),
    'The holder gains the Blossom trait.',
  );
});

test('every bonus is keyed by a lowercase trait name and reads as a sentence', () => {
  for (const [key, text] of Object.entries(EMBLEM_BONUSES)) {
    assert.equal(key, key.toLowerCase(), `${key}: keys are lowercased for lookup`);
    assert.ok(text.trim().length > 10, `${key}: too short to be a real effect`);
    assert.match(text.trim(), /[.!]$/, `${key}: should end as a sentence`);
    assert.doesNotMatch(text, /holder gains the/i, `${key}: duplicates the grant line`);
  }
});
