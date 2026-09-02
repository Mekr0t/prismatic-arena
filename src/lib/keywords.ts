// keywords.ts — definitions for the TFT keywords CDragon references but does
// not inline.
//
// Most item text explains its own keywords: Morellonomicon ships a rules block
// spelling out Burn and Wound, so those arrive for free. Others instead carry a
// TEMPLATE REFERENCE — `{{TFT_Keyword_Precision}}` — pointing at a definition
// that lives in the game client, not in the published data. The loader used to
// strip `{{…}}` wholesale, which is why Jeweled Gauntlet and Infinity Edge read
// "Gain Precision." and stopped, while Morellonomicon got a glossary.
//
// WHY THIS IS CURATED RATHER THAN HARVESTED. The obvious fix is to scrape the
// definitions out of the entries that DO spell them out. That was tried and is
// unsafe: Riot's own data contradicts itself. Both of these ship today —
//
//   TFT15_HiddenTech_AffinityForCold   "Chill: Reduce healing received by 20%"
//   TFT4_Item_OrnnEternalWinter        "Chill: reduce Attack Speed"
//
// — and Chill reduces Attack Speed; the first entry has Wound's effect pasted
// into it. A harvester picks whichever it happens to reach first, silently, and
// a wrong definition is worse than no definition. So each entry below is
// transcribed from Riot's text with the source that justifies it recorded.
//
// Keys match the `{{TFT_Keyword_<Key>}}` reference, case-insensitively.

export interface Keyword {
  /** Display name, as it should read at the head of the glossary line. */
  name: string;
  /** Definition, verbatim from the game's own wording. */
  text: string;
}

export const KEYWORDS: Record<string, Keyword> = {
  // Defined identically by DA_Retribution, DA_JeweledLotus_I and
  // DA_JeweledLotus_II — three set-18 sources that agree word for word.
  precision: {
    name: 'Precision',
    text: 'Ability damage can critically strike. Additional Precision grants 10% Critical Strike Damage.',
  },
  // 11 entries define this identically (Morellonomicon, Searing Shortbow, …).
  burn: {
    name: 'Burn',
    text: "Deals a percent of the target's max Health as true damage every second",
  },
  // 16 entries, all in agreement.
  wound: {
    name: 'Wound',
    text: 'Reduces healing received',
  },
  // The contradiction above. TFT4_Item_OrnnEternalWinter is the correct one:
  // Chill slows attacks, it does not touch healing.
  chill: {
    name: 'Chill',
    text: 'Reduce Attack Speed',
  },
};

/** Definition for a `{{TFT_Keyword_X}}` reference name, or null. */
export function keywordFor(ref: string | null | undefined): Keyword | null {
  if (!ref) return null;
  const m = ref.match(/^TFT_Keyword_(.+)$/i);
  if (!m) return null;
  return KEYWORDS[m[1].trim().toLowerCase()] ?? null;
}
