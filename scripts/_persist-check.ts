import './../src/server/queue/env';
import { pool, query } from '@/lib/db';
import type { MatchDto } from '@/lib/riot/types';
import { persistMatch } from '@/server/match-persist';

// Behavioural check for the batched persistMatch, against a SYNTHETIC match:
// no network, no real rows touched, fully self-cleaning. Exercises the bits the
// batching had to preserve — copy_index assignment for duplicate units, the
// carry heuristic, ragged item arrays, and idempotency on a second call.

const MATCH_ID = 'ZZTEST1_9000000001';

const unit = (character_id: string, tier: number, rarity: number, itemNames: string[]) => ({
  character_id,
  itemNames,
  rarity,
  tier,
});

const participant = (n: number) => ({
  puuid: `ZZTESTPUUID${String(n).padStart(60, '0')}`,
  placement: n,
  level: 8 + (n % 2),
  last_round: 30 + n,
  players_eliminated: n % 3,
  total_damage_to_players: 100 * n,
  gold_left: n,
  time_eliminated: 1000 * n,
  augments: n === 1 ? ['ZZ_Aug_A', 'ZZ_Aug_B', 'ZZ_Aug_C'] : ['ZZ_Aug_A'],
  traits: [
    { name: 'ZZ_TraitA', num_units: 4, style: 2, tier_current: 2, tier_total: 4 },
    { name: 'ZZ_TraitB', num_units: 2, style: 1, tier_current: 1, tier_total: 3 },
  ],
  units:
    n === 1
      ? [
          // Duplicate copies of one champ -> copy_index 0,1. The 3-item copy is
          // the carry (most items, rarity tiebreak).
          unit('ZZ_Samira', 3, 4, ['ZZ_Item_A', 'ZZ_Item_B', 'ZZ_Item_C']),
          unit('ZZ_Samira', 1, 4, []),
          unit('ZZ_Leona', 2, 2, ['ZZ_Item_D']),
          unit('ZZ_Zed', 2, 3, []), // no items at all -> empty text[]
        ]
      : [unit('ZZ_Leona', 2, 2, ['ZZ_Item_D']), unit('ZZ_Zed', 1, 3, [])],
  companion: { content_ID: `zz-${n}`, skin_ID: n, species: 'ZZ' },
});

const dto = {
  metadata: { match_id: MATCH_ID, data_version: '1', participants: [] },
  info: {
    game_datetime: 1787000000000,
    game_length: 2100.5,
    game_version: 'Linux Version 16.16.804.9184 (Aug 10 2026/16:13:14) [PUBLIC] <Releases/16.16>',
    queue_id: 1100,
    tft_set_number: 17,
    participants: Array.from({ length: 8 }, (_, i) => participant(i + 1)),
  },
} as unknown as MatchDto;

const cleanup = async () => {
  await query(`DELETE FROM matches WHERE match_id = $1`, [MATCH_ID]); // cascades
};

let failures = 0;
const check = (label: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    console.log(`        expected ${e}`);
    console.log(`        actual   ${a}`);
  }
};

try {
  await cleanup();

  // NOTE: don't try to count statements by wrapping pool.connect — pg's
  // pool.query() calls connect() in CALLBACK form internally, so a promise-only
  // wrapper swallows the callback and every query hangs.
  const t0 = Date.now();
  await persistMatch(dto, 'master_plus');
  console.log(`persisted 8 participants / 18 units / 16 traits / 10 augments in ${Date.now() - t0}ms\n`);

  const m = await query<{ region: string; queue_id: number; set_number: number }>(
    `SELECT region, queue_id, set_number FROM matches WHERE match_id = $1`,
    [MATCH_ID],
  );
  check('match row', m, [{ region: 'ZZTEST1', queue_id: 1100, set_number: 17 }]);

  const pc = await query<{ n: number }>(
    `SELECT count(*)::int n FROM match_participants WHERE match_id = $1`,
    [MATCH_ID],
  );
  check('8 participants', pc, [{ n: 8 }]);

  const rb = await query<{ rank_bucket: string; n: number }>(
    `SELECT rank_bucket, count(*)::int n FROM match_participants WHERE match_id = $1 GROUP BY 1`,
    [MATCH_ID],
  );
  check('rank_bucket written from the crawl seed', rb, [{ rank_bucket: 'master_plus', n: 8 }]);

  const p1 = await query<{ character_id: string; copy_index: number; star_tier: number; item_ids: string[]; is_carry: boolean }>(
    `SELECT pu.character_id, pu.copy_index, pu.star_tier, pu.item_ids, pu.is_carry
       FROM participant_units pu JOIN match_participants mp ON mp.id = pu.participant_id
      WHERE mp.match_id = $1 AND mp.placement = 1
      ORDER BY pu.character_id, pu.copy_index`,
    [MATCH_ID],
  );
  check('placement-1 units (copy_index, items, carry)', p1, [
    { character_id: 'ZZ_Leona', copy_index: 0, star_tier: 2, item_ids: ['ZZ_Item_D'], is_carry: false },
    { character_id: 'ZZ_Samira', copy_index: 0, star_tier: 3, item_ids: ['ZZ_Item_A', 'ZZ_Item_B', 'ZZ_Item_C'], is_carry: true },
    { character_id: 'ZZ_Samira', copy_index: 1, star_tier: 1, item_ids: [], is_carry: false },
    { character_id: 'ZZ_Zed', copy_index: 0, star_tier: 2, item_ids: [], is_carry: false },
  ]);

  const tr = await query<{ n: number }>(
    `SELECT count(*)::int n FROM participant_traits pt
       JOIN match_participants mp ON mp.id = pt.participant_id WHERE mp.match_id = $1`,
    [MATCH_ID],
  );
  check('16 trait rows (8 x 2)', tr, [{ n: 16 }]);

  const au = await query<{ augment_id: string; slot: number }>(
    `SELECT pa.augment_id, pa.slot FROM participant_augments pa
       JOIN match_participants mp ON mp.id = pa.participant_id
      WHERE mp.match_id = $1 AND mp.placement = 1 ORDER BY pa.slot`,
    [MATCH_ID],
  );
  check('placement-1 augments slotted 1..3', au, [
    { augment_id: 'ZZ_Aug_A', slot: 1 },
    { augment_id: 'ZZ_Aug_B', slot: 2 },
    { augment_id: 'ZZ_Aug_C', slot: 3 },
  ]);

  // Idempotency: a second persist must be a no-op, not a duplicate.
  await persistMatch(dto, 'master_plus');
  const after = await query<{ p: number; u: number; t: number; a: number }>(
    `SELECT (SELECT count(*)::int FROM match_participants WHERE match_id = $1) p,
            (SELECT count(*)::int FROM participant_units pu JOIN match_participants mp ON mp.id = pu.participant_id WHERE mp.match_id = $1) u,
            (SELECT count(*)::int FROM participant_traits pt JOIN match_participants mp ON mp.id = pt.participant_id WHERE mp.match_id = $1) t,
            (SELECT count(*)::int FROM participant_augments pa JOIN match_participants mp ON mp.id = pa.participant_id WHERE mp.match_id = $1) a`,
    [MATCH_ID],
  );
  check('re-persist is a no-op', after, [{ p: 8, u: 18, t: 16, a: 10 }]);
} finally {
  await cleanup();
  const left = await query<{ n: number }>(`SELECT count(*)::int n FROM matches WHERE match_id = $1`, [MATCH_ID]);
  console.log(`\ncleanup: synthetic match rows remaining = ${left[0].n}`);
  await pool.end();
}

console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
