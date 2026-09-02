import type { MatchDto } from '@/lib/riot/types';
import type { RankBucket } from '@/config/rank-buckets';
import { pool, query } from '@/lib/db';
import { resolvePatchId } from './patch';
import { RANKED_TFT_QUEUE_ID } from '@/config/queue-ids';

// Idempotent match persistence — shared by the profile write-path and the M4
// match-fetch worker so both store matches through exactly one path. Early-exits
// on a match_id we already have (duplicate scheduling/fetching is harmless), and
// every sub-insert is ON CONFLICT DO NOTHING. Derives patch_id via the shared
// resolvePatchId so crawled and profile-loaded matches land on the same patch.
//
// BATCHED. This used to issue one INSERT per row, sequentially awaited: 8
// participants × (1 + ~10 units + ~10 traits + ~3 augments) ≈ 190 round-trips
// for a single match, all inside one open transaction. At a 400-match crawl pass
// that is ~76 000 round-trips whose cost is almost entirely latency, and it held
// the transaction open for all of it. Each table is now one multi-row INSERT
// built with unnest(), taking the whole match to ~10 statements.
//
// RANKED ONLY, for the BOARDS. The `matches` row is always written; the
// participant fan-out (boards, units, traits, augments) is written only for
// queue 1100. Every downstream stage and every read query already filters on
// that queue, so for the other half of the crawl — Double Up, Normals, event
// modes — the fan-out produced ~190 rows per match that nothing has ever read.
// Measured 2026-08-21: 50,754 of 104,342 stored matches (48.6%) are non-ranked,
// accounting for roughly half of participant_units (1441 MB), participant_traits
// (1302 MB) and match_participants (1161 MB).
//
// The `matches` row MUST stay. It is what the dedup check reads, so dropping it
// would make the crawler re-fetch every non-ranked match on every pass — MORE
// Riot budget spent, not less. The queue id is only known AFTER the fetch, so
// none of this saves API quota; what it saves is write throughput and disk.
//
// A match with no queue_id at all is treated as non-ranked: readers filter
// `queue_id = 1100`, so a NULL would be invisible to them anyway, and storing
// boards no reader can reach is exactly what this change removes.
//
// The idempotency semantics are unchanged and depend on one subtlety: the
// participant insert is ON CONFLICT DO NOTHING ... RETURNING, which returns rows
// ONLY for participants this call actually inserted. Two concurrent persists of
// the same match therefore can't both write children — the loser gets an empty
// RETURNING and its child arrays come out empty, exactly as the old per-row loop
// skipped children when `RETURNING id` gave nothing.

/** Rows for one participant's children, keyed to the participant's puuid until
 *  the insert hands back real ids. */
interface ChildRows {
  units: { characterId: string; copyIndex: number; star: number; items: string[]; isCarry: boolean }[];
  traits: { traitId: string; numUnits: number; style: number }[];
  augments: string[];
}

/**
 * @param bucket Rank bucket for every board in this match, taken from the tier
 *   of the player the crawler drained to reach it — TFT lobbies are
 *   rank-homogeneous, so the seed's tier is a sound label for all eight boards,
 *   where per-participant rank would cost eight league calls per match. The
 *   profile write-path has no crawl context and omits it, so those boards record
 *   'unknown' instead of inheriting a rank nobody checked.
 */
/** What a persist call actually did, so callers can report it. */
export type PersistOutcome =
  | 'skipped' // already stored
  | 'stored' // ranked: matches row + full participant fan-out
  | 'meta-only'; // non-ranked: matches row only (see the RANKED ONLY note above)

export async function persistMatch(
  match: MatchDto,
  bucket: RankBucket = 'unknown',
): Promise<PersistOutcome> {
  const matchId = match.metadata.match_id;

  // Finished matches are immutable: skip if we already have it.
  const existing = await query('SELECT 1 FROM matches WHERE match_id = $1', [matchId]);
  if (existing.length > 0) return 'skipped';

  const info = match.info;
  const region = matchId.split('_')[0]; // e.g. 'EUW1'
  const isRanked = info.queue_id === RANKED_TFT_QUEUE_ID;

  // BOTS ARE NOT PLAYERS. AI-filled lobbies report every bot with the SAME
  // literal puuid 'BOT', and the participant insert below is
  // ON CONFLICT (match_id, puuid) DO NOTHING — so a lobby's bots used to
  // collapse into a single stored row. That is the entire cause of what the
  // audit recorded as "short lobbies": measured 2026-08-22, all 955 ranked
  // matches with fewer than 8 stored boards contained a bot row, and none was
  // short for any other reason. Worse, 1,825 of those surviving bot boards had
  // been clustered into 1,161 real comps at avg placement 6.34.
  //
  // So bots are dropped here, and player_count records how many real players
  // were actually in the lobby. A board that only had to beat bots is not
  // evidence about the meta (10,010 such boards averaged 3.638 / 67.4 % top-4,
  // against 4.500 / 50.00 % for full lobbies), so the cluster stage stamps only
  // player_count = 8 matches and everything downstream follows from that.
  const realParticipants = info.participants.filter((p) => p.puuid !== 'BOT');
  const playerCount = realParticipants.length;

  // Shape every child row up front, keyed by puuid — no DB access in this phase.
  // Skipped entirely for a non-ranked match: nothing below will read it, and at
  // ~half the crawl this is real CPU (8 boards × ~10 units, sorted per board).
  const childrenByPuuid = new Map<string, ChildRows>();
  for (const p of isRanked ? realParticipants : []) {
    // Carry heuristic: most items, tie-broken by rarity (cost tier).
    const carryId = [...p.units].sort(
      (a, b) => b.itemNames.length - a.itemNames.length || b.rarity - a.rarity,
    )[0]?.character_id;

    const copyCount = new Map<string, number>();
    const units: ChildRows['units'] = [];
    for (const u of p.units) {
      const copyIndex = copyCount.get(u.character_id) ?? 0;
      copyCount.set(u.character_id, copyIndex + 1);
      units.push({
        characterId: u.character_id,
        copyIndex,
        star: u.tier,
        items: u.itemNames ?? [],
        isCarry: u.character_id === carryId && u.itemNames.length > 0,
      });
    }

    childrenByPuuid.set(p.puuid, {
      units,
      traits: p.traits.map((t) => ({ traitId: t.name, numUnits: t.num_units, style: t.style })),
      augments: p.augments ?? [],
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const patchId = await resolvePatchId(client, info.tft_set_number, info.game_version ?? '');

    await client.query(
      `INSERT INTO matches
         (match_id, region, patch_id, game_version, queue_id, set_number,
          game_datetime, game_length, player_count)
       VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7::double precision / 1000.0), $8, $9)
       ON CONFLICT (match_id) DO NOTHING`,
      [
        matchId,
        region,
        patchId,
        info.game_version,
        info.queue_id,
        info.tft_set_number,
        info.game_datetime,
        info.game_length,
        playerCount,
      ],
    );

    // Non-ranked stops here: the matches row is stored (dedup depends on it),
    // the boards are not. COMMIT before returning — the transaction is complete,
    // it just contains one statement.
    if (!isRanked) {
      await client.query('COMMIT');
      return 'meta-only';
    }

    // Per-board TIER, from the tiers the crawl has already resolved. One
    // indexed read, no Riot calls — the crawler resolves a candidate's tier at
    // drain time and caches it on `accounts`, so by the time a match is
    // persisted the seed's tier is always known and the other seven are known
    // whenever they have been drained themselves.
    //
    // This is not the same fact as `rank_bucket`. The bucket is the tier of the
    // player the crawl drained to REACH this match, stamped on all eight boards;
    // measured 2026-09-02, ~44 % of boards labelled master_plus were played by
    // Diamond or Emerald accounts, because the EUW Master population is small
    // enough this early in the set that matchmaking widens. The bucket is the
    // sampling frame; this is the player. Both are worth keeping.
    const tierRows = await client.query<{ puuid: string; tier: string }>(
      `SELECT puuid, upper(tier) AS tier
         FROM accounts WHERE puuid = ANY($1::text[]) AND tier IS NOT NULL`,
      [realParticipants.map((p) => p.puuid)],
    );
    const tierByPuuid = new Map(tierRows.rows.map((r) => [r.puuid, r.tier]));

    // One insert for all 8 participants. RETURNING puuid alongside id is what
    // lets the child rows below attach to the right parent without a second read.
    const inserted = await client.query<{ id: string; puuid: string }>(
      `INSERT INTO match_participants
         (match_id, puuid, placement, level, last_round,
          players_elim, gold_left, total_dmg, companion, rank_bucket, tier)
       SELECT $1, v.puuid, v.placement, v.level, v.last_round,
              v.players_elim, v.gold_left, v.total_dmg, v.companion::jsonb, $10, v.tier
         FROM unnest($2::text[], $3::int[], $4::int[], $5::int[],
                     $6::int[], $7::int[], $8::int[], $9::text[], $11::text[])
              AS v(puuid, placement, level, last_round,
                   players_elim, gold_left, total_dmg, companion, tier)
       ON CONFLICT (match_id, puuid) DO NOTHING
       RETURNING id, puuid`,
      [
        matchId,
        realParticipants.map((p) => p.puuid),
        realParticipants.map((p) => p.placement),
        realParticipants.map((p) => p.level),
        realParticipants.map((p) => p.last_round),
        realParticipants.map((p) => p.players_eliminated),
        realParticipants.map((p) => p.gold_left),
        realParticipants.map((p) => p.total_damage_to_players),
        realParticipants.map((p) => JSON.stringify(p.companion ?? null)),
        bucket,
        // NULL where the player has never been drained — an honest "we could not
        // establish it", filled in later by ladder-crawl's stamp pass rather
        // than guessed at from the lobby's bucket.
        realParticipants.map((p) => tierByPuuid.get(p.puuid) ?? null),
      ],
    );

    // Flatten every inserted participant's children into column arrays.
    const uPid: string[] = [];
    const uChar: string[] = [];
    const uCopy: number[] = [];
    const uStar: (number | null)[] = [];
    const uItems: string[] = []; // JSON, expanded back to text[] in SQL
    const uCarry: boolean[] = [];
    const tPid: string[] = [];
    const tTrait: string[] = [];
    const tNum: (number | null)[] = [];
    const tStyle: (number | null)[] = [];
    const aPid: string[] = [];
    const aAug: string[] = [];
    const aSlot: number[] = [];

    for (const row of inserted.rows) {
      const kids = childrenByPuuid.get(row.puuid);
      if (!kids) continue;
      for (const u of kids.units) {
        uPid.push(row.id);
        uChar.push(u.characterId);
        uCopy.push(u.copyIndex);
        uStar.push(u.star);
        // item_ids is text[]; a ragged array-of-arrays can't go through unnest
        // (Postgres multidimensional arrays must be rectangular), so each row's
        // items travel as JSON and are expanded back to text[] below.
        uItems.push(JSON.stringify(u.items));
        uCarry.push(u.isCarry);
      }
      for (const t of kids.traits) {
        tPid.push(row.id);
        tTrait.push(t.traitId);
        tNum.push(t.numUnits);
        tStyle.push(t.style);
      }
      kids.augments.forEach((augmentId, i) => {
        aPid.push(row.id);
        aAug.push(augmentId);
        aSlot.push(i + 1);
      });
    }

    if (uPid.length > 0) {
      await client.query(
        `INSERT INTO participant_units
           (participant_id, character_id, copy_index, star_tier, item_ids, is_carry)
         SELECT v.participant_id, v.character_id, v.copy_index, v.star_tier,
                ARRAY(SELECT jsonb_array_elements_text(v.items::jsonb)), v.is_carry
           FROM unnest($1::bigint[], $2::text[], $3::smallint[], $4::int[], $5::text[], $6::boolean[])
                AS v(participant_id, character_id, copy_index, star_tier, items, is_carry)
         ON CONFLICT (participant_id, character_id, copy_index) DO NOTHING`,
        [uPid, uChar, uCopy, uStar, uItems, uCarry],
      );
    }

    if (tPid.length > 0) {
      await client.query(
        `INSERT INTO participant_traits (participant_id, trait_id, num_units, active_style)
         SELECT v.participant_id, v.trait_id, v.num_units, v.active_style
           FROM unnest($1::bigint[], $2::text[], $3::int[], $4::int[])
                AS v(participant_id, trait_id, num_units, active_style)
         ON CONFLICT (participant_id, trait_id) DO NOTHING`,
        [tPid, tTrait, tNum, tStyle],
      );
    }

    if (aPid.length > 0) {
      await client.query(
        `INSERT INTO participant_augments (participant_id, augment_id, slot)
         SELECT v.participant_id, v.augment_id, v.slot
           FROM unnest($1::bigint[], $2::text[], $3::int[])
                AS v(participant_id, augment_id, slot)
         ON CONFLICT (participant_id, slot) DO NOTHING`,
        [aPid, aAug, aSlot],
      );
    }

    await client.query('COMMIT');
    return 'stored';
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore rollback errors */
    }
    throw err;
  } finally {
    client.release();
  }
}
