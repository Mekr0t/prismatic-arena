import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIdentity,
  emblemsFromSignature,
  isEmblemItem,
  MIN_BOARD_UNITS,
  SIG_STAR_MAX_COST,
  type SigUnit,
} from './comp-signature';

// comp-signature defines what a comp IS. Every board in the database is reduced
// through it, so a change here silently re-clusters the entire dataset — which
// is exactly why it needed pinning.
//
// The thresholds are exported, so these assert against MIN_BOARD_UNITS and
// SIG_STAR_MAX_COST rather than the literals 6 and 3: an env override retunes
// the module and the tests follow it instead of going red for the wrong reason.

const u = (characterId: string, cost = 2, star = 1): SigUnit => ({ characterId, cost, star });

/** A legal board of exactly MIN_BOARD_UNITS distinct cost-2 units. */
const board = (n = MIN_BOARD_UNITS): SigUnit[] =>
  Array.from({ length: n }, (_, i) => u(`TFT17_Unit${i}`));

const sig = (units: SigUnit[], emblems: string[] = []): string | null =>
  buildIdentity(units, emblems)?.signature ?? null;

// ── the core property ────────────────────────────────────────────────────────

test('unit ORDER never changes identity', () => {
  const b = board();
  const shuffled = [...b].reverse();
  assert.equal(sig(shuffled), sig(b));
});

test('emblem order and duplicates never change identity', () => {
  const b = board();
  const a = sig(b, ['TFT17_Item_AEmblemItem', 'TFT17_Item_BEmblemItem']);
  const c = sig(b, ['TFT17_Item_BEmblemItem', 'TFT17_Item_AEmblemItem', 'TFT17_Item_AEmblemItem']);
  assert.equal(c, a, 'emblems are deduped and sorted');
});

test('the same board reduces to the same signature every time', () => {
  assert.equal(sig(board()), sig(board()));
});

// ── what SPLITS identity ─────────────────────────────────────────────────────

test('a duplicate copy is a different comp (tokens are not deduped)', () => {
  const single = board();
  const doubled = [...board(), u('TFT17_Unit0')];
  assert.notEqual(sig(doubled), sig(single));
});

test('a different unit is a different comp', () => {
  const a = board();
  const b = [...board().slice(0, -1), u('TFT17_Different')];
  assert.notEqual(sig(b), sig(a));
});

test('a worn emblem splits identity from the same units without it', () => {
  const b = board();
  assert.notEqual(sig(b, ['TFT17_Item_DarkStarEmblemItem']), sig(b));
});

// ── star bucketing ───────────────────────────────────────────────────────────

test('1-star and 2-star are the SAME identity', () => {
  const ones = board().map((x) => ({ ...x, star: 1 }));
  const twos = board().map((x) => ({ ...x, star: 2 }));
  assert.equal(sig(twos), sig(ones));
});

test('a 3-star on a reroll-cost unit splits identity', () => {
  const flat = board();
  const hit = [...board()];
  hit[0] = u('TFT17_Unit0', SIG_STAR_MAX_COST, 3);
  assert.notEqual(sig(hit), sig(flat));
});

// The subtle one. A 3★ 4/5-cost is a lottery hit or a set mechanic (the Arbiter
// "print", a 7-piece Meeple duplicate) landing on a fast-8/9 board. It changes
// the board's PLACEMENT, not what the comp IS, so it must not cluster that
// board away from the same comp without the hit.
test('a 3-star ABOVE the cost gate does NOT split identity', () => {
  const expensive = SIG_STAR_MAX_COST + 1;
  assert.ok(expensive <= 5, 'the gate must leave room for a real high-cost unit');
  const flat = [...board().slice(0, -1), u('TFT17_Carry', expensive, 1)];
  const lucky = [...board().slice(0, -1), u('TFT17_Carry', expensive, 3)];
  assert.equal(sig(lucky), sig(flat));
});

test('threeStars reports only hits at or below the cost gate', () => {
  const units = [
    ...board().slice(0, -2),
    u('TFT17_Reroll', SIG_STAR_MAX_COST, 3),
    u('TFT17_Lottery', 5, 3),
  ];
  const id = buildIdentity(units)!;
  assert.deepEqual(id.threeStars, ['TFT17_Reroll'], 'a 3-star 5-cost is not a "hit"');
});

// ── filtering ────────────────────────────────────────────────────────────────

test('summons (cost > 5) and unknown-cost units are excluded entirely', () => {
  const clean = board();
  const noisy = [...board(), u('TFT17_Summon', 9), u('TFT17_Unknown', 0)];
  const id = buildIdentity(noisy)!;
  assert.equal(id.signature, sig(clean), 'they must not appear in the signature');
  assert.ok(!id.coreUnits.includes('TFT17_Summon'));
  assert.ok(!id.coreUnits.includes('TFT17_Unknown'));
});

test('filtered units do not count toward the board-size floor', () => {
  const short = [
    ...board(MIN_BOARD_UNITS - 1),
    u('TFT17_Summon', 9),
    u('TFT17_Unknown', 0),
    u('TFT17_AlsoSummon', 6),
  ];
  assert.equal(buildIdentity(short), null, 'three fake units cannot pad a short board');
});

// ── the board-size floor ─────────────────────────────────────────────────────

test('a board below the floor is unclusterable, not an error', () => {
  assert.equal(buildIdentity(board(MIN_BOARD_UNITS - 1)), null);
  assert.equal(buildIdentity([]), null);
  assert.ok(buildIdentity(board(MIN_BOARD_UNITS)) !== null, 'exactly at the floor still clusters');
});

// Documents the SILENT LOSS the audit flagged (§2.3): a set with no loaded
// static catalog gives every unit cost 0, so the whole board filters away and
// clusters to nothing — with no job-level signal that it happened.
test('a board with no known costs vanishes silently (known gap)', () => {
  const unknownSet = Array.from({ length: 10 }, (_, i) => u(`TFT99_Unit${i}`, 0));
  assert.equal(buildIdentity(unknownSet), null, 'see audit §2.3 Silent loss');
});

// ── emblem helpers ───────────────────────────────────────────────────────────

test('isEmblemItem matches the id shape case-insensitively', () => {
  assert.equal(isEmblemItem('TFT17_Item_DarkStarEmblemItem'), true);
  assert.equal(isEmblemItem('tft17_item_darkstaremblemitem'), true);
  assert.equal(isEmblemItem('TFT_Item_InfinityEdge'), false);
  assert.equal(isEmblemItem(''), false);
});

test('emblemsFromSignature round-trips what buildIdentity wrote', () => {
  const emblems = ['TFT17_Item_BEmblemItem', 'TFT17_Item_AEmblemItem'];
  const id = buildIdentity(board(), emblems)!;
  assert.deepEqual(emblemsFromSignature(id.signature), [...emblems].sort());
  assert.deepEqual(id.emblems, [...emblems].sort(), 'the parsed set matches the stored one');
});

test('emblemsFromSignature ignores unit tokens and tolerates junk', () => {
  assert.deepEqual(emblemsFromSignature(sig(board())), [], 'no emblems, no tokens');
  assert.deepEqual(emblemsFromSignature(null), []);
  assert.deepEqual(emblemsFromSignature(undefined), []);
  assert.deepEqual(emblemsFromSignature(''), []);
  assert.deepEqual(emblemsFromSignature('TFT17_Unit0:lo|TFT17_Unit1:3'), []);
});

// ── shape of the returned identity ───────────────────────────────────────────

test('coreUnits keeps every real unit, duplicates included, sorted', () => {
  const id = buildIdentity([...board(), u('TFT17_Unit0')])!;
  assert.equal(id.coreUnits.length, MIN_BOARD_UNITS + 1);
  assert.deepEqual(id.coreUnits, [...id.coreUnits].sort(), 'sorted for stable display');
  assert.equal(id.coreUnits.filter((c) => c === 'TFT17_Unit0').length, 2);
});
