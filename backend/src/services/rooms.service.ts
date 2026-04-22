import { and, asc, count, desc, eq, ne, sql } from 'drizzle-orm';
import { db } from '../db';
import { rooms, roomMembers, users } from '../db/schema';
import { AppError } from '../errors/AppError';
import type {
  CreateRoomRequest,
  DmPeer,
  PatchRoomRequest,
  Room,
  RoomDetail,
  RoomMember,
  RoomRole,
  RoomType,
  RoomVisibility,
} from '@shared';

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

export async function listRoomsForUser(userId: string): Promise<Room[]> {
  const memberCountExpr = sql<number>`(
    SELECT COUNT(*)::int FROM ${roomMembers} rm WHERE rm.room_id = ${rooms.id}
  )`;

  const result = await db
    .select({
      id: rooms.id,
      type: rooms.type,
      name: rooms.name,
      description: rooms.description,
      visibility: rooms.visibility,
      ownerId: rooms.ownerId,
      createdAt: rooms.createdAt,
      memberCount: memberCountExpr,
    })
    .from(rooms)
    .innerJoin(roomMembers, eq(roomMembers.roomId, rooms.id))
    .where(eq(roomMembers.userId, userId))
    .orderBy(desc(rooms.createdAt));

  // For DMs, resolve `dmPeer` — the OTHER member from the caller's POV.
  // Doing this with a `WITH` / lateral join would avoid the N+1, but DM rows
  // per user are bounded by the user's friends count (realistic ceiling: low
  // hundreds), so a second batch query is fine for hackathon scope.
  const dmRoomIds = result.filter((r) => r.type === 'dm').map((r) => r.id);
  const dmPeerByRoomId = new Map<string, DmPeer>();
  if (dmRoomIds.length > 0) {
    const peerRows = await db
      .select({
        roomId: roomMembers.roomId,
        userId: roomMembers.userId,
        username: users.username,
      })
      .from(roomMembers)
      .innerJoin(users, eq(users.id, roomMembers.userId))
      .where(
        and(
          ne(roomMembers.userId, userId),
          // Use an IN filter inline — Drizzle's typed helpers accept sql`...`
          // fragments for small value lists, and `dmRoomIds` is user-bounded.
          sql`${roomMembers.roomId} IN ${dmRoomIds}`,
        ),
      );
    for (const row of peerRows) {
      dmPeerByRoomId.set(row.roomId, { userId: row.userId, username: row.username });
    }
  }

  return result.map((r) => ({
    id: r.id,
    type: r.type as RoomType,
    name: r.name,
    description: r.description,
    visibility: r.visibility as RoomVisibility,
    ownerId: r.ownerId,
    createdAt: r.createdAt.toISOString(),
    memberCount: Number(r.memberCount),
    ...(r.type === 'dm' && dmPeerByRoomId.has(r.id)
      ? { dmPeer: dmPeerByRoomId.get(r.id)! }
      : {}),
  }));
}

export async function getRoomDetail(userId: string, roomId: string): Promise<RoomDetail> {
  const [room] = await db
    .select()
    .from(rooms)
    .where(eq(rooms.id, roomId))
    .limit(1);

  if (!room) {
    throw new AppError('Room not found', 404);
  }

  const [membership] = await db
    .select({ userId: roomMembers.userId })
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)))
    .limit(1);

  if (!membership) {
    throw new AppError('Forbidden', 403);
  }

  const memberRows = await db
    .select({
      roomId: roomMembers.roomId,
      userId: roomMembers.userId,
      username: users.username,
      role: roomMembers.role,
      joinedAt: roomMembers.joinedAt,
    })
    .from(roomMembers)
    .innerJoin(users, eq(users.id, roomMembers.userId))
    .where(eq(roomMembers.roomId, roomId))
    .orderBy(
      // owner (0) < admin (1) < member (2); then joined_at asc
      sql`CASE ${roomMembers.role}
            WHEN 'owner' THEN 0
            WHEN 'admin' THEN 1
            ELSE 2
          END`,
      asc(roomMembers.joinedAt),
    );

  const members: RoomMember[] = memberRows.map((m) => ({
    roomId: m.roomId,
    userId: m.userId,
    username: m.username,
    role: m.role as RoomRole,
    joinedAt: m.joinedAt.toISOString(),
  }));

  const [{ value: memberCount }] = await db
    .select({ value: count() })
    .from(roomMembers)
    .where(eq(roomMembers.roomId, roomId));

  // `dmPeer` from the caller's POV — the OTHER member. Channels never carry
  // it; DMs always carry it (there are exactly two members so the filter is
  // guaranteed to yield one row).
  const type = room.type as RoomType;
  let dmPeer: DmPeer | undefined;
  if (type === 'dm') {
    const peer = members.find((m) => m.userId !== userId);
    if (peer) {
      dmPeer = { userId: peer.userId, username: peer.username };
    }
  }

  return {
    id: room.id,
    type,
    name: room.name,
    description: room.description,
    visibility: room.visibility as RoomVisibility,
    ownerId: room.ownerId,
    createdAt: room.createdAt.toISOString(),
    memberCount: Number(memberCount),
    members,
    ...(dmPeer ? { dmPeer } : {}),
  };
}

export async function createRoom(
  userId: string,
  body: CreateRoomRequest,
): Promise<RoomDetail> {
  try {
    const roomId = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(rooms)
        .values({
          type: 'channel',
          name: body.name,
          description: body.description ?? null,
          visibility: body.visibility,
          ownerId: userId,
        })
        .returning({ id: rooms.id });

      await tx.insert(roomMembers).values({
        roomId: inserted.id,
        userId,
        role: 'owner',
      });

      return inserted.id;
    });

    return getRoomDetail(userId, roomId);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AppError('Room name already taken', 409);
    }
    throw err;
  }
}

export async function joinRoom(userId: string, roomId: string): Promise<RoomDetail> {
  const [room] = await db
    .select()
    .from(rooms)
    .where(eq(rooms.id, roomId))
    .limit(1);

  if (!room) {
    throw new AppError('Room not found', 404);
  }

  // DM short-circuit runs BEFORE the membership lookup so non-members also
  // get this error, per the contract.
  if (room.type === 'dm') {
    throw new AppError('Direct messages are only reachable via /api/dm', 403);
  }

  const [existing] = await db
    .select({ userId: roomMembers.userId })
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)))
    .limit(1);

  if (!existing) {
    if (room.visibility === 'private') {
      throw new AppError('Private room — invitation required', 403);
    }

    await db.insert(roomMembers).values({
      roomId,
      userId,
      role: 'member',
    });
  }

  return getRoomDetail(userId, roomId);
}

export async function leaveRoom(userId: string, roomId: string): Promise<void> {
  // Short-circuit on DMs before touching membership so existing DM members
  // get the dedicated contract error rather than falling through to the
  // "owner cannot leave" / 404 paths.
  const [room] = await db
    .select({ type: rooms.type })
    .from(rooms)
    .where(eq(rooms.id, roomId))
    .limit(1);

  if (room?.type === 'dm') {
    throw new AppError('DM rooms cannot be left', 403);
  }

  const [membership] = await db
    .select({ role: roomMembers.role })
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)))
    .limit(1);

  if (!membership) {
    throw new AppError('Room not found', 404);
  }

  if (membership.role === 'owner') {
    throw new AppError('Owner cannot leave their own room', 403);
  }

  await db
    .delete(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)));
}

/**
 * Shared membership check — reusable from Round 3 Socket.io `room:join` handlers.
 */
export async function isRoomMember(userId: string, roomId: string): Promise<boolean> {
  const [row] = await db
    .select({ userId: roomMembers.userId })
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)))
    .limit(1);
  return Boolean(row);
}

/**
 * Assert the room exists and the caller is a current member.
 *
 * Round 12: lifted out of `messages.service.ts` so the same gate backs the
 * mark-read endpoint (`unread.service.ts`) and any future per-room mutation.
 * Error strings are contract-load-bearing — do not change without coordinating
 * with the history / message-send / mark-read wire spec.
 */
export async function assertRoomMembership(
  userId: string,
  roomId: string,
): Promise<{ type: 'channel' | 'dm' }> {
  const [room] = await db
    .select({ id: rooms.id, type: rooms.type })
    .from(rooms)
    .where(eq(rooms.id, roomId))
    .limit(1);

  if (!room) {
    throw new AppError('Room not found', 404);
  }

  const member = await isRoomMember(userId, roomId);
  if (!member) {
    throw new AppError('Not a room member', 403);
  }

  return { type: room.type as 'channel' | 'dm' };
}

export async function patchRoom(
  userId: string,
  roomId: string,
  body: PatchRoomRequest,
): Promise<RoomDetail> {
  // Belt-and-suspenders alongside the zod .refine in the route layer.
  const hasName = Object.prototype.hasOwnProperty.call(body, 'name');
  const hasDescription = Object.prototype.hasOwnProperty.call(body, 'description');
  const hasVisibility = Object.prototype.hasOwnProperty.call(body, 'visibility');
  if (!hasName && !hasDescription && !hasVisibility) {
    throw new AppError('At least one field is required', 400);
  }

  const [room] = await db
    .select()
    .from(rooms)
    .where(eq(rooms.id, roomId))
    .limit(1);

  if (!room) {
    throw new AppError('Room not found', 404);
  }

  // DM short-circuit — DM rooms are immutable by contract.
  if (room.type === 'dm') {
    throw new AppError('DM rooms are not editable', 400);
  }

  const [membership] = await db
    .select({ role: roomMembers.role })
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)))
    .limit(1);

  // Hide existence if the caller is not a member (Q2 = 2b allow-list).
  if (!membership) {
    throw new AppError('Room not found', 404);
  }

  if (membership.role !== 'owner' && membership.role !== 'admin') {
    throw new AppError('Only room owners and admins can edit room settings', 403);
  }

  // Build the update patch. If the proposed name is equivalent
  // case-insensitively to the current name, skip the rename — the unique
  // index would otherwise throw a spurious 409 when the caller is only
  // fixing casing (or repeating the same value).
  const patch: {
    name?: string;
    description?: string | null;
    visibility?: RoomVisibility;
  } = {};

  if (hasName && body.name !== undefined) {
    const proposed = body.name.trim();
    // `room.name` is only null for DMs, and we already short-circuited those.
    if (room.name !== null && proposed.toLowerCase() !== room.name.toLowerCase()) {
      patch.name = proposed;
    }
  }

  if (hasDescription) {
    const rawDescription = body.description;
    if (rawDescription === null) {
      patch.description = null;
    } else if (typeof rawDescription === 'string') {
      patch.description = rawDescription.trim();
    }
  }

  if (hasVisibility && body.visibility !== undefined) {
    patch.visibility = body.visibility;
  }

  if (Object.keys(patch).length > 0) {
    try {
      await db.update(rooms).set(patch).where(eq(rooms.id, roomId));
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new AppError('Room name already taken', 409);
      }
      throw err;
    }
  }

  return getRoomDetail(userId, roomId);
}
