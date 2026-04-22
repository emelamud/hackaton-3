import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  attachments,
  messages,
  roomMembers,
  users,
} from '../db/schema';
import { AppError } from '../errors/AppError';
import * as roomsService from './rooms.service';
import * as userBansService from './user-bans.service';
import * as attachmentsService from './attachments.service';
import { toAttachmentDto } from './attachments.service';
import type { Attachment, Message, MessageHistoryResponse } from '@shared';

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

  const { type } = await roomsService.assertRoomMembership(userId, roomId);

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

/**
 * Cursor-paginated message history for `GET /api/rooms/:id/messages`.
 *
 * Ordering: returns one ascending page (oldest-first, newest-last) so the FE
 * can prepend a page wholesale during infinite-scroll-up. Internally the query
 * fetches descending (`ORDER BY created_at DESC, id DESC LIMIT N+1`) so the
 * `before` cursor compares against the newest slice; the page is then reversed
 * before serialisation.
 *
 * Cursor shape: when `params.before` is provided, we resolve the referenced
 * message's `(createdAt, id)` and filter with a row-value comparison
 * `(messages.createdAt, messages.id) < (cursor.createdAt, cursor.id)`. The
 * `(createdAt, id)` tie-break is stable even when multiple messages share the
 * same millisecond `createdAt` — a single `created_at < X` would silently drop
 * the tail of a tied batch.
 *
 * `hasMore` is derived from a `limit + 1` fetch — if the extra row came back,
 * there are older messages past the requested window. The extra row is dropped
 * before reverse / serialisation.
 *
 * Attachments are batch-hydrated per page with one extra query
 * (`WHERE message_id = ANY(...) AND status='attached'`) — never per-row. Rows
 * with no attachments omit the field (wire parity with `message:send` ack /
 * `message:new`).
 */
export async function listMessageHistory(
  userId: string,
  roomId: string,
  params: { before?: string; limit: number },
): Promise<MessageHistoryResponse> {
  await roomsService.assertRoomMembership(userId, roomId);

  // 1) Resolve cursor — both (id, roomId) must match so a valid UUID that
  //    belongs to a different room still 400s (never leaks existence).
  let cursor: { createdAt: Date; id: string } | undefined;
  if (params.before) {
    const [row] = await db
      .select({ createdAt: messages.createdAt, id: messages.id })
      .from(messages)
      .where(and(eq(messages.id, params.before), eq(messages.roomId, roomId)))
      .limit(1);
    if (!row) {
      throw new AppError('Invalid cursor', 400);
    }
    cursor = row;
  }

  // 2) Fetch newest-first with row-value tie-break. Drizzle's sql template
  //    emits the (a, b) < (c, d) form Postgres supports natively.
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
    .where(
      and(
        eq(messages.roomId, roomId),
        cursor
          ? sql`(${messages.createdAt}, ${messages.id}) < (${cursor.createdAt}, ${cursor.id})`
          : undefined,
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(params.limit + 1);

  // 3) Detect `hasMore` via the limit+1 probe row and trim.
  const hasMore = rows.length > params.limit;
  const page = hasMore ? rows.slice(0, params.limit) : rows;

  // 4) Reverse to ascending for the wire (oldest first, newest last).
  page.reverse();

  // 5) Batch-hydrate attachments — one query, grouped by message_id in memory.
  const messageIds = page.map((r) => r.id);
  const byMessageId = new Map<string, Attachment[]>();
  if (messageIds.length > 0) {
    const attRows = await db
      .select()
      .from(attachments)
      .where(
        and(
          inArray(attachments.messageId, messageIds),
          eq(attachments.status, 'attached'),
        ),
      )
      .orderBy(asc(attachments.createdAt));

    for (const att of attRows) {
      const dto = toAttachmentDto(att);
      const mid = att.messageId;
      if (!mid) continue; // narrow away the nullable FK
      const list = byMessageId.get(mid) ?? [];
      list.push(dto);
      byMessageId.set(mid, list);
    }
  }

  // 6) Shape response — omit `attachments` entirely when the message has none
  //    so the wire matches `message:send` ack / `message:new` exactly.
  const out: Message[] = page.map((r) => {
    const msg: Message = {
      id: r.id,
      roomId: r.roomId,
      userId: r.userId,
      username: r.username,
      body: r.body,
      createdAt: r.createdAt.toISOString(),
    };
    const atts = byMessageId.get(r.id);
    if (atts && atts.length > 0) {
      msg.attachments = atts;
    }
    return msg;
  });

  return { messages: out, hasMore };
}
