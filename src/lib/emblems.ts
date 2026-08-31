// emblems.ts — reading the trait out of a trait emblem.
//
// An emblem grants its wearer a trait, and the only reliable link between the
// two is the emblem's DISPLAY NAME: "Invoker Emblem" grants Invoker. The id
// cannot be trusted for it — set 18 ships `DA_18_EmblemSlayer` named "Ravager
// Emblem", granting Ravager — and CDragon's `associatedTraits` field is empty
// on every one of set 18's 21 emblems.
//
// Lives here because three callers need the same rule (the planner's trait
// engine, the static-data loader's description fallback, and comp tooling), and
// three copies of a regex would eventually disagree about the one emblem whose
// name and id differ.

/** The trait's DISPLAY name for an emblem item name, or null if not an emblem. */
export function traitNameFromEmblem(itemName: string | null | undefined): string | null {
  if (!itemName) return null;
  const m = itemName.match(/^(.*?)\s+Emblem$/i);
  const name = m?.[1]?.trim();
  return name ? name : null;
}

/**
 * Per-emblem bonus effects, transcribed by hand.
 *
 * Set 18's emblems publish NOTHING — `desc: null`, `effects: {}`, no
 * `associatedTraits` — so unlike the trait-grant line above, the bonus cannot be
 * derived from anything. It is not in the emblem entry, the trait description,
 * or anywhere else in the catalog; it was searched for.
 *
 * Keyed by the trait's DISPLAY name, lowercased. Only ~half the emblems have a
 * bonus at all; an absent key simply means the emblem grants its trait and
 * nothing more, which is a real answer rather than a gap.
 *
 * TRANSCRIBE, DO NOT GUESS. An entry here is shown to users as fact, so it
 * should be copied from the in-game tooltip verbatim. Anything uncertain is
 * better left out — the grant line alone is honest, a wrong effect is not.
 *
 * TEMPORARY, like the set-18 trait bridge before it: CDragon caught up on
 * champions within days of launch, and `emblemGrantDescription` already prefers
 * published text over anything here. When Riot publishes emblem descriptions,
 * these entries stop being reached and can be deleted.
 *
 * Remaining set-18 emblems, for whoever fills these in — uncomment and complete
 * the ones that have an effect, delete the rest:
 *   blackthorn, blossom, brawler, coven, defender, elderwood, executioner,
 *   fae, flora fatalis, hunter, inferno, juggernaut, lunar, primal, rapidfire,
 *   ravager, spellweaver, sprykin, vanguard
 */
export const EMBLEM_BONUSES: Record<string, string> = {
  invoker: 'On cast, gain Ability Power equal to 10% of Mana spent.',
};

/**
 * The opening line every set's emblem description uses, for an emblem CDragon
 * has published no text for.
 *
 * Set 18's emblems ship with `desc: null`, `effects: {}` and no
 * `associatedTraits` — nothing — so the Library showed a named icon above an
 * empty body. Every other set opens the same way ("The holder gains the Academy
 * trait."), and that half is derivable.
 *
 * `liveTraitNames` gates it: an emblem whose name matches no trait in the set
 * being loaded returns null, so this can never invent a grant.
 *
 * A hand-transcribed bonus from EMBLEM_BONUSES is appended when one exists.
 * Nothing is invented: an emblem with no entry gets the grant line alone.
 */
export function emblemGrantDescription(
  itemName: string | null | undefined,
  liveTraitNames: ReadonlySet<string>,
): string | null {
  const traitName = traitNameFromEmblem(itemName);
  if (!traitName) return null;
  const key = traitName.toLowerCase();
  if (!liveTraitNames.has(key)) return null;
  const grant = `The holder gains the ${traitName} trait.`;
  const bonus = EMBLEM_BONUSES[key];
  // Blank line between the grant and the bonus, matching how the game separates
  // them and how the Precision glossary already reads.
  return bonus ? `${grant}\n\n${bonus}` : grant;
}
