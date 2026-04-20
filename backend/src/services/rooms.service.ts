import { and, asc, count, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { rooms, roomMembers, users } from '../db/schema';
import { AppError } from '../errors/AppError';
import type {
  CreateRoomRequest,
  Room,
  RoomDetail,
  RoomMember,
  RoomRole,
  RoomVisibility,
} from '../types/shared';

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

  return result.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    visibility: r.visibility as RoomVisibility,
    ownerId: r.ownerId,
    createdAt: r.createdAt.toISOString(),
    memberCount: Number(r.memberCount),
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

  return {
    id: room.id,
    name: room.name,
    description: room.description,
    visibility: room.visibility as RoomVisibility,
    ownerId: room.ownerId,
    createdAt: room.createdAt.toISOString(),
    memberCount: Number(memberCount),
    members,
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
