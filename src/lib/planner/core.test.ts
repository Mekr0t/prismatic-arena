import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyBoard,
  computeActiveTraits,
  encodeBoard,
  decodeBoard,
  encodeRiotCode,
  decodeRiotCode,
  BOARD_SIZE,
  BOARD_COLS,
  BOARD_ROWS,
  type Cell,
  type PlannerUnit,
  type PlannerTrait,
  type PlannerItem,
} from './core';

// The planner's pure core: the trait engine and two independent codec formats
// (our own board code, and Riot's official team-planner string). Shareable
// links and game imports both go through here, so a silent break in either
// codec produces a link that looks fine and restores the wrong board.

const unit = (
  id: string,
  traits: string[],
  plannerCode: number | null = null,
): PlannerUnit => ({ id, name: id, cost: 2, traits, iconUrl: null, plannerCode });

const trait = (id: string, breakpoints: { minUnits: number; style: number }[]): PlannerTrait => ({
  id,
  name: id,
  iconUrl: null,
  breakpoints,
});

const emblem = (id: string, forTrait: string): PlannerItem => ({
  id,
  name: id,
  iconUrl: null,
  kind: 'emblem',
  trait: forTrait,
});

const place = (cells: Record<number, Cell>): Cell[] => {
  const b = emptyBoard();
  for (const [i, c] of Object.entries(cells)) b[Number(i)] = c;
  return b;
};

const at = (unitId: string, items: string[] = []): Cell => ({ unitId, items });

// ── the board ────────────────────────────────────────────────────────────────

test('an empty board is BOARD_SIZE nulls, and the dimensions agree', () => {
  const b = emptyBoard();
  assert.equal(b.length, BOARD_SIZE);
  assert.equal(BOARD_COLS * BOARD_ROWS, BOARD_SIZE);
  assert.ok(b.every((c) => c === null));
});

// ── trait engine ─────────────────────────────────────────────────────────────

const TRAITS = [
  trait('Bastion', [{ minUnits: 2, style: 1 }, { minUnits: 4, style: 3 }, { minUnits: 6, style: 4 }]),
  trait('Unique', [{ minUnits: 1, style: 4 }]),
];
const UNITS = new Map<string, PlannerUnit>([
  ['A', unit('A', ['Bastion'])],
  ['B', unit('B', ['Bastion'])],
  ['C', unit('C', ['Bastion'])],
  ['D', unit('D', ['Unique'])],
]);
const ITEMS = new Map<string, PlannerItem>([
  ['BastionEmblem', emblem('BastionEmblem', 'Bastion')],
]);

const traitsOn = (board: Cell[]) => computeActiveTraits(board, UNITS, ITEMS, TRAITS);
const find = (board: Cell[], id: string) => traitsOn(board).find((t) => t.id === id)!;

test('a trait counts UNIQUE units, so a duplicate copy adds nothing', () => {
  const twoCopies = place({ 0: at('A'), 1: at('A') });
  assert.equal(find(twoCopies, 'Bastion').count, 1, 'the same champion twice is still one Bastion');
  assert.equal(find(twoCopies, 'Bastion').style, 0, 'and therefore inactive');
});

test('the active style is the highest breakpoint reached', () => {
  assert.equal(find(place({ 0: at('A') }), 'Bastion').style, 0);
  assert.equal(find(place({ 0: at('A'), 1: at('B') }), 'Bastion').style, 1);
  const three = place({ 0: at('A'), 1: at('B'), 2: at('C') });
  assert.equal(find(three, 'Bastion').count, 3);
  assert.equal(find(three, 'Bastion').style, 1, '3 clears the 2-breakpoint but not the 4');
});

test('nextAt names the threshold still to reach, and clears when maxed', () => {
  assert.equal(find(place({ 0: at('A') }), 'Bastion').nextAt, 2);
  assert.equal(find(place({ 0: at('A'), 1: at('B') }), 'Bastion').nextAt, 4);
  assert.equal(find(place({ 0: at('D') }), 'Unique').nextAt, null, 'a maxed trait has no next');
});

test('a single-breakpoint trait is flagged unique', () => {
  assert.equal(find(place({ 0: at('D') }), 'Unique').unique, true);
  assert.equal(find(place({ 0: at('A') }), 'Bastion').unique, false);
});

test('an emblem grants its trait to the wearer', () => {
  const withEmblem = place({ 0: at('A'), 1: at('D', ['BastionEmblem']) });
  assert.equal(find(withEmblem, 'Bastion').count, 2, 'D now counts as a Bastion');
  assert.equal(find(withEmblem, 'Bastion').style, 1);
});

test('an emblem on a unit that ALREADY has the trait does not double-count', () => {
  const redundant = place({ 0: at('A', ['BastionEmblem']), 1: at('B') });
  assert.equal(find(redundant, 'Bastion').count, 2, 'still two distinct Bastions, not three');
});

test('a non-emblem item grants nothing', () => {
  const items = new Map<string, PlannerItem>([
    ['Sword', { id: 'Sword', name: 'Sword', iconUrl: null, kind: 'component' }],
  ]);
  const board = place({ 0: at('D', ['Sword']) });
  assert.equal(computeActiveTraits(board, UNITS, items, TRAITS).find((t) => t.id === 'Bastion'), undefined);
});

test('an unknown unit contributes no traits but does not throw', () => {
  const board = place({ 0: at('A'), 1: at('MysteryChampion') });
  assert.doesNotThrow(() => traitsOn(board));
  assert.equal(find(board, 'Bastion').count, 1);
});

test('a trait with no definition still surfaces, labelled by its id', () => {
  const units = new Map([['X', unit('X', ['NotInCatalog'])]]);
  const [t] = computeActiveTraits(place({ 0: at('X') }), units, ITEMS, TRAITS);
  assert.equal(t.id, 'NotInCatalog');
  assert.equal(t.name, 'NotInCatalog', 'falls back to the id rather than rendering blank');
  assert.equal(t.style, 0);
  assert.equal(t.unique, false);
});

test('results sort by style, then count, then name', () => {
  const board = place({ 0: at('A'), 1: at('B'), 2: at('D') });
  const order = traitsOn(board).map((t) => t.id);
  assert.deepEqual(order, ['Unique', 'Bastion'], 'style 4 outranks style 1');
});

// ── our own board code ───────────────────────────────────────────────────────

test('a board round-trips through encode/decode, positions and items intact', () => {
  const board = place({ 0: at('A', ['Sword', 'Bow']), 13: at('B'), 27: at('C', ['Rod']) });
  const restored = decodeBoard(encodeBoard(board))!;
  assert.deepEqual(restored, board);
});

test('an empty board encodes to nothing, and nothing decodes to an empty board', () => {
  assert.equal(encodeBoard(emptyBoard()), '');
  assert.deepEqual(decodeBoard(''), emptyBoard());
});

test('the code is versioned and URL-safe', () => {
  const code = encodeBoard(place({ 0: at('A') }));
  assert.ok(code.startsWith('1'), 'leading version byte');
  assert.ok(!/[+/=]/.test(code), `must survive a URL unescaped, got ${code}`);
});

test('garbage decodes to null rather than throwing', () => {
  for (const bad of ['not base64 at all!!', '1@@@@', '1' + btoa('{"not":"an array"}')]) {
    assert.doesNotThrow(() => decodeBoard(bad));
    assert.equal(decodeBoard(bad), null, `expected null for ${bad}`);
  }
});

test('a decoded cell is clamped to three items', () => {
  const code = '1' + btoa(JSON.stringify([{ i: 0, u: 'A', it: ['a', 'b', 'c', 'd', 'e'] }]));
  assert.deepEqual(decodeBoard(code)![0], { unitId: 'A', items: ['a', 'b', 'c'] });
});

test('out-of-range and malformed entries are dropped, not fatal', () => {
  const code =
    '1' +
    btoa(JSON.stringify([{ i: 0, u: 'A' }, { i: BOARD_SIZE, u: 'B' }, { i: -1, u: 'C' }, { i: 3 }]));
  const board = decodeBoard(code)!;
  assert.equal(board[0]?.unitId, 'A');
  assert.equal(board.filter((c) => c !== null).length, 1, 'only the valid entry survives');
});

// ── Riot's official team-planner code ────────────────────────────────────────

const RIOT_UNITS = new Map<string, PlannerUnit>([
  ['A', unit('A', [], 0x00e)],
  ['B', unit('B', [], 0x0f0)],
  ['NoCode', unit('NoCode', [], null)],
  ['ZeroCode', unit('ZeroCode', [], 0)],
]);
const BY_CODE = new Map<number, string>([
  [0x00e, 'A'],
  [0x0f0, 'B'],
]);

test('a Riot code is 02 + ten 3-digit hex slots + the set tag', () => {
  const code = encodeRiotCode(place({ 0: at('A'), 1: at('B') }), RIOT_UNITS, 17)!;
  assert.equal(code, '0200E0F0' + '000'.repeat(8) + 'TFTSet17');
  assert.equal(code.length, 2 + 30 + 'TFTSet17'.length);
});

test('a Riot code round-trips back to the same units, in board order', () => {
  const code = encodeRiotCode(place({ 5: at('B'), 0: at('A') }), RIOT_UNITS, 17)!;
  assert.deepEqual(decodeRiotCode(code, BY_CODE), ['A', 'B'], 'board order, not insertion order');
});

test('duplicates collapse to one slot, first occurrence winning', () => {
  const code = encodeRiotCode(place({ 0: at('A'), 1: at('A'), 2: at('B') }), RIOT_UNITS, 17)!;
  assert.deepEqual(decodeRiotCode(code, BY_CODE), ['A', 'B']);
});

test('units the game cannot import are skipped', () => {
  const board = place({ 0: at('NoCode'), 1: at('ZeroCode'), 2: at('A') });
  assert.deepEqual(decodeRiotCode(encodeRiotCode(board, RIOT_UNITS, 17)!, BY_CODE), ['A']);
});

test('an unencodeable board returns null instead of an empty code', () => {
  assert.equal(encodeRiotCode(emptyBoard(), RIOT_UNITS, 17), null);
  assert.equal(encodeRiotCode(place({ 0: at('NoCode') }), RIOT_UNITS, 17), null);
});

test('the code caps at ten champions', () => {
  const many = new Map<string, PlannerUnit>();
  const board = emptyBoard();
  for (let i = 0; i < 12; i++) {
    const id = `U${i}`;
    many.set(id, unit(id, [], i + 1));
    board[i] = at(id);
  }
  const code = encodeRiotCode(board, many, 17)!;
  const byCode = new Map(Array.from(many.values()).map((u) => [u.plannerCode!, u.id]));
  assert.equal(decodeRiotCode(code, byCode)!.length, 10, 'the 11th and 12th are dropped');
});

test('decodeRiotCode rejects anything that is not the format', () => {
  for (const bad of ['', '02TFTSet17', '0300E000TFTSet17', '0200E0TFTSet', '0200EEETFTSet17X', 'nonsense']) {
    assert.equal(decodeRiotCode(bad, BY_CODE), null, `expected null for ${JSON.stringify(bad)}`);
  }
  assert.equal(decodeRiotCode('0200E0F', BY_CODE), null, 'hex length must divide by 3');
});

test('decodeRiotCode tolerates lowercase hex and surrounding whitespace', () => {
  assert.deepEqual(decodeRiotCode('  0200e000TFTSet17  ', BY_CODE), ['A']);
});

test('empty slots and unknown champion codes are skipped, not rendered as gaps', () => {
  // 000 = empty, FFF = a champion this catalog does not know (e.g. another set).
  assert.deepEqual(decodeRiotCode('0200000EFFF0F0TFTSet17', BY_CODE), ['A', 'B']);
  assert.equal(decodeRiotCode('02FFFFFFTFTSet17', BY_CODE), null, 'nothing resolvable -> null');
});
