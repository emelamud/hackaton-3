import { and, desc, eq, or } from 'drizzle-orm';
import { db } from '../db';
import { friendRequests, friendships, userBans, users } from '../db/schema';
import { AppError } from '../errors/AppError';
import type { UserBan } from '@shared';

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

export async function listBans(callerUserId: string): Promise<UserBan[]> {
  const rows = await db
    .select({
      userId: userBans.blockedUserId,
      username: users.username,
      createdAt: userBans.createdAt,
    })
    .from(userBans)
    .innerJoin(users, eq(users.id, userBans.blockedUserId))
    .where(eq(userBans.blockerUserId, callerUserId))
    .orderBy(desc(userBans.createdAt));

  return rows.map((r) => ({
    userId: r.userId,
    username: r.username,
    createdAt: r.createdAt.toISOString(),
  }));
}

/**
 * Ban `targetUserId` on behalf of `callerUserId`.
 *
 * Atomically:
 *  1. Inserts the `user_bans(blocker=caller, blocked=target)` row.
 *  2. Deletes the symmetric `friendships` pair (if any).
 *  3. Deletes any pending `friend_requests` in either direction.
 *
 * Returns `{ severedFriendship }` so the route can conditionally emit the
 * companion `friend:removed` event to the victim.
 *
 * The friend-request cleanup is deliberately silent — no
 * `friend:request:cancelled` broadcast fires. Stale pending UIs refresh on
 * next fetch. See Round 6 `Deferred` in the work summary.
 */
export async function banUser(
  callerUserId: string,
  targetUserId: string,
): Promise<{ severedFriendship: boolean }> {
  if (targetUserId === callerUserId) {
    throw new AppError('You cannot ban yourself', 400);
  }

  const [target] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, targetUserId))
    .limit(1);
  if (!target) {
    throw new AppError('User not found', 404);
  }

  let severedFriendship = false;
  try {
    await db.transaction(async (tx) => {
      await tx.insert(userBans).values({
        blockerUserId: callerUserId,
        blockedUserId: targetUserId,
      });

      const deletedFriendships = await tx
        .delete(friendships)
        .where(
          or(
            and(
              eq(friendships.userId, callerUserId),
              eq(friendships.friendUserId, targetUserId),
            ),
            and(
              eq(friendships.userId, targetUserId),
              eq(friendships.friendUserId, callerUserId),
            ),
          ),
        )
        .returning({ userId: friendships.userId });
      severedFriendship = deletedFriendships.length > 0;

      await tx
        .delete(friendRequests)
        .where(
          or(
            and(
              eq(friendRequests.fromUserId, callerUserId),
              eq(friendRequests.toUserId, targetUserId),
            ),
            and(
              eq(friendRequests.fromUserId, targetUserId),
              eq(friendRequests.toUserId, callerUserId),
            ),
          ),
        );
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AppError('User is already banned', 409);
    }
    throw err;
  }

  return { severedFriendship };
}

export async function unbanUser(
  callerUserId: string,
  targetUserId: string,
): Promise<void> {
  const deleted = await db
    .delete(userBans)
    .where(
      and(
        eq(userBans.blockerUserId, callerUserId),
        eq(userBans.blockedUserId, targetUserId),
      ),
    )
    .returning({ blockerUserId: userBans.blockerUserId });

  if (deleted.length === 0) {
    throw new AppError('Not banned', 404);
  }
}

/**
 * Returns true if there is an active ban between `userA` and `userB` in
 * either direction. Used by `messages.service.persistMessage` to gate DM
 * sends; extracted here so both callers share the same symmetric lookup.
 */
export async function hasBanBetween(userA: string, userB: string): Promise<boolean> {
  const [row] = await db
    .select({ blockerUserId: userBans.blockerUserId })
    .from(userBans)
    .where(
      or(
        and(eq(userBans.blockerUserId, userA), eq(userBans.blockedUserId, userB)),
        and(eq(userBans.blockerUserId, userB), eq(userBans.blockedUserId, userA)),
      ),
    )
    .limit(1);
  return Boolean(row);
}
