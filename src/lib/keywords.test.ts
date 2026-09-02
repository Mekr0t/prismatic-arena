import test from 'node:test';
import assert from 'node:assert/strict';
import { KEYWORDS, keywordFor } from './keywords';

// The glossary is transcribed, not derived, so the risk is a definition that is
// confidently wrong. Chill is the reason it is transcribed at all: Riot ships
// two contradictory definitions for it, and a harvester would pick whichever it
// reached first.

test('a TFT_Keyword_ reference resolves to its definition', () => {
  const p = keywordFor('TFT_Keyword_Precision');
  assert.equal(p?.name, 'Precision');
  assert.match(p!.text, /Ability damage can critically strike/);
});

test('the reference name is matched case-insensitively', () => {
  assert.equal(keywordFor('tft_keyword_precision')?.name, 'Precision');
  assert.equal(keywordFor('TFT_KEYWORD_BURN')?.name, 'Burn');
});

test('Chill is the Attack Speed definition, not the healing one', () => {
  // TFT15_HiddenTech_AffinityForCold ships "Chill: Reduce healing received by
  // 20%", which is Wound's effect pasted into the wrong entry. If this ever
  // reads like Wound again, the harvesting mistake has come back.
  const chill = keywordFor('TFT_Keyword_Chill')!;
  assert.match(chill.text, /Attack Speed/i);
  assert.doesNotMatch(chill.text, /healing/i);
});

test('Wound and Chill stay distinct', () => {
  assert.notEqual(KEYWORDS.wound.text, KEYWORDS.chill.text);
});

test('references that are not keywords resolve to null', () => {
  // Item-specific template refs share the {{…}} syntax and must keep being
  // dropped rather than matching some keyword by accident.
  assert.equal(keywordFor('TFT13_ChemBaronOnlyItem'), null);
  assert.equal(keywordFor('TFT17_SpaceGroove_TheGroove'), null);
  assert.equal(keywordFor('Precision'), null, 'bare name is not a reference');
  assert.equal(keywordFor(''), null);
  assert.equal(keywordFor(null), null);
});

test('an unknown keyword resolves to null so the loader can report it', () => {
  assert.equal(keywordFor('TFT_Keyword_Shred'), null);
});

test('every definition is non-empty and does not restate its own name', () => {
  for (const [key, kw] of Object.entries(KEYWORDS)) {
    assert.ok(kw.name.trim(), `${key}: empty name`);
    assert.ok(kw.text.trim().length > 10, `${key}: definition too short to be real`);
    // The renderer emits "«bold:Name»: text", so a definition starting with its
    // own name would render "Burn: Burn: deals…".
    assert.doesNotMatch(kw.text, new RegExp(`^${kw.name}\\s*:`, 'i'), `${key}: duplicates its name`);
  }
});

test('every key matches the name it resolves to', () => {
  for (const [key, kw] of Object.entries(KEYWORDS)) {
    assert.equal(key, kw.name.toLowerCase(), `${key} is keyed differently from "${kw.name}"`);
    assert.equal(keywordFor(`TFT_Keyword_${kw.name}`)?.name, kw.name);
  }
});
