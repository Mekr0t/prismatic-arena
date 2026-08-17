// merge-eval.ts — replay the Stage-6 merge over live data and evaluate it.
//
// Turns merge tuning from vibes into a measurable loop: runs the exact
// production path (loadCompProfiles → mergeComps) read-only (nothing is
// written), prints an archetype summary, checks a hand-labeled pairs file,
// and explains any individual pair on demand.
//
// Usage:
//   npm run merge:eval                     summary + labeled-pairs verdicts
//   npm run merge:eval -- --set 17         scope to one set
//   npm run merge:eval -- --why 123 456    why do/don't comps 123 and 456 merge?
//
// Pairs file (scripts/merge-eval-pairs.json):
//   { "pairs": [ { "a": 123, "b": 456, "expect": "merge", "note": "board4 photos" } ] }
// expect is "merge" (same archetype) or "split" (must stay separate). Comp ids
// come from the admin inspector (/admin/inspector). Exit code 1 on any failing
// pair, so this can gate a tuning change.

import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pool } from '@/lib/db';
import {
  loadCompProfiles,
  loadTailProfiles,
  loadMergeStatic,
} from '@/server/queue/stages/merge';
import {
  mergeComps,
  makeTailAssigner,
  debugCompare,
  type CompProfile,
  type CompareResult,
} from '@/server/queue/comp-merge';

// Mirrors the stage's MERGE_SEED_MIN_TOTAL split (mid-tier joins the merge,
// singletons are assign-only) so the eval replays the exact production path.
const SEED_MIN_TOTAL = (() => {
  const n = Number(process.env.MERGE_SEED_MIN_TOTAL);
  return Number.isFinite(n) ? n : 2;
})();

interface EvalPair {
  a: number;
  b: number;
  expect: 'merge' | 'split';
  note?: string;
  /** Tracked aspiration, not a gate: printed as KNOWN when unmet, exit stays 0.
   *  For boundary cases the current algorithm can't satisfy yet (e.g. cases
   *  waiting on the trait-similarity term). */
  known?: boolean;
}

function numArg(args: string[], flag: string): number | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const n = Number(args[i + 1]);
  return Number.isFinite(n) ? n : undefined;
}

function strArg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function fmtCompare(r: CompareResult): string {
  const parts =
    `score ${r.score.toFixed(3)}  cont ${r.containment.toFixed(2)}  ` +
    `jac ${r.jaccard.toFixed(2)}  carry ${r.carryOverlap.toFixed(2)}  ` +
    `trait ${r.traitSim >= 0 ? r.traitSim.toFixed(2) : '—'}`;
  return r.fails.length === 0 ? `${parts}  → MERGE` : `${parts}  → fails: ${r.fails.join(', ')}`;
}

function fmtProfile(p: CompProfile): string {
  const units = [...p.units]
    .sort()
    .map((u) => {
      const w = p.unitWeights.get(u);
      return w !== undefined && w !== 1 ? `${u}(${w})` : u;
    })
    .join(', ');
  const lines = [
    `  comp ${p.compId} (set ${p.setNumber}, ${p.boardCount} boards)`,
    `    units:   ${units}`,
    `    carries: ${[...p.carries].sort().join(', ') || '—'}`,
    `    dmg:     ${[...p.damageCarries].sort().join(', ') || '—'}`,
    `    grade3★: ${[...p.carryGrade3].sort().join(', ') || '—'}`,
    `    frame:   ${[...p.traitFrame.entries()]
      .sort((x, y) => y[1] - x[1])
      .map(([t, v]) => `${t.replace(/^TFT\d+_/, '')}:${v.toFixed(1)}`)
      .join(' ') || '—'}`,
  ];
  if (p.copySig) lines.push(`    copySig: ${p.copySig}`);
  if (p.heroAugmentSig) lines.push(`    heroAug: ${p.heroAugmentSig}`);
  return lines.join('\n');
}

function why(
  byId: Map<number, CompProfile>,
  labelById: Map<number, string>,
  aId: number,
  bId: number,
): void {
  const a = byId.get(aId);
  const b = byId.get(bId);
  if (!a || !b) {
    console.error(
      `comp ${!a ? aId : bId} is not in the merge input — no boards at all, wrong set, or unknown id.`,
    );
    process.exitCode = 1;
    return;
  }
  const la = labelById.get(aId);
  const lb = labelById.get(bId);
  const same = la !== undefined && la === lb; // undefined = unlabeled ≠ merged
  console.log(
    same
      ? `SAME archetype: ${la}`
      : `DIFFERENT archetypes:\n  a → ${la ?? '(unlabeled)'}\n  b → ${lb ?? '(unlabeled)'}`,
  );
  console.log('\nProfiles:');
  console.log(fmtProfile(a));
  console.log(fmtProfile(b));
  // Pairwise, both directions (dominant sets come from the seed side, so the
  // verdict can be asymmetric — e.g. empty-vs-nonempty carry-grade 3★).
  console.log('\nPairwise verdicts:');
  console.log(`  a vs b: ${fmtCompare(debugCompare(a, b))}`);
  console.log(`  b vs a: ${fmtCompare(debugCompare(b, a))}`);
  if (same) {
    console.log(
      '\nNote: they share an archetype in the full run; pairwise verdicts above may still' +
      '\nsay split — membership can come via intermediate variants widening the archetype.',
    );
  }
}

interface TailStats {
  total: number;
  totalBoards: number;
  assigned: number;
  assignedBoards: number;
}

function summary(
  merged: { floored: number; mid: number },
  tail: TailStats,
  byId: Map<number, CompProfile>,
  labelById: Map<number, string>,
): void {
  const rows = new Map<string, { members: number; boards: number }>();
  for (const [compId, label] of labelById) {
    const p = byId.get(compId);
    if (!p) continue;
    const r = rows.get(label) ?? { members: 0, boards: 0 };
    r.members += 1;
    r.boards += p.boardCount;
    rows.set(label, r);
  }
  const sorted = [...rows.entries()].sort((x, y) => y[1].boards - x[1].boards);
  const singletons = sorted.filter(([, r]) => r.members === 1).length;
  const disambiguated = sorted.filter(([l]) => l.includes('##k:')).length;

  console.log(
    `${merged.floored} floored + ${merged.mid} mid-tier comps → ${rows.size} archetypes`,
  );
  console.log(
    `singleton tail: ${tail.assigned}/${tail.total} comps assigned, ` +
    `${tail.assignedBoards}/${tail.totalBoards} boards recovered`,
  );
  console.log(`singleton archetypes: ${singletons}   disambiguated labels (##k:): ${disambiguated}`);
  console.log('\nTop archetypes by boards (incl. assigned tail):');
  for (const [label, r] of sorted.slice(0, 15)) {
    console.log(
      `  ${String(r.boards).padStart(6)} boards  ${String(r.members).padStart(3)} comps  ${label}`,
    );
  }
}

function evalPairs(
  byId: Map<number, CompProfile>,
  labelById: Map<number, string>,
  archetypeProfiles: ReadonlyMap<string, CompProfile>,
  file: string,
): void {
  if (!existsSync(file)) {
    console.log(`\n(no pairs file at ${file} — add labeled pairs to track merge quality)`);
    return;
  }
  const doc = JSON.parse(readFileSync(file, 'utf8')) as { pairs?: EvalPair[] };
  const pairs = doc.pairs ?? [];
  if (pairs.length === 0) {
    console.log(`\n(pairs file ${file} has no entries yet — fill in comp ids from /admin/inspector)`);
    return;
  }

  let failures = 0;
  console.log(`\nLabeled pairs (${pairs.length}):`);
  for (const p of pairs) {
    const a = byId.get(p.a);
    const b = byId.get(p.b);
    const note = p.note ? `  (${p.note})` : '';
    if (!a || !b) {
      console.log(`  SKIP  ${p.a} vs ${p.b} — comp ${!a ? p.a : p.b} not in merge input${note}`);
      continue;
    }
    const la = labelById.get(p.a);
    const lb = labelById.get(p.b);
    // Two UNLABELED comps are separate singleton rows, not a merge — undefined
    // labels must never compare equal (tail-tail pairs would silently "pass").
    const merged = la !== undefined && la === lb;
    const ok = (p.expect === 'merge') === merged;
    if (!ok && !p.known) failures++;
    const verdict = ok ? 'PASS ' : p.known ? 'KNOWN' : 'FAIL ';
    console.log(
      `  ${verdict} ${p.a} vs ${p.b} — expected ${p.expect}, got ${merged ? 'merge' : 'split'}${note}`,
    );
    if (!ok) {
      console.log(`        pairwise: ${fmtCompare(debugCompare(a, b))}`);
      console.log(`        labels:   ${la}  |  ${lb}`);
      // A pair can merge pairwise yet split in the full run — the accumulated
      // archetype profiles are what pass 1 / the fold pass actually compare.
      const archA = la !== undefined ? archetypeProfiles.get(la) : undefined;
      const archB = lb !== undefined ? archetypeProfiles.get(lb) : undefined;
      if (archB) console.log(`        a vs B's archetype: ${fmtCompare(debugCompare(a, archB))}`);
      if (archA) console.log(`        b vs A's archetype: ${fmtCompare(debugCompare(b, archA))}`);
      if (archA && archB) {
        console.log(`        A-arch vs B-arch:   ${fmtCompare(debugCompare(archA, archB))}`);
      }
    }
  }
  console.log(failures === 0 ? '\nAll labeled pairs pass.' : `\n${failures} pair(s) failing.`);
  if (failures > 0) process.exitCode = 1;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const setNumber = numArg(args, '--set');
  const pairsFile =
    strArg(args, '--pairs') ?? path.join(process.cwd(), 'scripts', 'merge-eval-pairs.json');

  const client = await pool.connect();
  let floored: CompProfile[];
  let mid: CompProfile[];
  let tail: CompProfile[];
  try {
    const shared = await loadMergeStatic(client, setNumber);
    floored = await loadCompProfiles(client, setNumber, shared);
    mid = await loadTailProfiles(client, setNumber, { minTotal: SEED_MIN_TOTAL }, shared);
    tail = await loadTailProfiles(client, setNumber, { maxTotal: SEED_MIN_TOTAL }, shared);
  } finally {
    client.release();
  }

  const profiles = [...floored, ...mid];
  if (profiles.length === 0) {
    console.log('No tier-relevant comps found (has cluster + rollup run? is the floor too high?).');
    return;
  }

  const result = await mergeComps(profiles);

  // Assign-only labeling of the singleton tail — mirrors runMerge.
  const assign = makeTailAssigner(result.archetypeProfiles);
  const labelById = new Map(result.assignments);
  let assigned = 0;
  let assignedBoards = 0;
  let tailBoards = 0;
  for (const t of tail) {
    tailBoards += t.boardCount;
    const label = assign(t);
    if (label !== null) {
      labelById.set(t.compId, label);
      assigned++;
      assignedBoards += t.boardCount;
    }
  }

  const byId = new Map([...profiles, ...tail].map((p) => [p.compId, p] as const));

  const whyIdx = args.indexOf('--why');
  if (whyIdx >= 0) {
    why(byId, labelById, Number(args[whyIdx + 1]), Number(args[whyIdx + 2]));
    return;
  }

  summary(
    { floored: floored.length, mid: mid.length },
    { total: tail.length, totalBoards: tailBoards, assigned, assignedBoards },
    byId,
    labelById,
  );
  evalPairs(byId, labelById, result.archetypeProfiles, pairsFile);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void pool.end());
