// stat-icons.ts — the one place a stat is tied to its in-game icon.
//
// TFT's stat glyphs live in a single texture atlas, `ASSETS/UX/Fonts/TextIcons.tex`,
// which CommunityDragon serves as texticons.png. The rectangles below are not
// guesses: they are the `mTextureUV` values the game's own unit-info card uses,
// read out of
//   clientstates/gameplay/ux/tft/tftunitinfo/uibase.cdtb.bin.json
// where each `*_Icon` element declares `mTextureName: "ASSETS/UX/Fonts/TextIcons.tex"`
// alongside its rect. Four stats the card never displays (health, health regen,
// mana, mana regen) are not in that file; their rects were read off the atlas
// directly and are marked below.
//
// The atlas declares itself 256 x 512 (`mTextureSourceResolutionWidth/Height`),
// and the CSS positions every icon against those dimensions. If Riot ever
// re-lays-out the sheet, every icon silently becomes the wrong glyph rather than
// breaking loudly — `npm run icons:check` exists to catch exactly that.

export const ATLAS_W = 256;
export const ATLAS_H = 512;
export const ATLAS_URL =
  'https://raw.communitydragon.org/latest/game/assets/ux/fonts/texticons.png';

export interface StatIcon {
  /** Top-left corner in atlas pixels. */
  x: number;
  y: number;
  /** Native square size in atlas pixels — the icons are NOT uniform (18, 20, 24),
   *  so the CSS scales each one to a common rendered size using this. */
  n: number;
  /** Spoken name, used as the accessible label. */
  label: string;
}

export type StatIconKey =
  | 'ad' | 'ap' | 'as' | 'health' | 'healthregen' | 'armor' | 'mr'
  | 'range' | 'crit' | 'mana' | 'manaregen' | 'omnivamp'
  | 'damageamp' | 'damagereduction';

export const STAT_ICONS: Record<StatIconKey, StatIcon> = {
  ad:              { x: 1,  y: 25,  n: 18, label: 'Attack Damage' },
  ap:              { x: 97, y: 25,  n: 18, label: 'Ability Power' },
  as:              { x: 25, y: 49,  n: 18, label: 'Attack Speed' },
  armor:           { x: 1,  y: 49,  n: 18, label: 'Armor' },
  mr:              { x: 73, y: 1,   n: 18, label: 'Magic Resist' },
  crit:            { x: 72, y: 48,  n: 20, label: 'Critical Strike' },
  range:           { x: 72, y: 72,  n: 24, label: 'Range' },
  omnivamp:        { x: 26, y: 25,  n: 20, label: 'Omnivamp' },
  damageamp:       { x: 26, y: 195, n: 20, label: 'Damage Amp' },
  damagereduction: { x: 50, y: 195, n: 20, label: 'Damage Reduction' },
  // Read off the atlas directly — the unit-info card does not show these four.
  health:          { x: 97, y: 49,  n: 18, label: 'Health' },
  healthregen:     { x: 1,  y: 97,  n: 18, label: 'Health Regen' },
  mana:            { x: 1,  y: 1,   n: 18, label: 'Mana' },
  manaregen:       { x: 25, y: 1,   n: 18, label: 'Mana Regen' },
};

/**
 * Every name that should resolve to an icon, lowercased.
 *
 * Three vocabularies converge here and they do NOT agree with each other:
 *   - CDragon's `%i:scaleAP%` icon tokens in description text
 *   - the terse labels the unit stat grid uses ("AP", "MR")
 *   - the spelled-out labels item stats use ("Ability Power", "Magic Resist")
 * Mapping them in one table is what keeps the same stat from showing an icon in
 * one place and bare text in another.
 */
const ALIASES: Record<string, StatIconKey> = {
  // CDragon icon token names
  scalead: 'ad', tftbasead: 'ad', scaleap: 'ap', scaleas: 'as',
  scalehealth: 'health', scalearmor: 'armor', scalemr: 'mr',
  scalerange: 'range', scaleda: 'damageamp', scalesv: 'omnivamp',
  scaledr: 'damagereduction', scalehpregen: 'healthregen',
  tftmanaregen: 'manaregen',
  // Unit stat grid labels
  ad: 'ad', ap: 'ap', as: 'as', hp: 'health', armor: 'armor', mr: 'mr',
  range: 'range', mana: 'mana', 'crit chance': 'crit',
  // Item stat labels
  'attack damage': 'ad', 'ability power': 'ap', 'attack speed': 'as',
  health: 'health', 'magic resist': 'mr', 'crit damage': 'crit',
  'life steal': 'omnivamp', omnivamp: 'omnivamp', 'damage amp': 'damageamp',
  'damage reduction': 'damagereduction', durability: 'damagereduction',
  'hp regen': 'healthregen', 'mana regen': 'manaregen',
  // Each icon's own `label` must map back to it: richToPlain substitutes the
  // label when flattening «icon:…» for tooltips, and a label that resolves to
  // nothing would round-trip an icon into bare, un-iconned text.
  'critical strike': 'crit', 'health regen': 'healthregen',
};

/** Icon key for a stat name from any of the three vocabularies, or null. */
export function statIconKey(name: string | null | undefined): StatIconKey | null {
  if (!name) return null;
  return ALIASES[name.trim().toLowerCase()] ?? null;
}
