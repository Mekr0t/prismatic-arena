import 'dotenv/config';
import {
  MIN_REAL_ROSTER,
  rosterSize,
  canonicalEntry,
  type CDragonSetLite,
} from './cdragon-set';
import { isEmblemItem } from '@/server/queue/comp-signature';
import { isArtifactItem, isRadiantItem } from '@/server/item-filters';

// _set-readiness.ts — "can I load the new set yet?", answered from the sources
// rather than by re-running the loader blind.
//
// Written on set-18 launch day, when CDragon's TFT extractor had published the
// set's traits, items and augments but only 2 of its 64 champions — and the
// file had been rebuilt AFTER launch, so waiting on a clock told you nothing.
// Riot's Data Dragon had the full roster the whole time, which is the tell that
// the gap is CDragon-side rather than Riot being slow.
//
// It reads the SAME gate the loader uses (./cdragon-set), so a green verdict
// here means `npm run data:load` will actually go through.
//
// Exit code is the point: 0 = loadable, 1 = not yet. So this works:
//   until npx tsx scripts/_set-readiness.ts; do sleep 600; done && npm run data:load
//
// Usage: npx tsx scripts/_set-readiness.ts [setNumber]   (defaults to SET_NUMBER, else the newest CDragon knows)

const CDRAGON = 'https://raw.communitydragon.org';
const DDRAGON = 'https://ddragon.leagueoflegends.com';

interface CDragonPayload {
  setData?: CDragonSetLite[];
  sets?: Record<string, CDragonSetLite>;
  items?: { apiName?: string; name?: string }[];
}

const bust = (u: string) => `${u}${u.includes('?') ? '&' : '?'}cb=${Date.now()}`;

async function cdragon(channel: 'latest' | 'pbe') {
  const url = `${CDRAGON}/${channel}/cdragon/tft/en_us.json`;
  const res = await fetch(bust(url), { cache: 'no-store' });
  if (!res.ok) throw new Error(`${channel}: HTTP ${res.status}`);
  const modified = res.headers.get('last-modified');
  const data = (await res.json()) as CDragonPayload;
  return { modified, data };
}

/** Riot's own feed, as the control: it tells us whether the roster EXISTS. */
async function ddragonRoster(set: number): Promise<{ version: string; champions: number }> {
  const versions = (await (await fetch(`${DDRAGON}/api/versions.json`)).json()) as string[];
  const version = versions[0];
  const j = (await (
    await fetch(`${DDRAGON}/cdn/${version}/data/en_US/tft-champion.json`)
  ).json()) as { data?: Record<string, { cost?: number }> };
  const champions = Object.entries(j.data ?? {}).filter(
    ([key, v]) => new RegExp(`TFTSet${set}\\b`, 'i').test(key) && (v.cost ?? 0) >= 1 && (v.cost ?? 0) <= 5,
  ).length;
  return { version, champions };
}

/** Item ids the app's own predicates would classify differently than set 17 did. */
function classifierReport(items: { apiName?: string; name?: string }[], set: number) {
  const prefixed = items.filter((i) => new RegExp(`^(TFT${set}_|DA_${set}_)`, 'i').test(i.apiName ?? ''));
  const emblems = prefixed.filter((i) => isEmblemItem(i.apiName ?? ''));
  const artifacts = prefixed.filter((i) => isArtifactItem(i.apiName ?? ''));
  const radiants = prefixed.filter((i) => isRadiantItem(i.apiName ?? ''));

  // The failure mode that matters: something NAMED an emblem/artifact that the
  // id-shape predicate misses. An unrecognised emblem silently splits every
  // board that wears it away from its line, because emblems are part of the
  // comp signature.
  //
  // SHOP OFFERINGS ARE EXCLUDED, and calibrating that mattered: run against
  // set 17 (fully published, everything classified correctly) the naive name
  // check flagged three items — MarketOffering_ArtifactAnvil, two
  // DelayedRandomArtifact. Those are the anvil that GRANTS an artifact, not an
  // artifact, so the predicate is right to reject them. A checker that cries
  // wolf on a known-good set gets ignored on the set it was built for, so the
  // baseline has to be clean.
  const isOffering = (id: string) => /MarketOffering|Anvil|ArmoryKey|Chest|Key/i.test(id);
  const equippable = prefixed.filter((i) => !isOffering(i.apiName ?? ''));
  const missedEmblems = equippable.filter(
    (i) => /emblem/i.test(i.name ?? '') && !isEmblemItem(i.apiName ?? ''),
  );
  const missedArtifacts = equippable.filter(
    (i) => /artifact/i.test(i.name ?? '') && !isArtifactItem(i.apiName ?? ''),
  );
  return { total: prefixed.length, emblems, artifacts, radiants, missedEmblems, missedArtifacts };
}

/**
 * Are a set's ABILITY NUMBERS published yet?
 *
 * Separate from the roster gate on purpose: set 18 loaded fine while every one
 * of its ability descriptions rendered with the numbers missing, because
 * CDragon ships `variables: []` for 72 of its 74 champions.
 *
 * The values live in the per-character bin at
 * `game/characters/<id>.cdtb.bin.json`, and set 18's are STUBS — every champion
 * publishes the identical spell block: one calculation keyed `{d678dbfb}` and
 * DataValues literally named `DataValue` / `OtherValue`. A real one (set 17's
 * Briar) names them after the ability: `ModifiedDamage`, `ADDamage`, `APDamage`.
 *
 * So the tell is simple — do the champions differ from each other, and are the
 * names readable? Sampled rather than exhaustive: 74 fetches to answer a
 * yes/no question is rude to CDragon, and stubs are identical by definition.
 */
async function abilityDataReport(
  champions: { apiName?: string; cost?: number; traits?: string[] }[],
): Promise<{
  sampled: number;
  reachable: number;
  distinctShapes: number;
  readableNames: number;
  stub: boolean;
}> {
  // PLAYABLE champions only. The set list also carries jungle camps and
  // training dummies, and those are long-standing units whose bins DO hold real
  // spell data — sampling one reports "available" for a set whose actual roster
  // is still stubbed. Same has-a-trait rule the roster gate uses.
  const sample = champions
    .filter((c) => c.apiName && (c.cost ?? 0) >= 1 && (c.cost ?? 0) <= 5 && (c.traits?.length ?? 0) > 0)
    .slice(0, 5);
  let reachable = 0;
  let readableNames = 0;
  const shapes = new Set<string>();

  for (const c of sample) {
    const url = `${CDRAGON}/latest/game/characters/${String(c.apiName).toLowerCase()}.cdtb.bin.json`;
    const res = await fetch(bust(url), { cache: 'no-store' }).catch(() => null);
    if (!res?.ok) continue;
    reachable++;
    const j = (await res.json()) as Record<string, unknown>;
    const key = Object.keys(j).find((k) => /\/Spells\/[^/]*Spell$/i.test(k));
    const spell = key ? ((j[key] as Record<string, unknown>)?.mSpell as Record<string, unknown>) : null;
    const calcs = Object.keys((spell?.mSpellCalculations as object) ?? {});
    const dvs = ((spell?.DataValues as { name?: string }[]) ?? []).map((d) => String(d.name));
    // A stub keys its calculation by hash and names its values generically.
    const named = calcs.some((k) => !/^\{[0-9a-f]{8}\}$/.test(k)) ||
      dvs.some((n) => !/^(Data|Other)Value$/i.test(n));
    if (named) readableNames++;
    shapes.add(JSON.stringify([calcs.sort(), dvs.sort()]));
  }

  return {
    sampled: sample.length,
    reachable,
    distinctShapes: shapes.size,
    readableNames,
    // Every sampled champion sharing one shape, with no readable names, is the
    // signature of a template record rather than real per-champion data.
    stub: reachable > 1 && shapes.size === 1 && readableNames === 0,
  };
}

(async () => {
  const arg = process.argv[2] ?? process.env.SET_NUMBER;
  const [live, pbe] = await Promise.all([cdragon('latest'), cdragon('pbe')]);

  const entries = live.data.setData ?? [];
  const numbers = [...new Set(entries.map((s) => s.number ?? 0))].filter((n) => n > 0);
  const set = arg ? Number(arg) : Math.max(...numbers);
  if (!Number.isFinite(set)) throw new Error(`Not a set number: ${arg}`);

  console.log(`\n=== set ${set} readiness ===\n`);

  const rows = [live, pbe].map((src, i) => {
    const chan = i === 0 ? 'cdragon/latest' : 'cdragon/pbe';
    const entry = canonicalEntry(src.data.setData ?? [], set);
    return {
      source: chan,
      rostered: rosterSize(entry),
      champions: entry?.champions?.length ?? 0,
      traits: entry?.traits?.length ?? 0,
      augments: entry?.augments?.length ?? 0,
      rebuilt: src.modified ?? '?',
    };
  });

  const dd = await ddragonRoster(set).catch(() => null);
  if (dd) {
    rows.push({
      source: `ddragon ${dd.version}`,
      rostered: dd.champions,
      champions: dd.champions,
      traits: 0,
      augments: 0,
      rebuilt: '(control: does the roster exist at all?)',
    });
  }
  console.table(rows);

  const ready = rosterSize(canonicalEntry(live.data.setData ?? [], set)) >= MIN_REAL_ROSTER;

  if (ready) {
    console.log(`READY — cdragon/latest has a full roster (>= ${MIN_REAL_ROSTER}).`);
    console.log('  run: npm run data:load');

    const rep = classifierReport(live.data.items ?? [], set);
    console.log(`\nitem classifiers over ${rep.total} set-${set} items:`);
    console.log(`  emblems ${rep.emblems.length} · artifacts ${rep.artifacts.length} · radiants ${rep.radiants.length}`);
    if (rep.missedEmblems.length) {
      console.log(`  WARNING: ${rep.missedEmblems.length} item(s) NAMED an emblem that isEmblemItem() misses:`);
      for (const i of rep.missedEmblems.slice(0, 8)) console.log(`    ${i.apiName} ("${i.name}")`);
      console.log('    -> emblems are part of the comp signature; unrecognised ones split boards off their line.');
    }
    if (rep.missedArtifacts.length) {
      console.log(`  WARNING: ${rep.missedArtifacts.length} item(s) NAMED an artifact that isArtifactItem() misses:`);
      for (const i of rep.missedArtifacts.slice(0, 8)) console.log(`    ${i.apiName} ("${i.name}")`);
      console.log('    -> ARTIFACT_ID_RE in item-filters.ts assumes TFT_Item_Artifact_* / Ornn families.');
    }
    if (!rep.missedEmblems.length && !rep.missedArtifacts.length) {
      console.log('  no id-shape mismatches — the classifiers handle this set as-is.');
    }

    // Loadable and "ability numbers present" are different questions; this set
    // has been loadable for days with every ability rendering numberless.
    const entry = canonicalEntry(live.data.setData ?? [], set);
    const ab = await abilityDataReport(entry?.champions ?? []);
    console.log(`
ability numbers (per-character bins, ${ab.reachable}/${ab.sampled} reachable):`);
    if (ab.stub) {
      console.log(
        `  NOT YET — all ${ab.reachable} sampled champions publish the SAME spell block ` +
          `with generic value names. Riot has not shipped the real data, so ability
` +
          `  descriptions will keep rendering without their numbers. Nothing to do but wait.`,
      );
    } else if (ab.readableNames > 0) {
      console.log(
        `  AVAILABLE — ${ab.readableNames}/${ab.reachable} sampled champions name their spell ` +
          `values after the ability. The per-character bins are worth wiring up:
` +
          `  they resolve the @Var@ placeholders CDragon's own variables array does not.`,
      );
    } else {
      console.log(`  inconclusive — ${ab.reachable} bins reachable, ${ab.distinctShapes} distinct shapes.`);
    }
  } else {
    const have = rosterSize(canonicalEntry(live.data.setData ?? [], set));
    console.log(`NOT READY — cdragon/latest has ${have} rostered champions, need >= ${MIN_REAL_ROSTER}.`);
    if (dd && dd.champions >= MIN_REAL_ROSTER) {
      console.log(
        `  Riot's Data Dragon already lists ${dd.champions}, so the roster EXISTS ` +
          `— this is a CDragon extraction gap, not Riot being slow.`,
      );
      console.log('  Nothing to do but wait; every TFT tool depends on that file, so it gets fixed fast.');
    } else {
      console.log('  Data Dragon does not have it either — the set genuinely has not shipped.');
    }
    console.log(`\n  poll until ready:\n    until npx tsx scripts/_set-readiness.ts ${set}; do sleep 600; done && npm run data:load`);
  }
  process.exit(ready ? 0 : 1);
})().catch((e) => {
  console.error('ERROR:', (e as Error).message);
  process.exit(2);
});
