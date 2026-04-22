# Round 9 — Orchestrator Tasks

## Goal
Lock the contract for paginated message history: the new `MessageHistoryResponse` type, the `?before=<messageId>&limit=` cursor semantics on `GET /api/rooms/:id/messages`, and the wire rules for ordering, `hasMore`, attachment hydration, and edge cases — so BE and FE can wire smooth infinite-scroll-upwards on the message list.

## Scope
Round 9 from `plans/master-plan.md` — user can scroll up through full message history with smooth infinite scroll; unread/anchor behavior feels right (requirements §2.5.6, §3.2 "usable with ≥ 10 000 messages", §3.3 "infinite scrolling for older messages").

Out of scope:
- Unread tracking / last-read cursor (Round 12).
- `?after=` forward-pagination (Round 12 — needed for unread jumps).
- Search within history (not in requirements).
- Date/jump-to-date navigation.
- Virtual scrolling / windowed rendering — deferred; the 50-per-page + anchor-preserving DOM approach is fine for the hackathon scale.

## Design decisions (locked during planning)

**D1. Cursor = `messageId`.** Existing Round-3 contract note already prefigured this: "Round 9 introduces `?before=<messageId>&limit=`". Server resolves the cursor id to its `(created_at, id)` tuple in a single sub-query and filters `(messages.created_at, messages.id) < (cursor.created_at, cursor.id)` (row-value comparison — supported by Postgres). This gives a stable cursor even when multiple messages share an identical `created_at` to ms-precision.

**D2. Response shape = `MessageHistoryResponse { messages: Message[]; hasMore: boolean }`.** Master-plan explicitly names this type. The Round-3-era contract note ("and keeps the same response shape") is superseded — Round 9 reshapes the endpoint for all callers. `messages` is ordered **ascending** (oldest first, newest last) so the FE can prepend a page wholesale; `hasMore` is derived from a `limit+1` fetch server-side (fetch `limit+1`, drop the extra row, set `hasMore` from "did we get more than `limit`").

**D3. `limit` = default 50, max 100, min 1.** Default 50 matches today's Round-3 behaviour; the 100 ceiling prevents pathological requests. Anything outside [1, 100] → `400 { "error": "...", "details": [...] }` via the standard zod validator.

**D4. Initial load has no `before`.** `GET /api/rooms/:id/messages?limit=50` returns the 50 newest, ascending, with `hasMore` indicating whether older pages exist. No special "page 0" flag — absence of `before` is the signal. Existing callers (pre-Round-9 FE, Round-3/6/7/8 smoke harnesses) that hit the endpoint with no query params continue to work structurally (same ordering, same message shape) but now MUST read from `response.messages` instead of treating the response as an array. This is a BC break — Round 9 smoke harness must exercise it; older smoke harnesses stay frozen at their round's semantics.

**D5. Cursor resolution errors.** If `before` is a UUID but no such message exists (or it belongs to a different room), the server returns `400 { "error": "Invalid cursor" }`. This is the only new error string Round 9 introduces. Rationale: silently returning an empty page would hide client bugs; a hard 400 forces the FE to clear its pagination state.

**D6. Attachments hydration.** Every returned `Message` must carry `attachments` populated exactly as `message:send` ack / `message:new` do (Round 8). BE must batch-fetch per page via `SELECT * FROM attachments WHERE message_id = ANY($messageIds) AND status='attached'` to avoid N+1. Wire parity with pre-Round-8 smoke assertions is preserved: messages with no attachments omit the field.

**D7. No cursor echoed in the response.** The FE uses `messages[0].id` as the next `before`. No `nextCursor` / `prevCursor` field — keeps the payload flat; one source of truth.

**D8. Ordering is stable on ties.** Tie-break: `id` (UUID) ascending within a tied `created_at`. Applies to both the filter comparison (row-value `(created_at, id) < (cursor_ca, cursor_id)`) and the `ORDER BY` clause (`created_at DESC, id DESC` on the query side, reversed to ASC in the response). Locks out cursor "skip" bugs.

**D9. No change to `messages.created_at` index.** Existing `messages_room_created_idx` on `(room_id, created_at)` already covers the hot query. Adding `id` to the index is micro-optimisation for a tie-break case that almost never fires at hackathon volume — flag as a future config improvement, do NOT add it now.

**D10. Live-send-during-pagination.** `message:send` broadcasts continue to append at the bottom of the FE's list; pagination only prepends at the top. No coupling — handled entirely FE-side.

## Dependencies
- `plans/master-plan.md` §Round 9 bullets.
- `requirements.txt` §2.5.6 (infinite scroll for old history), §3.2 (usable with ≥ 10 000 messages), §3.3 (persistence + infinite scrolling).
- `shared/api-contract.md` — current state; Round 9 rewrites the `GET /api/rooms/:id/messages` block and adds the `MessageHistoryResponse` mention inline.
- `shared/types/message.ts` — extend with `MessageHistoryResponse` interface.
- `plans/round-8/backend_work_summary.md` §Next round needs to know — the batch-fetch approach for attachments + the existing `listRecentMessages` that needs replacing.
- `plans/round-8/frontend_work_summary.md` §Next round needs to know — the `(loaded)` scroll-anchor plumbing and the `objectUrlCache` memory note (both flagged; Round 9 must respect them, not fix them).

## Tasks

### 1. Extend `/shared/types/message.ts`

Add `MessageHistoryResponse` next to the existing `Message` / `SendMessagePayload` / `MessageSendAck` exports:

```ts
export interface MessageHistoryResponse {
  messages: Message[];  // ascending: oldest first, newest last
  hasMore: boolean;     // true when older pages exist (server fetched limit+1)
}
```

Do not touch `Message` or `SendMessagePayload` in Round 9 — their Round-8 shape is still correct.

### 2. No new file under `/shared/types/`
All history types live on `message.ts`; the barrel `index.ts` re-exports `./message` so `MessageHistoryResponse` resolves automatically. No change to `/shared/types/index.ts`.

### 3. Rewrite the `GET /api/rooms/:id/messages` section in `/shared/api-contract.md`

Replace the existing Round-3 block under `## Rooms Endpoints` → `### GET /api/rooms/:id/messages` with the Round-9 version.

Content:

- **Headline**: returns a page of messages for infinite-scroll-upwards. Caller must be a current member of the room.
- **Query params**:
  - `limit` — optional integer, default 50, min 1, max 100. Out-of-range → `400 { "error": "...", "details": [...] }`.
  - `before` — optional UUID. When present, only messages strictly OLDER than the referenced message are returned (row-value comparison on `(created_at, id)` — ties on `created_at` break by `id`). When absent, returns the newest page.
- **Success** `200` — `MessageHistoryResponse`:
  ```json
  {
    "messages": [
      {
        "id": "uuid",
        "roomId": "uuid",
        "userId": "uuid",
        "username": "alice",
        "body": "hello team",
        "createdAt": "ISO",
        "attachments": [
          { "id": "uuid", "roomId": "uuid", "uploaderId": "uuid", "filename": "pic.png", "mimeType": "image/png", "sizeBytes": 123, "kind": "image", "comment": null, "createdAt": "ISO" }
        ]
      }
    ],
    "hasMore": true
  }
  ```
  Ordering: `createdAt` ascending (oldest first, newest last) so the FE can prepend a page wholesale. Each `Message` carries `attachments` populated exactly as `message:send` / `message:new` do — field omitted when empty.
- **Errors**:
  - `400` — `limit` outside [1, 100] or `before` malformed UUID: `{ "error": "...", "details": [...] }`.
  - `400` — `before` refers to a message that does not exist OR belongs to a different room: `{ "error": "Invalid cursor" }`.
  - `403` — caller is not a current member: `{ "error": "Not a room member" }`.
  - `404` — room not found: `{ "error": "Room not found" }`.

Preserve the rest of the `## Rooms Endpoints` section untouched. The summary table entry for this row should read:
`GET | /api/rooms/:id/messages | ?before=&limit= | 200 MessageHistoryResponse (oldest-first page + hasMore) | 400 invalid cursor/validation, 403 not a member, 404 not found`

### 4. Housekeeping — grep `/shared/api-contract.md` for the superseded Round-3 note

Find the existing line `"No cursor / before parameter in Round 3. Round 9 introduces ?before=<messageId>&limit= and keeps the same response shape."` and DELETE it. The new block in task 3 now speaks authoritatively — the Round-3 forward-reference is obsolete, and "keeps the same response shape" is now false (we reshape to `MessageHistoryResponse`).

Preserve other "Round 10+ / Round 11+ / Round 12+" forward-references; they are still accurate.

### 5. No agent description changes
Neither `.claude/agents/backend-developer.md` nor `frontend-developer.md` needs changes. Pagination is not a new stack concern.

### 6. No docker-compose / env / migration-infra changes
All Round 9 changes are contract-level + code-level. The existing `messages_room_created_idx` on `(room_id, created_at)` covers the hot query per D9.

### 7. No master-plan update
Round 9 bullet in `plans/master-plan.md` still reads accurately after this round's scope. Do not edit.

## Wrap-up
Write `plans/round-9/orchestrator_work_summary.md` with:
- **Built** — files touched under `/shared/` (`message.ts` extended, `api-contract.md` rewritten block 3), and confirmation that no other contracts moved.
- **Deviations** — likely pressure points: (a) `MessageHistoryResponse` vs keeping a bare `Message[]` with a header-based `hasMore` (hold firm on the wrapper — master-plan names the type, and the FE benefits from carrying the flag inline); (b) cursor semantics — strict `<` vs inclusive `<=` (lock strict; inclusive would double-send the boundary message after a prepend and force FE to filter); (c) whether to expose a `nextCursor` in the response (D7: no — FE derives from `messages[0].id`); (d) BC break for pre-Round-9 smoke harnesses (expected; do not try to preserve the array shape).
- **Deferred** — `?after=` forward pagination (Round 12), virtual-scroll / windowed rendering, search, jump-to-date, a `messages(room_id, created_at, id)` compound index (micro-optimisation flagged in D9).
- **Next round needs to know**
  - For Round 10 (edit / delete): edits mutate an existing message in place — `message:edit` / `message:delete` socket events will arrive on the already-loaded slice. The FE must patch the `messages` signal by id; pagination pages hold references to the same ids, so edits propagate naturally. No new cursor concerns.
  - For Round 11 (room moderation): none.
  - For Round 12 (unread + catalog): the `?before=` cursor pattern generalises — add a sibling `?after=<messageId>` for "load newer" jumps from a last-read position. Response shape stays `MessageHistoryResponse`; `hasMore` semantics flip to "newer pages exist". Same row-value cursor semantics (just flipped comparator). Catalog endpoint is independent, no coupling.
- **Config improvements** — candidate items: promote `limit` default / max to env vars (`MESSAGE_PAGE_DEFAULT=50`, `MESSAGE_PAGE_MAX=100`); add `id` to the compound index as `(room_id, created_at, id)` if production traffic ever shows tie-break misses; consider an ETag / `If-None-Match` on the page endpoint for free re-validation; expose a `Server-Timing` header with the `attachments-batch` sub-query latency for observability.
