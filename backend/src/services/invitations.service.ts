import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db';
import { invitations, roomMembers, rooms, users } from '../db/schema';
import { AppError } from '../errors/AppError';
import * as roomsService from './rooms.service';
import type {
  CreateInvitationRequest,
  Invitation,
  RoomDetail,
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

/**
 * Re-select a single invitation joined with the room name and the inviter
 * username — returns the fully denormalised wire shape used for both the
 * HTTP response and the `invitation:new` socket broadcast.
 */
async function loadDenormalisedInvitation(invitationId: string): Promise<Invitation | null> {
  const [row] = await db
    .select({
      id: invitations.id,
      roomId: invitations.roomId,
      roomName: rooms.name,
      invitedUserId: invitations.invitedUserId,
      invitedByUserId: invitations.invitedByUserId,
      invitedByUsername: users.username,
      createdAt: invitations.createdAt,
    })
    .from(invitations)
    .innerJoin(rooms, eq(rooms.id, invitations.roomId))
    .innerJoin(users, eq(users.id, invitations.invitedByUserId))
    .where(eq(invitations.id, invitationId))
    .limit(1);

  if (!row) return null;

  return {
    id: row.id,
    roomId: row.roomId,
    roomName: row.roomName,
    invitedUserId: row.invitedUserId,
    invitedByUserId: row.invitedByUserId,
    invitedByUsername: row.invitedByUsername,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function createInvitation(
  inviterUserId: string,
  roomId: string,
  body: CreateInvitationRequest,
): Promise<Invitation> {
  const [room] = await db
    .select()
    .from(rooms)
    .where(eq(rooms.id, roomId))
    .limit(1);

  if (!room) {
    throw new AppError('Room not found', 404);
  }

  if (room.visibility !== 'private') {
    throw new AppError('Invitations are only for private rooms', 400);
  }

  const inviterIsMember = await roomsService.isRoomMember(inviterUserId, roomId);
  if (!inviterIsMember) {
    throw new AppError('Forbidden', 403);
  }

  const [target] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, body.username))
    .limit(1);

  if (!target) {
    throw new AppError('User not found', 404);
  }

  const targetAlreadyMember = await roomsService.isRoomMember(target.id, roomId);
  if (targetAlreadyMember) {
    throw new AppError('User is already a member of this room', 409);
  }

  let insertedId: string;
  try {
    const [inserted] = await db
      .insert(invitations)
      .values({
        roomId,
        invitedUserId: target.id,
        invitedByUserId: inviterUserId,
      })
      .returning({ id: invitations.id });
    insertedId = inserted.id;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AppError('An invitation is already pending for this user', 409);
    }
    throw err;
  }

  const denormalised = await loadDenormalisedInvitation(insertedId);
  if (!denormalised) {
    // Shouldn't happen — we just inserted it. Defensive.
    throw new AppError('Invitation not found', 404);
  }
  return denormalised;
}

export async function listInvitationsForUser(
  invitedUserId: string,
): Promise<Invitation[]> {
  const rows = await db
    .select({
      id: invitations.id,
      roomId: invitations.roomId,
      roomName: rooms.name,
      invitedUserId: invitations.invitedUserId,
      invitedByUserId: invitations.invitedByUserId,
      invitedByUsername: users.username,
      createdAt: invitations.createdAt,
    })
    .from(invitations)
    .innerJoin(rooms, eq(rooms.id, invitations.roomId))
    .innerJoin(users, eq(users.id, invitations.invitedByUserId))
    .where(eq(invitations.invitedUserId, invitedUserId))
    .orderBy(desc(invitations.createdAt));

  return rows.map((r) => ({
    id: r.id,
    roomId: r.roomId,
    roomName: r.roomName,
    invitedUserId: r.invitedUserId,
    invitedByUserId: r.invitedByUserId,
    invitedByUsername: r.invitedByUsername,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function acceptInvitation(
  invitedUserId: string,
  invitationId: string,
): Promise<{ invitation: Invitation; room: RoomDetail }> {
  const invitation = await loadDenormalisedInvitation(invitationId);
  if (!invitation) {
    throw new AppError('Invitation not found', 404);
  }

  if (invitation.invitedUserId !== invitedUserId) {
    throw new AppError('Forbidden', 403);
  }

  await db.transaction(async (tx) => {
    const [existingMember] = await tx
      .select({ userId: roomMembers.userId })
      .from(roomMembers)
      .where(
        and(
          eq(roomMembers.roomId, invitation.roomId),
          eq(roomMembers.userId, invitedUserId),
        ),
      )
      .limit(1);

    if (!existingMember) {
      await tx.insert(roomMembers).values({
        roomId: invitation.roomId,
        userId: invitedUserId,
        role: 'member',
      });
    }

    await tx.delete(invitations).where(eq(invitations.id, invitationId));
  });

  const room = await roomsService.getRoomDetail(invitedUserId, invitation.roomId);
  return { invitation, room };
}

export async function rejectInvitation(
  invitedUserId: string,
  invitationId: string,
): Promise<void> {
  const [row] = await db
    .select({
      id: invitations.id,
      invitedUserId: invitations.invitedUserId,
    })
    .from(invitations)
    .where(eq(invitations.id, invitationId))
    .limit(1);

  if (!row) {
    throw new AppError('Invitation not found', 404);
  }

  if (row.invitedUserId !== invitedUserId) {
    throw new AppError('Forbidden', 403);
  }

  await db.delete(invitations).where(eq(invitations.id, invitationId));
}

export async function revokeInvitation(
  inviterUserId: string,
  invitationId: string,
): Promise<Invitation> {
  // Load fully denormalised first so the route can fan out the payload.
  const invitation = await loadDenormalisedInvitation(invitationId);
  if (!invitation) {
    throw new AppError('Invitation not found', 404);
  }

  if (invitation.invitedByUserId !== inviterUserId) {
    throw new AppError('Forbidden', 403);
  }

  await db.delete(invitations).where(eq(invitations.id, invitationId));
  return invitation;
}
