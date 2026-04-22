import { sql } from 'drizzle-orm';
import { db } from '../db';

// Round 7 — the "interest set" for a given user X is:
//   X's friends ∪ X's DM peers ∪ X's room co-members (channels and DMs alike)
// DMs are rows in `rooms` with `type='dm'` and exactly two `room_members`, so
// the DM-peer case is naturally covered by the room-co-members sub-select.
// The function returns a deduped array of userIds (X themselves excluded).

// Drizzle's `db.execute<T>` constrains T to extend `Record<string, unknown>`
// — an index-signature is required. Using a type alias (rather than an
// interface) keeps that assignability without loosening the column shape.
type InterestRow = { other_user_id: string } & Record<string, unknown>;

export async function getInterestSet(userId: string): Promise<string[]> {
  // Single SQL UNION — Postgres dedupes across the two arms automatically. We
  // stay in raw SQL because Drizzle's typed `.union()` helper would force us
  // to build two identically-shaped select-query objects and then wrap them
  // in a `db.select().from(sq)` — more ceremony for the same generated SQL.
  const result = await db.execute<InterestRow>(sql`
    SELECT DISTINCT other_user_id FROM (
      -- Friends (symmetric rows; WHERE user_id = $1 covers both directions).
      SELECT friend_user_id AS other_user_id
      FROM friendships
      WHERE user_id = ${userId}

      UNION

      -- Co-members of any room the caller is in (channels AND DMs).
      SELECT rm_other.user_id AS other_user_id
      FROM room_members rm_caller
      JOIN room_members rm_other
        ON rm_other.room_id = rm_caller.room_id
       AND rm_other.user_id <> rm_caller.user_id
      WHERE rm_caller.user_id = ${userId}
    ) agg
    WHERE other_user_id <> ${userId}
  `);

  return result.rows.map((r) => r.other_user_id);
}
