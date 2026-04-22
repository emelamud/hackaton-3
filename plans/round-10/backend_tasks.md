# Round 10 — Backend Tasks

## Goal
Implement reply / edit / delete message actions: schema migration adding `reply_to_id` + `edited_at` to `messages`, new `/api/messages/:id` PATCH + DELETE routes, `replyToId` handling on `message:send`, reply-preview batch-hydration on `GET /api/rooms/:id/messages`, attachment on-disk unlink on delete, and `message:edit` / `message:delete` socket broadcasts.

## Dependencies
- `/shared/api-contract.md` — READ the Round-10 orchestrator additions (`## Message Endpoints` section + extended `message:send` / `message:edit` / `message:delete` socket blocks + the new `editedAt` / `replyTo` fields on `GET /api/rooms/:id/messages`). **Do not modify `/shared/` — if something is wrong or missing there, report it to the orchestrator.**
- `/shared/types/message.ts` — `Message.editedAt: string | null`, `Message.replyTo?: ReplyPreview | null`, `ReplyPreview`, `EditMessageRequest`, `MessageDeletedPayload`, `SendMessagePayload.replyToId?: string`.
- `/shared/types/socket.ts` — new `message:edit: Message` and `message:delete: MessageDeletedPayload` entries on `ServerToClientEvents`.
- `backend/src/db/schema.ts` — add `replyToId` + `editedAt` columns on `messages`.
- `backend/src/services/messages.service.ts` — existing `persistMessage` / `listMessageHistory`; extend both.
- `backend/src/services/attachments.service.ts` — existing `toAttachmentDto`, the uploads-dir convention.
- `backend/src/services/rooms.service.ts` — `assertRoomMembership(userId, roomId)` helper (lifted in Round 12).
- `backend/src/services/user-bans.service.ts` — `hasBanBetween(userA, userB)` helper (Round 6).
- `backend/src/socket/io.ts` — `emitToRoom<E>(roomId, event, payload)` helper.
- `backend/src/middleware/validate.ts` — `validate(schema)` (body), `validateParams(schema)`, `validateQuery(schema)` (Round 9).
- Prior round summaries for context (already compacted into this task file; re-read only if a decision seems off):
  - `plans/round-8/backend_work_summary.md` — on-disk unlink flagged; Round 10 is the round that addresses it.
  - `plans/round-9/backend_work_summary.md` — pagination shape + `listMessageHistory` + `toAttachmentDto` reuse pattern.
  - `plans/round-12/backend_work_summary.md` — unread query uses `WHERE user_id <> caller`; hard delete is unread-safe (no query change).

## Tasks

### 1. Schema migration — extend `messages` table

Edit `backend/src/db/schema.ts`. Add two columns on `messages`:

- `replyToId: uuid('reply_to_id')` — nullable, self-referential FK to `messages.id` with `onDelete: 'set null'`. This is critical — on hard delete of a target, we must not cascade-drop its replies.
- `editedAt: timestamp('edited_at')` — nullable; set on PATCH.

**Gotcha — self-referential FK in Drizzle**: declaring a reference to `messages` inside the `messages` table definition needs `AnyPgColumn` or a lazy reference. Use:
```ts
replyToId: uuid('reply_to_id').references((): AnyPgColumn => messages.id, { onDelete: 'set null' }),
```
Import `AnyPgColumn` from `drizzle-orm/pg-core`.

Keep the existing `roomCreatedIdx` compound index (`(room_id, created_at)`). Do NOT add an index on `reply_to_id` — the batch hydrator looks targets up by PK (`WHERE id = ANY(...)`) which is already backed by the PK index. If a Round-11 moderation feature ever needs "all replies to X", flag then.

Run `pnpm db:generate` and commit the generated SQL under `backend/src/db/migrations/`. Verify the migration applies cleanly on container startup (`docker compose up -d --build backend` → check logs). If generation produces an unexpected surprise (dropping the index, renaming columns), inspect the diff carefully before committing.

### 2. Extend `persistMessage` — handle `replyToId`

In `backend/src/services/messages.service.ts`, extend `persistMessage` to accept `replyToId?: string` alongside `body` / `attachmentIds`. The signature becomes:

```ts
export async function persistMessage(
  userId: string,
  roomId: string,
  body: string,
  attachmentIds: string[] = [],
  replyToId?: string,
): Promise<Message>
```

Behaviour:
1. Resolve the reply target BEFORE the insert transaction. `SELECT id FROM messages WHERE id = $replyToId AND room_id = $roomId LIMIT 1` (both must match — cross-room replies 400 without leaking existence). On miss → `throw new AppError('Invalid reply target', 400)` which the socket handler surfaces via the ack envelope.
2. Insert the message with the resolved `reply_to_id` set; `edited_at` stays null.
3. Shape the response `Message`:
   - `editedAt: null` (always present — NEW field).
   - `replyTo`: hydrate if `replyToId` was set. Fetch the target's `id, user_id, username, body, created_at` in one query, shape as `ReplyPreview` (with `bodyPreview = raw_body.slice(0, 140)`).
   - Follow the "omit when not a reply" rule: if `replyToId` is undefined, OMIT the `replyTo` field entirely from the wire response. If `replyToId` is set and the target was resolved in step 1 (which it always is — step 1 would have thrown otherwise), include `replyTo: <ReplyPreview>` (never `null` on this path — the `null` case only appears on historical reads where the original target was later deleted).

### 3. Update `message:send` handler to accept `replyToId`

Find the socket handler for `message:send` (likely `backend/src/socket/io.ts` or a dedicated handler file). Extend its zod payload schema:

```ts
const sendMessageSchema = z.object({
  roomId: z.string().uuid(),
  body: z.string(),
  attachmentIds: z.array(z.string().uuid()).max(5).optional(),
  replyToId: z.string().uuid().optional(),
});
```

Pass the parsed `replyToId` through to `persistMessage`. Validation failures still return `{ ok: false, error: 'Invalid payload' }`. The new domain error (`'Invalid reply target'` thrown from `persistMessage`) surfaces through whatever AppError-to-ack mapping already exists — verify the string bubbles verbatim.

### 4. Extend `listMessageHistory` — hydrate `editedAt` + batch-hydrate `replyTo`

In the existing paginated history service, after the page is fetched + reversed (before the attachments batch hydration block):

1. Extend the `db.select(...)` column list to include `editedAt: messages.editedAt` and `replyToId: messages.replyToId`.
2. Shape step: set `msg.editedAt = r.editedAt ? r.editedAt.toISOString() : null` on every row.
3. Batch-hydrate reply previews with the SAME pattern as attachments — one extra query per page:
   - Collect the distinct `replyToId` values across the page into `replyTargetIds` (skip nulls).
   - If non-empty: `SELECT id, user_id, username, body, created_at FROM messages JOIN users ON ... WHERE messages.id = ANY($replyTargetIds)` → build a `Map<string, ReplyPreview>`.
   - For each shaped message in the response: if `replyToId` is non-null AND a preview exists, set `msg.replyTo = previewsMap.get(replyToId)`. If `replyToId` is non-null AND no preview (target was deleted → `SET NULL` already fired, but if we see a non-null `replyToId` with no resolvable target, that would be a race), set `msg.replyTo = null`. If `replyToId` is null, OMIT the field entirely.

The batch hydration is O(1) extra query per page regardless of page size — zero N+1.

Truncate each `bodyPreview` via `raw_body.slice(0, 140)`. No ellipsis suffix server-side.

### 5. New route — `PATCH /api/messages/:id`

Create a new router file `backend/src/routes/messages.ts`. Mount it in `backend/src/index.ts` alongside the existing routers (order doesn't matter; keep alphabetical if that's the convention).

Route scaffolding:
```ts
const idSchema = z.object({ id: z.string().uuid() });
const editMessageSchema = z.object({ body: z.string() });

router.patch(
  '/:id',
  requireAuth,
  validateParams(idSchema),
  validate(editMessageSchema),
  async (req, res) => {
    const updated = await messagesService.editMessage(
      req.user!.id,
      req.params.id,
      req.body.body,
    );
    emitToRoom(updated.roomId, 'message:edit', updated);
    res.json(updated);
  },
);
```

### 6. New service — `editMessage(userId, messageId, newBody)` in `messages.service.ts`

```ts
export async function editMessage(
  userId: string,
  messageId: string,
  newBody: string,
): Promise<Message>
```

Ordering of checks (match the documented error priority in the contract):
1. Load the message: `SELECT id, room_id, user_id, body FROM messages WHERE id = $messageId`. If no row → `404 "Message not found"`.
2. Membership gate: `assertRoomMembership(userId, row.roomId)` — a former member sees `404 "Message not found"` (rewrite the error string from the helper's default to match the contract; the easiest way is to wrap the call and swallow the 403 into a 404 with the message-not-found string to avoid leaking cross-room existence).
   - Gotcha: `assertRoomMembership` throws 403 `'Not a room member'` / 404 `'Room not found'` — neither matches `"Message not found"`. Wrap it: `try { await assertRoomMembership(userId, row.roomId); } catch { throw new AppError('Message not found', 404); }`.
3. Author gate: `row.user_id !== userId` → `403 "Only the author can edit this message"`.
4. DM ban gate: resolve `rooms.type`; if `'dm'`, load the other participant and `hasBanBetween` → `403 "Personal messaging is blocked"`. Reuse the Round 6 / Round 8 pattern used in `persistMessage`. For channels, skip.
5. Body validation: `trimmed = newBody.trim()`. If `trimmed.length > 3072` → `400 "Body must be between 1 and 3072 characters"`. If `trimmed.length === 0`: check if the message has at least one attached attachment (`SELECT 1 FROM attachments WHERE message_id = $messageId AND status='attached' LIMIT 1`). If yes, allow empty body. If no → `400 "Body must be between 1 and 3072 characters"`.
6. UPDATE: `UPDATE messages SET body = $trimmed, edited_at = NOW() WHERE id = $messageId RETURNING ...`. Use a transaction only if you add more writes later — for a single UPDATE, a transaction is unnecessary.
7. Shape the response identically to `listMessageHistory`'s per-message shaping: pull the row, join `users` for `username`, batch-hydrate its attachments (single query) and its reply target (single query if `replyToId` is non-null). Reuse `toAttachmentDto`. `editedAt` will now be set; `replyTo` follows the omit/null rule.

### 7. New route — `DELETE /api/messages/:id`

In `backend/src/routes/messages.ts`:
```ts
router.delete(
  '/:id',
  requireAuth,
  validateParams(idSchema),
  async (req, res) => {
    const { roomId } = await messagesService.deleteMessage(req.user!.id, req.params.id);
    emitToRoom(roomId, 'message:delete', { roomId, messageId: req.params.id });
    res.status(204).send();
  },
);
```

### 8. New service — `deleteMessage(userId, messageId)` in `messages.service.ts`

```ts
export async function deleteMessage(
  userId: string,
  messageId: string,
): Promise<{ roomId: string }>
```

Behaviour:
1. Load the message: `SELECT id, room_id, user_id FROM messages WHERE id = $messageId`. If no row → `404 "Message not found"`.
2. Membership gate (same wrap-to-404 pattern as task 6).
3. Author gate: `403 "Only the author can delete this message"`.
4. DM ban gate: same as task 6 → `403 "Personal messaging is blocked"`.
5. **Collect attachment paths BEFORE delete** — the FK cascade drops the rows but not the files:
   ```ts
   const atts = await db
     .select({ storagePath: attachments.storagePath })
     .from(attachments)
     .where(and(eq(attachments.messageId, messageId), eq(attachments.status, 'attached')));
   ```
6. DELETE in a transaction: `DELETE FROM messages WHERE id = $messageId`. Inside the tx, nothing else is needed — cascade handles attachments, and `ON DELETE SET NULL` handles replies.
7. After the tx commits, unlink each `storagePath` via `fs.promises.unlink`. Wrap in a `Promise.allSettled(...)` so one failure does NOT break the others. Log WARN on each failure with `{ messageId, storagePath, errCode }`. Do NOT propagate unlink errors to the HTTP response — the DB state is already authoritative.
   - Gotcha: `storagePath` from Round 8 is a container-absolute path (verify by reading `backend/src/services/attachments.service.ts` — if it's a relative path, join with the uploads dir root the same way `getAttachmentForDownload` does).
8. Return `{ roomId }` so the route handler can fan out the socket event. (We return after the DB commit but parallel to / after the unlinks; if the unlinks are slow, the HTTP response should NOT wait — spawn them in the background via `void doUnlinks()` and return immediately. Acceptable for hackathon: the DB state is already correct.)

### 9. Socket broadcast wiring

Use `emitToRoom(roomId, 'message:edit', message)` and `emitToRoom(roomId, 'message:delete', { roomId, messageId })` from `backend/src/socket/io.ts`. These fan out to `io.in('room:<roomId>').emit(...)` — ALL sockets in the room, INCLUDING the author's own tab. Different from `message:new`'s `socket.to(...)` exclusion pattern; do NOT try to reuse the sender-exclusion semantics for edit/delete — the HTTP caller has no socket handle anyway.

Verify `emitToRoom` is already generic over `ServerToClientEvents`. Round 12 confirmed `emitToUser` is generic; `emitToRoom` should be too. If it isn't, widen it (it's a one-line fix) — do NOT add a cast at the callsite.

### 10. Smoke harness — `tmp/round-10/smoke.js`

Follow the Round 9 / Round 12 pattern: Node script with `node-fetch` + `socket.io-client`. Seeds its own users/rooms/messages, then runs scenarios end-to-end against the live backend. Captures raw observed payloads for the summary's "Scenario result matrix".

Scenarios to cover (minimum):

**Reply (send flow)**
1. Alice sends msg-1 in #chat. Bob replies to msg-1 with msg-2 (`replyToId: msg1.id`). Ack payload includes `message.replyTo = { id: msg1.id, userId: alice, username: 'alice', bodyPreview: <first 140 chars>, createdAt: <iso> }`.
2. Alice fetches `GET /api/rooms/#chat/messages`. msg-2 in the page has `replyTo` populated identically to the ack. msg-1 has `replyTo` OMITTED (not null) from the wire.
3. Bob attempts `replyToId` pointing at a message in a different room — ack is `{ ok: false, error: 'Invalid reply target' }`.
4. Bob attempts `replyToId: <random UUID>` — ack is `{ ok: false, error: 'Invalid reply target' }`.
5. Bob attempts `replyToId: <malformed UUID>` — ack is `{ ok: false, error: 'Invalid payload' }` (zod catches it pre-service).
6. Body-preview truncation: seed msg-1 with a 200-char body; bob replies. `replyTo.bodyPreview` is exactly 140 chars, no ellipsis.

**Edit**
7. Alice PATCHes her own message with a new body. Response `200` carries the updated `Message` with `editedAt` set (within 2s of server now). `message:edit` is received by bob's socket and alice's OTHER tab.
8. Bob attempts to PATCH alice's message — `403 { error: 'Only the author can edit this message' }`.
9. PATCH with body ="   " (whitespace-only) on a message with no attachments — `400 { error: 'Body must be between 1 and 3072 characters' }`.
10. PATCH with body ="   " on a message that HAS attachments — `200`, body becomes empty string, editedAt set, attachments still hydrated on the response.
11. PATCH with body of 3073+ chars — `400 "Body must be between 1 and 3072 characters"`.
12. PATCH by a NON-member of the room — `404 { error: 'Message not found' }` (NOT 403 — non-membership must not leak message existence).
13. PATCH on a random UUID — `404 { error: 'Message not found' }`.
14. PATCH in a DM when a user-ban exists in either direction — `403 { error: 'Personal messaging is blocked' }`.
15. History fetch after edit — `editedAt` on the edited message matches the PATCH response; unedited messages have `editedAt: null`.

**Delete**
16. Alice DELETEs her own message. `204`, no body. `message:delete` received by bob's socket AND alice's other tab.
17. Bob attempts to DELETE alice's message — `403 { error: 'Only the author can delete this message' }`.
18. DELETE by a non-member — `404 { error: 'Message not found' }`.
19. DELETE in a DM with an active user-ban — `403 { error: 'Personal messaging is blocked' }`.
20. DELETE a message that has ≥1 attached image. Verify: after DELETE, `GET /api/attachments/:id` on the attachment returns `404 "Attachment not found"` (cascade fired). Verify the on-disk file is gone (`fs.access` throws ENOENT) — run from the BE container or mount a shared volume; if unclear how to inspect, capture the log line from the unlink sweep and call it out.
21. DELETE a message that was the `replyToId` of another message. After delete, the replying message survives — `GET /api/rooms/:id/messages` shows the replying message with `replyTo: null` (NOT omitted; the field is present-but-null to preserve the "was a reply" signal).

**Regressions (sanity checks — should still pass from earlier rounds)**
22. `GET /api/rooms/:id/messages` still paginates correctly (hasMore, before-cursor, attachments hydration unchanged).
23. `message:send` without `replyToId` still produces a `Message` with `replyTo` OMITTED from the ack (not null, not empty object).
24. Unread count (`GET /api/unread`) after deleting one of the unread messages: count drops by 1 on the next fetch (live-computed, no cache to bust).

Pace sends at 210 ms each to stay under the socket rate limit (refill 5/s, burst 10) — same pattern as Round 9 / Round 12 smokes.

Capture raw payloads for each scenario in the `backend_work_summary.md` Scenario matrix. Do NOT just write "passed" — the project convention is verbatim payloads.

### 11. Verification gate

Before writing the summary:
- `pnpm build` in `backend/` — zero errors.
- `pnpm lint` in `backend/` — zero warnings / errors.
- `docker compose up -d --build backend` — container starts cleanly; migrations apply without surprises; capture the boot log lines.
- `node tmp/round-10/smoke.js` — all scenarios above run; capture the full output in the summary.

## Wrap-up
Write `plans/round-10/backend_work_summary.md` with sections: **Built**, **Deviations**, **Deferred**, **Next round needs to know**, **Config improvements**. Under **Built** include the schema diff, the exact migration filename that was generated, the new route path table, and the new socket-event list. Under **Next round needs to know** specifically flag:
- Any change to the `message:send` error-string set (so FE keeps its ack-handling switch current).
- Whether `editedAt: null` showing up on every history response broke any pre-existing smoke assertions.
- Any fragility in the on-disk unlink path that Round 11 (room moderation / room delete) will need to mirror when it hard-deletes a whole room's message set.
