# Round 9 — Orchestrator Work Summary

## Built

**Shared types (`/shared/types/`)**

- `message.ts` — extended. Added the new `MessageHistoryResponse` interface below the existing `MessageSendAck` export:
  ```ts
  export interface MessageHistoryResponse {
    messages: Message[];
    hasMore: boolean;
  }
  ```
  No changes to `Message` (Round-8 shape still correct) or `SendMessagePayload` (Round-8 shape still correct). The barrel `index.ts` re-exports `./message`, so `MessageHistoryResponse` resolves through `@shared` automatically — no `/shared/types/index.ts` edit needed.

**API contract (`/shared/api-contract.md`)**

- `### GET /api/rooms/:id/messages` — **rewritten** from the Round-3 bare-array spec to the Round-9 paginated spec:
  - Query params block added: `limit` (default 50, min 1, max 100, out-of-range → zod `"Validation failed"`) and `before` (optional UUID cursor).
  - Success body reshaped from `Message[]` to `MessageHistoryResponse { messages, hasMore }`. The `messages` array stays ordered `createdAt` ascending (oldest first, newest last) so the FE can prepend a page wholesale.
  - Explicitly documents that each returned `Message` carries `attachments` populated exactly as `message:send` ack / `message:new` do (Round 8), that BE must batch-fetch per page (no N+1), and that messages with no attachments OMIT the field (wire parity with pre-Round-8 assertions preserved).
  - `hasMore` semantics spelled out: server fetches `limit+1` rows; extra row present → `hasMore=true` and is dropped from the response. FE uses `messages[0].id` as the next `?before` — no separate `nextCursor` field on the wire.
  - New 400 error string `"Invalid cursor"` documented for (a) `before` UUID that doesn't exist or (b) `before` referencing a message in a different room. Cross-room ids 400 (not 404) so the endpoint does not leak existence of messages in other rooms. Malformed-UUID `before` stays on the zod `"Validation failed"` envelope (caught before the cursor resolver runs).
  - Existing errors preserved: 403 `"Not a room member"`, 404 `"Room not found"`. Added explicit row for `400 Validation failed` covering limit-out-of-range and malformed-UUID cursor.
- Summary table row for `GET /api/rooms/:id/messages` updated to reflect the new query params, response type, and error set:
  `GET | /api/rooms/:id/messages | ?before=<messageId>&limit=<1..100> | 200 MessageHistoryResponse (oldest-first page + hasMore) | 400 invalid cursor / validation, 403 not a member, 404 not found`
- Superseded Round-3 forward-reference line deleted verbatim: the `"No cursor / before parameter in Round 3. Round 9 introduces ?before=<messageId>&limit= and keeps the same response shape."` note is gone — Round-9 now speaks authoritatively and the "keeps the same response shape" claim is false (we reshape to `MessageHistoryResponse`). Grep across `api-contract.md` confirms only one remaining `Round 9` reference, and it is the intentional BC-break note in the rewritten endpoint description.

**No other shared surface touched.** Agent descriptions, CLAUDE.md files, master-plan.md, docker-compose.yml, schema / migrations — all untouched. Round 9 is purely a contract + code shape change; no new stack concerns, no deployment changes.

## Deviations

1. **Error envelope for validation failures locked to `"Validation failed"` + `details`** — the task file left this slightly open ("400 { "error": "...", "details": [...] }"); I locked the string to the verbatim `"Validation failed"` envelope that the existing `validate` middleware already emits everywhere else in the contract. Keeps the FE's existing validation-error handling path unchanged.

2. **Summary-table cell widened to include the query params column value explicitly** (`?before=<messageId>&limit=<1..100>`). The task file sketch used `?before=&limit=`; the explicit form is consistent with how the catalog endpoint is documented later in the master plan.

3. **Attachments hydration spelled out inline in the endpoint block** rather than relegated to a footnote. The task file let this live as a cross-reference to Round 8; promoting it inline makes the paginated endpoint self-describing and closes the "does pagination also carry attachments?" question BE readers would otherwise have to hunt for.

## Deferred

- `?after=<messageId>` forward-pagination — Round 12 will need it for "jump to unread" / "load newer from last-read" flows. Contract stays prepared: the cursor comparator can flip with a sibling param without reshaping the response.
- Virtual scroll / windowed rendering (Angular CDK `cdk-virtual-scroll-viewport` inverted mode) — not needed at hackathon scale; flagged as FE config improvement territory.
- Compound index `messages(room_id, created_at, id)` for perfect tie-break coverage — the existing `(room_id, created_at)` index covers the hot path; tie-break on identical-millisecond `created_at` is rare enough that the micro-optimisation is flagged as a future config improvement, not Round-9 work.
- Search within history, date-jump navigation, pinned messages — none of these are in requirements.
- `MESSAGE_PAGE_DEFAULT` / `MESSAGE_PAGE_MAX` env vars — hard-coded 50 / 100 today; flagged as config improvement.
- `ETag` / `If-None-Match` / `Server-Timing` instrumentation on the history endpoint — nice observability, not load-bearing.

## Next round needs to know

**For Round 10 (edit / delete).** The paginated endpoint already carries `attachments` on every returned `Message`, so Round-10's in-place mutations (`message:edit`, `message:delete` socket events) can update the FE's already-loaded pages by id without touching the cursor logic. The **outstanding Round-8-flagged concern** about on-disk file unlink on `message delete` (`attachments.message_id → messages.id ON DELETE CASCADE` drops the row but leaves the bytes on disk) still applies — Round 10's delete handler must `SELECT storage_path FROM attachments WHERE message_id = $1` before the cascade fires and `fs.promises.unlink` each path in an `afterCommit` hook. This is unchanged by Round 9.

**For Round 11 (room moderation).** No coupling with pagination. Ban / kick flows do not reshape the history endpoint. The same Round-8 on-disk-unlink pattern applies on `room delete`, scoped by `room_id`.

**For Round 12 (unread + public catalog).**
- Extend `listMessageHistory` with a sibling `after?: string` param and flip the comparator (row-value `(createdAt, id) > (cursor_ca, cursor_id)`). Response shape stays `MessageHistoryResponse`; `hasMore` semantics become "newer pages exist".
- The `catalog` endpoint (`GET /rooms/catalog?q=&cursor=`) is independent of history pagination. Same `?cursor=` style naming is fine, but the shape is different (search results, not chronological).
- Unread counts do NOT need to read attachments — keep that path lean.

**Contract-level locks**
- `MessageHistoryResponse.messages` is ordered ASCENDING. Any future round that adds a new history variant (e.g. "load 20 around a specific message for context jumps") should preserve the ASCENDING convention unless there's a compelling reason to diverge — the FE's prepend logic is built on it.
- `"Invalid cursor"` is now a reserved error string on this endpoint. Do not overload it with new meanings in Round 10+; introduce a distinct verbatim string if the cursor semantics need to discriminate more failure modes.
- `hasMore` is the only signal the FE uses to stop paginating. If a future round ever wants to let the endpoint return an empty page with `hasMore=true` (e.g. after a moderation purge), document it explicitly — the current FE assumes empty-page-ever means floor reached.

## Config improvements

- **`MESSAGE_PAGE_DEFAULT` and `MESSAGE_PAGE_MAX` as env vars** — currently hard-coded 50 / 100 in the zod schema and the BE service. Low-effort; lets prod tune without a code change.
- **Compound `messages(room_id, created_at, id)` index** — future-proofs the tie-break row-value filter against pathological same-ms timestamps. Negligible write cost at current scale.
- **`Server-Timing` header** on the history endpoint — surface `db-page-query;dur=<ms>` + `attachments-batch;dur=<ms>` so capacity planning can see where time goes on image-heavy pages.
- **`ETag` / `If-None-Match`** support on a specific `(roomId, limit, before)` tuple — enables cheap re-validation on reconnect / room re-open. Downside: interacts weirdly with live edits landing via Round 10; probably deferred until that round closes.
- **`X-Request-Id` propagation** through the history endpoint — already flagged in Round-8 notes; the paginated endpoint is a natural place to extend it since a slow page is the most likely to spawn a support ticket.
- **Promote `getRecent` → `getHistory` FE service** — the rename is already in the FE task file; mention here because the old method name was also used in the Round-3 smoke harness verbiage. Any future cross-round tooling referencing `getRecent` should be updated.
