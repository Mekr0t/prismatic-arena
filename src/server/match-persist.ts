import type { MatchDto } from '@/lib/riot/types';
import { pool, query } from '@/lib/db';
import { resolvePatchId } from './patch';

// Idempotent match persistence — shared by the profile write-path and the M4
// match-fetch worker so both store matches through exactly one path. Early-exits
// on a match_id we already have (duplicate scheduling/fetching is harmless), and
// every sub-insert is ON CONFLICT DO NOTHING. Derives patch_id via the shared
// resolvePatchId so crawled and profile-loaded matches land on the same patch.
export async function persistMatch(match: MatchDto): Promise<void> {
  const matchId = match.metadata.match_id;

  // Finished matches are immutable: skip if we already have it.
  const existing = await query('SELECT 1 FROM matches WHERE match_id = $1', [matchId]);
  if (existing.length > 0) return;

  const info = match.info;
  const region = matchId.split('_')[0]; // e.g. 'EUW1'

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

    for (const p of info.participants) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO match_participants
           (match_id, puuid, placement, level, last_round,
            players_elim, gold_left, total_dmg, companion)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (match_id, puuid) DO NOTHING
         RETURNING id`,
        [
          matchId,
          p.puuid,
          p.placement,
          p.level,
          p.last_round,
          p.players_eliminated,
          p.gold_left,
          p.total_damage_to_players,
          JSON.stringify(p.companion ?? null),
        ],
      );
      const participantId = inserted.rows[0]?.id;
      if (!participantId) continue;

      // Carry heuristic: most items, tie-broken by rarity (cost tier).
      const carryId = [...p.units].sort(
        (a, b) => b.itemNames.length - a.itemNames.length || b.rarity - a.rarity,
      )[0]?.character_id;

      const copyCount = new Map<string, number>();
      for (const u of p.units) {
        const copyIndex = copyCount.get(u.character_id) ?? 0;
        copyCount.set(u.character_id, copyIndex + 1);
        await client.query(
          `INSERT INTO participant_units
             (participant_id, character_id, copy_index, star_tier, item_ids, is_carry)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (participant_id, character_id, copy_index) DO NOTHING`,
          [
            participantId,
            u.character_id,
            copyIndex,
            u.tier,
            u.itemNames,
            u.character_id === carryId && u.itemNames.length > 0,
          ],
        );
      }

      for (const t of p.traits) {
        await client.query(
          `INSERT INTO participant_traits
             (participant_id, trait_id, num_units, active_style)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (participant_id, trait_id) DO NOTHING`,
          [participantId, t.name, t.num_units, t.style],
        );
      }

      const augments = p.augments ?? [];
      for (let i = 0; i < augments.length; i++) {
        await client.query(
          `INSERT INTO participant_augments (participant_id, augment_id, slot)
           VALUES ($1, $2, $3)
           ON CONFLICT (participant_id, slot) DO NOTHING`,
          [participantId, augments[i], i + 1],
        );
      }
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
