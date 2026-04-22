import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { roomMembers, rooms } from '../db/schema';
import { AppError } from '../errors/AppError';
import type { PublicCatalogResponse } from '@shared';

/**
 * Public-channel catalog — paginated newest-first, with `isMember` per row.
 *
 * Returns `type='channel' AND visibility='public'` rows only; private rooms
 * and DMs are invisible here (requirement §2.4.4). Cursor pagination follows
 * Round 9's row-value `(createdAt, id) < (cursor.createdAt, cursor.id)` pattern
 * for stable tie-break when multiple rooms share the same millisecond
 * `createdAt`. `limit + 1` probe avoids a second count query.
 *
 * `q` does a case-insensitive substring search on `name OR description`.
 * Empty/absent `q` returns all public channels.
 */
export async function listPublicCatalog(
  userId: string,
  params: { q?: string; cursor?: string; limit: number },
): Promise<PublicCatalogResponse> {
  // 1) Resolve cursor. The cursor MUST be a public channel id — private-room
  //    ids 400 to avoid leaking their existence to non-members.
  let cursor: { createdAt: Date; id: string } | undefined;
  if (params.cursor) {
    const [row] = await db
      .select({ createdAt: rooms.createdAt, id: rooms.id })
      .from(rooms)
      .where(
        and(
          eq(rooms.id, params.cursor),
          eq(rooms.type, 'channel'),
          eq(rooms.visibility, 'public'),
        ),
      )
      .limit(1);
    if (!row) {
      throw new AppError('Invalid cursor', 400);
    }
    cursor = row;
  }

  // 2) Shape the page query. Per-row `memberCount` and `isMember` via
  //    correlated subqueries so we keep the main select to a single row per
  //    public channel.
  const memberCountExpr = sql<number>`(
    SELECT COUNT(*)::int FROM ${roomMembers} rm WHERE rm.room_id = ${rooms.id}
  )`;
  const isMemberExpr = sql<boolean>`EXISTS (
    SELECT 1 FROM ${roomMembers} rm
    WHERE rm.room_id = ${rooms.id} AND rm.user_id = ${userId}
  )`;

  const qTrimmed = params.q?.trim();
  const searchPredicate =
    qTrimmed && qTrimmed.length > 0
      ? sql`(${rooms.name} ILIKE ${'%' + qTrimmed + '%'} OR ${rooms.description} ILIKE ${'%' + qTrimmed + '%'})`
      : undefined;

  const rowsPlusProbe = await db
    .select({
      id: rooms.id,
      name: rooms.name,
      description: rooms.description,
      createdAt: rooms.createdAt,
      memberCount: memberCountExpr,
      isMember: isMemberExpr,
    })
    .from(rooms)
    .where(
      and(
        eq(rooms.type, 'channel'),
        eq(rooms.visibility, 'public'),
        searchPredicate,
        cursor
          ? sql`(${rooms.createdAt}, ${rooms.id}) < (${cursor.createdAt}, ${cursor.id})`
          : undefined,
      ),
    )
    .orderBy(desc(rooms.createdAt), desc(rooms.id))
    .limit(params.limit + 1);

  // 3) Trim + reshape. `hasMore` comes from the probe row; `nextCursor` is the
  //    last row's id on `hasMore=true`, else null.
  const hasMore = rowsPlusProbe.length > params.limit;
  const page = hasMore ? rowsPlusProbe.slice(0, params.limit) : rowsPlusProbe;
  const nextCursor = hasMore ? page[page.length - 1].id : null;

  return {
    rooms: page.map((r) => ({
      id: r.id,
      // `name` is non-null for channels at the DB level (check constraint).
      // The `as string` cast reflects that narrowing; selecting via Drizzle
      // still types it `string | null` because the column is nullable for DMs.
      name: r.name as string,
      description: r.description,
      memberCount: Number(r.memberCount),
      createdAt: r.createdAt.toISOString(),
      isMember: Boolean(r.isMember),
    })),
    hasMore,
    nextCursor,
  };
}
