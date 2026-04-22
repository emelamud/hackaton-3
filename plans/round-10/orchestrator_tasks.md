# Round 10 — Orchestrator Tasks

## Goal
Lock the shared contract for reply / edit / delete message actions: extend `Message` with reply + edit metadata, add new REST endpoints (PATCH + DELETE `/api/messages/:id`), add new socket events (`message:edit`, `message:delete`), and document the hard-delete semantics (attachment unlink + `replyToId ON DELETE SET NULL`).

## Dependencies
- `/shared/api-contract.md` — current contract (Round 1–9 + Round 12).
- `/shared/types/message.ts`, `/shared/types/socket.ts`, `/shared/types/index.ts` — the shared surface you will mutate.
- Prior round summaries:
  - `plans/round-8/backend_work_summary.md` — attachment cascade leaves on-disk files orphaned; Round 10 must unlink.
  - `plans/round-9/orchestrator_work_summary.md` — `"Invalid cursor"` reserved on history endpoint; reuse is fine for new distinct error strings but don't overload it.
  - `plans/round-12/orchestrator_work_summary.md` — hard-delete path is unread-safe (no cursor mutation needed); soft-delete would require adding `WHERE deleted_at IS NULL` to the unread query. **Decision locked: hard delete.**
- `.claude/agents/backend-developer.md`, `.claude/agents/frontend-developer.md` — stack assumptions (no changes required unless you discover a new pattern).
- `CLAUDE.md` (root), `backend/CLAUDE.md`, `frontend/CLAUDE.md` — conventions for the downstream agents.

## Tasks

### 1. Extend `/shared/types/message.ts`

Add two new exports and extend the existing `Message`:

```ts
export interface ReplyPreview {
  id: string;
  userId: string;
  username: string;
  bodyPreview: string;   // first 140 chars of the target body (not trimmed mid-UTF-8 — use a simple JS `.slice(0, 140)` on the raw body; downstream rounds can tighten)
  createdAt: string;
}

export interface Message {
  id: string;
  roomId: string;
  userId: string;
  username: string;
  body: string;
  createdAt: string;
  editedAt: string | null;      // NEW — null when never edited; ISO string when edited
  attachments?: Attachment[];   // unchanged (omitted when none)
  replyTo?: ReplyPreview | null; // NEW — OMITTED when the message is not a reply; PRESENT AS null only when the original reply target has been deleted (replyToId SET NULL)
}

export interface EditMessageRequest {
  body: string;                  // 1–3072 trimmed, OR empty-trim allowed ONLY when the message has ≥1 attached attachment
}

export interface MessageDeletedPayload {
  roomId: string;
  messageId: string;
}
```

Extend `SendMessagePayload`:
```ts
export interface SendMessagePayload {
  roomId: string;
  body: string;
  attachmentIds?: string[];
  replyToId?: string;           // NEW — when present, must reference a message in the same room
}
```

Wire rules for the FE/BE to lock:
- `editedAt: null` for unedited messages (NOT omitted). This field is ALWAYS present — any pre-Round-10 consumer that ignored the field keeps working, but the type is now tightened.
- `replyTo`: **omitted** entirely for non-reply messages (same convention as `attachments`). **Present as `null`** only when the message WAS a reply but the target has since been hard-deleted (FK `ON DELETE SET NULL`) — the FE uses this distinction to render "(deleted message)" if it wants, though minimal behaviour is to render the message as if it were not a reply.
  - FE is free to treat `replyTo === null` identically to "field omitted" — the distinction is optional to surface. Don't require FE to render a deleted tombstone this round; the underlying type just preserves the signal for a later polish round.
- `bodyPreview` is a raw slice of `body` up to 140 chars. No ellipsis suffix server-side — FE owns the visual "…" if it wants one. This keeps the wire shape auditable.

### 2. Extend `/shared/types/socket.ts`

Add two server-to-client events to `ServerToClientEvents`:

```ts
'message:edit': Message;              // full updated message (with editedAt set, attachments + replyTo hydrated)
'message:delete': MessageDeletedPayload;
```

Import `MessageDeletedPayload` from `./message` (co-locate with the existing `Message` import). Do NOT add anything to `ClientToServerEvents` — edit/delete are strictly HTTP-driven (same rationale as `POST /api/rooms/:id/read` in Round 12: HTTP is more debuggable for author-gated mutations and avoids the rate-limit split between socket and HTTP paths).

### 3. Extend `/shared/types/index.ts`

`message.ts` is already re-exported via `export * from './message'`, so the new `ReplyPreview`, `EditMessageRequest`, `MessageDeletedPayload` exports flow through automatically. **Verify this** — if the existing barrel doesn't re-export `./message`, fix it (this would be a pre-existing gap, not a Round 10 regression).

### 4. Update `/shared/api-contract.md`

**4a. Extend `## Rooms Endpoints` → `### GET /api/rooms/:id/messages`** endpoint block:
- Under "Success `200`" sample body: add `"editedAt": null` to every `Message` example, and show ONE example row with a populated `replyTo` block. Example additions:
  ```json
  {
    "id": "uuid",
    "roomId": "uuid",
    "userId": "uuid",
    "username": "alice",
    "body": "hello team",
    "createdAt": "ISO",
    "editedAt": null,
    "replyTo": {
      "id": "uuid",
      "userId": "uuid",
      "username": "bob",
      "bodyPreview": "earlier message body…",
      "createdAt": "ISO"
    }
  }
  ```
- Add a sentence immediately under the existing attachments paragraph:
  > Each `Message` carries `editedAt` (always present — `null` for unedited messages, ISO string for edited ones) and optionally `replyTo` (omitted when the message is not a reply; present as `null` when the original target was hard-deleted). Reply previews are batch-hydrated server-side (one extra query per page: `WHERE id = ANY($replyTargetIds)`).
- No change to `hasMore` / pagination / cursor semantics. No new query param. No new error strings.

**4b. Extend the `## Rooms Endpoints` → `### Summary` table**: no change — the endpoint path/params/success stay the same; only the response shape is enriched.

**4c. Add a new top-level `## Message Endpoints` section**, inserted AFTER `## Public Room Catalog` and BEFORE `## Socket Events` (preserves the "HTTP endpoints above, sockets below" grouping established in Round 12). Contents:

```
## Message Endpoints

All message endpoints require `Authorization: Bearer <accessToken>` and return `401 { "error": "..." }` on missing / invalid / expired access tokens.

### Rules
- Edit / delete are strictly author-only. Room-admin delete lands in Round 11 (§master-plan) — this round scopes to authors mutating their own messages.
- Hard delete. `DELETE /api/messages/:id` removes the row; attachment rows cascade via FK; on-disk attachment files are unlinked by the service AFTER the DB transaction commits (best-effort; unlink failures are logged, not propagated to the client).
- `replyToId` on `messages` uses `ON DELETE SET NULL`. A message that reply-references a deleted target keeps its text and attachments; its `replyTo` field on the wire becomes `null` (signal preserved; rendering is FE-policy).
- DM ban gate: when the message lives in a DM and a `user_bans` row exists in either direction between the two participants, PATCH and DELETE both return `403 { "error": "Personal messaging is blocked" }` (matches the `message:send` ack and `POST /api/attachments` gate from Round 6 / Round 8). Channel rooms never consult user-bans.
- Room-membership gate: caller must be a current member of the message's `roomId`. Former members see `404 { "error": "Message not found" }` — consistent with the non-existence response so leaving a room does not reveal membership history.
- Body validation on edit mirrors the `message:send` rule: trimmed body must be 1–3072 chars, OR empty-after-trim is allowed when the message has at least one attached attachment (attachment-only messages stay valid after body clear).
- Editing does NOT modify attachments (no attach/detach in Round 10). Deleting drops attachments via cascade + unlink.

### Summary

| Method | Path | Body | Success | Errors |
|--------|------|------|---------|--------|
| PATCH | `/api/messages/:id` | `EditMessageRequest` | `200 Message` (with `editedAt` set, attachments + replyTo hydrated) + `message:edit` broadcast to `room:<roomId>` | `400` validation / empty-body-with-no-attachments, `403` not the author / DM blocked, `404` not found / not a member |
| DELETE | `/api/messages/:id` | — | `204` + `message:delete` broadcast to `room:<roomId>` | `403` not the author / DM blocked, `404` not found / not a member |

---

### PATCH `/api/messages/:id`

Edit the message body. Author only.

**Request body** (`EditMessageRequest`):
\`\`\`json
{ "body": "updated text" }
\`\`\`

**Body validation**:
- `body` — required string, trimmed length 1–3072 chars. Trim-to-empty is permitted ONLY when the message has ≥1 attached attachment (attachment-only messages may have body cleared).

**Success** `200` — the updated `Message` (with `editedAt` set to server `now()`, attachments and `replyTo` hydrated). Server also emits `message:edit` with the same `Message` payload to `room:<roomId>` (all sockets — the author's own mutating tab receives its own broadcast; reconciling an in-flight edit against the same payload is a no-op in the FE).

**Errors** (evaluated in this order — clients rely on the order for the correct UX string):
- `401` — missing / invalid / expired access token.
- `404` — message id does not exist OR the caller is not a current member of the message's room: `{ "error": "Message not found" }`.
- `403` — caller is not the message author: `{ "error": "Only the author can edit this message" }`.
- `403` — target room is a DM and a `user_bans` row exists in either direction: `{ "error": "Personal messaging is blocked" }`.
- `400` — validation error: `{ "error": "Validation failed", "details": [...] }`.
- `400` — trimmed body empty AND the message has no attachments: `{ "error": "Body must be between 1 and 3072 characters" }` (verbatim reuse of the `message:send` string — Round 10 does not introduce a second failure shape for this class).

---

### DELETE `/api/messages/:id`

Delete the message. Hard delete — row + attachment cascade + on-disk file unlink. Author only.

**Success** `204`. Server emits `message:delete` with `{ roomId, messageId }` to `room:<roomId>` (all sockets — the author's own mutating tab included, same rationale as `message:edit`).

**Errors**:
- `401` — missing / invalid / expired access token.
- `404` — message id does not exist OR the caller is not a current member of the message's room: `{ "error": "Message not found" }`.
- `403` — caller is not the message author: `{ "error": "Only the author can delete this message" }`.
- `403` — target room is a DM and a `user_bans` row exists in either direction: `{ "error": "Personal messaging is blocked" }`.

**Side effects**:
- Any `attachments` rows pointing at this message cascade via FK (schema already has `onDelete: 'cascade'`).
- On-disk files backing those attachments are `fs.promises.unlink`ed AFTER the DB transaction commits. Unlink failures are logged at WARN and do NOT fail the HTTP response (the DB state is already authoritative; an orphaned file is worse than a phantom 500).
- Any `messages` rows with `replyToId = :id` have their `replyToId` set to NULL via the FK constraint. Those messages stay visible; their `replyTo` field on future `GET /api/rooms/:id/messages` responses becomes `null`.
- Room unread counts (Round 12) naturally drop — the live-computed query against `messages` stops counting deleted rows with no cursor mutation needed.
```

**4d. Extend `## Socket Events` → `## Client → Server events` → `#### message:send`** payload block and validation bullet list:
- Payload example gains `"replyToId": "uuid"` alongside the existing `body` / `attachmentIds`.
- Validation bullets: add "`replyToId` is optional; when present, must be a UUID and must reference an existing message in the SAME `roomId`. Any mismatch fails the send with a new ack error string — see below."
- Failure ack enumeration: add `{ "ok": false, "error": "Invalid reply target" }` — fires for unknown id or id in a different room. (Analogous to `"Invalid cursor"` / `"Invalid attachment reference"` patterns. Single generic string — the FE cannot usefully distinguish sub-cases.)
- Success ack: `message.replyTo` follows the same omit-vs-null rule as the history endpoint (omitted if send did not include `replyToId`; present as `ReplyPreview` when send included one).

**4e. Extend `## Socket Events` → `## Server → Client events`** with two new event blocks inserted AFTER the existing `#### message:new` block (keep message-domain events contiguous). Use this text verbatim:

```
#### `message:edit`
- Payload: `Message` (fully hydrated — body updated, `editedAt` set, attachments + replyTo populated exactly as `GET /api/rooms/:id/messages` returns them).
- Fired to ALL sockets in `room:<roomId>` after `PATCH /api/messages/:id` succeeds (including the author's own mutating tab — the author's HTTP 200 response arrives first; the broadcast is a reconcile no-op for that tab and a live-update for other tabs / devices).
- FE applies by id: find the matching message in the rendered page and replace wholesale. If the message id is not present locally (e.g. it was on a page that has been evicted, future config improvement — currently pages are unbounded), the event is dropped.

#### `message:delete`
- Payload: `MessageDeletedPayload` — `{ roomId, messageId }`.
- Fired to ALL sockets in `room:<roomId>` after `DELETE /api/messages/:id` succeeds. Author's own tab receives its own broadcast — same rationale as `message:edit`.
- FE applies by id: remove the matching message from the rendered page. No `deletedAt` / tombstone payload — the row is simply gone; `MessageListComponent` filters it out of `messages()`.
- Unread badges (Round 12) do NOT update live on this event — the sidebar is refreshed on the next `GET /api/unread` or on normal accrual. A room you had 5 unread in, where one of those is now deleted, still shows 5 until the next refresh. Acceptable hackathon trade-off; flagged in Config improvements.
```

### 5. No changes to agent descriptions

The existing `.claude/agents/backend-developer.md` and `.claude/agents/frontend-developer.md` already reference `/shared/api-contract.md` and `/shared/types/` as the source of truth. Round 10 introduces no new libraries, frameworks, or conventions — just new endpoints and types under existing patterns. Skip editing agent descriptions unless something surprising comes up during implementation.

### 6. No changes to root / sub-project `CLAUDE.md`

Round 10 fits under existing conventions. Do not touch `CLAUDE.md` files unless you discover a genuinely new pattern.

### 7. No changes to `docker-compose.yml` / Dockerfiles / env files

Round 10 does not change the stack, ports, or deployment topology.

### 8. Decisions locked for downstream agents (record in summary under "Built" so BE/FE don't have to re-derive)

- **D1 — Delete path**: HARD delete. Row + attachment cascade + post-commit `fs.unlink`. Unread query unchanged (Round 12 summary blessed this path).
- **D2 — Reply FK policy**: `messages.reply_to_id` → `messages.id ON DELETE SET NULL`. Replies to a deleted target keep their body + attachments; `replyTo` becomes `null` on the wire.
- **D3 — `replyTo` omission rule**: OMIT when the message is not a reply; PRESENT AS `null` when it was a reply to a now-deleted message. Distinct from `undefined`-for-absence.
- **D4 — `editedAt` always present**: `null` for unedited messages, ISO string otherwise. Always on the wire (breaks pre-Round-10 callers that hard-asserted on key sets — accepted; Round 9's smoke harness did this; Round 10's BE smoke will update the assertion).
- **D5 — Route protocol**: PATCH + DELETE `/api/messages/:id` (HTTP), not socket. Edit/delete are author-gated mutations — HTTP path is more debuggable and matches Round 12's `POST /api/rooms/:id/read` precedent.
- **D6 — Broadcast scope**: `message:edit` and `message:delete` fan out to ALL sockets in `room:<roomId>`, INCLUDING the author's own sockets. Rationale: author's HTTP 200 updates tab A; broadcast keeps tabs B/C/other devices in sync. Reconciling a broadcast against already-mutated state is a no-op. Diverges from `message:new`'s `socket.to(...)` pattern because HTTP caller and broadcast fan-out aren't on the same socket.
- **D7 — DM ban gate uniform across edit+delete**: both PATCH and DELETE consult `hasBanBetween` for DMs; returns `"Personal messaging is blocked"`. Victim cannot delete their own messages once banned. Hackathon simplification — uniform freeze semantics.
- **D8 — Who can delete**: author only. Room-admin delete is explicitly Round 11 scope.
- **D9 — `replyToId` on send**: must reference a message in the SAME `roomId` on the socket payload. Cross-room or unknown id fails the send with `"Invalid reply target"` (new ack string).
- **D10 — Reply preview truncation**: server `.slice(0, 140)` on raw body. No ellipsis suffix. FE owns visual truncation.
- **D11 — Unread on delete**: no proactive refresh. Sidebar badge stays stale until next `/api/unread` poll or natural accrual. Flagged as Config improvement.
- **D12 — Attachment editing**: OUT OF SCOPE. PATCH edits `body` only. Cannot add/remove attachments on an existing message in Round 10.
- **D13 — Edit indicator persistence**: once `editedAt` is set, subsequent edits bump it to the latest edit time. No edit count / history kept.
- **D14 — No edit window / no cooldown**: any message the author owns can be edited at any time (subject to DM ban gate).

## Wrap-up
Write `plans/round-10/orchestrator_work_summary.md` with sections: **Built**, **Deviations**, **Deferred**, **Next round needs to know**, **Config improvements**. Include verification notes from `pnpm build` in both `backend/` and `frontend/` after the shared-type changes land — any compile break in either package is the signal that a decision above needs BE/FE follow-up coordination.
