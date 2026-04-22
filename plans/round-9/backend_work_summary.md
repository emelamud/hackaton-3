# Round 9 — Backend Work Summary

## Built

### Service — `backend/src/services/messages.service.ts`
- Deleted `listRecentMessages(userId, roomId, limit=50): Promise<Message[]>` entirely (no renames, clean removal — was the only Round 3-era pagination path).
- New `listMessageHistory(userId, roomId, params: { before?: string; limit: number }): Promise<MessageHistoryResponse>`:
  1. `assertRoomAndMembership` kept as the first call — same 403 `"Not a room member"` / 404 `"Room not found"` semantics.
  2. When `params.before` is provided, resolves the cursor with `SELECT created_at, id FROM messages WHERE id = $before AND room_id = $roomId LIMIT 1`. Both conditions are required — a valid UUID that belongs to a different room still 400s (never leaks cross-room existence).
  3. Page fetch uses Drizzle `sql`-template row-value comparison `(messages.created_at, messages.id) < (${cursor.createdAt}, ${cursor.id})` so ties on `created_at` break stably by `id`. Template interpolation worked first try under the project's Drizzle version — no decomposed OR-form fallback needed.
  4. `ORDER BY created_at DESC, id DESC LIMIT params.limit + 1` — the `+1` probe row is the sole signal for `hasMore`; drop it before reverse.
  5. Page reversed in-place (`.reverse()`) before shaping so the wire stays ascending (oldest-first, newest-last) per the contract.
  6. Attachments batch-hydrated with a single query: `SELECT * FROM attachments WHERE message_id = ANY($messageIds) AND status='attached' ORDER BY created_at ASC`, grouped in a `Map<string, Attachment[]>` in memory. Zero N+1.
  7. Each `Message` gets `attachments` only when the page produced at least one row for its id — the field is omitted (not set to `[]`) for bare messages. Wire parity with `message:send` ack / `message:new`.
- Route caller updated; grep for `listRecentMessages` returns zero references.

### Service — `backend/src/services/attachments.service.ts`
- Extracted the private `toDto` helper into an exported `toAttachmentDto(row)` — wire shape is now reused by both `createPendingAttachment` / `commitAttachmentsToMessage` / `getAttachmentForDownload` (unchanged callsites, renamed call) AND the new `listMessageHistory` batch-hydrator. Single source of truth for the DTO field list; any future column addition lands in exactly one place.
- No other changes in this file.

### Middleware — `backend/src/middleware/validate.ts`
- Added a new sibling `validateQuery(schema)` — mirrors the existing `validateParams` except it calls `schema.safeParse(req.query)` and assigns back via `Object.assign(req.query, result.data)` so coerced/defaulted values (e.g. `z.coerce.number().default(50)`) land on `req.query` with the right types for the handler.
- Same error shape as the existing `validate` (`{ error: "Validation failed", details: [...] }`), same `AppError(..., 400)` path through the error handler.

### Route — `backend/src/routes/rooms.ts`
- Rewrote `GET /:id/messages`:
  - Added `messageHistoryQuerySchema = z.object({ before: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) })`.
  - Middleware chain now `validateParams(idSchema) → validateQuery(messageHistoryQuerySchema) → handler`.
  - Handler casts `req.query` through `z.infer` and delegates to `messagesService.listMessageHistory(req.user!.id, req.params.id, params)`. No business logic in the route.
- All other room routes untouched.

### No schema / migration / Docker changes
- `backend/src/db/schema.ts` unchanged. The existing `messages_room_created_idx` on `(room_id, created_at)` already backs the pagination hot path; a compound `(room_id, created_at, id)` index is flagged in Config improvements but deliberately deferred (tie-break rows are rare at hackathon millisecond-precision timestamps).
- `backend/src/db/migrations/` unchanged (no new migration file).
- `docker-compose.yml` / Dockerfile unchanged.

### Smoke harness — `tmp/round-9/smoke.js`
All 15 scenarios executed end-to-end against the live backend (port 3000). Seeding: 3 users (alice/bob/carol); 4 rooms (`#history` with 125 messages — 11 carry image attachments, one every 12th; `#other` with 1 message for the wrong-room cursor test; `#empty` with zero messages; `#fifty` with exactly 50 messages). Seed sends are paced at 210 ms each to stay under the socket rate-limit (5 msgs/sec refill, burst 10) — ~37 s total seed time, one-shot at start.

#### Raw observed payloads

```
[setup] {"aliceId":"2f6e95a6-1f5a-48ff-8149-6d39503df686","bobId":"d3c52280-db84-40e3-b335-379ecfeba784","carolId":"57460155-3da0-4a4f-adc3-1d1d96edd529","historyId":"ff70acdc-d670-4302-8e20-c718c32fce6b","otherId":"78216024-e1aa-438b-a41f-ac17fa7db6c9","emptyId":"7dbee276-f4f4-4773-8a03-06bc407db30a","fiftyId":"c766e858-1699-4505-8dd1-2cceb9e44156"}

[seed_history] {"count":125,"attachedCount":11}
[seed_other] {"otherMessageId":"e9e0f5f7-1652-47a1-9474-9a478beae91b"}
[seed_fifty] {"count":50}

[1] {"status":200,"messagesLength":50,"hasMore":true,"asc":true,"newestBody":"msg-124","withAttachCount":4,"withoutAttachCount":46,"sampleAttachmentKeys":["comment","createdAt","filename","id","kind","mimeType","roomId","sizeBytes","uploaderId"],"sampleAttachment":{"id":"d3a61df6-9317-4824-a832-74ecb1dc6e87","roomId":"ff70acdc-d670-4302-8e20-c718c32fce6b","uploaderId":"2f6e95a6-1f5a-48ff-8149-6d39503df686","filename":"image-84.png","mimeType":"image/png","sizeBytes":340,"kind":"image","comment":"comment-84","createdAt":"2026-04-22T10:38:24.511Z"},"emptyArrayOnBareMsg":false}

[2] {"status":200,"messagesLength":25,"hasMore":true,"newestBody":"msg-124"}

[3] {"status":200,"messagesLength":50,"hasMore":true,"strictlyOlder":true,"overlap":0,"oldestBody":"msg-25","newestBody":"msg-74"}

[4] {"pages":3,"total":125,"lastPageLen":25,"finalHasMore":false,"expected":125}

[5] {"attachmentKeys":["comment","createdAt","filename","id","kind","mimeType","roomId","sizeBytes","uploaderId"],"keysMatchContract":true,"noStatus":true,"noMessageId":true,"noStoragePath":true,"download":{"status":200,"contentType":"image/png","byteLen":340,"sizeBytes":340,"matches":true},"sampleAttachment":{"id":"d3a61df6-9317-4824-a832-74ecb1dc6e87","roomId":"ff70acdc-d670-4302-8e20-c718c32fce6b","uploaderId":"2f6e95a6-1f5a-48ff-8149-6d39503df686","filename":"image-84.png","mimeType":"image/png","sizeBytes":340,"kind":"image","comment":"comment-84","createdAt":"2026-04-22T10:38:24.511Z"}}

[6] {"status":400,"body":{"error":"Invalid cursor"}}

[7] {"status":400,"body":{"error":"Invalid cursor"}}

[8] {"status":400,"body":{"error":"Validation failed","details":[{"field":"before","message":"Invalid UUID"}]}}

[9] {"limit0":{"status":400,"body":{"error":"Validation failed","details":[{"field":"limit","message":"Too small: expected number to be >=1"}]}},"limit500":{"status":400,"body":{"error":"Validation failed","details":[{"field":"limit","message":"Too big: expected number to be <=100"}]}}}

[10] {"status":403,"body":{"error":"Not a room member"}}

[11] {"status":404,"body":{"error":"Room not found"}}

[12] {"status":401,"body":{"error":"Missing or invalid authorization header"}}

[13] {"pageStatus":200,"pageMessagesLen":50,"liveLeakedIntoOldPage":false,"freshNewestBody":"LIVE-MESSAGE-AFTER-CURSOR","freshNewestIsLive":true}

[14] {"status":200,"body":{"messages":[],"hasMore":false}}

[15] {"status":200,"messagesLength":50,"hasMore":false}

[done] all 15 scenarios executed
```

#### Key observations per scenario

- **1. Initial page (no cursor)** — `200`, `messages.length = 50`, `hasMore = true` (125 > 50). Ordering ascending (`asc: true`). Newest body `"msg-124"` confirms the latest slice. Of the 50 rows on page 1, 4 carry attachments (msg-84, msg-96, msg-108, msg-120) and 46 are bare. Attachment keys exactly match the shared contract (`[comment, createdAt, filename, id, kind, mimeType, roomId, sizeBytes, uploaderId]` — no `status`, `messageId`, or `storagePath`). Bare messages OMIT the field entirely (`emptyArrayOnBareMsg: false`), matching the `message:send` ack / `message:new` wire parity.
- **2. Custom `limit=25`** — `200`, `messages.length = 25`, `hasMore = true`, newest still `"msg-124"`.
- **3. Second page via `before`** — Using `messages[0].id` from scenario 1 as cursor; returns 50 rows (msg-25..msg-74), `hasMore = true`, zero id overlap with scenario 1, and the newest row of the new page is strictly older than the scenario-1 floor.
- **4. Walk to the floor** — 3 total pages (50 + 50 + 25), no duplicate ids across pages, final page size 25, final `hasMore = false`. Total row count = 125 — the exact seed size.
- **5. Attachment hydration across pages** — Wire shape matches contract keys (9 fields, none of the internal `status` / `messageId` / `storagePath`). `GET /api/attachments/:id` with bob's Bearer returns `200` with `Content-Type: image/png` and byte count exactly matching `sizeBytes` — paginated shape + download flow are compatible.
- **6. Invalid cursor — random UUID** — `400 { "error": "Invalid cursor" }`.
- **7. Invalid cursor — wrong room** — Using the `#other` message's id against `#history`: `400 { "error": "Invalid cursor" }`. Does NOT leak that the id exists in a different room.
- **8. Invalid cursor — malformed UUID** — `400 { "error": "Validation failed", "details": [{ "field": "before", "message": "Invalid UUID" }] }` (caught by the zod layer, before the cursor resolver).
- **9. Limit out of range** — `limit=0` → `"Too small: expected number to be >=1"`; `limit=500` → `"Too big: expected number to be <=100"`. Both `400 "Validation failed"`.
- **10. Non-member** — carol is not in `#history`; `403 { "error": "Not a room member" }`.
- **11. Room not found** — random UUID as roomId: `404 { "error": "Room not found" }`.
- **12. Unauthenticated** — no Bearer: `401 { "error": "Missing or invalid authorization header" }`.
- **13. Live send during pagination** — Held `heldCursor = messages[0].id` from scenario 1 (the oldest message ON the newest page). Alice sends `"LIVE-MESSAGE-AFTER-CURSOR"`. Fetching with `before=heldCursor` returns 50 older rows and `liveLeakedIntoOldPage = false`. A fresh no-cursor fetch has `"LIVE-MESSAGE-AFTER-CURSOR"` as the NEWEST row (`freshNewestIsLive = true`). Row-value comparison correctly contains newer writes outside the `<` predicate.
- **14. Empty room** — `200 { "messages": [], "hasMore": false }`. No-message rooms are stable.
- **15. Exactly-50 room** — `200`, `messages.length = 50`, `hasMore = false`. The `limit+1` probe correctly returns exactly 50, not 51. Critical off-by-one regression trap passes.

### Verification gate

- `pnpm build` in `backend/` — clean (`> tsc` with no errors, no warnings).
- `pnpm lint` in `backend/` — clean (`> eslint src --ext .ts` with no warnings, no errors).
- `docker compose up -d --build backend` — rebuilt + restarted cleanly; container log:
  ```
  Running database migrations...
  Applying migrations from /app/dist/backend/src/db/migrations...
  Migrations complete.
  Starting backend server...
  Uploads directory ready at /app/uploads
  Backend running on port 3000
  ```
- All 15 smoke scenarios observe the expected payloads (captured verbatim above).

## Deviations

1. **Row-value SQL comparison worked first try** — Drizzle's `sql` template accepted `(${messages.createdAt}, ${messages.id}) < (${cursor.createdAt}, ${cursor.id})` without complaint. No fallback to the decomposed `createdAt < X OR (createdAt = X AND id < Y)` form was necessary.
2. **`validateQuery` landed as a new middleware** (not inline `.safeParse`) — symmetric with existing `validate` / `validateParams`, zero divergent code paths, and reusable for any future GET route that needs query validation (e.g. Round 12's `?after=` forward cursor or the catalog's filter params).
3. **`toAttachmentDto` got extracted as an exported helper** (the task's option c). Keeping it private to `attachments.service.ts` would have meant duplicating the 9-field DTO mapping in `messages.service.ts` for the batch hydrator — that's exactly the wire-parity drift the shared types are meant to prevent. Exporting it is the cheap, clean, one-source-of-truth choice. The old private symbol `toDto` → public `toAttachmentDto` (one rename + three internal callsite updates).
4. **Old `listRecentMessages` was removed outright, not renamed** — a BC-breaking rewrite is cleaner without a deprecated wrapper sitting around. There was exactly one caller (`backend/src/routes/rooms.ts`), updated in the same commit.
5. **Smoke seeding is paced at 210 ms per send** to stay under the `message:send` per-socket token bucket (5 msgs/sec refill, burst 10). A cleaner option would be a test-only rate-limit bypass flag, but the pacing keeps the harness pure contract-level and runs in ~37 s — acceptable for hackathon verification. Noted in Config improvements.
6. **`Object.assign(req.query, result.data)` in `validateQuery`** (not a direct assignment) — Express 4 technically permits both, but `Object.assign` matches the pattern already used by `validateParams` and sidesteps the "some versions of TypeScript treat `req.query` as a getter" edge case.

## Deferred

- **`?after=<messageId>` forward pagination** — Round 12 will need it for unread-jump. Extending `listMessageHistory` to take `after?: string` and flip the comparator (`> cursor`) is a ~10-line change; the response shape stays `MessageHistoryResponse` and `hasMore` semantics become "newer pages exist".
- **Compound index `messages(room_id, created_at, id)`** — the existing `(room_id, created_at)` index covers the hot path; the row-value tie-break can fall off the index for rows sharing a millisecond-precision `created_at`. Negligible at hackathon volume; the compound index is a one-migration fix when profiling shows the scan cost matters.
- **ETag / conditional-GET** on the history endpoint — the page has a stable id-set; a hash over `messages[].id` would let the FE 304 a repeat fetch. Blocked on an observability story to justify the cache surface.
- **`Server-Timing: db-query;dur=<ms>, attachments-batch;dur=<ms>`** — low-effort observability win; no header support wired anywhere today.
- **Search / date-jump** — out of scope for Round 9; tracked in master plan for a later round.
- **Test-only rate-limit bypass** for the socket `message:send` bucket — would let the smoke harness seed 125 messages instantly instead of paced at 210 ms. Not worth adding a code path that only runs in tests without a clearer signal that seeding time is a bottleneck.

## Next round needs to know

- **For Round 10 (message edit / delete)**: the paginated endpoint already includes `attachments`; `message:edit` / `message:delete` socket events land in-place mutations that the FE applies to its already-loaded pages — no cursor touch needed. `listMessageHistory` does not need to be aware of edit/delete metadata unless Round 10 adds an `editedAt` field to `Message`; in that case extend the SELECT column list and pass through to the DTO.
  - **Carry-forward from Round 8**: on-disk file unlink on message delete is still the outstanding concern (`DELETE … RETURNING storage_path` + `fs.promises.unlink` in an `afterCommit` hook). Not Round 9's problem, but carry the note forward into Round 10's task file.
- **For Round 11 (moderation)**: no coupling with history pagination.
- **For Round 12 (unread + catalog)**:
  - Extend `listMessageHistory` with `after?: string` — resolve cursor the same way, flip the row-value comparison to `>`, keep `ORDER BY` descending, reverse for the wire. Semantic change: `hasMore` now means "newer pages exist". Shape stays `MessageHistoryResponse`.
  - The query schema should allow at most one of `before` / `after` (reject `both` with a 400 — `z.object(...).refine(...)`). Round 9's schema does not enforce this because only `before` is present today.
  - Catalog endpoint is independent — shares no surface with the history endpoint.
- **Contract locks established in Round 9**:
  - `"Invalid cursor"` is now a reserved error string for the history endpoint. Used for both the non-existent-UUID case and the wrong-room case. Don't overload with new meanings.
  - `MessageHistoryResponse` field set is `{ messages, hasMore }` — no `nextCursor`. The FE derives the next cursor from `messages[0].id` client-side. If a future round ever needs a distinct cursor field (e.g. opaque encoded state), add it alongside `hasMore` rather than replacing the derivation rule.
  - `toAttachmentDto` is the canonical wire-shape helper for the `Attachment` type. Any new attachment-related read path MUST go through this helper — Round 9's batch hydrator is the first reuse; future ones should not copy the field list.

## Config improvements

- **`MESSAGE_PAGE_DEFAULT` / `MESSAGE_PAGE_MAX` env vars** — hard-coded `50` / `100` in `messageHistoryQuerySchema`. Cheap to parameterise; would let prod ops tune without a code change.
- **Compound index `messages(room_id, created_at, id)`** — the carry-forward from task 5; file a migration when the row-value comparison shows up in slow-query logs.
- **`Server-Timing: db-query;dur=<ms>, attachments-batch;dur=<ms>`** — would surface the two-phase query cost (page + attachment hydration) in dev-tools without a proper tracing stack.
- **`X-Request-Id` through the paginated path** — correlation id from a single `uuid()` at the Express edge, propagated into `AppError` log lines, makes "this specific page is slow" diagnosable.
- **Metrics (`history_requests_total{status}`, `history_page_attachments_batch_size`)** — Prometheus counters for the pagination surface. Blocked by the project's lack of a metrics stack today; low-priority until there's one to plug into.
- **Test-only rate-limit bypass header on `message:send`** — e.g. a `SMOKE_RATE_BYPASS` env + socket handshake flag — would let the smoke harness seed 125 messages in <2 s instead of ~26 s of paced sends. Scope creep for now, but worth revisiting if future rounds need higher seed counts.
- **Replace the `Object.assign(req.query, result.data)` in `validateQuery` with a proper `req.query = result.data` assignment** under Express 5 (which supports the setter) — currently preserved as an `Object.assign` for Express 4 compat.
