export const COMPONENT_IDS = new Set([
  'TFT_Item_BFSword',
  'TFT_Item_RecurveBow',
  'TFT_Item_NeedlesslyLargeRod',
  'TFT_Item_TearOfTheGoddess',
  'TFT_Item_ChainVest',
  'TFT_Item_NegatronCloak',
  'TFT_Item_GiantsBelt',
  'TFT_Item_SparringGloves',
  'TFT_Item_Spatula',
  'TFT_Item_FryingPan',
]);

// Superset used when counting "completed" items on a board: components plus
// EmptyBag (a filler slot in match data, not a buildable component). Everything
// NOT in this set (finished items, radiants, artifacts, trait emblems) counts
// as completed. Shared by carry-classify, comps-example-team, and
// comp-detail-service so the three paths can never drift apart.
export const COMPONENT_ITEMS = new Set([...COMPONENT_IDS, 'TFT_Item_EmptyBag']);

// Artifact-class items are RNG acquisitions (Artifact Anvils, portals,
// augments), never craftable from components: the modern TFT_Item_Artifact_*
// pool plus the legacy Ornn families (TFT4_/TFT9_Item_Ornn*, e.g. Gold
// Collector = TFT4_Item_OrnnTheCollector) and event variants
// (TFTEventPM_Item_Artifact_*). Used to classify Library items and to keep
// artifacts out of example-board "recommended" item sets.
export const ARTIFACT_ID_RE = /_Item_Artifact_|_Item_Ornn/i;
export function isArtifactItem(itemId: string): boolean {
  return ARTIFACT_ID_RE.test(itemId);
}

// Set-mechanic special items — granted by a set mechanic, never craftable
// (set 17: Anima Squad cashout weapons, the Ekko Offering anomaly). They stay
// COUNTED as completed items everywhere (user ruling 2026-07-17: anima weapons
// are only played on cashout boards, so they are an identity signal, not
// noise) — this class only steers display preference away from them on
// ordinary lines. The patterns live in the per-set registry (`set-config.ts`);
// imported + re-exported here so item-classification callers keep one import
// surface (isRadiantItem / isRngAcquiredItem below compose with it).
import { isMechanicItem } from './set-config';
export { isMechanicItem };

// Radiant items — upgraded item variants, even rarer than artifacts (all
// equipped ids carry a "Radiant" token, e.g. …_Radiant / …_RadiantField).
// Anima weapons are excluded: TFT17_AnimaSquadItem_Tier2/3_RadiantField carries
// the token but is a cashout weapon, not a radiant upgrade.
export const RADIANT_ID_RE = /Radiant/i;
export function isRadiantItem(itemId: string): boolean {
  return RADIANT_ID_RE.test(itemId) && !isMechanicItem(itemId);
}

/** RNG-acquired item (artifact, radiant, or set-mechanic special) — never a
 *  plannable build, so example boards prefer sets without one (see
 *  comps-example-team). */
export function isRngAcquiredItem(itemId: string): boolean {
  return isArtifactItem(itemId) || isRadiantItem(itemId) || isMechanicItem(itemId);
}

export const ITEM_JUNK =
  /Grant|Tutorial|Trainer|Encounter|Tooltip|Debug|Test|Placeholder|Consumable|Reforger|Remover|Duplicator|Magnetic|TacticianCrown|Choncc|Unstable|Component$/i;

export const ITEM_NAME_JUNK =
  /\bAnvil\b|Tome of Traits|^TFT\b|\bMode\b|^Jammed!$|^Unusable Slot$|^game_item_displayname_|^tft_item_name_/i;
