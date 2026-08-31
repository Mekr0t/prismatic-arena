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
 * It deliberately stops there. The per-emblem BONUS line — Invoker's "On cast,
 * gain Ability Power equal to 10% of Mana spent" — is not published anywhere
 * for set 18, and a guessed effect shown as fact is worse than a short entry.
 */
export function emblemGrantDescription(
  itemName: string | null | undefined,
  liveTraitNames: ReadonlySet<string>,
): string | null {
  const traitName = traitNameFromEmblem(itemName);
  if (!traitName) return null;
  if (!liveTraitNames.has(traitName.toLowerCase())) return null;
  return `The holder gains the ${traitName} trait.`;
}
