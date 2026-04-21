import { aliasedTable, and, desc, eq, or, sql } from 'drizzle-orm';
import { db } from '../db';
import { friendRequests, friendships, users } from '../db/schema';
import { AppError } from '../errors/AppError';
import type { CreateFriendRequestBody, Friend, FriendRequest } from '@shared';

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
 * Re-select a single friend request joined with both `from_user` and
 * `to_user` usernames — returns the fully denormalised wire shape used for
 * both HTTP responses and socket payloads.
 */
async function loadDenormalisedRequest(
  requestId: string,
): Promise<
  | (FriendRequest & { fromUserId: string; toUserId: string })
  | null
> {
  const fromUsers = aliasedTable(users, 'from_users');
  const toUsers = aliasedTable(users, 'to_users');

  const [row] = await db
    .select({
      id: friendRequests.id,
      fromUserId: friendRequests.fromUserId,
      fromUsername: fromUsers.username,
      toUserId: friendRequests.toUserId,
      toUsername: toUsers.username,
      message: friendRequests.message,
      createdAt: friendRequests.createdAt,
    })
    .from(friendRequests)
    .innerJoin(fromUsers, eq(fromUsers.id, friendRequests.fromUserId))
    .innerJoin(toUsers, eq(toUsers.id, friendRequests.toUserId))
    .where(eq(friendRequests.id, requestId))
    .limit(1);

  if (!row) return null;

  return {
    id: row.id,
    fromUserId: row.fromUserId,
    fromUsername: row.fromUsername,
    toUserId: row.toUserId,
    toUsername: row.toUsername,
    message: row.message,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listFriends(userId: string): Promise<Friend[]> {
  const rows = await db
    .select({
      userId: friendships.friendUserId,
      username: users.username,
      friendshipCreatedAt: friendships.createdAt,
    })
    .from(friendships)
    .innerJoin(users, eq(users.id, friendships.friendUserId))
    .where(eq(friendships.userId, userId))
    .orderBy(desc(friendships.createdAt));

  return rows.map((r) => ({
    userId: r.userId,
    username: r.username,
    friendshipCreatedAt: r.friendshipCreatedAt.toISOString(),
  }));
}

export async function removeFriend(
  userId: string,
  otherUserId: string,
): Promise<void> {
  let deletedCount = 0;
  await db.transaction(async (tx) => {
    const deleted = await tx
      .delete(friendships)
      .where(
        or(
          and(
            eq(friendships.userId, userId),
            eq(friendships.friendUserId, otherUserId),
          ),
          and(
            eq(friendships.userId, otherUserId),
            eq(friendships.friendUserId, userId),
          ),
        ),
      )
      .returning({ userId: friendships.userId });
    deletedCount = deleted.length;
  });

  if (deletedCount === 0) {
    throw new AppError('Not a friend', 404);
  }

  if (deletedCount === 1) {
    // Normal path deletes 2 rows (symmetric pair). A 1-row delete means the
    // symmetric row was somehow missing — log so the inconsistency surfaces
    // without blocking the caller.
    // eslint-disable-next-line no-console
    console.warn(
      `removeFriend deleted 1 row instead of 2 for (${userId}, ${otherUserId}) — asymmetric friendship detected`,
    );
  }
}

export async function createFriendRequest(
  fromUserId: string,
  body: CreateFriendRequestBody,
): Promise<FriendRequest> {
  const toUsernameTrimmed = body.toUsername.trim();

  // Case-insensitive username match (usernames are unique — ILIKE with no
  // wildcards is equivalent to `lower(u) = lower($)` with the unique index).
  const [target] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.username}) = lower(${toUsernameTrimmed})`)
    .limit(1);

  if (!target) {
    throw new AppError('User not found', 404);
  }

  if (target.id === fromUserId) {
    throw new AppError('You cannot send a friend request to yourself', 400);
  }

  // Are they already friends? Check either row direction.
  const [existingFriendship] = await db
    .select({ userId: friendships.userId })
    .from(friendships)
    .where(
      or(
        and(
          eq(friendships.userId, fromUserId),
          eq(friendships.friendUserId, target.id),
        ),
        and(
          eq(friendships.userId, target.id),
          eq(friendships.friendUserId, fromUserId),
        ),
      ),
    )
    .limit(1);

  if (existingFriendship) {
    throw new AppError('You are already friends with this user', 409);
  }

  const rawMessage =
    typeof body.message === 'string' ? body.message.trim() : '';
  const message = rawMessage.length > 0 ? rawMessage : null;

  let insertedId: string;
  try {
    const [inserted] = await db
      .insert(friendRequests)
      .values({
        fromUserId,
        toUserId: target.id,
        message,
      })
      .returning({ id: friendRequests.id });
    insertedId = inserted.id;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AppError(
        'A pending friend request already exists between you and this user',
        409,
      );
    }
    throw err;
  }

  const denormalised = await loadDenormalisedRequest(insertedId);
  if (!denormalised) {
    // Shouldn't happen — we just inserted it. Defensive.
    throw new AppError('Friend request not found', 404);
  }
  return denormalised;
}

export async function listIncomingFriendRequests(
  userId: string,
): Promise<FriendRequest[]> {
  const fromUsers = aliasedTable(users, 'from_users');
  const toUsers = aliasedTable(users, 'to_users');

  const rows = await db
    .select({
      id: friendRequests.id,
      fromUserId: friendRequests.fromUserId,
      fromUsername: fromUsers.username,
      toUserId: friendRequests.toUserId,
      toUsername: toUsers.username,
      message: friendRequests.message,
      createdAt: friendRequests.createdAt,
    })
    .from(friendRequests)
    .innerJoin(fromUsers, eq(fromUsers.id, friendRequests.fromUserId))
    .innerJoin(toUsers, eq(toUsers.id, friendRequests.toUserId))
    .where(eq(friendRequests.toUserId, userId))
    .orderBy(desc(friendRequests.createdAt));

  return rows.map((r) => ({
    id: r.id,
    fromUserId: r.fromUserId,
    fromUsername: r.fromUsername,
    toUserId: r.toUserId,
    toUsername: r.toUsername,
    message: r.message,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function listOutgoingFriendRequests(
  userId: string,
): Promise<FriendRequest[]> {
  const fromUsers = aliasedTable(users, 'from_users');
  const toUsers = aliasedTable(users, 'to_users');

  const rows = await db
    .select({
      id: friendRequests.id,
      fromUserId: friendRequests.fromUserId,
      fromUsername: fromUsers.username,
      toUserId: friendRequests.toUserId,
      toUsername: toUsers.username,
      message: friendRequests.message,
      createdAt: friendRequests.createdAt,
    })
    .from(friendRequests)
    .innerJoin(fromUsers, eq(fromUsers.id, friendRequests.fromUserId))
    .innerJoin(toUsers, eq(toUsers.id, friendRequests.toUserId))
    .where(eq(friendRequests.fromUserId, userId))
    .orderBy(desc(friendRequests.createdAt));

  return rows.map((r) => ({
    id: r.id,
    fromUserId: r.fromUserId,
    fromUsername: r.fromUsername,
    toUserId: r.toUserId,
    toUsername: r.toUsername,
    message: r.message,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function acceptFriendRequest(
  recipientUserId: string,
  requestId: string,
): Promise<{
  request: FriendRequest;
  friendForRecipient: Friend;
  friendForSender: Friend;
}> {
  const request = await loadDenormalisedRequest(requestId);
  if (!request) {
    throw new AppError('Friend request not found', 404);
  }

  if (request.toUserId !== recipientUserId) {
    throw new AppError('Forbidden', 403);
  }

  const friendshipCreatedAt = new Date();

  await db.transaction(async (tx) => {
    try {
      await tx.insert(friendships).values([
        {
          userId: request.fromUserId,
          friendUserId: request.toUserId,
          createdAt: friendshipCreatedAt,
        },
        {
          userId: request.toUserId,
          friendUserId: request.fromUserId,
          createdAt: friendshipCreatedAt,
        },
      ]);
    } catch (err) {
      // Defensive: if the pair is already friends (would mean request
      // creation should have been blocked at the earlier check), swallow
      // and proceed — the post-condition we care about is "they are now
      // friends".
      if (!isUniqueViolation(err)) {
        throw err;
      }
    }
    await tx.delete(friendRequests).where(eq(friendRequests.id, requestId));
  });

  const friendshipCreatedAtIso = friendshipCreatedAt.toISOString();

  return {
    request,
    friendForRecipient: {
      userId: request.fromUserId,
      username: request.fromUsername,
      friendshipCreatedAt: friendshipCreatedAtIso,
    },
    friendForSender: {
      userId: request.toUserId,
      username: request.toUsername,
      friendshipCreatedAt: friendshipCreatedAtIso,
    },
  };
}

export async function rejectFriendRequest(
  recipientUserId: string,
  requestId: string,
): Promise<FriendRequest> {
  const request = await loadDenormalisedRequest(requestId);
  if (!request) {
    throw new AppError('Friend request not found', 404);
  }

  if (request.toUserId !== recipientUserId) {
    throw new AppError('Forbidden', 403);
  }

  await db.delete(friendRequests).where(eq(friendRequests.id, requestId));
  return request;
}

export async function cancelFriendRequest(
  senderUserId: string,
  requestId: string,
): Promise<FriendRequest> {
  const request = await loadDenormalisedRequest(requestId);
  if (!request) {
    throw new AppError('Friend request not found', 404);
  }

  if (request.fromUserId !== senderUserId) {
    throw new AppError('Forbidden', 403);
  }

  await db.delete(friendRequests).where(eq(friendRequests.id, requestId));
  return request;
}

