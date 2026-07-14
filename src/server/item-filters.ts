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

export const ITEM_JUNK =
  /Grant|Tutorial|Trainer|Encounter|Tooltip|Debug|Test|Placeholder|Consumable|Reforger|Remover|Duplicator|Magnetic|TacticianCrown|Choncc|Unstable|Component$/i;

export const ITEM_NAME_JUNK =
  /\bAnvil\b|Tome of Traits|^TFT\b|\bMode\b|^Jammed!$|^Unusable Slot$|^game_item_displayname_|^tft_item_name_/i;
