import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { messages, roomMembers, roomReadCursors } from '../db/schema';
import * as roomsService from './rooms.service';
import type { MarkRoomReadResponse, UnreadCount } from '@shared';

/**
 * Per-room unread counts for the caller's memberships.
 *
 * One query: left-join the cursor onto the caller's memberships and count
 * messages in a correlated subquery. Rows with `unreadCount === 0` are filtered
 * out to save wire bytes — FE treats absence as 0 (per orchestrator D3).
 *
 * "Unread" is defined as `messages.created_at > COALESCE(cursor.last_read_at,
 * member.joined_at) AND messages.user_id <> caller`. The caller's own messages
 * are never counted.
 */
export async function listUnread(userId: string): Promise<UnreadCount[]> {
  const unreadCountExpr = sql<number>`(
    SELECT COUNT(*)::int FROM ${messages} m
    WHERE m.room_id = ${roomMembers.roomId}
      AND m.created_at > COALESCE(${roomReadCursors.lastReadAt}, ${roomMembers.joinedAt})
      AND m.user_id <> ${userId}
  )`;

  const rows = await db
    .select({
      roomId: roomMembers.roomId,
      lastReadAt: roomReadCursors.lastReadAt,
      unreadCount: unreadCountExpr,
    })
    .from(roomMembers)
    .leftJoin(
      roomReadCursors,
      and(
        eq(roomReadCursors.userId, roomMembers.userId),
        eq(roomReadCursors.roomId, roomMembers.roomId),
      ),
    )
    .where(eq(roomMembers.userId, userId));

  return rows
    .filter((r) => Number(r.unreadCount) > 0)
    .map((r) => ({
      roomId: r.roomId,
      unreadCount: Number(r.unreadCount),
      lastReadAt: r.lastReadAt ? r.lastReadAt.toISOString() : null,
    }));
}

/**
 * Mark a room read up to server `now()`.
 *
 * UPSERT with `GREATEST(existing, EXCLUDED)` so a laggy tab firing a stale
 * mark-read after a fresher one never rewinds the cursor (orchestrator D1 —
 * monotonic advancement). Membership is checked up-front; both channels and
 * DMs are valid targets because the cursor table is room-type-agnostic.
 */
export async function markRoomRead(
  userId: string,
  roomId: string,
): Promise<MarkRoomReadResponse> {
  await roomsService.assertRoomMembership(userId, roomId);

  const [row] = await db
    .insert(roomReadCursors)
    .values({ userId, roomId, lastReadAt: new Date() })
    .onConflictDoUpdate({
      target: [roomReadCursors.userId, roomReadCursors.roomId],
      set: {
        lastReadAt: sql`GREATEST(${roomReadCursors.lastReadAt}, EXCLUDED.last_read_at)`,
      },
    })
    .returning({ lastReadAt: roomReadCursors.lastReadAt });

  return {
    roomId,
    lastReadAt: row.lastReadAt.toISOString(),
  };
}
