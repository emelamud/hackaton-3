# Round 10 — Orchestrator Work Summary

## Built

**Shared types (`/shared/types/`)**

- `message.ts` — **edited**. Three new exports plus two existing-interface extensions:
  - `ReplyPreview { id, userId, username, bodyPreview, createdAt }` — denormalised reply preview attached to replying messages. `bodyPreview` is a raw server-side `.slice(0, 140)` of the target body; no ellipsis suffix on the wire.
  - `EditMessageRequest { body }` — PATCH `/api/messages/:id` body shape. Trimmed length 1–3072 chars OR empty-after-trim when the message has ≥1 attached attachment.
  - `MessageDeletedPayload { roomId, messageId }` — `message:delete` socket-event payload.
  - `Message` extended with `editedAt: string | null` (ALWAYS present — `null` for unedited, ISO string for edited) and optional `replyTo?: ReplyPreview | null` (OMITTED when not a reply; PRESENT AS `null` when the target was deleted via `ON DELETE SET NULL`). The distinction between "omitted" and "null" preserves a "was a reply" signal for a later polish round.
  - `SendMessagePayload` extended with optional `replyToId?: string` — when present, must reference a message in the same `roomId`.
- `socket.ts` — **edited**. Added `'message:edit': Message` and `'message:delete': MessageDeletedPayload` to `ServerToClientEvents`. Import list extended to pull `MessageDeletedPayload` from `./message`. `ClientToServerEvents` untouched — edit/delete stay HTTP-only per D5 (same rationale as `POST /api/rooms/:id/read` in Round 12).
- `index.ts` — **unchanged**. The existing `export * from './message'` re-export already propagates the new `ReplyPreview` / `EditMessageRequest` / `MessageDeletedPayload` exports.

**API contract (`/shared/api-contract.md`)**

- `### GET /api/rooms/:id/messages` endpoint block — **edited**:
  - Example message body in the `Success 200` JSON extended with `"editedAt": null` and a full `replyTo` sub-object (showing `id/userId/username/bodyPreview/createdAt`).
  - Prose paragraph under the existing attachments paragraph added: documents the always-present `editedAt`, the omit-vs-null semantics for `replyTo`, the batch hydration pattern (one extra query per page, `WHERE id = ANY($replyTargetIds)` — zero N+1), and the `.slice(0, 140)` no-ellipsis truncation.
  - No new query param. No new error strings. Summary-table row unchanged (endpoint path / response type / errors all stable).
- `## Message Endpoints` — **new top-level section**, inserted AFTER `## Public Room Catalog` and BEFORE `## Socket Events`. Preserves the "HTTP endpoints above, sockets below" split established in Round 12. Contents:
  - **Rules** block: author-only (room-admin delete explicitly Round 11 scope); hard delete; `reply_to_id ON DELETE SET NULL` rationale; DM ban gate uniform across PATCH+DELETE; membership gate returns `404 "Message not found"` (not 403 — avoids leaking cross-room existence); body validation mirrors `message:send`; edit does NOT touch attachments in Round 10.
  - **Summary table** with both endpoints.
  - **PATCH** block with full request/response shape, a 6-step error priority list (401 → 404 → 403-author → 403-ban → 400-validation → 400-empty-body), and the `message:edit` broadcast note.
  - **DELETE** block with full success/error shape, the 4-step error priority list, and a **Side effects** sub-list calling out the three follow-on consequences: attachment cascade + on-disk unlink in an afterCommit hook, replies' `reply_to_id SET NULL`, and the unread-decrement-on-next-refresh behaviour.
- `#### message:send` socket event block — **edited**:
  - Payload example extended with `"replyToId": "uuid"`.
  - Validation bullet list gained a Round-10 bullet covering `replyToId` UUID+same-room check.
  - Success ack example extended with `"editedAt": null`, full `replyTo` sub-object; prose clarified about the omit-vs-always-present rules for `attachments` / `editedAt` / `replyTo`.
  - Failure ack enumeration gained `'Invalid reply target'` (Round 10) — fires for unknown id OR id in a different room, single generic string (mirrors `'Invalid cursor'` / `'Invalid attachment reference'` patterns). The `'Invalid payload'` string's scope was widened to cover malformed `replyToId` (caught by the zod layer pre-service).
  - New Round-10 paragraph documenting the resolve-before-tx behaviour for `replyToId`.
- `#### message:new` socket event block — **edited**:
  - Payload example gained `"editedAt": null`.
  - New Round-10 bullet documents that `editedAt` is always present and `replyTo` follows the same omit-when-absent rule as `attachments`.
- `#### message:edit` — **new event block**, inserted immediately after `message:new` (keeps message-domain server-to-client events contiguous). Documents: full `Message` payload, ALL sockets in `room:<roomId>` fan-out INCLUDING author's tab (divergent from `message:new`'s sender-exclusion pattern — no HTTP-caller socket handle, blanket fan-out is simpler), FE id-based replacement semantics.
- `#### message:delete` — **new event block**, immediately after `message:edit`. Documents: `MessageDeletedPayload` payload, same blanket fan-out, id-based removal semantics, explicit note that unread badges do NOT live-update (hackathon trade-off flagged in Config improvements).

**No other shared surface touched.** Agent descriptions (`.claude/agents/backend-developer.md`, `.claude/agents/frontend-developer.md`), CLAUDE.md files (root, `backend/`, `frontend/`), `master-plan.md`, `docker-compose.yml`, env files, Dockerfiles — all untouched. Round 10 is purely a contract + new-code change; no new stack concerns, no deployment changes, no agent-config changes.

**Verification**
- `pnpm build` in `frontend/` — **clean**. Angular production build succeeds in 10.16 s; the new shared re-exports + the `editedAt: string | null` required-field addition break zero FE callsites (no FE code was constructing `Message` literals — it only receives them from the BE, so the field just gets set by the server and read in templates).
- `pnpm build` in `backend/` — **FAILS with 2 expected errors**, both in `backend/src/services/messages.service.ts`:
  - Line 98: `persistMessage` returns a `Message` literal missing `editedAt`.
  - Line 218: `listMessageHistory`'s shape step returns `Message` rows missing `editedAt`.
  These are the exact callsites that the backend-developer will rework in Phase 2 — Task 2 extends `persistMessage` with `replyToId` handling and `editedAt: null` on fresh rows; Task 4 extends `listMessageHistory` to hydrate `editedAt` on every row and batch-hydrate `replyTo` previews. **This is expected Phase-1 fallout and is why the backend is dispatched immediately after this summary.**

## Deviations

1. **`bodyPreview` truncation — no ellipsis suffix server-side**. Task file deviation locked: `.slice(0, 140)` on raw body. Rationale: keeps the wire shape auditable (any downstream consumer can compare `replyTo.bodyPreview` against the target's body without stripping "…"). FE owns visual truncation — same pattern used elsewhere in the app for message-body preview chips.

2. **`replyTo` omit-vs-null distinction locked as wire semantics, not just a type artefact**. `undefined` means "this message is not a reply"; `null` means "this message WAS a reply to a now-deleted target". FE is free to render both identically in Round 10 (minimal behaviour) but the signal is preserved on the wire for later polish rounds — e.g. rendering "Replying to a deleted message" faintly.

3. **`editedAt` always present on the wire, including for `message:new`**. Pre-Round-10 callers asserting exact-key-set equality (e.g. the Round 9 smoke harness) will see one extra key. This is an intentional minor BC-break — tightening the type shape now avoids "is this field absent because it's unedited, or absent because an older server version?" ambiguity. Flagged to the BE so the new smoke harness updates its assertions.

4. **DM ban gate uniform across PATCH+DELETE (no "delete exception")**. Requirements §2.3.5 say "existing personal message history remains visible but becomes read-only/frozen" — "read-only" covers both edit AND delete in our reading. Alternative (allow self-delete even when banned) was considered but rejected: uniform freeze is simpler, avoids the "banned user deletes their side of the evidence" concern, and matches the composer-freeze UX consistency. Noted as a hackathon simplification.

5. **Broadcast-to-all scope (including author's own tab) for `message:edit` / `message:delete`**. Diverges from `message:new`'s `socket.to('room:<roomId>').emit(...)` sender-exclusion pattern. Rationale: the HTTP mutation path has no socket handle, so per-caller exclusion would require the client to pass its socket id on the HTTP request — complexity for zero gain. Embracing the redundancy: the author's initiating tab's HTTP response already mutates local state; the broadcast reconciles (no-op on the same tab; live update on other tabs / devices).

6. **New top-level `## Message Endpoints` section (not folded into `## Rooms Endpoints`)**. Alternative: put PATCH + DELETE `/api/messages/:id` under Rooms since messages belong to rooms. Chose separate section because the routes are keyed by message id, not room id — the natural grouping by URL path keeps them together. Also mirrors the Round-8 `## Attachment Endpoints` decision (attachments belong to messages, but they're their own top-level section).

7. **`replyToId` resolution happens BEFORE the insert transaction, not inside it**. Task file called for same-room validation but did not lock tx placement. Resolving outside the tx keeps the tx small (single INSERT + attachment commit) and gives a clearer error path — an `AppError('Invalid reply target', 400)` thrown pre-tx is easier to map to the ack envelope than one thrown inside. If the target is deleted between resolution and insert, the resulting `reply_to_id` would point at a non-existent row — the FK constraint would catch it, but this is a theoretical race that requires sub-millisecond timing at scale. Acceptable.

## Deferred

- **Soft-delete / tombstone rendering of deleted messages** — hard delete is the locked path per D1; tombstones would require (a) a `deletedAt` column, (b) `WHERE deleted_at IS NULL` on every read path including Round 12's unread query, (c) FE "Message deleted" UI. Out of scope.
- **Edit window / cooldown** — no time limit on editing your own messages. Requirements §2.5.4 don't impose one; pulling one in would require a UI affordance ("Edit expired") for zero user-facing gain at hackathon scale.
- **Attachment editing on PATCH** — Round 10 edits body only. Adding attachments to an existing message or removing them from one is out of scope (would require a separate `PATCH /api/messages/:id/attachments` flow with upload-first + commit semantics similar to `message:send`).
- **Room-admin delete** — explicitly Round 11 scope. Round 10's PATCH/DELETE are strictly `row.user_id === caller` gated.
- **Jump-to-reply-target when the target is not loaded** — FE will `scrollIntoView` when the target is in `messages()`; when it's not (user hasn't paginated back far enough), clicking the reply quote does nothing. Loading-older-pages-until-the-target-is-found is a nice-to-have; flagged under Config improvements.
- **Live unread-decrement on `message:delete`** — sidebar badge stays stale until next `GET /api/unread` or natural accrual. Flagged under Config improvements — fixing it properly requires either pushing a fresh unread snapshot on every delete or adding the delete to `UnreadService`'s decrement path, neither of which is load-bearing for the hackathon.
- **"(edited)" timestamp on hover** — FE renders a static "(edited)" indicator. Surfacing the exact `editedAt` timestamp via a tooltip is a UX polish that can land in a later round.
- **Per-message edit history** — once `editedAt` is set, it's bumped on every subsequent edit; prior versions are lost. Matches Slack's behaviour (no "see edit history" affordance). Requirements don't ask for it.

## Next round needs to know

**For Round 11 (room moderation / room delete) if/when it ships**
- `messages.reply_to_id ON DELETE SET NULL` — when a moderation action hard-deletes a whole room, the `rooms` cascade drops all `messages` rows; any reply-targets in other rooms are not affected (they can't exist — Round 10's `message:send` rejects cross-room `replyToId`). So room delete is transparent to the reply graph.
- The on-disk attachment unlink pattern landed in Round 10 via Round-10's `deleteMessage` service. Round 11's room-delete path should reuse the same "SELECT storage_path BEFORE delete → DELETE → fs.unlink afterCommit" sequence, scoped by `room_id` instead of `message_id`. Consider lifting the unlink helper into `attachments.service.ts` so both paths share it.
- Room-admin delete of other users' messages: extend `deleteMessage` to accept an `override: 'admin'` branch that checks `role IN ('owner', 'admin')` instead of the author gate. The existing error strings need a second variant (`"Only the author or a room admin can delete this message"`) — lock in Round 11's orchestrator.

**For the next polish round (whenever it runs)**
- `UnreadService` could consume `message:delete` to decrement its counter when the deleted message was unread at the time. Today it ignores the event. Low-effort addition: store the last-seen `message:new` count per room in the service, decrement on `message:delete` if the deleted id is in the unread range.
- `MessageListComponent` could hydrate `replyTo` for messages where the target is not currently loaded by firing a bounded fetch (`GET /api/messages/:id`-style — not a Round-10 endpoint, would need adding) when the user clicks the quote block. Scoped to "click to jump" UX — not a background preload.
- Reply-preview truncation could move to a server-side `truncate_on_grapheme_boundary` helper if the raw `.slice(0, 140)` ever lands in the middle of a multi-byte codepoint or a grapheme cluster and a user reports rendering glitches. Not observed at hackathon scale.

**Contract locks established in Round 10**
- `Message.editedAt: string | null` — ALWAYS present on every wire shape that carries a `Message` (`message:send` ack, `message:new`, `message:edit`, `GET /api/rooms/:id/messages`). Don't make it optional in a future round — the null carries meaning.
- `Message.replyTo` — omit when the message is not a reply; `null` when the target was deleted. Distinct from each other; FE may render them identically but the wire must preserve the signal.
- `ReplyPreview.bodyPreview` — raw server-side `.slice(0, 140)`, no ellipsis. Future rounds should not add ellipsis server-side without coordinating with the FE (it may already render its own).
- `'Invalid reply target'` is now a reserved ack error string on `message:send`. Fires for unknown id OR cross-room id. Don't overload with new meanings; new cursor-bearing references should either reuse verbatim or pick a distinct string.
- `message:edit` / `message:delete` fan out to ALL sockets in `room:<roomId>` (no sender exclusion). Don't switch to `socket.to(...)` without also adding a socket-id field to the PATCH/DELETE HTTP request.
- `reply_to_id ON DELETE SET NULL` — a future round that introduces soft-delete must decide whether to preserve or invalidate the reply link; today the link survives a target hard-delete only in the form "was a reply, target gone".

## Config improvements

- **Live unread-decrement on `message:delete`** — wire `UnreadService` to the event and decrement the counter when the deleted message id was in the unread range. Low-effort, noticeable UX win.
- **Jump-to-reply-target autoload** — when the user clicks a reply quote whose target is not in `messages()`, paginate backward in a loop until the target appears (bounded at e.g. 5 pages to prevent runaways). Needs a loading indicator on the quote block.
- **"(edited) <timestamp>" tooltip** — show `editedAt` as a relative time on hover via `matTooltip`.
- **Attachment editing** — `PATCH /api/messages/:id/attachments` for add/remove. Scope: probably a mini-round of its own, not load-bearing for the core product.
- **Reply-preview truncation — grapheme-aware** — replace `body.slice(0, 140)` with `[...body].slice(0, 140).join('')` (counts codepoints, not UTF-16 units). Prevents surrogate-pair splits on emoji-heavy messages. Zero runtime cost at hackathon scale.
- **Hoist the on-disk unlink helper** — `fs.promises.unlink` sequence in `deleteMessage` (task 8) should live in `attachments.service.ts` as `unlinkAttachmentsByStoragePaths(paths: string[]): Promise<void>`. Round 11's room-delete path will want to reuse it.
- **`Server-Timing: edit-tx;dur=<ms>` on `PATCH /api/messages/:id`** — the UPDATE is fast but the attachment-hydration + reply-preview-hydration on the response shape runs two extra queries. Surfacing the breakdown helps spot-check whether either becomes a hot path.
- **Room-wide broadcast on delete is noisy at scale** — at 1000-member rooms (requirement §3.1) a single delete fans out to 1000 sockets. Not a concern at hackathon, but if the app ever grows this is the first event to consider coalescing or gating behind a rate limit.
