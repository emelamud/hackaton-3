# Round 8 — Orchestrator Work Summary

## Built

**Shared types (`/shared/types/`)**

- `attachment.ts` — NEW file. Exports `AttachmentKind = 'image' | 'file'`, `Attachment`, `UploadAttachmentResponse`. `Attachment` mirrors the DB row with denormalised `kind` computed server-side; `messageId` is deliberately NOT on the interface (the back-pointer is implicit since attachments are read as `Message.attachments`).
- `message.ts` — extended. Added optional `attachments?: Attachment[]` to `Message` and optional `attachmentIds?: string[]` to `SendMessagePayload`. Both fields stay undefined / absent when empty so pre-Round-8 smoke assertions that do `expect(msg).toEqual({ id, roomId, userId, username, body, createdAt })` continue to round-trip.
- `index.ts` — added `export * from './attachment';` between `./message` and `./invitation` so `Attachment`, `AttachmentKind`, `UploadAttachmentResponse` resolve via the barrel.

**API contract (`/shared/api-contract.md`)**

- NEW `## Attachment Endpoints` section inserted between `## Direct Message Endpoints` and `## User Ban Endpoints` — preserves rough chronological grouping. Contains:
  - `### Rules` block — upload-first flow, 20 MB / 3 MB caps, MIME whitelist for the `image` slot, magic-byte sniff, pending→attached state machine, 1-hour orphan sweep, membership-gated downloads, DM-ban gate on upload (NOT on download — frozen-history read access preserved per §2.3.5), per-attachment `comment` (max 200 chars, nullable).
  - Summary table.
  - `### POST /api/attachments` — multipart fields (`file`, `roomId`, optional `comment`), exact error ordering (401 → 413 → missing file → body validation → 404 room → 403 not member → 403 DM blocked → 400 unsupported type → 400 magic-byte mismatch).
  - `### GET /api/attachments/:id` — response headers (`Content-Type`, `Content-Length`, `Content-Disposition` with RFC 5987 encoding, `X-Content-Type-Options: nosniff`, `Cache-Control: private, max-age=0, must-revalidate`), membership gate evaluated before file open, no `Range:` support, truncated response on on-disk miss.
- `#### message:send` extended (within `## Socket Events`):
  - Payload example now shows `attachmentIds`.
  - Validation rule changed: `body.trim().length >= 1 OR attachmentIds.length >= 1` (attachment-only messages are valid).
  - Success ack example expanded to show populated `message.attachments` (with inline `Attachment` shape for discoverability).
  - New failure ack string documented verbatim: `{ "ok": false, "error": "Invalid attachment reference" }` — single generic string covering wrong-uploader / wrong-room / already-attached / unknown-id / over-cap.
  - Atomic commit semantics spelled out — pending rows flip to attached inside the same transaction that inserts the `messages` row.
- `#### message:new` extended with a one-line Round 8 note: `message.attachments` is populated whenever the original `message:send` referenced attachment ids; absent otherwise (wire parity with pre-Round-8 assertions preserved).

**Docker compose (`docker-compose.yml`)**

- Added `volumes: [uploads_data:/app/uploads]` to the `backend` service.
- Added `uploads_data:` entry under the top-level `volumes:` key (parity with `postgres_data:`). Files survive `docker compose down` + `up`.

**Environment (`backend/.env.example`)**

- Verified `UPLOADS_DIR=/app/uploads` is already present (added in an earlier round's groundwork pass). No change needed.

**Design-decision rationale captured in the contract** (per the planning Q&A — see `plans/round-8/planning_qa.md`):

- D1 — upload-first via `POST /api/attachments` → `message:send { attachmentIds }` with atomic commit. Locked in the `## Attachment Endpoints` rules + `#### message:send` block.
- D2 — cap 5 attachments per send. Locked in `#### message:send` validation.
- D3 — per-attachment `comment` in scope (requirement §2.6.3); 200-char limit, nullable; captured at upload only (no comment-update endpoint). Locked in `POST /api/attachments` multipart fields + rules.
- D4 — `MessageSendAck.message.attachments?: Attachment[]` is the ack shape extension. Success example spells it out.
- D5 — locked in documentation via the absence of a lightbox/dialog endpoint (pure FE concern; contract doesn't need to enumerate it — the FE task file owns the decision).
- D6 — `uploads_data` named volume, `UPLOADS_DIR=/app/uploads`.
- D7 — authenticated fetch → Blob → object URL (FE concern; the contract only specifies Bearer auth + membership gate on the download endpoint).
- D8 — 1-hour orphan sweep. Documented in `## Attachment Endpoints → Rules`.

## Deviations

1. **Error-ordering table in `POST /api/attachments`** — the orchestrator task file spelled out 11 precedence rules (including separate 401 and success rows); I collapsed the documented list to 8 production error slots (401 handled by the global middleware, success implicit). No behavioural change; the listed order matches the task file's intent 1:1. BE implementer should evaluate in the documented order.

2. **Added `404 { "error": "Attachment not found" }` to `GET /api/attachments/:id`** with the explicit message string. The orchestrator task file only said `404 attachment not found`; locking the verbatim body string here so the FE can pattern-match (same convention as every other endpoint in the contract).

3. **Success ack example in `message:send` now inlines the full `Attachment` shape** rather than linking to the `Attachment` type. Redundancy with `/shared/types/attachment.ts`, but the other ack examples (e.g. `dm:created`, `RoomDetail`) inline their shapes the same way — consistency beats terseness here.

4. **No agent description changes.** The task file's optional housekeeping item (tighten `multer` note from "Round 4+" to "Round 8+") was skipped — the wording is still accurate ("file uploads land starting Round 8" is literally what "Round 4+" meant pre-Round-8) and editing it is pure cosmetic churn with no effect on agent behaviour.

## Deferred

- **Thumbnail pipeline** — no `thumbnailUrl?: string` field added to `Attachment`. Deferred to post-hackathon (D7 locked inline CSS-constrained rendering).
- **Signed download URLs** — contract does not support them. Signing infra is extra surface for zero user-visible gain at hackathon scale.
- **`Range:` header support on downloads** — single-shot 200 only; documented as out of scope.
- **EXIF stripping / virus scanning / image rotation** — not in contract, not in scope.
- **Per-attachment comment editing** — contract has no update endpoint for `Attachment.comment`. Would need a `PATCH /api/attachments/:id` in a future round (Round 10 when message editing lands).
- **`message:send` migration into `ClientToServerEvents`** — still deferred from Round 7. Round 8 doesn't touch this; `message:send` continues to use its ad-hoc ack-callback signature in `backend/src/socket/io.ts`.
- **CDN / cache layer on downloads** — `Cache-Control: private, max-age=0, must-revalidate` explicitly prevents intermediate caching. Safe because per-user access rules are embedded in the response. A future CDN pass would need scoped signed URLs.
- **`PATCH /api/rooms/:id/attachments` bulk reordering** — not a real use case; nothing attached to it.

## Next round needs to know

**For Round 9 (pagination)** — the cursor endpoint `GET /rooms/:id/messages?before=&limit=` must populate `attachments` on each returned `Message`. Avoid N+1 — batch-fetch `SELECT * FROM attachments WHERE message_id = ANY($messageIds) AND status='attached'` then group in memory before serialising. The paginated response shape is otherwise unchanged.

**For Round 10 (message edit / delete)** — two concerns:
- The `attachments.message_id → messages.id ON DELETE CASCADE` FK takes the DB row on message delete, but **the on-disk files are NOT unlinked by the cascade**. Round 10's delete handler MUST read `storage_path`s via `DELETE … RETURNING storage_path` (or a prior `SELECT` within the same transaction) and unlink them via `fs.promises.unlink` in an `afterCommit` hook.
- Message editing that would add or remove attachments is out of Round 10's current scope (master-plan bullet only mentions edit/delete/reply semantics for the message body). If the planner widens that, they inherit the same on-disk unlink concern.

**For Round 11 (room deletion)** — same pattern scoped by `room_id`: the `attachments.room_id → rooms.id ON DELETE CASCADE` takes the row, but the room-delete handler must unlink every file under the room before (or via RETURNING from) the cascade. Document this explicitly in Round 11's orchestrator task file.

**For Round 12 (unread / public catalog)** — no coupling. Unread counts don't read attachments. The public catalog endpoint (if it returns message previews) may want to skip / placeholder attachments for lighter payloads, but that's a polish question for the Round 12 planner.

**Contract-level**
- `Message.attachments` and `SendMessagePayload.attachmentIds` are now live. Any future round that adds new message-level metadata should extend `Message` via optional fields (wire parity with prior-round smoke harnesses).
- `"Invalid attachment reference"` is now a reserved ack string on `message:send`. Don't overload it with new sub-cases; if a future round needs to distinguish (e.g. "attachment expired" vs "attachment wrong room"), add a new verbatim string.
- The 8-MIME-whitelist choice locks the "inline image" bucket. If the product ever adds SVG support, the MIME whitelist expands AND we pick up the full XML sanitization concern (SVG can embed scripts). Out of scope today; flag for Round 13+ if ever.

## Config improvements

- **Make `MAX_ATTACHMENTS_PER_MESSAGE` an env var** (currently the hard-coded `5` lives in the BE validator). Low-effort change; future UX may want 10 or 3 depending on device density research.
- **Make `ATTACHMENT_ORPHAN_TTL_MS` configurable** (currently hard-coded 1 hour). Test harnesses need a shorter TTL to exercise the sweep path without waiting — right now the smoke harness has to monkey-patch.
- **RFC 5987 encoding helper as a shared utility** — the BE route file needs it for `Content-Disposition`; if a future round (e.g. export / reports) needs the same encoding, extract it into `backend/src/utils/http.ts`.
- **Consider adding an `Attachment.url` denormalisation** so the FE doesn't have to synthesize `${baseUrl}/attachments/${id}`. Current approach is fine (URLs are stable; base URL is already in `environment.apiUrl`); would only matter if we ever add signed URLs or multiple storage backends.
- **Drop forward-references in API contract** — housekeeping grep confirmed no stale "Round 8 will …" forward references remain (the Round-8 content now appears as historical in place). The Round 9+ forward references (pagination, moderation, public catalog) are still accurate.
- **`message:send` into `ClientToServerEvents`** — still the unresolved type-hygiene item from Round 7. Round 8 introduces a second optional-field extension (`attachmentIds`) that widens the surface the migration would have to carry. Decide before Round 11 whether to bite the bullet.
- **Type-hygiene: extract `Attachment.kind` from `Attachment.mimeType` only on the BE and never the FE** — documented in the FE task file, but worth flagging contract-side: if the FE ever recomputes `kind` from `mimeType` and the whitelist diverges between BE and FE, you get divergent UX. A FE-only lint rule banning direct MIME-based kind inference would be nice.
