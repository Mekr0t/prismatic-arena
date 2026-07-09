import 'dotenv/config';
import { Pool } from 'pg';

// Community Dragon serves the canonical TFT catalog whose apiName fields match
// tft-match-v1 exactly (TFT17_Ezreal, TFT_Item_BlueBuff, TFT17_AssassinTrait).
// "latest" tracks the current patch.
const TFT_DATA_URL =
  process.env.TFT_DATA_URL ??
  'https://raw.communitydragon.org/latest/cdragon/tft/en_us.json';

// ── Community Dragon shapes (loose — fields are accessed defensively) ─────────
interface CDragonTrait {
  apiName?: string;
  name?: string; // display name, e.g. "Assassin"
  desc?: string; // general trait description
  icon?: string;
  effects?: {
    minUnits?: number;
    maxUnits?: number | null;
    style?: number;
    min?: number;
    max?: number;
    variables?: Record<string, number>;
  }[];
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
  // Prefer setData (mode-aware, ids match match-v1). Among entries sharing the
  // highest set number, prefer the canonical "TFTSet{n}" mutator over variants.
  const candidates = (data.setData ?? []).filter(
    (s) => (s.number ?? 0) > 0 && (s.champions?.length ?? 0) > 0,
  );
  if (candidates.length > 0) {
    const maxNum = override ?? Math.max(...candidates.map((s) => s.number!));
    const sameNum = candidates.filter((s) => s.number === maxNum);
    const chosen = sameNum.find((s) => s.mutator === `TFTSet${maxNum}`) ?? sameNum[0];
    if (chosen) {
      return {
        setNumber: maxNum,
        champions: chosen.champions ?? [],
        traits: chosen.traits ?? [],
        augmentApiNames: chosen.augments ?? [],
        name: chosen.name,
      };
    }
  }
  

  // Fallback: the `sets` map keyed by set number.
  const sets = data.sets ?? {};
  const keys = Object.keys(sets)
    .map(Number)
    .filter((n) => !Number.isNaN(n));
  if (keys.length === 0) throw new Error('Could not locate any TFT set in the data file');
  const num = override ?? Math.max(...keys);
  const s = sets[String(num)];
  if (!s) throw new Error(`Set ${num} not present in the data file`);
  return { setNumber: num, champions: s.champions ?? [], traits: s.traits ?? [], augmentApiNames: s.augments ?? [], name: s.name };
}

function formatTraitDescription(t: CDragonTrait): string | null {
  if (!t.desc) return null;
  const effects = t.effects ?? [];

  // Grab all <row>...</row> blocks
  const rowMatches = Array.from(t.desc.matchAll(/<row>(.*?)<\/row>/gi));
  const rows = rowMatches.map((m) => m[1]);

  // Build a merged effects map from all breakpoints for the intro paragraph.
  // Constant teamwide values (e.g. TeamwideAS) appear in every breakpoint with the
  // same value — using the first occurrence is correct and sufficient.
  const introEffMap: Record<string, number> = {};
  for (const e of effects) {
    if (typeof e.minUnits === 'number' && !('MinUnits' in introEffMap))
      introEffMap['MinUnits'] = e.minUnits;
    const vars = (e as any).variables ?? {};
    for (const [k, v] of Object.entries(vars)) {
      if (typeof v === 'number' && !(k in introEffMap)) introEffMap[k] = v as number;
    }
  }

  // Intro text before first <row> (Meeple has this)
  const introHtml = t.desc.split(/<row>/i)[0] ?? '';
  const intro = resolveDesc(introHtml, introEffMap);

  const lines: string[] = [];
  if (intro && intro.trim()) lines.push(intro.trim());

  // Build one line per breakpoint
  for (let i = 0; i < rows.length; i++) {
    const rowHtml = `<row>${rows[i]}</row>`;
    const e = effects[i] ?? effects[effects.length - 1];

    const effMap: Record<string, number> = {};
    if (typeof e.minUnits === 'number') effMap.MinUnits = e.minUnits;

    const vars = (e as any).variables ?? {};
    for (const [k, v] of Object.entries(vars)) {
      if (typeof v === 'number') effMap[k] = v;
    }

    const line = resolveDesc(rowHtml, effMap);
    if (line && line.trim()) lines.push(line.trim());
  }

  return lines.join('\n');
}

// Breakpoint metadata fields — not variable values.
const TRAIT_META = new Set(['minUnits', 'maxUnits', 'style', 'min', 'max']);

// Builds a per-variable range string from all breakpoint levels, e.g. { Damage: "15/25/40" }.
function buildTraitEffectsMap(effects: Record<string, any>[]): Record<string, string> {
  const byVar = new Map<string, number[]>();

  for (const e of effects) {
    // Expose MinUnits/MaxUnits so @MinUnits@ resolves in desc
    if (typeof e['minUnits'] === 'number') {
      const arr = byVar.get('MinUnits') ?? [];
      arr.push(e['minUnits']);
      byVar.set('MinUnits', arr);
    }

    // Values nested under variables
    const vars: Record<string, number> = e['variables'] ?? {};
    for (const [k, v] of Object.entries(vars)) {
      if (typeof v !== 'number') continue;
      const arr = byVar.get(k) ?? [];
      arr.push(v);
      byVar.set(k, arr);
    }
  }

  const out: Record<string, string> = {};
  for (const [k, vals] of byVar) {
    const unique = [...new Set(vals)];
    out[k] = unique
      .map((v) => (v === Math.floor(v) ? String(Math.floor(v)) : v.toFixed(1)))
      .join('/');
  }
  return out;
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

    const entry = Object.entries(eff).find(([k]) => k.toLowerCase() === varKey.toLowerCase());
    if (!entry) return ''; // unresolvable (obfuscated key, Modified*, etc.) — hide rather than show raw name
    
    const val = entry[1];
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
    const result = val * multiplier;
    return result === Math.floor(result) ? String(Math.floor(result)) : result.toFixed(1);
  });

  const text = resolved
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/%i:[^%]+%/g, '')
    .replace(/\{\{[^}]+\}\}/g, '')
    .replace(/\[\[[^\]]+\]\]/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/(?<!\d)%/g, '')            // remove stray % left by unresolvable variables (e.g. obfuscated CDragon keys)
    .replace(/\(\s*\)/g, '')            // remove empty ()
    .replace(/\s+\)/g, ')')             // fix " )" → ")"
    .replace(/\(\s+/g, '(')             // fix "( " → "("
    .replace(/\s{2,}/g, ' ')            // collapse double spaces
    .replace(/\s+([.,])/g, '$1')        // fix " ." / " ,"
    .trim();
  return text || null;
}

async function main(): Promise<void> {
  const overrideSet = process.env.SET_NUMBER ? Number(process.env.SET_NUMBER) : undefined;
  const patch = process.env.TFT_PATCH; // e.g. '17.5' — optional, marks current patch

  console.log(`Fetching ${TFT_DATA_URL} ...`);
  const res = await fetch(TFT_DATA_URL);
  if (!res.ok) throw new Error(`Failed to fetch TFT data: HTTP ${res.status}`);
  const data = (await res.json()) as CDragonData;

  const { setNumber, champions, traits, augmentApiNames, name } = pickCurrentSet(data, overrideSet);
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
      const breakpoints = (t.effects ?? []).map((e) => ({
        minUnits: e.minUnits ?? e.min ?? null,
        maxUnits: e.maxUnits ?? e.max ?? null,
        style: e.style ?? null,
      }));
      await client.query(
        `INSERT INTO traits (set_number, trait_id, name, description, breakpoints, icon_path)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (set_number, trait_id) DO UPDATE
           SET name = EXCLUDED.name, description = EXCLUDED.description,
               breakpoints = EXCLUDED.breakpoints, icon_path = EXCLUDED.icon_path`,
        [setNumber, t.apiName, t.name, formatTraitDescription(t), JSON.stringify(breakpoints), t.icon ?? null],
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

    for (const it of items) {
      await client.query(
        `INSERT INTO items (set_number, item_id, name, icon_path, composition, description)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (set_number, item_id) DO UPDATE
           SET name = EXCLUDED.name, icon_path = EXCLUDED.icon_path,
               composition = EXCLUDED.composition, description = EXCLUDED.description`,
        [setNumber, it.apiName, it.name, it.icon ?? null, it.composition ?? [], resolveDesc(it.desc, it.effects)],
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
  console.log('Static data loaded.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
