import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSIGN_BAR,
  CORE_RATE,
  MIN_SEPARATION,
  PROFILE_MIN_RATE,
  assignBoard,
  boardKey,
  convergeCentroids,
  coreUnits,
  groupBoards,
  headlineTrait,
  isMarkerTrait,
  jaccard,
  listableCentroids,
  nameCarries,
  nameCentroid,
  profileScore,
  resolveNameCollisions,
  seedProfiles,
  traitCounts,
  type Centroid,
  type ItemisationRate,
  type NameStatics,
  type UnitRate,
} from './comp-centroid';

// comp-centroid defines what a LINE is. Every board in the database is assigned
// through it, so a change here silently re-groups the entire dataset — the same
// reason comp-signature.ts is pinned this hard.
//
// Tests assert against the EXPORTED knobs, not the literals, so an env override
// retunes the module and the tests follow it instead of going red for the wrong
// reason.

const profile = (...pairs: [string, number][]): UnitRate[] =>
  pairs.map(([characterId, rate]) => ({ characterId, rate }));

const centroid = (units: UnitRate[], boards = 100, index = 0): Centroid => ({ index, units, boards });

/** n boards of the given unit-set. */
const boards = (units: string[], n: number) => ({ units, weight: n });

// ── identity is order-free ───────────────────────────────────────────────────

test('unit ORDER never changes a board key', () => {
  assert.equal(boardKey(['c', 'a', 'b']), boardKey(['a', 'b', 'c']));
});

test('a repeated unit does not make a different board', () => {
  // Identity is which units are present, not how many copies — a second copy is
  // a bench unit or a duplicator, not a different line.
  assert.equal(boardKey(['a', 'b', 'a']), boardKey(['a', 'b']));
});

test('grouping sums weights and is volume-ordered', () => {
  const g = groupBoards([boards(['a', 'b'], 3), boards(['b', 'a'], 4), boards(['c', 'd'], 10)]);
  assert.equal(g.length, 2);
  assert.deepEqual(g[0].units, ['c', 'd']);
  assert.equal(g[0].boards, 10);
  assert.equal(g[1].boards, 7);
});

// ── scoring ──────────────────────────────────────────────────────────────────

test('a board matching the profile exactly scores 1', () => {
  assert.equal(profileScore(new Set(['a', 'b']), profile(['a', 1], ['b', 1])), 1);
});

test('missing a CORE unit costs far more than missing a flex one', () => {
  const p = profile(['a', 1], ['b', 1], ['c', 1], ['flex', 0.2]);
  const noFlex = profileScore(new Set(['a', 'b', 'c']), p);
  const noCore = profileScore(new Set(['a', 'b', 'flex']), p);
  assert.ok(noFlex > noCore, `${noFlex} should beat ${noCore}`);
  // The whole point of the rework: a board that skipped the coin-flip unit is
  // still comfortably the same line.
  assert.ok(noFlex >= ASSIGN_BAR);
});

test('a board of unrelated units scores below the assign bar', () => {
  const p = profile(['a', 1], ['b', 1], ['c', 1], ['d', 1]);
  assert.ok(profileScore(new Set(['x', 'y', 'z', 'w']), p) < ASSIGN_BAR);
});

test('jaccard of disjoint sets is 0 and of equal sets is 1', () => {
  assert.equal(jaccard(new Set(['a']), new Set(['b'])), 0);
  assert.equal(jaccard(new Set(['a', 'b']), new Set(['b', 'a'])), 1);
});

// ── seeding ──────────────────────────────────────────────────────────────────

test('seeding SKIPS a near-duplicate of a seed already taken', () => {
  // This is the bug that made a naive top-N useless: the biggest unit-sets are
  // nested variants of each other, so 60 slots covered 23% of boards.
  const base = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const g = groupBoards([
    boards(base, 100),
    boards(base.slice(0, 6), 90), // jaccard 6/7 = 0.86 — too close
    boards(['q', 'r', 's', 't', 'u', 'v', 'w'], 80), // disjoint
  ]);
  const seeds = seedProfiles(g, { seedCount: 10 });
  assert.equal(seeds.length, 2);
});

test('seedCount is a ceiling, not a target', () => {
  const g = groupBoards([boards(['a', 'b', 'c', 'd', 'e', 'f'], 10)]);
  assert.equal(seedProfiles(g, { seedCount: 50 }).length, 1);
});

test('MIN_SEPARATION is what decides a seed, so lowering it takes fewer', () => {
  const g = groupBoards([
    boards(['a', 'b', 'c', 'd'], 10),
    boards(['a', 'b', 'c', 'x'], 9), // jaccard 3/5 = 0.6
  ]);
  assert.equal(seedProfiles(g, { seedCount: 9, minSeparation: 0.5 }).length, 1);
  assert.equal(seedProfiles(g, { seedCount: 9, minSeparation: MIN_SEPARATION }).length, 2);
});

// ── convergence ──────────────────────────────────────────────────────────────

test('two genuinely different lines converge to two centroids', () => {
  const lineA = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'];
  const lineB = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'];
  const res = convergeCentroids(
    groupBoards([
      boards(lineA, 500),
      boards([...lineA.slice(0, 5), 'x'], 200),
      boards(lineB, 400),
      boards([...lineB.slice(0, 5), 'y'], 150),
    ]),
  );
  assert.equal(res.centroids.length, 2);
  assert.equal(res.homedBoards, res.totalBoards);
});

test('a coin-flip unit lands between PROFILE_MIN_RATE and CORE_RATE, not in or out', () => {
  // The statement the old model could not make: Soraka is neither part of the
  // line nor a different line, she is a 58% slot.
  const core = ['a', 'b', 'c', 'd', 'e', 'f'];
  const res = convergeCentroids(groupBoards([boards([...core, 'flex'], 55), boards(core, 45)]));
  assert.equal(res.centroids.length, 1);
  const flex = res.centroids[0].units.find((u) => u.characterId === 'flex');
  assert.ok(flex, 'the flex unit must survive in the profile');
  assert.ok(flex!.rate > PROFILE_MIN_RATE && flex!.rate < CORE_RATE);
  assert.deepEqual([...coreUnits(res.centroids[0])].sort(), core);
});

test('over-seeding does not over-split: redundant profiles collapse', () => {
  const core = ['a', 'b', 'c', 'd', 'e', 'f'];
  const groups = groupBoards(
    Array.from({ length: 40 }, (_, i) => boards([...core, `noise${i}`], 10)),
  );
  const few = convergeCentroids(groups, { seedCount: 3 });
  const many = convergeCentroids(groups, { seedCount: 300 });
  assert.equal(many.centroids.length, few.centroids.length);
  assert.equal(many.centroids.length, 1);
});

test('assignment is ORDER-INDEPENDENT — the property the old merge lacked', () => {
  const mk = (seed: number) => {
    const g = [
      boards(['a1', 'a2', 'a3', 'a4', 'a5', 'a6'], 300),
      boards(['b1', 'b2', 'b3', 'b4', 'b5', 'b6'], 280),
      boards(['a1', 'a2', 'a3', 'a4', 'a5', 'z'], 90),
      boards(['b1', 'b2', 'b3', 'b4', 'b5', 'z'], 85),
    ];
    // Rotate the input order; grouping is volume-ordered, so the election must
    // not notice.
    return convergeCentroids(groupBoards([...g.slice(seed), ...g.slice(0, seed)]));
  };
  const a = mk(0);
  const b = mk(2);
  assert.deepEqual(
    a.centroids.map((c) => c.units),
    b.centroids.map((c) => c.units),
  );
});

test('a board matching nothing is OFF-META rather than forced into a line', () => {
  const res = convergeCentroids(
    groupBoards([boards(['a', 'b', 'c', 'd', 'e', 'f'], 500), boards(['q', 'r', 's', 't', 'u', 'v'], 2)]),
  );
  // The lone unit-set can seed its own line, so scope the claim to assignment:
  // an unrelated board never joins the big line.
  assert.equal(assignBoard(['q', 'r', 's', 't', 'u', 'v'], [res.centroids[0]]), null);
});

test('assignBoard against frozen centroids is what lower ranks use', () => {
  const c = centroid(profile(['a', 1], ['b', 1], ['c', 1], ['d', 0.9], ['e', 0.5]));
  assert.equal(assignBoard(['a', 'b', 'c', 'd'], [c])?.index, 0);
  assert.equal(assignBoard(['a', 'z', 'y', 'x'], [c]), null);
});

test('empty input converges to nothing rather than throwing', () => {
  const res = convergeCentroids(groupBoards([]));
  assert.deepEqual(res.centroids, []);
  assert.equal(res.totalBoards, 0);
});

// ── listing ──────────────────────────────────────────────────────────────────

test('listing stops at the coverage target, not at a fixed count', () => {
  const cs = [400, 300, 200, 60, 25, 22].map((n, i) => centroid(profile(['u', 1]), n, i));
  const listed = listableCentroids(cs, 0.8, 20);
  assert.equal(listed.reduce((a, c) => a + c.boards, 0) >= 0.8 * 1007, true);
  assert.ok(listed.length < cs.length);
});

test('the absolute floor keeps noise lines off an early-patch list', () => {
  const cs = [8, 5, 3, 2].map((n, i) => centroid(profile(['u', 1]), n, i));
  assert.deepEqual(listableCentroids(cs, 0.8, 20), []);
});

test('coverage keeps the list stable as a patch fills', () => {
  // Same distribution shape, 10x the boards: the point of a relative floor is
  // that the list does not grow from 20 lines to 200 over a patch.
  const shape = [400, 300, 200, 120, 90, 60, 40, 30, 25, 22];
  const early = listableCentroids(shape.map((n, i) => centroid(profile(['u', 1]), n, i)));
  const late = listableCentroids(shape.map((n, i) => centroid(profile(['u', 1]), n * 10, i)));
  assert.equal(early.length, late.length);
});

// ── naming ───────────────────────────────────────────────────────────────────

const statics = (): NameStatics => ({
  unitTraits: new Map([
    ['Malphite', ['Blackthorn', 'Battlemage']],
    ['Azir', ['Blackthorn', 'Executioner', 'Summoner']],
    ['Yunara', ['Blossom', 'Executioner']],
    ['Soraka', ['FloraFatalis', 'Executioner']],
    ['Kennen', ['Inferno', 'Executioner']],
    ['Ahri', ['Blossom', 'Spellweaver']],
    ['Karma', ['Blossom', 'Spellweaver']],
    ['Alune', ['AluneUnique', 'Lunar', 'Spellweaver']],
  ]),
  unitNames: new Map(
    ['Malphite', 'Azir', 'Yunara', 'Soraka', 'Kennen', 'Ahri', 'Karma', 'Alune'].map((n) => [n, n]),
  ),
  traitNames: new Map(
    ['Blackthorn', 'Battlemage', 'Executioner', 'Summoner', 'Blossom', 'Spellweaver', 'FloraFatalis', 'Inferno', 'Lunar', 'AluneUnique'].map(
      (n) => [n, n === 'Battlemage' ? 'Monolith' : n],
    ),
  ),
  traitBreakpoints: new Map([
    // Monolith: ONE breakpoint at one unit, and a high style — the exact shape
    // that hijacked four different Malphite lines.
    ['Battlemage', [{ style: 4, minUnits: 1 }]],
    ['AluneUnique', [{ style: 4, minUnits: 1 }]],
    [
      'Executioner',
      [
        { style: 1, minUnits: 2 },
        { style: 3, minUnits: 3 },
        { style: 5, minUnits: 4 },
      ],
    ],
    [
      'Blossom',
      [
        { style: 1, minUnits: 3 },
        { style: 3, minUnits: 5 },
      ],
    ],
    ['Blackthorn', [{ style: 1, minUnits: 2 }, { style: 3, minUnits: 4 }]],
    ['Spellweaver', [{ style: 1, minUnits: 2 }, { style: 3, minUnits: 4 }]],
    ['Summoner', [{ style: 1, minUnits: 2 }]],
    ['FloraFatalis', [{ style: 1, minUnits: 2 }]],
    ['Inferno', [{ style: 1, minUnits: 2 }]],
    ['Lunar', [{ style: 1, minUnits: 2 }]],
  ]),
  unitCosts: new Map([
    ['Malphite', 4],
    ['Azir', 3],
    ['Yunara', 2],
    ['Soraka', 4],
    ['Kennen', 5],
    ['Ahri', 4],
    ['Karma', 1],
    ['Alune', 5],
  ]),
});

test('a marker trait is recognised by its single one-unit breakpoint', () => {
  assert.equal(isMarkerTrait([{ style: 4, minUnits: 1 }]), true);
  assert.equal(isMarkerTrait([{ style: 1, minUnits: 2 }]), false);
  assert.equal(isMarkerTrait([]), true);
  assert.equal(isMarkerTrait(undefined), true);
});

test('a marker trait NEVER names a line, however high its style', () => {
  // The reported bug: four different Malphite lines all called "Monolith".
  const c = centroid(
    profile(['Malphite', 1], ['Azir', 1], ['Kennen', 0.73], ['Soraka', 0.6], ['Yunara', 0.4]),
  );
  assert.equal(headlineTrait(c, statics()), 'Executioner');
});

test('trait counts come from RATES, so flex units count toward a vertical', () => {
  const c = centroid(profile(['Azir', 1], ['Kennen', 0.73], ['Soraka', 0.6], ['Yunara', 0.4]));
  const counts = traitCounts(c, statics());
  assert.ok(Math.abs(counts.get('Executioner')! - 2.73) < 1e-9);
  // Counting only core units would have seen a single Executioner and named the
  // line after something else entirely.
  assert.equal(headlineTrait(c, statics()), 'Executioner');
});

test('a higher breakpoint beats a lower one, and 3/3 beats 2/2 at equal style', () => {
  const s = statics();
  const four = centroid(profile(['Azir', 1], ['Yunara', 1], ['Soraka', 1], ['Kennen', 1]));
  assert.equal(headlineTrait(four, s), 'Executioner'); // style 5 at 4 units
  const blossom = centroid(profile(['Ahri', 1], ['Karma', 1], ['Yunara', 1]));
  // Blossom 3/3 (style 1) against Spellweaver 2/2 (style 1): more units wins.
  assert.equal(headlineTrait(blossom, s), 'Blossom');
});

test('a line with no non-marker trait active gets no trait in its name', () => {
  const c = centroid(profile(['Malphite', 1], ['Alune', 1]));
  assert.equal(headlineTrait(c, statics()), null);
  assert.equal(nameCentroid(c, [], statics()), '');
});

test('carries are drawn from CORE units only', () => {
  // The reported bug in reverse: a 45%-rate unit won a carry slot on a handful
  // of itemised boards and put its name on a line it is not part of.
  const c = centroid(profile(['Malphite', 1], ['Azir', 1], ['Yunara', 0.91], ['Ahri', 0.45]));
  const items: ItemisationRate[] = [
    { characterId: 'Ahri', rate: 0.99, boards: 5 },
    { characterId: 'Malphite', rate: 0.8, boards: 8 },
    { characterId: 'Yunara', rate: 0.5, boards: 5 },
  ];
  assert.deepEqual(nameCarries(c, items, statics()), ['Malphite', 'Yunara']);
});

test('the full name is trait + two carries', () => {
  const c = centroid(profile(['Malphite', 1], ['Azir', 1], ['Soraka', 0.9], ['Kennen', 0.85]));
  const items: ItemisationRate[] = [
    { characterId: 'Malphite', rate: 0.95, boards: 30 },
    { characterId: 'Soraka', rate: 0.7, boards: 20 },
    { characterId: 'Azir', rate: 0.1, boards: 3 },
  ];
  assert.equal(nameCentroid(c, items, statics()), 'Executioner Malphite Soraka');
});

test('colliding names are separated by their distinguishing core unit', () => {
  const a = centroid(profile(['Malphite', 1], ['Ahri', 1], ['Azir', 1], ['Yunara', 0.9]), 34, 0);
  const b = centroid(profile(['Malphite', 1], ['Ahri', 1], ['Azir', 1], ['Alune', 1]), 15, 1);
  const resolved = resolveNameCollisions(['X Malphite Ahri', 'X Malphite Ahri'], [a, b], statics());
  assert.equal(resolved[0], 'X Malphite Ahri Yunara');
  assert.equal(resolved[1], 'X Malphite Ahri Alune');
});

test('a name that does not collide is left exactly as it was', () => {
  const a = centroid(profile(['Malphite', 1]), 10, 0);
  const b = centroid(profile(['Ahri', 1]), 9, 1);
  assert.deepEqual(resolveNameCollisions(['One', 'Two'], [a, b], statics()), ['One', 'Two']);
});

test('identical cores fall through to the FLEX band for a differentiator', () => {
  // Measured on master_plus: two Aphelios lines with the same six core units,
  // 20pp apart on top-4, separated only by their flex slots. A core-only search
  // finds nothing and leaves a 744-board line sharing a name with a 190-board
  // one.
  const a = centroid(
    profile(['Malphite', 1], ['Ahri', 1], ['Azir', 1], ['Yunara', 0.74], ['Soraka', 0.72]),
    744,
    0,
  );
  const b = centroid(
    profile(['Malphite', 1], ['Ahri', 1], ['Azir', 1], ['Karma', 0.51], ['Kennen', 0.35]),
    190,
    1,
  );
  const out = resolveNameCollisions(['N', 'N'], [a, b], statics());
  assert.equal(out[0], 'N Yunara'); // highest-rate unit b does not field at all
  assert.equal(out[1], 'N Karma');
  assert.notEqual(out[0], out[1]);
});

test('a core-unique unit still wins over a higher-rate flex one', () => {
  // The flex fallback must not demote the core rule: an expensive unit the line
  // always fields identifies it better than a coin-flip slot.
  const a = centroid(profile(['Malphite', 1], ['Kennen', 0.95], ['Yunara', 0.6]), 50, 0);
  const b = centroid(profile(['Malphite', 1], ['Ahri', 0.9], ['Karma', 0.6]), 40, 1);
  const out = resolveNameCollisions(['N', 'N'], [a, b], statics());
  assert.equal(out[0], 'N Kennen'); // core, not the 60% Yunara
  assert.equal(out[1], 'N Ahri');
});

test('truly indistinguishable profiles are left alone rather than given a fake difference', () => {
  const a = centroid(profile(['Malphite', 1], ['Ahri', 1]), 10, 0);
  const b = centroid(profile(['Malphite', 1], ['Ahri', 1]), 9, 1);
  assert.deepEqual(resolveNameCollisions(['N', 'N'], [a, b], statics()), ['N', 'N']);
});

test('collision resolution prefers the highest-cost distinguishing unit', () => {
  const a = centroid(profile(['Malphite', 1], ['Karma', 1], ['Kennen', 1]), 10, 0);
  const b = centroid(profile(['Malphite', 1], ['Ahri', 1]), 9, 1);
  const out = resolveNameCollisions(['N', 'N'], [a, b], statics());
  assert.equal(out[0], 'N Kennen'); // Kennen 5c over Karma 1c
  assert.equal(out[1], 'N Ahri');
});
