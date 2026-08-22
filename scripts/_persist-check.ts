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

// Non-ranked variants, for the ranked-only board gate below.
const DOUBLEUP_ID = 'ZZTEST1_9000000002';
const NOQUEUE_ID = 'ZZTEST1_9000000003';
const BOTLOBBY_ID = 'ZZTEST1_9000000004';
const ALL_IDS = [MATCH_ID, DOUBLEUP_ID, NOQUEUE_ID, BOTLOBBY_ID];

/** The same synthetic match under a different id and queue. */
const dtoAs = (matchId: string, queueId: number | null) =>
  ({ ...dto, metadata: { ...dto.metadata, match_id: matchId },
     info: { ...dto.info, queue_id: queueId } }) as unknown as MatchDto;

/** The same synthetic match with `bots` of its 8 seats taken by AI. Riot reports
 *  EVERY bot with the identical literal puuid 'BOT'. */
const dtoWithBots = (matchId: string, bots: number) =>
  ({ ...dto, metadata: { ...dto.metadata, match_id: matchId },
     info: { ...dto.info,
       participants: dto.info.participants.map((p, i) =>
         i < bots ? { ...p, puuid: 'BOT' } : p) } }) as unknown as MatchDto;

const playerCount = async (matchId: string) =>
  (await query<{ c: number | null }>(
    `SELECT player_count AS c FROM matches WHERE match_id = $1`, [matchId]))[0]?.c ?? null;

const boardCounts = async (matchId: string) => {
  const r = await query<{ m: number; p: number; u: number }>(
    `SELECT (SELECT count(*)::int FROM matches WHERE match_id = $1) m,
            (SELECT count(*)::int FROM match_participants WHERE match_id = $1) p,
            (SELECT count(*)::int FROM participant_units pu
               JOIN match_participants mp ON mp.id = pu.participant_id
              WHERE mp.match_id = $1) u`,
    [matchId],
  );
  return r[0];
};

const cleanup = async () => {
  await query(`DELETE FROM matches WHERE match_id = ANY($1::text[])`, [ALL_IDS]); // cascades
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

  // ── RANKED-ONLY BOARD GATE ────────────────────────────────────────────────
  // Only queue 1100 gets a participant fan-out; everything else stores just the
  // matches row. The matches row is the load-bearing part: it is what the crawl's
  // dedup check reads, so if it stopped being written the crawler would re-fetch
  // every non-ranked match on every pass and spend MORE Riot budget, not less.
  console.log(`\nranked-only board gate:`);
  check('ranked (1100) writes boards', await persistMatch(dtoAs(MATCH_ID + 'X', 1100)), 'stored');
  await query(`DELETE FROM matches WHERE match_id = $1`, [MATCH_ID + 'X']);

  check('Double Up (1160) is meta-only', await persistMatch(dtoAs(DOUBLEUP_ID, 1160), 'master_plus'), 'meta-only');
  check('  ... matches row written, zero boards', await boardCounts(DOUBLEUP_ID), { m: 1, p: 0, u: 0 });
  check('  ... dedup check still finds it',
    (await query(`SELECT 1 FROM matches WHERE match_id = $1`, [DOUBLEUP_ID])).length, 1);
  check('  ... re-persist is a no-op', await persistMatch(dtoAs(DOUBLEUP_ID, 1160), 'master_plus'), 'skipped');

  // ── BOTS ARE NOT PLAYERS ────────────────────────────────────────
  // AI-filled lobbies report every bot under the identical literal puuid 'BOT',
  // and the participant insert is ON CONFLICT (match_id, puuid) DO NOTHING — so
  // before this fix a lobby's bots collapsed into ONE stored row. That was the
  // entire cause of the "short lobbies" the audit had recorded as a genuine
  // Riot-payload characteristic: measured 2026-08-22, all 955 ranked matches
  // with fewer than 8 stored boards contained a bot row and none was short for
  // any other reason, and 1,825 surviving bot boards had been clustered into
  // 1,161 real comps.
  console.log(`
bots are not players:`);
  check('3 bots -> only the 5 real boards stored',
    await persistMatch(dtoWithBots(BOTLOBBY_ID, 3), 'master_plus'), 'stored');
  check('  ... 5 participants, no BOT row', await boardCounts(BOTLOBBY_ID), { m: 1, p: 5, u: 10 });
  check('  ... zero rows carry the BOT puuid',
    (await query(`SELECT 1 FROM match_participants WHERE match_id = $1 AND puuid = 'BOT'`, [BOTLOBBY_ID])).length, 0);
  check('  ... player_count records the 5 real players', await playerCount(BOTLOBBY_ID), 5);
  check('full lobby records player_count 8', await playerCount(MATCH_ID), 8);

  // A NULL queue_id is invisible to every reader (they filter `queue_id = 1100`),
  // so storing boards for it would be storing rows nothing can reach.
  check('missing queue_id is meta-only', await persistMatch(dtoAs(NOQUEUE_ID, null), 'master_plus'), 'meta-only');
  check('  ... zero boards', (await boardCounts(NOQUEUE_ID)).p, 0);
} finally {
  await cleanup();
  const left = await query<{ n: number }>(`SELECT count(*)::int n FROM matches WHERE match_id = ANY($1::text[])`, [ALL_IDS]);
  console.log(`\ncleanup: synthetic match rows remaining = ${left[0].n}`);
  await pool.end();
}

console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
