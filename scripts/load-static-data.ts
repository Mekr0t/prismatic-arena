import 'dotenv/config';
import { Pool } from 'pg';
// The roster gate lives in its own module so this file and _set-readiness.ts
// cannot disagree about when a set is loadable (this file self-runs on
// import, so nothing can import the threshold FROM here).
import { MIN_REAL_ROSTER, rosterSize, canonicalEntry } from './cdragon-set';
import { statIconKey } from '@/lib/stat-icons';
import { keywordFor } from '@/lib/keywords';
import { emblemGrantDescription, traitNameFromEmblem, EMBLEM_BONUSES } from '@/lib/emblems';
import { lookupBinField } from '@/lib/bin-hash';
import { traitValueIcons } from '@/server/set-config';
import type { StatIconKey } from '@/lib/stat-icons';

// Community Dragon serves the canonical TFT catalog whose apiName fields match
// tft-match-v1 exactly (TFT17_Ezreal, TFT_Item_BlueBuff, TFT17_AssassinTrait).
// "latest" tracks the current patch.
const TFT_DATA_URL =
  process.env.TFT_DATA_URL ??
  'https://raw.communitydragon.org/latest/cdragon/tft/en_us.json';

// ── Community Dragon shapes (loose — fields are accessed defensively) ─────────
interface CDragonTraitEffect {
  minUnits?: number;
  maxUnits?: number | null;
  style?: number;
  min?: number;
  max?: number;
  // CDragon variable values are usually numbers but can be strings/arrays for
  // some traits — callers guard with `typeof v === 'number'`.
  variables?: Record<string, unknown>;
}
interface CDragonTrait {
  apiName?: string;
  name?: string; // display name, e.g. "Assassin"
  desc?: string; // general trait description
  icon?: string;
  effects?: CDragonTraitEffect[];
}
interface CDragonChampion {
  apiName?: string; // e.g. "TFT17_Ezreal" — matches match-v1 character_id
  name?: string; // e.g. "Ezreal"
  cost?: number;
  role?: string; // e.g. "APCaster"
  traits?: string[]; // DISPLAY names, e.g. ["Dark Star", "Assassin"]
  icon?: string;
  tileIcon?: string;
  ability?: {
    name?: string;
    desc?: string;
    icon?: string;
    variables?: { name?: string; value?: (number | null)[] }[];
  };
  stats?: {
    hp?: number;
    initialMana?: number;
    armor?: number;
    magicResist?: number;
    attackDamage?: number;
    abilityPower?: number;
    attackSpeed?: number;
    critChance?: number;
    critMultiplier?: number;
    range?: number;
  };
}
interface CDragonSet {
  mutator?: string; // e.g. "TFTSet17"
  name?: string;
  number?: number;
  champions?: CDragonChampion[];
  traits?: CDragonTrait[];
  augments?: string[]; // apiNames of augments in this set
}
interface CDragonItem {
  apiName?: string; // e.g. "TFT_Item_BlueBuff"
  name?: string;
  icon?: string;
  desc?: string; // item or augment description
  composition?: string[]; // 2-element array of component apiNames for craftable items
  effects?: Record<string, number>; // augments: { Tier: 1|2|3 } where 1=Silver 2=Gold 3=Prismatic
}
interface CDragonData {
  items?: CDragonItem[];
  setData?: CDragonSet[];
  sets?: Record<string, CDragonSet>;
}

// Curated stat keys from an item's CDragon `effects` map → display label + kind.
// `pct` values are inconsistent in the data — sometimes a fraction (AD 0.15 =
// 15%), sometimes already a whole percent (AS 10 = 10%, CritChance 35 = 35%) —
// so a value < 1 is treated as a fraction (×100) and ≥ 1 as an already-whole
// percent. `flat` values (AP, Health, Armor, …) are point bonuses, no %. Keys
// not listed are ability parameters (HealthThreshold, ShieldDuration), not stats.
const ITEM_STAT_KEYS: Record<string, { label: string; kind: 'pct' | 'flat' }> = {
  AD: { label: 'Attack Damage', kind: 'pct' },
  AP: { label: 'Ability Power', kind: 'flat' },
  Health: { label: 'Health', kind: 'flat' },
  HealthMax: { label: 'Health', kind: 'flat' },
  Armor: { label: 'Armor', kind: 'flat' },
  MagicResist: { label: 'Magic Resist', kind: 'flat' },
  AttackSpeed: { label: 'Attack Speed', kind: 'pct' },
  AS: { label: 'Attack Speed', kind: 'pct' },
  CritChance: { label: 'Crit Chance', kind: 'pct' },
  CritDamage: { label: 'Crit Damage', kind: 'pct' },
  LifeSteal: { label: 'Life Steal', kind: 'pct' },
  Omnivamp: { label: 'Omnivamp', kind: 'pct' },
  StatOmnivamp: { label: 'Omnivamp', kind: 'pct' },
  Mana: { label: 'Mana', kind: 'flat' },
  DamageAmp: { label: 'Damage Amp', kind: 'pct' },
  DurabilityToGive: { label: 'Durability', kind: 'pct' },
};

/** Extract the curated stat bonuses from an item's effects, as an ordered list
 *  ready for display. Empty when the item has no recognised stats. */
function itemStats(effects: Record<string, number> | undefined): { label: string; value: string }[] {
  if (!effects) return [];
  const out: { label: string; value: string }[] = [];
  for (const [key, rule] of Object.entries(ITEM_STAT_KEYS)) {
    const raw = effects[key];
    if (typeof raw !== 'number' || raw === 0) continue;
    const value =
      rule.kind === 'pct'
        ? `+${Math.round(raw < 1 ? raw * 100 : raw)}%`
        : `+${Math.round(raw)}`;
    if (!out.some((o) => o.label === rule.label)) out.push({ label: rule.label, value });
  }
  return out;
}

function getRarity(icon: string): 'Silver' | 'Gold' | 'Prismatic' | null {
  if (!icon) return null;
  const basename = icon.split('/').pop() ?? '';
  const core = basename
    .replace(/\.TFT[^.]*\.tex$/i, '')
    .replace(/\.tex$/i, '');
  if (/(?:_|-)?III$/i.test(core)) return 'Prismatic';
  if (/(?:_|-)?II$/i.test(core))  return 'Gold';
  if (/(?:_|-)?I$/i.test(core))   return 'Silver';
  const numMatch = core.match(/(\d+)$/);
  if (numMatch) {
    const n = parseInt(numMatch[1], 10);
    if (n === 3) return 'Prismatic';
    if (n === 2) return 'Gold';
    if (n === 1) return 'Silver';
  }
  return null;
}

function pickCurrentSet(
  data: CDragonData,
  override?: number,
): { setNumber: number; champions: CDragonChampion[]; traits: CDragonTrait[]; augmentApiNames: string[]; name?: string } {
  // Prefer setData (mode-aware, ids match match-v1). Among entries sharing a set
  // number, prefer the canonical "TFTSet{n}" mutator over mode variants
  // (TFTSet17_PVEMODE, TFTSet17_PAIRS, TFTSetEvent5YR — all carry near-identical
  // rosters but different augment pools).
  const candidates = (data.setData ?? []).filter(
    (s) => (s.number ?? 0) > 0 && (s.champions?.length ?? 0) > 0,
  );

  if (candidates.length > 0) {
    const numbers = [...new Set(candidates.map((s) => s.number!))].sort((a, b) => b - a);
    const pickFor = (n: number): CDragonSet | undefined =>
      canonicalEntry(candidates, n) as CDragonSet | undefined;

    if (override !== undefined) {
      const chosen = pickFor(override);
      if (!chosen) throw new Error(`SET_NUMBER=${override} is not present in the data file`);
      const roster = rosterSize(chosen);
      if (roster < MIN_REAL_ROSTER && process.env.ALLOW_EMPTY_SET !== '1') {
        // REFUSE rather than warn. Setting SET_NUMBER to the next set ahead of
        // launch day is the normal way to prepare for it, so the override says
        // "use 18 when it is ready", not "load whatever is under 18 today".
        // Honouring it literally is how 19 jungle camps replaced a live catalog.
        // Leaving SET_NUMBER=18 in .env and re-running daily is now a fine
        // workflow: it refuses until Riot publishes, then loads.
        throw new Error(
          `SET_NUMBER=${override} is not populated yet — ${roster} rostered champions ` +
            `(need >= ${MIN_REAL_ROSTER}). CDragon publishes traits, augments and a few ` +
            `neutral monsters for a set well before its roster lands, and loading that ` +
            `stub would overwrite the live catalog.
` +
            `  — re-run once Riot publishes the roster (nothing else to change), or
` +
            `  — set ALLOW_EMPTY_SET=1 to load it anyway.`,
        );
      }
      return {
        setNumber: override,
        champions: chosen.champions ?? [],
        traits: chosen.traits ?? [],
        augmentApiNames: chosen.augments ?? [],
        name: chosen.name,
      };
    }

    // Newest set whose roster has actually shipped. Anything newer is reported
    // rather than silently skipped — that line is the cue to re-run on launch day.
    for (const n of numbers) {
      const chosen = pickFor(n);
      if (!chosen) continue;
      const roster = rosterSize(chosen);
      if (roster < MIN_REAL_ROSTER) {
        console.warn(
          `[data:load] Set ${n} is present but NOT YET POPULATED ` +
            `(${roster} rostered champions, ${chosen.champions?.length ?? 0} entries total) — skipping. ` +
            `Re-run once Riot publishes the roster, or force it with SET_NUMBER=${n}.`,
        );
        continue;
      }
      return {
        setNumber: n,
        champions: chosen.champions ?? [],
        traits: chosen.traits ?? [],
        augmentApiNames: chosen.augments ?? [],
        name: chosen.name,
      };
    }
    throw new Error(
      `No set in the data file has a published roster (>= ${MIN_REAL_ROSTER} champions with traits). ` +
        `Force one with SET_NUMBER=<n> if this is deliberate.`,
    );
  }

  // Fallback: the `sets` map keyed by set number.
  const sets = data.sets ?? {};
  const keys = Object.keys(sets)
    .map(Number)
    .filter((n) => !Number.isNaN(n));
  if (keys.length === 0) throw new Error('Could not locate any TFT set in the data file');
  const num = override ?? Math.max(...keys);
  const s2 = sets[String(num)];
  if (!s2) throw new Error(`Set ${num} not present in the data file`);
  return { setNumber: num, champions: s2.champions ?? [], traits: s2.traits ?? [], augmentApiNames: s2.augments ?? [], name: s2.name };
}

// Splits a trait into its intro (the always-on bonus, → traits.description) and
// one resolved effect string per breakpoint (→ breakpoints[].effect), so the UI
// can show each breakpoint's actual effect beside its badge instead of a bare
// unit count. Rows appear as <row> or <expandRow>; each resolves against its own
// breakpoint variables.
/**
 * Put a trait's stat glyphs into a value row that does not name its stat.
 *
 * Injected into the RAW row before `resolveDesc` runs, because resolveDesc
 * collapses runs of whitespace — and those runs are precisely the positional
 * signal: CDragon leaves a double space where the client draws an icon
 * ("@ADAPGain*100@%  OR"). Fill the gaps in order, append whatever is left.
 */
function injectValueIcons(rowHtml: string, icons: readonly StatIconKey[]): string {
  if (!icons.length) return rowHtml;
  let i = 0;
  let out = rowHtml.replace(/ {2,}/g, () => (i < icons.length ? ` «icon:${icons[i++]}» ` : ' '));
  while (i < icons.length) out += ` «icon:${icons[i++]}»`;
  return out;
}

function buildTraitContent(t: CDragonTrait, setNumber: number): { intro: string | null; rowTexts: (string | null)[] } {
  if (!t.desc) return { intro: null, rowTexts: [] };
  const effects = t.effects ?? [];

  const rowRe = /<(?:expandRow|row)>([\s\S]*?)<\/(?:expandRow|row)>/gi;
  const rows = Array.from(t.desc.matchAll(rowRe)).map((m) => m[1]);

  // Merged map across breakpoints for the intro paragraph (constant teamwide
  // values repeat identically, so first occurrence wins).
  const introEffMap: Record<string, number> = {};
  for (const e of effects) {
    if (typeof e.minUnits === 'number' && !('MinUnits' in introEffMap))
      introEffMap['MinUnits'] = e.minUnits;
    const vars = e.variables ?? {};
    for (const [k, v] of Object.entries(vars)) {
      if (typeof v === 'number' && !(k in introEffMap)) introEffMap[k] = v;
    }
  }

  const introHtml = t.desc.split(/<(?:expandRow|row)>/i)[0] ?? '';
  const intro = resolveDesc(introHtml, introEffMap);

  // One <row> per breakpoint (Meeple, Challenger) maps by index; a single
  // <expandRow> (Conduit) is a TEMPLATE repeated for every breakpoint, resolved
  // with each breakpoint's own variables. Build one effect string per breakpoint.
  const template = rows.length === 1 && effects.length > 1 ? rows[0] : null;
  const rowTexts = effects.map((e, i) => {
    const rawRow = template ?? rows[i];
    if (rawRow == null) return null;
    const rowHtml = injectValueIcons(rawRow, traitValueIcons(setNumber, t.apiName ?? ''));
    const effMap: Record<string, number> = {};
    if (typeof e.minUnits === 'number') effMap.MinUnits = e.minUnits;
    const vars = e.variables ?? {};
    for (const [k, v] of Object.entries(vars)) if (typeof v === 'number') effMap[k] = v;
    const line = resolveDesc(rowHtml, effMap);
    // The badge already shows the unit count, so drop a leading "(N)" the row
    // sometimes repeats (e.g. Conduit's "(2) 1 Mana Regen").
    return line ? line.replace(/^\(\d+\)\s*/, '') || null : null;
  });

  return { intro, rowTexts };
}

// Builds effects map from champion ability variables.
// value array: [base, 1★, 2★, 3★, 4★, ...] — use indices 1-3 for the three star levels.
// Converts ability variables array → { VarName: "145/190/285" } for 1★/2★/3★
function buildAbilityEffectsMap(
  variables: { name?: string; value?: (number | null)[] }[] | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of variables ?? []) {
    if (!v.name || !Array.isArray(v.value)) continue;
    // value[0] is the unused base entry; indices 1-3 are 1★/2★/3★.
    const vals = v.value.slice(1, 4).filter((x): x is number => typeof x === 'number');
    const unique = [...new Set(vals)];
    // Store full precision so resolveDesc can apply the *100 multiplier correctly.
    out[v.name] = unique
      .map((n) => (n === Math.floor(n) ? String(Math.floor(n)) : String(n)))
      .join('/');
  }
  return out;
}

// CommunityDragon wraps meaningful spans in semantic tags. We keep them as
// compact «class:text» tokens (guillemets never appear in TFT text) so the
// client can colour them; everything unknown is unwrapped to plain text. The
// token grammar is parsed — never innerHTML'd — on the render side
// (src/lib/rich-text.tsx), and the class set here must match the CSS there.
const RICH_TAG_CLASS: Record<string, string> = {
  physicaldamage: 'phys',
  magicdamage: 'magic',
  truedamage: 'true',
  scalehealth: 'hp',
  scalelevel: 'lvl',
  scaleap: 'ap',
  scalead: 'ad',
  scalearmor: 'armor',
  scalemr: 'armor',
  scalemana: 'mana',
  tftbonus: 'bonus',
  tfthighlight: 'bonus',
  tftkeyword: 'kw',
  status: 'kw',
  spellpassive: 'label',
  spellactive: 'label',
  tftpassive: 'label',
  tftactive: 'label',
  tftbold: 'bold',
  rules: 'rules',
  tftrules: 'rules',
  tftitemrules: 'rules',
  tftradiantitembonus: 'radiant',
  tftshadowitembonus: 'shadow',
  tftshadowitempenalty: 'shadow',
};

// CDragon embeds stat icons as %i:Name% next to a value to say WHAT the value is
// / scales with. These now resolve to the REAL game glyph: `statIconKey` maps the
// CDragon name to an atlas entry (src/lib/stat-icons.ts) and we emit «icon:key»,
// which rich-text.tsx draws. Previously this emitted a «scale:AP» text label
// purely because we could not draw the icon.
//
// Names with no glyph keep a muted text label — better a word than nothing.
const ICON_TEXT_FALLBACK: Record<string, string> = {
  set14ampicon: 'Meeps', // reused icon asset; only Meeple uses it (the Meep count)
};

// Keyword references we could not resolve, reported once at the end of the load
// rather than per occurrence — 16 items reference Precision alone, and a warning
// per row would bury the signal it exists to give.
const unresolvedKeywords = new Set<string>();

// Variable names that resolved neither by name nor by hash — i.e. the value is
// genuinely not published. Reported once at the end so the size of the gap is
// visible rather than silently rendering as a missing number mid-sentence.
const unresolvedVars = new Set<string>();

function resolveDesc(
  desc: string | null | undefined,
  effects: Record<string, number | string> | null | undefined,
): string | null {
  if (!desc) return null;
  const eff = effects ?? {};

  const resolved = desc.replace(/@([^@]+)@/g, (_, raw: string) => {
    if (raw.startsWith('TFTUnitProperty') || raw.startsWith('ShowIf')) return '';

    const multMatch = raw.match(/^([^*]+)\*(\d+(?:\.\d+)?)$/);
    const varKey = multMatch ? multMatch[1] : raw;
    const multiplier = multMatch ? parseFloat(multMatch[2]) : 1.0;

    // Direct name first, then the FNV-1a hash CDragon publishes when it cannot
    // reverse a field name (see lib/bin-hash.ts). Set 18 keys most trait
    // variables that way, which is why its breakpoints lost their numbers.
    const val = lookupBinField(eff, varKey);
    if (val === undefined) {
      unresolvedVars.add(varKey);
      return ''; // genuinely absent — hide rather than show the raw name
    }

    if (typeof val === 'string') {
      // Ability values are stored as full-precision strings (possibly "41/62/644" for multi-star).
      // Apply the multiplier here, since buildAbilityEffectsMap stores raw values.
      return val.split('/').map(s => {
        const n = parseFloat(s);
        if (isNaN(n)) return s;
        const r = n * multiplier;
        if (r === 0) return '0';
        if (r === Math.floor(r)) return String(Math.floor(r));
        // toPrecision(3) gives 3 significant figures, handling both 0.75 → "0.75" and 0.0099... → rounds to 0.01
        const sig = parseFloat(r.toPrecision(3));
        return sig === Math.floor(sig) ? String(Math.floor(sig)) : String(sig);
      }).join('/');
    }
    // Riot stores these as 32-bit floats, so a clean decimal arrives widened and
    // slightly wrong: Adaptor's 35% is published as 0.3499999940395355, which
    // ×100 is not an integer and rendered "35.0%" between a "25%" and a "50%".
    // Six significant figures is past float32's ~7-digit precision, so it
    // recovers the intended value while leaving genuine fractions alone —
    // 33.333… still formats as 33.3, and large values keep their magnitude.
    const result = parseFloat((val * multiplier).toPrecision(6));
    return result === Math.floor(result) ? String(Math.floor(result)) : result.toFixed(1);
  });

  // Preserve semantic markup as «class:text» tokens instead of flattening.
  let out = resolved.replace(/<br\s*\/?>/gi, '\n');

  // Drop <ShowIf.CONDITION>…</ShowIf.CONDITION> blocks — augment/variant-only
  // additions that otherwise concatenate onto the base value (e.g. Viktor's
  // "<ShowIf.…Augment…>5</…>4 seconds" rendering as "54 seconds"). ShowIfNot
  // blocks are the DEFAULT branch, so their tags are merely unwrapped below.
  let prevShow: string;
  do {
    prevShow = out;
    out = out.replace(/<ShowIf\.[^>]*>[\s\S]*?<\/ShowIf\.[^>]*>/gi, '');
  } while (out !== prevShow);

  for (const [tag, cls] of Object.entries(RICH_TAG_CLASS)) {
    const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
    let prev: string;
    do {
      prev = out;
      out = out.replace(re, (_m, inner) => `«${cls}:${inner}»`);
    } while (out !== prev);
  }

  // Strip anything that can hollow out a token's content FIRST (icons, empty
  // parens left by a stripped %i:…% icon, stray %), so the empty-token pass below
  // sees the final inner value.
  let text = out
    .replace(/<[^>]+>/g, '')             // unwrap unknown/structural tags (maintext, showif, li, …)
    .replace(/%i:([^%]+)%/g, (_m, name: string) => {
      const key = statIconKey(String(name));
      if (key) return `«icon:${key}»`;
      const label = ICON_TEXT_FALLBACK[String(name).toLowerCase()];
      return label ? `«scale:${label}»` : '';
    })
    // `{{TFT_Keyword_X}}` is a reference to a definition that lives in the game
    // client rather than the published data. Dropping it wholesale is why
    // Jeweled Gauntlet read "Gain Precision." and stopped, while Morellonomicon
    // — which inlines its own rules block — explained Burn and Wound. Resolve
    // the ones we know into the SAME shape CDragon uses for an inline block, so
    // both paths render identically.
    .replace(/\{\{([^}]+)\}\}/g, (_m, ref: string) => {
      const kw = keywordFor(ref.trim());
      if (kw) return `«rules:«bold:${kw.name}»: ${kw.text}»`;
      // Not a keyword (item-specific template refs like TFT13_ChemBaronOnlyItem
      // also use this syntax), or a keyword we have no definition for. Record
      // the latter so a new one surfaces at load time instead of silently
      // becoming a sentence that references something never explained.
      if (/^TFT_Keyword_/i.test(ref.trim())) unresolvedKeywords.add(ref.trim());
      return '';
    })
    .replace(/\[\[[^\]]+\]\]/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/(?<!\d)%/g, '')            // stray % from unresolvable vars (keeps "244%")
    .replace(/\(\s*\)/g, '');            // empty () left by a stripped icon

  // Drop tokens whose value never resolved (obfuscated CDragon keys) so we don't
  // render an empty coloured span, e.g. "«phys: »" → "". Repeat to peel nested
  // empties inside-out.
  let prevEmpty: string;
  do {
    prevEmpty = text;
    text = text.replace(/«[a-z]+:\s*»/g, '');
  } while (text !== prevEmpty);

  text = text
    .replace(/\s+\)/g, ')')             // fix " )" → ")"
    .replace(/\(\s+/g, '(')             // fix "( " → "("
    .replace(/[ \t]{2,}/g, ' ')          // collapse double spaces (keep newlines)
    .replace(/ +([.,])/g, '$1')          // fix " ." / " ,"
    .replace(/\n{3,}/g, '\n\n')          // cap blank runs
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim();
  return text || null;
}

async function main(): Promise<void> {
  const overrideSet = process.env.SET_NUMBER ? Number(process.env.SET_NUMBER) : undefined;
  const patch = process.env.TFT_PATCH; // e.g. '17.5' — optional, marks current patch

  // TFT_DATA_FILE points at a local CDragon en_us.json (offline / pinned patch);
  // otherwise fetch the live "latest" catalog.
  const dataFile = process.env.TFT_DATA_FILE;
  let data: CDragonData;
  if (dataFile) {
    console.log(`Reading ${dataFile} ...`);
    const fs = await import('node:fs/promises');
    data = JSON.parse(await fs.readFile(dataFile, 'utf8')) as CDragonData;
  } else {
    console.log(`Fetching ${TFT_DATA_URL} ...`);
    const res = await fetch(TFT_DATA_URL);
    if (!res.ok) throw new Error(`Failed to fetch TFT data: HTTP ${res.status}`);
    data = (await res.json()) as CDragonData;
  }

  const picked = pickCurrentSet(data, overrideSet);
  const { setNumber, traits, augmentApiNames, name } = picked;
  const champions = picked.champions;
  console.log(
    `Set ${setNumber}${name ? ` (${name})` : ''}: ${champions.length} champions, ${traits.length} traits`,
  );

  const allItems = data.items ?? [];
  const itemLookup = new Map(allItems.filter((i) => i.apiName).map((i) => [i.apiName!, i]));
  // Use the set's own augments list (authoritative) rather than filtering all data.items.
  // Filter names containing '@' — these are variable-only placeholder entries.
  const augments = augmentApiNames
    .map((n) => itemLookup.get(n))
    .filter((i): i is CDragonItem => !!i && !!i.name && !i.name.includes('@'));
  const items = allItems.filter((i) => i.apiName && i.name && !/augment/i.test(i.apiName));
  console.log(`Set ${setNumber} augments: ${augments.length}, global items: ${items.length}`);

  // Champion.traits are DISPLAY names; translate to trait apiNames so that
  // units.trait_ids line up with the trait ids match data uses.
  const traitNameToApi = new Map<string, string>();
  for (const t of traits) if (t.name && t.apiName) traitNameToApi.set(t.name, t.apiName);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (patch) {
      // Label only — `is_current` is derived automatically from real match
      // data in resolvePatchId (patch.ts), never from this hand-set value.
      await client.query(
        `INSERT INTO patches (set_number, patch, label)
         VALUES ($1, $2, $3)
         ON CONFLICT (set_number, patch) DO UPDATE SET label = EXCLUDED.label`,
        [setNumber, patch, name ?? null],
      );
    } else {
      console.warn(
        'TFT_PATCH not set — skipping patches upsert. Run with e.g. TFT_PATCH=17.5 to label the set.',
      );
    }

    for (const t of traits) {
      if (!t.apiName || !t.name) continue;
      const { intro, rowTexts } = buildTraitContent(t, setNumber);
      const breakpoints = (t.effects ?? []).map((e, i) => ({
        minUnits: e.minUnits ?? e.min ?? null,
        maxUnits: e.maxUnits ?? e.max ?? null,
        style: e.style ?? null,
        effect: rowTexts[i] ?? null,
      }));
      // If there's no standalone intro, fall back to the first breakpoint effect
      // so the hover tooltip still has something to show.
      const description = intro ?? rowTexts.find((r) => !!r) ?? null;
      await client.query(
        `INSERT INTO traits (set_number, trait_id, name, description, breakpoints, icon_path)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (set_number, trait_id) DO UPDATE
           SET name = EXCLUDED.name, description = EXCLUDED.description,
               breakpoints = EXCLUDED.breakpoints, icon_path = EXCLUDED.icon_path`,
        [setNumber, t.apiName, t.name, description, JSON.stringify(breakpoints), t.icon ?? null],
      );
    }

    for (const c of champions) {
      if (!c.apiName || !c.name) continue;
      const traitApis = (c.traits ?? []).map((n) => traitNameToApi.get(n) ?? n);
      await client.query(
        `INSERT INTO units (set_number, character_id, name, cost, role, trait_ids, icon_path, ability_name, ability_desc, stats)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (set_number, character_id) DO UPDATE
           SET name = EXCLUDED.name, cost = EXCLUDED.cost, role = EXCLUDED.role,
               trait_ids = EXCLUDED.trait_ids, icon_path = EXCLUDED.icon_path,
               ability_name = EXCLUDED.ability_name, ability_desc = EXCLUDED.ability_desc,
               stats = EXCLUDED.stats`,
        [
          setNumber, c.apiName, c.name, c.cost ?? null, c.role ?? null, traitApis, c.tileIcon ?? c.icon ?? null,
          c.ability?.name ?? null,
          resolveDesc(c.ability?.desc, buildAbilityEffectsMap(c.ability?.variables)),
          c.stats ? JSON.stringify(c.stats) : null,
        ],
      );
    }

    // Display names of THIS set's traits, for the emblem fallback below.
    const liveTraitNames = new Set(
      traits.map((t) => (t.name ?? '').trim().toLowerCase()).filter(Boolean),
    );
    let emblemsFilledIn = 0;
    // Every emblem key this set actually has, so a mistyped EMBLEM_BONUSES key
    // can be reported. An unrecognised key is otherwise SILENT — it simply never
    // matches, and the emblem quietly renders with the grant line alone, which
    // is exactly how "spirkin" and "ravanger" sat there doing nothing.
    const emblemKeysInSet = new Set<string>();

    for (const it of items) {
      const stats = itemStats(it.effects);
      // CDragon's own text always wins; the fallback only fills a hole. That
      // way the day Riot publishes set-18 emblem descriptions, they take over
      // with no code change and nothing to remove.
      const emblemKey = traitNameFromEmblem(it.name)?.toLowerCase();
      if (emblemKey && liveTraitNames.has(emblemKey)) emblemKeysInSet.add(emblemKey);

      let description = resolveDesc(it.desc, it.effects);
      if (!description) {
        const fallback = emblemGrantDescription(it.name, liveTraitNames);
        if (fallback) {
          description = fallback;
          emblemsFilledIn++;
        }
      }
      await client.query(
        `INSERT INTO items (set_number, item_id, name, icon_path, composition, description, stats)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (set_number, item_id) DO UPDATE
           SET name = EXCLUDED.name, icon_path = EXCLUDED.icon_path,
               composition = EXCLUDED.composition, description = EXCLUDED.description,
               stats = EXCLUDED.stats`,
        [
          setNumber, it.apiName, it.name, it.icon ?? null, it.composition ?? [],
          description, JSON.stringify(stats),
        ],
      );
    }
    const strayBonuses = Object.keys(EMBLEM_BONUSES).filter((k) => !emblemKeysInSet.has(k));
    if (strayBonuses.length) {
      console.warn(
        `[data:load] ${strayBonuses.length} EMBLEM_BONUSES key(s) match no emblem in set ` +
          `${setNumber} and had no effect: ${strayBonuses.join(', ')}
` +
          `  Check the spelling against the trait's DISPLAY name — the key is that ` +
          `name lowercased (e.g. "Ravager Emblem" -> ravager, even though its id ` +
          `says Slayer).`,
      );
    }
    if (emblemsFilledIn) {
      console.log(
        `[data:load] ${emblemsFilledIn} emblem(s) had no published description; ` +
          `filled in the trait grant, plus a transcribed bonus where one is known ` +
          `(src/lib/emblems.ts). Bonuses are never guessed — an emblem with no ` +
          `entry gets the grant line alone.`,
      );
    }

    for (const a of augments) {
      const augTier = getRarity(a.icon ?? '');
      await client.query(
        `INSERT INTO augments (set_number, augment_id, name, description, icon_path, tier)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (set_number, augment_id) DO UPDATE
           SET name = EXCLUDED.name, description = EXCLUDED.description,
               icon_path = EXCLUDED.icon_path, tier = EXCLUDED.tier`,
        [setNumber, a.apiName, a.name ?? a.apiName, resolveDesc(a.desc, a.effects), a.icon ?? null, augTier],
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }

  // Eyeball a few rows to confirm name + trait resolution looks right.
  console.log('\nSample champions:');
  for (const c of champions.slice(0, 3)) {
    const traitApis = (c.traits ?? []).map((n) => traitNameToApi.get(n) ?? n);
    console.log(`  ${c.apiName} -> ${c.name} (cost ${c.cost}) traits=[${traitApis.join(', ')}]`);
  }
  if (unresolvedVars.size) {
    const shown = [...unresolvedVars].slice(0, 12);
    console.warn(
      `[data:load] ${unresolvedVars.size} variable name(s) had no published value ` +
        `and rendered as a gap: ${shown.join(', ')}${unresolvedVars.size > shown.length ? ', …' : ''}
` +
        `  These resolved neither by name nor by CDragon's {hash} key, so the ` +
        `number is absent upstream rather than mismatched here.`,
    );
  }
  if (unresolvedKeywords.size) {
    console.warn(
      `[data:load] ${unresolvedKeywords.size} keyword reference(s) have no definition ` +
        `and were dropped: ${[...unresolvedKeywords].join(', ')}
` +
        `  Add them to src/lib/keywords.ts — the text they reference lives in the ` +
        `client, so the sentence citing them reads as a dead end without it.`,
    );
  }
  console.log('Static data loaded.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
