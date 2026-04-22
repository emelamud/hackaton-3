import fs from 'node:fs';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  attachments,
  messages,
  roomMembers,
  rooms,
  users,
} from '../db/schema';
import { AppError } from '../errors/AppError';
import * as roomsService from './rooms.service';
import * as userBansService from './user-bans.service';
import * as attachmentsService from './attachments.service';
import { toAttachmentDto } from './attachments.service';
import type {
  Attachment,
  Message,
  MessageHistoryResponse,
  ReplyPreview,
} from '@shared';

const REPLY_PREVIEW_MAX = 140;

/**
 * Server-side reply-preview truncation — raw UTF-16 `.slice(0, 140)`. No
 * ellipsis suffix; FE owns any visual truncation affordance. Locked in
 * Round 10's contract.
 */
function truncateForPreview(body: string): string {
  return body.slice(0, REPLY_PREVIEW_MAX);
}

/**
 * Fetch a single reply preview for a known-existing target id. Used on the
 * `persistMessage` / `editMessage` shape steps; `listMessageHistory` uses a
 * batched variant below.
 */
async function fetchReplyPreview(messageId: string): Promise<ReplyPreview | null> {
  const [row] = await db
    .select({
      id: messages.id,
      userId: messages.userId,
      username: users.username,
      body: messages.body,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .innerJoin(users, eq(users.id, messages.userId))
    .where(eq(messages.id, messageId))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    username: row.username,
    bodyPreview: truncateForPreview(row.body),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Batch version of `fetchReplyPreview` — one query, returns a Map keyed by
 * target id. Used by `listMessageHistory` to hydrate all reply previews in a
 * page with a single extra query (zero N+1).
 */
async function fetchReplyPreviewMap(
  ids: string[],
): Promise<Map<string, ReplyPreview>> {
  const out = new Map<string, ReplyPreview>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({
      id: messages.id,
      userId: messages.userId,
      username: users.username,
      body: messages.body,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .innerJoin(users, eq(users.id, messages.userId))
    .where(inArray(messages.id, ids));
  for (const r of rows) {
    out.set(r.id, {
      id: r.id,
      userId: r.userId,
      username: r.username,
      bodyPreview: truncateForPreview(r.body),
      createdAt: r.createdAt.toISOString(),
    });
  }
  return out;
}

/**
 * Resolve a `replyToId` BEFORE the insert transaction — confirms the target
 * exists AND lives in the same room as the new message. Cross-room or unknown
 * ids fail with `'Invalid reply target'` (single generic string per the
 * contract, covering both sub-cases). Placed outside the tx so the error
 * maps cleanly to the socket ack envelope.
 */
async function assertReplyTargetInRoom(
  replyToId: string,
  roomId: string,
): Promise<void> {
  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.id, replyToId), eq(messages.roomId, roomId)))
    .limit(1);
  if (!row) {
    throw new AppError('Invalid reply target', 400);
  }
}

export async function persistMessage(
  userId: string,
  roomId: string,
  body: string,
  attachmentIds: string[] = [],
  replyToId?: string,
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

  // Round 10 — resolve the reply target BEFORE the insert transaction. Cross-
  // room / unknown-id failures map cleanly onto the socket ack envelope as
  // `'Invalid reply target'`. If the target is hard-deleted between this
  // check and the INSERT, the FK constraint would catch it — a theoretical
  // race at sub-millisecond timing; acceptable at hackathon scale.
  if (replyToId) {
    await assertReplyTargetInRoom(replyToId, roomId);
  }

  // Wrap the insert + attachment commit in a single tx so a failed commit
  // (bad id, wrong uploader, already-attached) rolls back the message row.
  // The pending attachments stay `pending` and the sweep eventually reaps
  // them.
  const { messageId, attachments: committedAttachments } = await db.transaction(async (tx) => {
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
        replyToId: replyToId ?? null,
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
      editedAt: messages.editedAt,
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
    // Round 10 — always present on the wire. Fresh sends are never edited.
    editedAt: row.editedAt ? row.editedAt.toISOString() : null,
  };
  if (committedAttachments.length > 0) {
    message.attachments = committedAttachments;
  }
  if (replyToId) {
    // The target was validated to exist in this room above; this fetch always
    // resolves. (Theoretical race — target hard-deleted between validation
    // and this fetch — would produce `null`, which we treat as "omit" rather
    // than invent a wire-null for the fresh-send path.)
    const preview = await fetchReplyPreview(replyToId);
    if (preview) {
      message.replyTo = preview;
    }
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
 *
 * Round 10 — reply previews are batch-hydrated with the same pattern: collect
 * distinct non-null `reply_to_id` values and look them up in a single
 * `WHERE id = ANY(...)` query. `editedAt` is always present on the wire
 * (`null` when unedited). `replyTo` is OMITTED when the message was never a
 * reply; PRESENT AS `null` when the message WAS a reply but the target was
 * hard-deleted (the FK has `ON DELETE SET NULL`).
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
      editedAt: messages.editedAt,
      replyToId: messages.replyToId,
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

  // 5b) Batch-hydrate reply previews — same one-extra-query-per-page pattern.
  //     Collect distinct non-null reply_to_ids across the page.
  const replyTargetIds = Array.from(
    new Set(page.map((r) => r.replyToId).filter((v): v is string => v !== null)),
  );
  const replyPreviewMap = await fetchReplyPreviewMap(replyTargetIds);

  // 6) Shape response — omit `attachments` / `replyTo` entirely when absent
  //    (wire parity with `message:send` ack / `message:new`); `replyTo` is
  //    PRESENT AS `null` when the message's stored `reply_to_id` is non-null
  //    but no preview resolved (target was hard-deleted; FK already SET NULL
  //    means this branch only triggers in a narrow race window — belt and
  //    suspenders).
  const out: Message[] = page.map((r) => {
    const msg: Message = {
      id: r.id,
      roomId: r.roomId,
      userId: r.userId,
      username: r.username,
      body: r.body,
      createdAt: r.createdAt.toISOString(),
      editedAt: r.editedAt ? r.editedAt.toISOString() : null,
    };
    const atts = byMessageId.get(r.id);
    if (atts && atts.length > 0) {
      msg.attachments = atts;
    }
    if (r.replyToId !== null) {
      const preview = replyPreviewMap.get(r.replyToId);
      msg.replyTo = preview ?? null;
    }
    return msg;
  });

  return { messages: out, hasMore };
}

/**
 * Load a single message, fully hydrated (attachments + replyTo), shaped
 * identically to a row in `listMessageHistory`. Used by the PATCH edit path
 * to build the response payload after the UPDATE.
 */
async function hydrateMessageById(messageId: string): Promise<Message> {
  const [row] = await db
    .select({
      id: messages.id,
      roomId: messages.roomId,
      userId: messages.userId,
      username: users.username,
      body: messages.body,
      createdAt: messages.createdAt,
      editedAt: messages.editedAt,
      replyToId: messages.replyToId,
    })
    .from(messages)
    .innerJoin(users, eq(users.id, messages.userId))
    .where(eq(messages.id, messageId))
    .limit(1);
  if (!row) {
    // Caller is expected to have just UPDATEd this id — a missing row here
    // would indicate a concurrent delete race. Treat as 404.
    throw new AppError('Message not found', 404);
  }

  const msg: Message = {
    id: row.id,
    roomId: row.roomId,
    userId: row.userId,
    username: row.username,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt ? row.editedAt.toISOString() : null,
  };

  const attRows = await db
    .select()
    .from(attachments)
    .where(
      and(eq(attachments.messageId, messageId), eq(attachments.status, 'attached')),
    )
    .orderBy(asc(attachments.createdAt));
  if (attRows.length > 0) {
    msg.attachments = attRows.map((r) => toAttachmentDto(r));
  }

  if (row.replyToId !== null) {
    const preview = await fetchReplyPreview(row.replyToId);
    msg.replyTo = preview ?? null;
  }

  return msg;
}

/**
 * Wrapper around `roomsService.assertRoomMembership` that rewrites both its
 * natural error strings (`'Not a room member'` / `'Room not found'`) to
 * `'Message not found'` (404). Used by the edit + delete paths so a non-
 * member / missing room does not leak cross-room existence (matching the
 * already-unknown-id response byte-for-byte).
 */
async function assertRoomMembershipOr404(
  userId: string,
  roomId: string,
): Promise<void> {
  try {
    await roomsService.assertRoomMembership(userId, roomId);
  } catch {
    throw new AppError('Message not found', 404);
  }
}

/**
 * Resolve the DM peer for a DM room and, if a user-ban exists in either
 * direction, throw `'Personal messaging is blocked'` (403). Matches the gate
 * already used by `persistMessage` and `POST /api/attachments`.
 */
async function assertDmNotBanned(
  userId: string,
  roomId: string,
  type: 'channel' | 'dm',
): Promise<void> {
  if (type !== 'dm') return;
  const [peer] = await db
    .select({ userId: roomMembers.userId })
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), ne(roomMembers.userId, userId)))
    .limit(1);
  if (peer && (await userBansService.hasBanBetween(userId, peer.userId))) {
    throw new AppError('Personal messaging is blocked', 403);
  }
}

export async function editMessage(
  userId: string,
  messageId: string,
  newBody: string,
): Promise<Message> {
  // 1) Load — scope check before anything else so unknown ids never leak.
  const [row] = await db
    .select({
      id: messages.id,
      roomId: messages.roomId,
      userId: messages.userId,
    })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);
  if (!row) {
    throw new AppError('Message not found', 404);
  }

  // 2) Membership gate — rewrite helper's 403/404 strings to the unified
  //    `'Message not found'` (404) so non-members cannot distinguish cross-
  //    room message existence.
  await assertRoomMembershipOr404(userId, row.roomId);

  // 3) Author gate — checked AFTER membership so a non-member sees 404, not 403.
  if (row.userId !== userId) {
    throw new AppError('Only the author can edit this message', 403);
  }

  // 4) DM ban gate — resolve room type; DM channels consult user_bans in
  //    either direction.
  const roomType = await getRoomType(row.roomId);
  await assertDmNotBanned(userId, row.roomId, roomType);

  // 5) Body validation — mirrors `message:send`, with the attachment-only
  //    empty-body carve-out.
  const trimmed = newBody.trim();
  if (trimmed.length > 3072) {
    throw new AppError('Body must be between 1 and 3072 characters', 400);
  }
  if (trimmed.length === 0) {
    const [attached] = await db
      .select({ id: attachments.id })
      .from(attachments)
      .where(
        and(eq(attachments.messageId, messageId), eq(attachments.status, 'attached')),
      )
      .limit(1);
    if (!attached) {
      throw new AppError('Body must be between 1 and 3072 characters', 400);
    }
  }

  // 6) UPDATE — single statement, no tx needed.
  await db
    .update(messages)
    .set({ body: trimmed, editedAt: new Date() })
    .where(eq(messages.id, messageId));

  // 7) Shape response identically to listMessageHistory per-row shape.
  return hydrateMessageById(messageId);
}

/**
 * Tiny helper: look up a room's `type` by id. Exists to keep `editMessage` /
 * `deleteMessage` tidy without plumbing it through `roomsService`. Caller
 * has already asserted membership; a vanished row at this point is a race
 * — default to `'channel'` to skip the ban gate safely.
 */
async function getRoomType(roomId: string): Promise<'channel' | 'dm'> {
  const [row] = await db
    .select({ type: rooms.type })
    .from(rooms)
    .where(eq(rooms.id, roomId))
    .limit(1);
  return (row?.type as 'channel' | 'dm') ?? 'channel';
}

export async function deleteMessage(
  userId: string,
  messageId: string,
): Promise<{ roomId: string }> {
  // 1) Load the row.
  const [row] = await db
    .select({
      id: messages.id,
      roomId: messages.roomId,
      userId: messages.userId,
    })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);
  if (!row) {
    throw new AppError('Message not found', 404);
  }

  // 2) Membership gate — same wrap-to-404 pattern as edit.
  await assertRoomMembershipOr404(userId, row.roomId);

  // 3) Author gate.
  if (row.userId !== userId) {
    throw new AppError('Only the author can delete this message', 403);
  }

  // 4) DM ban gate — uniform freeze across PATCH/DELETE per the orchestrator's
  //    locked decision.
  const roomType = await getRoomType(row.roomId);
  await assertDmNotBanned(userId, row.roomId, roomType);

  // 5) Collect attachment storage paths BEFORE delete — the FK cascade drops
  //    the rows but not the on-disk files.
  const attRows = await db
    .select({ storagePath: attachments.storagePath })
    .from(attachments)
    .where(
      and(eq(attachments.messageId, messageId), eq(attachments.status, 'attached')),
    );
  const storagePaths = attRows
    .map((r) => r.storagePath)
    .filter((p): p is string => Boolean(p));

  // 6) DELETE the message. Cascade cleans attachments; reply_to_id SET NULL
  //    cleans reply links. No explicit tx needed — this is one statement and
  //    Postgres already wraps single statements implicitly.
  await db.delete(messages).where(eq(messages.id, messageId));

  // 7) Best-effort on-disk unlink — run AFTER the DB commit, AllSettled so one
  //    stray file doesn't bubble up. Logged at WARN; never propagated to the
  //    HTTP response (DB state is already authoritative).
  //    Fire-and-forget so the HTTP response does not wait on slow fs.
  void (async () => {
    if (storagePaths.length === 0) return;
    const results = await Promise.allSettled(
      storagePaths.map((p) => fs.promises.unlink(p)),
    );
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        const err = r.reason as NodeJS.ErrnoException;
        // eslint-disable-next-line no-console
        console.warn(
          `deleteMessage unlink failed messageId=${messageId} path=${storagePaths[i]} code=${err?.code ?? 'unknown'}`,
        );
      }
    });
  })();

  return { roomId: row.roomId };
}
