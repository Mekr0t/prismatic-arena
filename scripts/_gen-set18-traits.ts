import { readFile, writeFile } from 'node:fs/promises';

// _gen-set18-traits.ts — turns a hand-written trait list into a resolved seed.
//
// Run once (re-run if the source list changes):
//   npx tsx scripts/_gen-set18-traits.ts [path/to/traits.txt]
//
// Writes scripts/set18-traits.ts as `championId -> traitApiName[]`, resolving
// DISPLAY names ("Ahri", "Coven") against the real ids from map22 + Data Dragon
// + CDragon. Resolution beats transcription: the source list is written by hand
// from the in-game client, so anything that fails to resolve is reported loudly
// rather than silently dropped.

// The hand-written source list lives IN THE REPO, next to the generator that
// reads it. It was transcribed from the in-game client and is the only part of
// the set-18 catalog with no machine-readable origin — if it is not committed,
// the seed cannot be regenerated and a typo cannot be corrected.
const SRC = process.argv[2] ?? 'scripts/set18-traits-source.txt';
const OUT = 'scripts/set18-traits.ts';
const SET = 18;

const MAP22 = 'https://raw.communitydragon.org/latest/game/data/maps/shipping/map22/map22.bin.json';
const CDRAGON = 'https://raw.communitydragon.org/latest/cdragon/tft/en_us.json';
const DDRAGON = 'https://ddragon.leagueoflegends.com';

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// Units whose in-game display name cannot be derived from their id. Supplied by
// the user from the client, which is the authoritative source for both.
const MANUAL_NAMES: Record<string, string> = {
  DA_18_Sentry: 'Pebbles',
  DA_CrimsonRaptor18: 'Mama Beak',
};

/** "DA_Krug18" -> "Krug", "DA_Gromp18_AP" -> "Gromp", "DA_18_ElderDragon" -> "Elder Dragon" */
function deriveName(id: string): string {
  const core = id
    .replace(/^DA_/, '')
    .replace(/^18_/, '')
    .replace(/18(_[A-Z]{2,3})?$/, '')
    .replace(/_(AD|AP)$/, '');
  return core.replace(/([a-z])([A-Z])/g, '$1 $2').trim();
}

interface Champ { id: string; name: string; cost: number; icon: string | null }

(async () => {
  // ── real ids ───────────────────────────────────────────────────────────────
  const map22 = JSON.parse(await (await fetch(MAP22)).text()) as Record<string, Record<string, unknown>>;
  const shop = Object.entries(map22)
    .filter(([k, v]) => new RegExp(`TFTSet${SET}/Shop/`, 'i').test(k) && (v as { __type?: string }).__type === 'TftShopData')
    .map(([, v]) => v as { mName?: string; BaseCost?: number; SquareSplashPath?: string; TeamPlannerPortraitPath?: string });

  const cd = JSON.parse(await (await fetch(CDRAGON)).text()) as {
    setData?: { number?: number; mutator?: string; traits?: { apiName?: string; name?: string }[] }[];
  };
  const traits = ((cd.setData ?? []).find((s) => s.number === SET && s.mutator === `TFTSet${SET}`)?.traits ?? [])
    .map((t) => ({ api: t.apiName!, name: t.name! }));
  const traitByName = new Map(traits.map((t) => [norm(t.name), t]));

  const vs = (await (await fetch(`${DDRAGON}/api/versions.json`)).json()) as string[];
  const dd = (await (await fetch(`${DDRAGON}/cdn/${vs[0]}/data/en_US/tft-champion.json`)).json()) as {
    data?: Record<string, { id?: string; name?: string; cost?: number }>;
  };
  const ddName = new Map(
    Object.entries(dd.data ?? {})
      .filter(([k]) => new RegExp(`TFTSet${SET}\\b`, 'i').test(k))
      .map(([, v]) => [v.id!, v.name!]),
  );

  // LIVE CONTENT ONLY. map22's set-18 shop holds two prefixes: `DA_*` (74, all
  // of them present in Riot's published Data Dragon, all in the in-game trait
  // list) and `TFT18_*` (19, ZERO in Data Dragon, 10 with no icon path and 10
  // with no display-name string, none visible in the client). The second group
  // is datamined future content — shipping it would invent champions players
  // cannot field, and every one of them would land in the catalog trait-less.
  const isLive = (id: string) => /^DA_/.test(id);

  const champs: Champ[] = shop
    .filter((c) => (c.BaseCost ?? 0) >= 1 && (c.BaseCost ?? 0) <= 5 && c.mName && isLive(c.mName))
    .map((c) => ({
      id: c.mName!,
      name: MANUAL_NAMES[c.mName!] ?? ddName.get(c.mName!) ?? deriveName(c.mName!),
      cost: c.BaseCost!,
      icon: c.SquareSplashPath ?? c.TeamPlannerPortraitPath ?? null,
    }));
  const champByName = new Map<string, Champ>();
  for (const c of champs) if (!champByName.has(norm(c.name))) champByName.set(norm(c.name), c);

  // ── parse the hand-written list ────────────────────────────────────────────
  const lines = (await readFile(SRC, 'utf8')).split(/\r?\n/).map((l) => l.trim());
  const byTrait = new Map<string, Set<string>>();
  let section: string | null = null;
  let current: string | null = null;
  let pending: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l === '----') {
      const label = lines[i + 1];
      if (['class', 'origin', 'unique'].includes(label)) { section = label; current = null; pending = null; i += 2; }
      continue;
    }
    if (!l) { if (section !== 'unique') current = null; continue; }
    if (section === 'unique') {
      if (pending === null) pending = l;
      else { (byTrait.get(l) ?? byTrait.set(l, new Set()).get(l)!).add(pending); pending = null; }
      continue;
    }
    if (current === null) { current = l; if (!byTrait.has(l)) byTrait.set(l, new Set()); continue; }
    byTrait.get(current)!.add(l);
  }

  // "KobukoGnar" is two names run together in the source list.
  for (const set of byTrait.values()) {
    if (set.delete('KobukoGnar')) { set.add('Kobuko'); set.add('Gnar'); }
  }

  // ── resolve ────────────────────────────────────────────────────────────────
  const assigned = new Map<string, Set<string>>();
  const unresolvedChamp: string[] = [];
  const unresolvedTrait: string[] = [];
  const add = (champId: string, traitApi: string) => {
    if (!assigned.has(champId)) assigned.set(champId, new Set());
    assigned.get(champId)!.add(traitApi);
  };

  for (const [traitName, members] of byTrait) {
    const t = traitByName.get(norm(traitName));
    if (!t) { unresolvedTrait.push(traitName); continue; }
    for (const m of members) {
      const c = champByName.get(norm(m));
      if (!c) { unresolvedChamp.push(`${m} (under ${traitName})`); continue; }
      add(c.id, t.api);
    }
  }

  // ── derived rules (documented, not hand-typed) ─────────────────────────────
  // AVATAR: each Lux variant is Avatar plus the trait named in its display
  // name — "Lux (Coven)" is the Coven Avatar. Fielding one converts every other
  // Avatar in the shop to that trait, and it counts DOUBLE for bonuses; the
  // doubling is a combat rule, not an identity one, so it is not modelled here.
  const avatar = traitByName.get(norm('Avatar'));
  let luxCount = 0;
  if (avatar) {
    for (const c of champs) {
      if (!/^Lux/i.test(c.name) && !/Lux/i.test(c.id)) continue;
      add(c.id, avatar.api);
      const inner = c.name.match(/\(([^)]+)\)/)?.[1];
      const t = inner ? traitByName.get(norm(inner)) : undefined;
      if (t) add(c.id, t.api);
      luxCount += 1;
    }
  }
  // RIVAL: Kha'Zix and Rengar. Kha'Zix's evolve choice (Executioner / Rapidfire
  // / Ravager / Spellweaver) is picked in-game per match, so it is deliberately
  // NOT static identity — only Rival is.
  const rival = traitByName.get(norm('Rival'));
  let rivalCount = 0;
  if (rival) {
    for (const c of champs) {
      if (/KhaZix|Kha'Zix|Rengar/i.test(c.id) || /Kha'?Zix|Rengar/i.test(c.name)) { add(c.id, rival.api); rivalCount += 1; }
    }
  }

  // ── report ─────────────────────────────────────────────────────────────────
  console.log(`champions in map22 (cost 1-5): ${champs.length}`);
  console.log(`traits in CDragon:             ${traits.length}`);
  console.log(`resolved from the list:        ${assigned.size - luxCount - rivalCount} champions`);
  console.log(`derived (Avatar/Lux):          ${luxCount}`);
  console.log(`derived (Rival):               ${rivalCount}`);
  console.log(`TOTAL with >=1 trait:          ${assigned.size} / ${champs.length}`);

  if (unresolvedTrait.length) {
    console.log(`\nUNRESOLVED TRAIT NAMES (${unresolvedTrait.length}):`);
    for (const t of unresolvedTrait) console.log(`  ${t}`);
  }
  if (unresolvedChamp.length) {
    console.log(`\nUNRESOLVED CHAMPION NAMES (${unresolvedChamp.length}):`);
    for (const c of unresolvedChamp) console.log(`  ${c}`);
  }
  const missing = champs.filter((c) => !assigned.has(c.id));
  if (missing.length) {
    console.log(`\nNO TRAIT ASSIGNED (${missing.length}):`);
    for (const c of missing) console.log(`  ${c.id.padEnd(26)} ${c.name} (cost ${c.cost})`);
  }

  // ── emit ───────────────────────────────────────────────────────────────────
  const rows = [...assigned.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([id, set]) => {
      const c = champs.find((x) => x.id === id)!;
      const list = [...set].sort().map((t) => `'${t}'`).join(', ');
      return `  ${id}: [${list}], // ${c.name} (cost ${c.cost})`;
    });

  const body = `// AUTO-GENERATED by scripts/_gen-set18-traits.ts " do not hand-edit.
//
// TEMPORARY. Set 18 launched with CDragon's TFT extractor unable to read the
// new data format: it published the set's traits, items and augments but only
// 2 of its ${champs.length} champions, and crucially NO champion-to-trait links " a mapping
// that exists in no public source (checked: cdragon tft json, cdragon pbe,
// map22.bin.json raw, Data Dragon tft-champion/tft-trait).
//
// So the links were transcribed from the in-game client by hand and resolved
// against real ids here. Champions, costs and icons still come from map22,
// which IS current; only this one mapping is human-sourced.
//
// DELETE THIS FILE once \`npx tsx scripts/_set-readiness.ts\` reports READY " the
// loader prefers real trait data whenever the source provides it, so a stale
// copy is inert rather than harmful, but it should not outlive its reason.
//
// Generated ${new Date().toISOString().slice(0, 10)} " ${assigned.size}/${champs.length} champions.

export const SET18_TRAITS: Record<string, string[]> = {
${rows.join('\n')}
};
`.replace(/ " /g, ' \u2014 ');

  await writeFile(OUT, body, 'utf8');
  console.log(`\nwrote ${OUT} (${rows.length} champions)`);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
