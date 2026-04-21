import { and, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { db } from '../db';
import { friendRequests, friendships, users } from '../db/schema';
import { AppError } from '../errors/AppError';
import type { UserSearchRelationship, UserSearchResult } from '@shared';

const MAX_SEARCH_RESULTS = 20;

export async function searchUsers(
  callerUserId: string,
  q: string,
): Promise<UserSearchResult[]> {
  const trimmed = q.trim();
  if (trimmed.length < 2) {
    throw new AppError('Search query must be at least 2 characters', 400);
  }

  // Prefix match (case-insensitive). The `users_username_unique` index on
  // `username` backs point lookups; prefix ILIKE against a small table is
  // acceptable for the hackathon scale. A trigram index is a later-round
  // optimisation.
  const candidates = await db
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(
      and(
        ne(users.id, callerUserId),
        sql`${users.username} ILIKE ${trimmed + '%'}`,
      ),
    )
    .orderBy(
      sql`CASE WHEN lower(${users.username}) = lower(${trimmed}) THEN 0 ELSE 1 END`,
      sql`lower(${users.username}) ASC`,
    )
    .limit(MAX_SEARCH_RESULTS);

  if (candidates.length === 0) {
    return [];
  }

  const candidateIds = candidates.map((c) => c.id);

  // Relationship lookups — two batched queries keyed by the small candidate
  // id list. One LEFT JOIN + CTE shape was considered; two simple IN queries
  // is easier to reason about and avoids coercing drizzle into a raw SQL
  // expression for the relationship column.
  const friendRows = await db
    .select({ friendUserId: friendships.friendUserId })
    .from(friendships)
    .where(
      and(
        eq(friendships.userId, callerUserId),
        inArray(friendships.friendUserId, candidateIds),
      ),
    );

  const requestRows = await db
    .select({
      fromUserId: friendRequests.fromUserId,
      toUserId: friendRequests.toUserId,
    })
    .from(friendRequests)
    .where(
      or(
        and(
          eq(friendRequests.fromUserId, callerUserId),
          inArray(friendRequests.toUserId, candidateIds),
        ),
        and(
          eq(friendRequests.toUserId, callerUserId),
          inArray(friendRequests.fromUserId, candidateIds),
        ),
      ),
    );

  const friendSet = new Set(friendRows.map((r) => r.friendUserId));
  const outgoingSet = new Set(
    requestRows
      .filter((r) => r.fromUserId === callerUserId)
      .map((r) => r.toUserId),
  );
  const incomingSet = new Set(
    requestRows
      .filter((r) => r.toUserId === callerUserId)
      .map((r) => r.fromUserId),
  );

  return candidates.map((c) => {
    let relationship: UserSearchRelationship = 'none';
    if (friendSet.has(c.id)) {
      relationship = 'friend';
    } else if (outgoingSet.has(c.id)) {
      relationship = 'outgoing_pending';
    } else if (incomingSet.has(c.id)) {
      relationship = 'incoming_pending';
    }
    return { id: c.id, username: c.username, relationship };
  });
}
