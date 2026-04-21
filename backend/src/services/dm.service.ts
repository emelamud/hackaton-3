import { and, eq, or } from 'drizzle-orm';
import { db } from '../db';
import {
  directMessages,
  friendships,
  roomMembers,
  rooms,
  userBans,
  users,
} from '../db/schema';
import { AppError } from '../errors/AppError';
import * as roomsService from './rooms.service';
import type { RoomDetail } from '@shared';

function isUniqueViolation(err: unknown): boolean {
  // PG error code 23505 === unique_violation. Drizzle may wrap the pg error,
  // exposing the driver error via `cause`, so walk the chain.
  let cursor: unknown = err;
  for (let i = 0; i < 5 && cursor && typeof cursor === 'object'; i++) {
    const maybe = cursor as { code?: string; cause?: unknown };
    if (maybe.code === '23505') return true;
    cursor = maybe.cause;
  }
  return false;
}

/**
 * Upsert a DM room between `callerUserId` and `targetUserId`.
 *
 * Returns `{ room, created }`:
 *   - `created: true` on first-time create (route layer emits `dm:created`
 *     to both participants and wires their live sockets into the room).
 *   - `created: false` on idempotent re-hit (no socket broadcast fires).
 *
 * Gates: self-check → target-user exists → friendship gate → ban gate.
 * Each gate uses the exact contract error string so FE can surface them.
 */
export async function openDirectMessage(
  callerUserId: string,
  targetUserId: string,
): Promise<{ room: RoomDetail; created: boolean }> {
  if (targetUserId === callerUserId) {
    throw new AppError('You cannot open a DM with yourself', 400);
  }

  // Target user exists? Load `username` too for downstream use (though
  // `roomsService.getRoom` resolves members independently — we just need the
  // 404 side-effect here).
  const [target] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, targetUserId))
    .limit(1);
  if (!target) {
    throw new AppError('User not found', 404);
  }

  // Friendship gate — mirrors the lookup pattern used by `createFriendRequest`.
  const [friendshipRow] = await db
    .select({ userId: friendships.userId })
    .from(friendships)
    .where(
      and(
        eq(friendships.userId, callerUserId),
        eq(friendships.friendUserId, targetUserId),
      ),
    )
    .limit(1);
  if (!friendshipRow) {
    throw new AppError('You must be friends to start a direct message', 403);
  }

  // Ban gate — either direction is a block.
  const [banRow] = await db
    .select({ blockerUserId: userBans.blockerUserId })
    .from(userBans)
    .where(
      or(
        and(
          eq(userBans.blockerUserId, callerUserId),
          eq(userBans.blockedUserId, targetUserId),
        ),
        and(
          eq(userBans.blockerUserId, targetUserId),
          eq(userBans.blockedUserId, callerUserId),
        ),
      ),
    )
    .limit(1);
  if (banRow) {
    throw new AppError('Personal messaging is blocked', 403);
  }

  // Canonical pair — UUIDs sort lexicographically, so string comparison is
  // stable and matches the DB CHECK constraint `user_a_id < user_b_id`.
  const [userAId, userBId] =
    callerUserId < targetUserId
      ? [callerUserId, targetUserId]
      : [targetUserId, callerUserId];

  // Existing-pair fast path.
  const [existing] = await db
    .select({ roomId: directMessages.roomId })
    .from(directMessages)
    .where(
      and(eq(directMessages.userAId, userAId), eq(directMessages.userBId, userBId)),
    )
    .limit(1);

  if (existing) {
    const room = await roomsService.getRoomDetail(callerUserId, existing.roomId);
    return { room, created: false };
  }

  // Create path — all three inserts in one transaction. The pair-unique
  // index guards against a race where two concurrent callers both miss the
  // SELECT above and try to INSERT.
  let roomId: string;
  try {
    roomId = await db.transaction(async (tx) => {
      const [insertedRoom] = await tx
        .insert(rooms)
        .values({
          type: 'dm',
          name: null,
          description: null,
          visibility: 'private',
          ownerId: null,
        })
        .returning({ id: rooms.id });

      await tx.insert(directMessages).values({
        roomId: insertedRoom.id,
        userAId,
        userBId,
      });

      await tx.insert(roomMembers).values([
        { roomId: insertedRoom.id, userId: callerUserId, role: 'member' },
        { roomId: insertedRoom.id, userId: targetUserId, role: 'member' },
      ]);

      return insertedRoom.id;
    });
  } catch (err) {
    // Race: another concurrent call inserted the pair first. Re-SELECT and
    // return as an idempotent re-hit.
    if (isUniqueViolation(err)) {
      const [raced] = await db
        .select({ roomId: directMessages.roomId })
        .from(directMessages)
        .where(
          and(
            eq(directMessages.userAId, userAId),
            eq(directMessages.userBId, userBId),
          ),
        )
        .limit(1);
      if (raced) {
        const room = await roomsService.getRoomDetail(callerUserId, raced.roomId);
        return { room, created: false };
      }
    }
    throw err;
  }

  const room = await roomsService.getRoomDetail(callerUserId, roomId);
  return { room, created: true };
}
