import type { MatchDto } from '@/lib/riot/types';
import type { RankBucket } from '@/config/rank-buckets';
import { pool, query } from '@/lib/db';
import { resolvePatchId } from './patch';

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
export async function persistMatch(
  match: MatchDto,
  bucket: RankBucket = 'unknown',
): Promise<void> {
  const matchId = match.metadata.match_id;

  // Finished matches are immutable: skip if we already have it.
  const existing = await query('SELECT 1 FROM matches WHERE match_id = $1', [matchId]);
  if (existing.length > 0) return;

  const info = match.info;
  const region = matchId.split('_')[0]; // e.g. 'EUW1'

  // Shape every child row up front, keyed by puuid — no DB access in this phase.
  const childrenByPuuid = new Map<string, ChildRows>();
  for (const p of info.participants) {
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
         (match_id, region, patch_id, game_version, queue_id, set_number, game_datetime, game_length)
       VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7::double precision / 1000.0), $8)
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
      ],
    );

    // One insert for all 8 participants. RETURNING puuid alongside id is what
    // lets the child rows below attach to the right parent without a second read.
    const inserted = await client.query<{ id: string; puuid: string }>(
      `INSERT INTO match_participants
         (match_id, puuid, placement, level, last_round,
          players_elim, gold_left, total_dmg, companion, rank_bucket)
       SELECT $1, v.puuid, v.placement, v.level, v.last_round,
              v.players_elim, v.gold_left, v.total_dmg, v.companion::jsonb, $10
         FROM unnest($2::text[], $3::int[], $4::int[], $5::int[],
                     $6::int[], $7::int[], $8::int[], $9::text[])
              AS v(puuid, placement, level, last_round,
                   players_elim, gold_left, total_dmg, companion)
       ON CONFLICT (match_id, puuid) DO NOTHING
       RETURNING id, puuid`,
      [
        matchId,
        info.participants.map((p) => p.puuid),
        info.participants.map((p) => p.placement),
        info.participants.map((p) => p.level),
        info.participants.map((p) => p.last_round),
        info.participants.map((p) => p.players_eliminated),
        info.participants.map((p) => p.gold_left),
        info.participants.map((p) => p.total_damage_to_players),
        info.participants.map((p) => JSON.stringify(p.companion ?? null)),
        bucket,
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
