# Round 9 — Backend Tasks

## Goal
Replace `listRecentMessages` with a cursor-paginated history endpoint. `GET /api/rooms/:id/messages?before=<messageId>&limit=50` returns a `MessageHistoryResponse` (oldest-first page + `hasMore` flag), with each message's `attachments` batch-hydrated in one extra query per page. No N+1. Stable ordering on ties.

## Dependencies
- `/shared/api-contract.md` — rewritten `### GET /api/rooms/:id/messages` block and the new `Invalid cursor` error string.
- `/shared/types/message.ts` — new `MessageHistoryResponse { messages: Message[]; hasMore: boolean }` export.
- **Do not modify `/shared/`.** If a contract / type change is needed, report to the orchestrator.
- `backend/CLAUDE.md` — route vs service separation, Drizzle conventions, error handling.
- `backend/src/services/messages.service.ts` — existing `listRecentMessages(userId, roomId, limit = 50)`. This is the function you rewrite; keep the membership-assertion helper (`assertRoomAndMembership`) as the entry gate.
- `backend/src/services/attachments.service.ts` — Round 8 shaped the `Attachment` DTO shape; reuse the existing mapper (either via an exported `toDto` helper or by copying the field list). Do NOT re-invent the wire shape — it MUST match `message:send` ack / `message:new`.
- `backend/src/routes/rooms.ts` — where the existing `GET /:id/messages` handler lives. The route shape changes (accepts query params); wire via zod.

## Tasks

### 1. Service — rewrite `listRecentMessages` in `backend/src/services/messages.service.ts`

New signature:

```ts
export async function listMessageHistory(
  userId: string,
  roomId: string,
  params: { before?: string; limit: number },
): Promise<MessageHistoryResponse> { ... }
```

Rename the old function (`listRecentMessages` → `listMessageHistory`) and switch the export. Keep `assertRoomAndMembership(userId, roomId)` as the first call — same 403/404 semantics as Round 3.

Core query, in one transaction (or a single implicit one if you prefer — no writes, read-only is fine):

1. **Resolve cursor** (only when `params.before` is defined):
   ```ts
   const [cursor] = await db
     .select({ createdAt: messages.createdAt, id: messages.id })
     .from(messages)
     .where(and(eq(messages.id, params.before), eq(messages.roomId, roomId)))
     .limit(1);
   if (!cursor) throw new AppError('Invalid cursor', 400);
   ```
   Both conditions matter — a UUID that exists but belongs to a different room must still 400 (not leak existence of cross-room messages).

2. **Fetch page** using a row-value comparison for a stable tie-break:
   ```ts
   const rows = await db
     .select({ id, roomId, userId, username: users.username, body, createdAt })
     .from(messages)
     .innerJoin(users, eq(users.id, messages.userId))
     .where(and(
       eq(messages.roomId, roomId),
       cursor
         ? sql`(${messages.createdAt}, ${messages.id}) < (${cursor.createdAt}, ${cursor.id})`
         : sql`true`,
     ))
     .orderBy(desc(messages.createdAt), desc(messages.id))
     .limit(params.limit + 1);   // fetch one extra to detect hasMore
   ```

3. **Detect `hasMore`** and trim:
   ```ts
   const hasMore = rows.length > params.limit;
   const page = hasMore ? rows.slice(0, params.limit) : rows;
   ```

4. **Reverse to ascending** (oldest first, newest last — wire contract):
   ```ts
   page.reverse();
   ```

5. **Batch-hydrate attachments** — one query for the whole page, regardless of size:
   ```ts
   const messageIds = page.map((r) => r.id);
   const attRows = messageIds.length
     ? await db
         .select({ ...attachmentDtoCols, messageId: attachments.messageId })
         .from(attachments)
         .where(and(
           inArray(attachments.messageId, messageIds),
           eq(attachments.status, 'attached'),
         ))
         .orderBy(asc(attachments.createdAt))
       : [];

   const byMessageId = new Map<string, Attachment[]>();
   for (const att of attRows) {
     const dto = toAttachmentDto(att);
     const list = byMessageId.get(att.messageId) ?? [];
     list.push(dto);
     byMessageId.set(att.messageId, list);
   }
   ```
   `toAttachmentDto` must match the exact wire shape used by `attachments.service.createPendingAttachment` return + `commitAttachmentsToMessage` return. If there's already an exported helper, reuse it; otherwise copy the Round-8 field mapping verbatim (no `status`, no `messageId`, no `storagePath` on the wire).

6. **Shape the response**:
   ```ts
   const messages_ = page.map((r) => {
     const atts = byMessageId.get(r.id);
     const msg: Message = {
       id: r.id,
       roomId: r.roomId,
       userId: r.userId,
       username: r.username,
       body: r.body,
       createdAt: r.createdAt.toISOString(),
     };
     if (atts && atts.length) msg.attachments = atts;
     return msg;
   });
   return { messages: messages_, hasMore };
   ```

Notes:
- Do NOT emit an `attachments: []` empty array on messages that have none — omit the field to preserve wire parity with `message:send` / `message:new` (field is optional per `Message` type).
- Row-value comparison `(a, b) < (c, d)` is standard SQL supported by Postgres; Drizzle's `sql` template handles it. Alternative (if the template expression fails under your Drizzle version): decompose into `createdAt < cursor.createdAt OR (createdAt = cursor.createdAt AND id < cursor.id)`.
- Do NOT add `LIMIT 51` magic number; always `params.limit + 1`.

### 2. Delete / deprecate the old `listRecentMessages`

Since Round 9 is a BC-breaking rewrite of this exact endpoint, remove the old `listRecentMessages` function entirely. Any remaining callers inside the BE (grep for it) should move to `listMessageHistory({ limit: 50 })`. There is exactly one caller today (`routes/rooms.ts`) — update it in task 3.

### 3. Route — rewrite the handler in `backend/src/routes/rooms.ts`

Before (Round 3):

```ts
roomsRouter.get('/:id/messages', validateParams(idSchema), async (req, res, next) => {
  try {
    const result = await messagesService.listRecentMessages(req.user!.id, req.params.id);
    res.status(200).json(result);
  } catch (err) { next(err); }
});
```

After:

```ts
const messageHistoryQuerySchema = z.object({
  before: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

roomsRouter.get(
  '/:id/messages',
  validateParams(idSchema),
  validateQuery(messageHistoryQuerySchema),   // new middleware variant; see task 4
  async (req, res, next) => {
    try {
      const params = req.query as unknown as z.infer<typeof messageHistoryQuerySchema>;
      const result = await messagesService.listMessageHistory(req.user!.id, req.params.id, params);
      res.status(200).json(result);
    } catch (err) { next(err); }
  },
);
```

Keep the existing `requireAuth` router-level middleware that already guards everything under `/api/rooms`.

### 4. Add a `validateQuery` middleware (if not already present)

Check `backend/src/middleware/validate.ts` — if it only exports `validate(schema)` (body) and `validateParams(schema)`, add a sibling:

```ts
export function validateQuery<T extends ZodSchema>(schema: T): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      return next(new AppError('Validation failed', 400, result.error.issues));
    }
    req.query = result.data as ParsedQs;  // cast is fine; express lets you replace req.query
    next();
  };
}
```

Same error shape as the existing `validate` middleware (`{ error: "Validation failed", details: [...] }`). If `validateQuery` already exists from an earlier round, skip this task and reuse it.

### 5. No schema / migration changes

The existing `messages_room_created_idx` on `(room_id, created_at)` covers the `ORDER BY created_at DESC + room_id = $1` hot path. The row-value comparison on `(created_at, id)` CAN fall off the index for tie-break rows, but the tie-break only fires for rows with identical millisecond-precision `created_at` — negligible at hackathon volume. Do not add a compound `(room_id, created_at, id)` index in Round 9; it's flagged as a future config improvement.

No `pnpm db:generate` needed for Round 9.

### 6. Smoke harness — `tmp/round-9/smoke.js`

Drive the full Round 9 contract end-to-end. Same pattern as Round 7/8 (`node-fetch` + `socket.io-client`). Produce a structured JSON log keyed per scenario.

Setup: register two users (alice, bob). Create a public channel `#history`. Both join. Alice sends 125 messages to `#history` via `message:send` — mix of body-only and body+single-attachment (use a small PNG uploaded via `POST /api/attachments` for ~10 of them, spread across the 125 so pagination pages include a realistic mix). A second channel `#other` with a single message for the wrong-room cursor test.

Scenarios (record verbatim payloads):

1. **Initial page (no cursor)** — `GET /api/rooms/:historyId/messages`. Assert:
   - `200`.
   - `body.messages.length === 50`.
   - `body.hasMore === true` (125 > 50).
   - Ordering: `messages[0].createdAt < messages[49].createdAt` (ascending).
   - `messages[49]` is the most-recent message alice sent.
   - Messages that had attachments at send time carry `attachments` with the exact same shape as `message:send` ack / `message:new` (id, roomId, uploaderId, filename, mimeType, sizeBytes, kind, comment, createdAt — no `status`, no `messageId`, no `storagePath`).
   - Messages without attachments omit the field (not `attachments: []`).

2. **Custom `limit`** — `GET /api/rooms/:historyId/messages?limit=25`. Assert: `messages.length === 25`, `hasMore === true`.

3. **Second page via `before`** — `GET /api/rooms/:historyId/messages?before=<messages[0].id from scenario 1>`. Assert:
   - `200`, `messages.length === 50`, `hasMore === true`.
   - Strictly older: `newPage.messages[49].createdAt < scenario1.messages[0].createdAt` (or `<=` with `id <` tie-break).
   - No overlap with scenario 1 by id.

4. **Walk to the floor** — keep fetching pages with `before = messages[0].id` until `hasMore === false`. Assert: total returned across all pages === 125 (no drops, no duplicates). Assert final page has `hasMore === false` and `messages.length <= 50`.

5. **Attachment hydration across pages** — find a page that contains at least one message-with-attachment. Assert its `attachments[0]` shape matches the Round-8 wire exactly. Download the attachment via `GET /api/attachments/:id` with bob's Bearer — confirm `200` + bytes (sanity that paginated shape + download flow are compatible).

6. **Invalid cursor — non-existent UUID** — `GET /api/rooms/:historyId/messages?before=<random UUID that doesn't exist>`. Assert: `400 { "error": "Invalid cursor" }`.

7. **Invalid cursor — wrong room** — `GET /api/rooms/:historyId/messages?before=<id of the #other message>`. Assert: `400 { "error": "Invalid cursor" }` (must not leak that the id exists in a different room).

8. **Invalid cursor — malformed UUID** — `GET /api/rooms/:historyId/messages?before=not-a-uuid`. Assert: `400 { "error": "Validation failed", "details": [...] }` (zod layer catches this before the cursor resolver).

9. **Limit out of range** — `GET /api/rooms/:historyId/messages?limit=0` and `?limit=500`. Assert both return `400` with `details`.

10. **Non-member** — carol (not in `#history`) calls the endpoint. Assert: `403 { "error": "Not a room member" }`.

11. **Room not found** — `GET /api/rooms/<random uuid>/messages`. Assert: `404 { "error": "Room not found" }`.

12. **Unauthenticated** — no Bearer. Assert: `401`.

13. **Live send does not poison pagination** — hold a page cursor open; alice sends a new message via `message:send`; then continue paginating from the held cursor. Assert: no new message leaks into the older pages (cursor compares against historical `(createdAt, id)`, so newer rows fall outside the `<` predicate). Assert the new message lands correctly on a fresh no-cursor fetch.

14. **Empty room** — create `#empty` with just alice as member, no messages. `GET /api/rooms/:emptyId/messages`. Assert: `200 { messages: [], hasMore: false }`.

15. **Exactly-50 room** — create `#fifty` with 50 messages. `GET /api/rooms/:fiftyId/messages`. Assert: `messages.length === 50`, `hasMore === false` (the `limit+1` fetch returned exactly 50, not 51). Critical regression trap for the off-by-one.

Verification gate:
- `pnpm build` in `backend/` — clean (0 errors).
- `pnpm lint` in `backend/` — clean (0 warnings / errors).
- `docker compose up -d --build backend` — rebuilt + restarted cleanly; log shows `Backend running on port 3000`.
- All 15 smoke scenarios observe the expected payloads.

### 7. Do not introduce new dependencies

Drizzle + the existing `zod` middleware cover everything. No `knex`, no raw `pg` escape hatch.

## Wrap-up
Write `plans/round-9/backend_work_summary.md` with:
- **Built** — the rewritten `listMessageHistory` (delete of `listRecentMessages`), the route change to `GET /api/rooms/:id/messages`, the new `validateQuery` middleware (or reuse note), the smoke harness, confirmation that no schema / migration / docker changes landed.
- **Deviations** — likely pressure points: (a) row-value comparison SQL portability — if Drizzle's `sql` template trips on `(a, b) < (c, d)`, fall back to the decomposed OR form documented in task 1, note it; (b) whether `validateQuery` landed as a new middleware vs an inline `.safeParse` on `req.query` — either is fine, but note which; (c) whether `toAttachmentDto` got extracted into `attachments.service.ts` as an exported helper or stayed private per callsite (extraction is cleaner but optional); (d) whether the old `listRecentMessages` export got renamed vs removed — removal is the clean path.
- **Deferred** — `?after=` forward-pagination (Round 12 will need it for unread jumps); compound index `messages(room_id, created_at, id)` for perfect tie-break coverage; ETag / conditional-GET on the history endpoint; `Server-Timing` headers; search / date-jump.
- **Next round needs to know**
  - For Round 10 (message edit / delete): the paginated endpoint already includes `attachments`; the edit / delete endpoints only mutate in place. Emitting `message:edit` / `message:delete` socket events keeps the FE's already-loaded pages coherent — no cursor touch needed. **On-disk file unlink on delete** is still the outstanding Round-8-flagged concern (not Round-9's problem, but carry the note forward).
  - For Round 11 (moderation): no coupling.
  - For Round 12 (unread + catalog): extend `listMessageHistory` with an `after?: string` param and flip the comparator. Response shape stays `MessageHistoryResponse`; `hasMore` semantics become "newer pages exist". Catalog endpoint is independent.
- **Config improvements** — `MESSAGE_PAGE_DEFAULT` / `MESSAGE_PAGE_MAX` env vars; the compound-index follow-up flagged in task 5; `Server-Timing` header with `db-query;dur=<ms>` + `attachments-batch;dur=<ms>` for pagination latency observability; an explicit `X-Request-Id` through the paginated path so a slow page can be traced against the index scan.
