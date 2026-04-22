import { and, desc, eq, ne } from 'drizzle-orm';
import { db } from '../db';
import { messages, roomMembers, rooms, users } from '../db/schema';
import { AppError } from '../errors/AppError';
import * as roomsService from './rooms.service';
import * as userBansService from './user-bans.service';
import * as attachmentsService from './attachments.service';
import type { Attachment, Message } from '@shared';

async function assertRoomAndMembership(
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

  const isMember = await roomsService.isRoomMember(userId, roomId);
  if (!isMember) {
    throw new AppError('Not a room member', 403);
  }

  return { type: room.type as 'channel' | 'dm' };
}

export async function persistMessage(
  userId: string,
  roomId: string,
  body: string,
  attachmentIds: string[] = [],
): Promise<Message> {
  const trimmed = body.trim();

  // Round 8 — body-OR-attachments rule. Either a non-empty trimmed body or at
  // least one attachment satisfies the "message carries content" invariant.
  // Reuses the existing contract string so FE can pattern-match a single
  // failure class regardless of which side of the OR tripped the check.
  if (
    (trimmed.length < 1 && attachmentIds.length === 0) ||
    trimmed.length > 3072
  ) {
    throw new AppError('Body must be between 1 and 3072 characters', 400);
  }

  const { type } = await assertRoomAndMembership(userId, roomId);

  // Round 6 — DM-ban gate. Only fires for DMs; channel rooms skip the lookup
  // entirely per Q7/Q9 (channel conversations are never gated on user-bans).
  if (type === 'dm') {
    // Resolve the other DM participant: DMs have exactly two `room_members`.
    const [peer] = await db
      .select({ userId: roomMembers.userId })
      .from(roomMembers)
      .where(and(eq(roomMembers.roomId, roomId), ne(roomMembers.userId, userId)))
      .limit(1);

    if (peer && (await userBansService.hasBanBetween(userId, peer.userId))) {
      throw new AppError('Personal messaging is blocked', 403);
    }
  }

  // Wrap the insert + attachment commit in a single tx so a failed commit
  // (bad id, wrong uploader, already-attached) rolls back the message row.
  // The pending attachments stay `pending` and the sweep eventually reaps
  // them.
  const { messageId, attachments } = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(messages)
      .values({
        roomId,
        userId,
        // Attachment-only messages persist an empty string body so the NOT
        // NULL column stays happy and downstream code can continue to treat
        // `body` as `string` (never nullable). Wire serialisation echoes the
        // empty string — FE renders from `attachments` alone in that case.
        body: trimmed,
      })
      .returning({ id: messages.id });

    let committed: Attachment[] = [];
    if (attachmentIds.length > 0) {
      committed = await attachmentsService.commitAttachmentsToMessage({
        attachmentIds,
        callerId: userId,
        roomId,
        messageId: inserted.id,
        tx,
      });
    }

    return { messageId: inserted.id, attachments: committed };
  });

  const [row] = await db
    .select({
      id: messages.id,
      roomId: messages.roomId,
      userId: messages.userId,
      username: users.username,
      body: messages.body,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .innerJoin(users, eq(users.id, messages.userId))
    .where(eq(messages.id, messageId))
    .limit(1);

  const message: Message = {
    id: row.id,
    roomId: row.roomId,
    userId: row.userId,
    username: row.username,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };
  if (attachments.length > 0) {
    message.attachments = attachments;
  }
  return message;
}

export async function listRecentMessages(
  userId: string,
  roomId: string,
  limit = 50,
): Promise<Message[]> {
  await assertRoomAndMembership(userId, roomId);

  // Fetch newest N first (so we get the latest slice), then reverse for
  // ascending order (oldest first, newest last) per the contract.
  const rows = await db
    .select({
      id: messages.id,
      roomId: messages.roomId,
      userId: messages.userId,
      username: users.username,
      body: messages.body,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .innerJoin(users, eq(users.id, messages.userId))
    .where(eq(messages.roomId, roomId))
    .orderBy(desc(messages.createdAt))
    .limit(limit);

  return rows
    .map((m) => ({
      id: m.id,
      roomId: m.roomId,
      userId: m.userId,
      username: m.username,
      body: m.body,
      createdAt: m.createdAt.toISOString(),
    }))
    .reverse();
}
