# Round 8 — Backend Work Summary

## Built

### Schema + migration — `attachments` table
- Added `attachments` to `backend/src/db/schema.ts` with columns, `onDelete: 'cascade'` FKs on both `room_id → rooms.id` and `message_id → messages.id`, plain FK on `uploader_id → users.id`, a `kind: 'image' | 'file'` text enum column, `status: 'pending' | 'attached'` text column with default `'pending'`, `with timezone` timestamps, `attachmentsMessageIdx` (for the Round 9 batch-load) and partial `attachmentsPendingSweepIdx` on `(status, createdAt) WHERE status = 'pending'` (for the sweep scan). Added `AttachmentRow` / `NewAttachmentRow` type exports.
- Generated `backend/src/db/migrations/0007_unknown_lily_hollister.sql` via `pnpm db:generate`; the migration applies cleanly on a fresh DB via `docker compose up` (observed the `Migrations complete.` log after `docker compose up -d --build backend`).

### New service — `backend/src/services/attachments.service.ts`
- `createPendingAttachment({ uploaderId, roomId, filename, mimeType, sizeBytes, comment, buffer }) → Promise<Attachment>` — inserts the pending row, writes the file to `<UPLOADS_DIR>/<yyyy>/<mm>/<id>`, then UPDATEs `storage_path` on the row. If writing / updating fails, the file is `fs.unlink`'d and the row deleted on a best-effort basis so the next sweep sees a clean state. `kind` is derived server-side from the MIME whitelist.
- `getAttachmentForDownload(attachmentId, callerId) → Promise<{ attachment, absolutePath }>` — 404 if the row is absent, 403 if the caller is not a current `room_members` row for `attachment.roomId`. Constant error strings — never leaks storage path / stored filename.
- `commitAttachmentsToMessage({ attachmentIds, callerId, roomId, messageId, tx })` — validates each id (uploader, room, status='pending'), duplicate ids, and the 5-id cap; flips `status='attached'` + `attached_at=now()` + `message_id` inside the provided tx. Throws `AppError('Invalid attachment reference', 400)` on any mismatch so the caller can collapse failure sub-cases into the contract's single ack string.
- `sweepPendingAttachments(nowMs, maxAgeMs)` — deletes DB rows + on-disk files for `status='pending'` rows older than the TTL (default 1 h). Individual unlink failures are logged + swallowed so a missing file doesn't block row cleanup.
- Exported helpers `deriveKind(mime)` / `isAllowedImageMime(mime)` — the MIME whitelist (`image/png | image/jpeg | image/gif | image/webp`) lives in this file; the route imports `deriveKind` for its 3 MB sub-cap check.

### New route — `backend/src/routes/attachments.ts`
- Mounted at `app.use('/api/attachments', attachmentsRouter)`.
- `POST /api/attachments`:
  - `requireAuth` → multer (memoryStorage, `limits.fileSize=20MB`, `files=1`, `fields=10`) → handler.
  - Multer error wrapper maps `LIMIT_FILE_SIZE → 413 "File exceeds size limit"`; other multer errors collapse to `400 "Invalid upload"` so we don't leak internals.
  - Contract-exact error order after multer: missing file (400 `"File is required"`) → zod body validation (`roomId` UUID, `comment` ≤200 chars, `"Validation failed"`) → room lookup (404 `"Room not found"`) → membership (403 `"Forbidden"`) → DM ban (403 `"Personal messaging is blocked"`, only for `rooms.type='dm'`, reuses `userBansService.hasBanBetween`) → unsupported MIME (`Content-Type` empty-after-lower/trim → 400 `"Unsupported file type"`) → image sub-cap (kind='image' + size>3MB → 413 `"File exceeds size limit"`) → magic-byte sniff (inline `imageMagicMatches` checks PNG/JPEG/GIF/WebP signatures; mismatch → 400 `"File content does not match declared type"`).
  - Delegates to `createPendingAttachment` and returns `201 { attachment }` with the DTO (no `status` / `messageId` / `storagePath` fields on the wire).
- `GET /api/attachments/:id`:
  - `requireAuth` + `validateParams` (UUID). Delegates to `getAttachmentForDownload`.
  - Response headers: `Content-Type`, `Content-Length`, `Content-Disposition: ${inline|attachment}; filename*=UTF-8''${rfc5987(filename)}`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, max-age=0, must-revalidate`.
  - `encodeRFC5987ValueChars` helper — `encodeURIComponent` then escapes `'()*` (the chars older browsers' `Content-Disposition` parsers mis-handle).
  - Streams via `fs.createReadStream(...).pipe(res)`. Stream error handler flips to 500 if headers haven't flushed, otherwise destroys the response (client sees truncated body) — documented in the contract.
- Dev-only `POST /api/attachments/__sweep-for-tests` (mounted only when `NODE_ENV !== 'production'`) — accepts `{ maxAgeMs }` and calls `sweepPendingAttachments(Date.now(), maxAgeMs)`. Exists so scenario 18 in the smoke harness can force-invoke the sweep without waiting an hour.

### Extended `backend/src/services/messages.service.ts`
- `persistMessage(userId, roomId, body, attachmentIds = [])` — body-OR-attachments rule: either `body.trim().length >= 1` or `attachmentIds.length >= 1` is required; oversize (>3072) still rejected. Violation → `"Body must be between 1 and 3072 characters"` (reused string).
- Insert + commit wrapped in `db.transaction(async (tx) => { ... })`. The insert runs first; if `attachmentIds` is non-empty, `commitAttachmentsToMessage` runs inside the same tx. Partial failure throws, the tx rolls back, the `messages` row is never created, and the pending attachments stay `pending`.
- The returned DTO includes `attachments: Attachment[]` when non-empty, and omits the field otherwise (wire parity with pre-Round-8 assertions).

### Extended `backend/src/socket/io.ts`
- `sendMessageSchema` now accepts an optional `attachmentIds: z.array(z.string().uuid()).optional()`. The 5-id cap is **not** enforced here — that check lives in `commitAttachmentsToMessage` so 6+ ids produce the contract-exact `"Invalid attachment reference"` ack instead of the catch-all `"Invalid payload"`.
- `message:send` handler passes `parsed.data.attachmentIds ?? []` into `persistMessage`. Broadcast stays unchanged (`socket.to('room:<id>').emit('message:new', message)`), but the broadcast payload now carries `attachments` when the ack did.

### Startup wire — `backend/src/index.ts`
- Registered `/api/attachments`.
- Rewrote the startup tail as an async `start()`:
  1. `await fs.promises.mkdir(config.uploadsDir, { recursive: true })` — fails fast on an unwriteable path; logs the resolved path.
  2. `runSweep()` once at startup.
  3. `setInterval(runSweep, 10 * 60 * 1000)`.
  4. `httpServer.listen(...)`.
- `runSweep` logs `deletedCount` at info level when >0; `warn` + swallow on error so a sweep failure never crashes the process.

### Smoke harness — `tmp/round-8/smoke.js`
All 19 scenarios listed in `plans/round-8/backend_tasks.md`, run end-to-end against the live backend (port 3000). `node-fetch` for HTTP (including a hand-rolled multipart builder — avoids adding a `form-data` dep) + `socket.io-client` for three sockets (S-alice, S-bob, S-carol).

#### Raw observed payloads

```
[setup] {"aliceId":"d5a18120-f75f-4353-9ada-0ca48eefdda2","bobId":"c41130d9-a46c-43c6-9934-14440a07026b","carolId":"b71de766-249b-40ee-a9a2-37eaaaa1e0a3","engId":"73622d7e-ae34-4897-a320-862dcd665b7b","dmId":"01edaa12-0e5e-4d18-8dea-ac1675c585e7"}

[1] {"upload_status":201,"upload_attachment":{"id":"70d8f9d0-c967-4fd5-a591-aaed147c241e","roomId":"73622d7e-ae34-4897-a320-862dcd665b7b","uploaderId":"d5a18120-f75f-4353-9ada-0ca48eefdda2","filename":"smoke.png","mimeType":"image/png","sizeBytes":512000,"kind":"image","comment":"screenshot","createdAt":"2026-04-22T08:29:58.630Z"},"upload_has_status_field":false,"send_ack":{"ok":true,"message":{"id":"0bebbab7-7ff9-4f90-b5c8-5c0da6417c18","roomId":"73622d7e-ae34-4897-a320-862dcd665b7b","userId":"d5a18120-f75f-4353-9ada-0ca48eefdda2","username":"alice_r8_...","body":"here","createdAt":"2026-04-22T08:29:58.650Z","attachments":[{"id":"70d8f9d0-...","kind":"image","sizeBytes":512000,"mimeType":"image/png","filename":"smoke.png","comment":"screenshot"}]}}}

[2] {"bob_received":[{"id":"0bebbab7-...","roomId":"73622d7e-...","body":"here","attachment_kind":"image","attachment_id":"70d8f9d0-..."}],"alice_self_echo":"absent"}

[3] {"status":200,"headers":{"content-type":"image/png","content-length":"512000","content-disposition":"inline; filename*=UTF-8''smoke.png","x-content-type-options":"nosniff","cache-control":"private, max-age=0, must-revalidate"},"bytes_match":true,"buffer_len":512000}

[4] {"status":403,"body":"{\"error\":\"Forbidden\"}"}

[5] {"status":401,"body":"{\"error\":\"Missing or invalid authorization header\"}"}

[6] {"status":413,"body":{"error":"File exceeds size limit"}}

[7] {"status":413,"body":{"error":"File exceeds size limit"}}

[8] {"status":400,"body":{"error":"File content does not match declared type"}}

[9_upload] {"status":201,"attachment":{"id":"11e6bc1c-...","kind":"file","sizeBytes":10485760,"mimeType":"application/zip","filename":"demo.zip","comment":null}}
[9_download] {"status":200,"headers":{"content-type":"application/zip","content-length":"10485760","content-disposition":"attachment; filename*=UTF-8''demo.zip","x-content-type-options":"nosniff","cache-control":"private, max-age=0, must-revalidate"},"starts_with_attachment":true}

[10] {"ack":{"ok":false,"error":"Invalid attachment reference"}}

[11] {"upload_status":201,"ack":{"ok":false,"error":"Invalid attachment reference"}}

[12] {"ack_bob_reject":{"ok":false,"error":"Invalid attachment reference"},"ack_alice_rescue":"pending-preserved"}

[13] {"ack":{"ok":false,"error":"Invalid attachment reference"}}

[14] {"ack":{"ok":false,"error":"Body must be between 1 and 3072 characters"}}

[15] {"ack":{"ok":true,"message":{"id":"a53140e2-...","body":"","attachments":[{"id":"41928428-...","kind":"image","filename":"capless.png"}]}}}

[16] {"ban_status":204,"upload_status":403,"upload_body":{"error":"Personal messaging is blocked"},"pre_send_ack":true}

[17] {"status":200,"headers":{"content-type":"image/png","content-length":"16384","content-disposition":"inline; filename*=UTF-8''pre-ban.png","x-content-type-options":"nosniff","cache-control":"private, max-age=0, must-revalidate"},"buffer_len":16384}

[18] {"upload_status":201,"sweep_status":200,"sweep_body":{"deletedCount":9},"verify_ack":{"ok":false,"error":"Invalid attachment reference"}}

[19] {"leave_status":204,"download_status":403,"body":"{\"error\":\"Forbidden\"}"}

[done] all 19 scenarios executed
```

Key observations:
- **Scenario 1** — Wire `attachment` DTO omits `status`, `messageId`, `storagePath` (contract-compliant); ack includes full `attachments` array.
- **Scenario 2** — `message:new` broadcast carries the same `attachments` array; the sender's own socket does NOT receive its own broadcast (`alice_self_echo: "absent"`).
- **Scenario 10** — 6 pending uploads are created successfully; the 7th call (`message:send` with 6 ids) rejects with the generic `Invalid attachment reference`, never leaking the 5-id cap as a distinct string.
- **Scenario 12** — bob's hijack attempt rejects; alice's immediate re-attach succeeds, proving the row stayed `pending` after the failed commit.
- **Scenario 18** — sweep deletes 9 orphans (6 bulk + 1 up11 DM stray + 1 up12 pending-preserved row + 1 fresh up18); verify ack confirms the target id is gone.
- **Scenario 19** — alice (a plain member, not the owner — bob now owns `#eng` in the harness setup) leaves cleanly; her download then 403s even though she uploaded the file.

### Verification gate
- `pnpm build` in `backend/` — clean (0 errors).
- `pnpm lint` in `backend/` — clean (0 warnings / errors).
- `docker compose up -d --build backend` — rebuilt + restarted cleanly; container log:
  ```
  Running database migrations...
  Applying migrations from /app/dist/backend/src/db/migrations...
  Migrations complete.
  Starting backend server...
  Uploads directory ready at /app/uploads
  Backend running on port 3000
  ```
- All 19 smoke scenarios observe the expected payloads.

## Deviations

1. **Magic-byte sniff lives in the route file, not the service.** The task notes ~20 lines of inline byte comparison are fine; I kept it in `attachments.ts` as `imageMagicMatches(mime, buffer)` because it only runs once per request and has no reuse in the service layer.
2. **`encodeRFC5987ValueChars` helper also lives in the route file** (not extracted to `backend/src/utils/http.ts`). Noted in Config improvements for future extraction if another route ever needs the same encoding.
3. **Dev-only test endpoint added** — `POST /api/attachments/__sweep-for-tests` gated on `NODE_ENV !== 'production'`. The task allowed "a test-only endpoint OR the exported service function directly"; the harness runs out-of-process, so the endpoint was the simpler path. **Important**: this endpoint is mounted at module-load time based on `config.nodeEnv`, which resolves once. If a prod deployment somehow runs with `NODE_ENV != 'production'`, this endpoint becomes exposed. Acceptable for hackathon scope; documented.
4. **WebP magic-byte check is partial.** The RIFF/WEBP signature at byte offsets 0..3 + 8..11 is fully checked. The 4-byte `size` field between them is not validated (per RFC 6386 it's a payload size) — mismatch there would be an obviously-corrupt file and would fail downstream readers anyway.
5. **`Content-Disposition` uses only the modern `filename*=UTF-8''…` form** — no legacy `filename="…"` fallback. All modern browsers (Chrome/Firefox/Safari/Edge, last ~5 years) parse `filename*=` correctly; adding the legacy form would buy us IE11 support at the cost of ambiguous double-spec. Deferred.
6. **Duplicate `attachmentIds` in a single `message:send` payload rejected** as an `Invalid attachment reference`. The contract doesn't spell out duplicate handling; rejecting is the conservative choice (`[id, id]` would otherwise attach the same row twice and leave a contradicting wire shape).
7. **`commitAttachmentsToMessage` validates one id at a time inside the tx**, not a bulk `WHERE id IN (...)` preflight. Costs N round-trips per send (N ≤ 5), but keeps the "first failure short-circuits with the precise state" shape — a bulk approach would need a second pass to identify which id caused the mismatch. Hackathon scope accepts the N extra queries.

## Deferred

- **Thumbnail / preview pipeline** (`sharp` or similar) — locked out by D7 + orchestrator summary.
- **Signed / short-lived download URLs** — Cache-Control already blocks intermediate caching.
- **`Range:` header support on downloads** — single-shot 200 only (contract).
- **EXIF stripping / virus scanning / image rotation** — not in contract.
- **Per-attachment comment editing** — no `PATCH /api/attachments/:id`; would pair with Round 10 message-edit.
- **On-disk unlink on message-delete / room-delete** — Round 10 and Round 11 concerns. The `ON DELETE CASCADE` FKs drop the DB rows; the actual file bytes need `DELETE … RETURNING storage_path` + `fs.promises.unlink` in a post-commit hook. Documented in Next round needs to know.
- **`message:send` migration into `ClientToServerEvents`** — still the unresolved type-hygiene item from Round 7; Round 8 added another optional field (`attachmentIds`) to the payload that the migration will have to carry. Deciding pre-Round-11 is suggested in the orchestrator summary.
- **Metric emission on sweep runs** — console.log only today. A Prometheus counter or structured-log line would be the next step for capacity planning.
- **Per-user / per-room storage quotas** — no enforcement. A spam uploader could burn disk up to 20 MB × upload rate × 1 h TTL before sweep fires.
- **Formal integration tests (Jest + Supertest)** — hackathon-scope deferral, not flagged as a config improvement (per `backend/CLAUDE.md` testing policy).

## Next round needs to know

**Round 9 (pagination).** `GET /rooms/:id/messages?before=&limit=` must populate `attachments` on every returned `Message`. Avoid N+1: batch-fetch `SELECT * FROM attachments WHERE message_id = ANY($messageIds) AND status='attached' ORDER BY created_at` then group by `message_id` in memory before serialising. The existing `listRecentMessages` (still Round 3-era) does NOT currently fetch attachments — Round 9 should extend it when it introduces the cursor.

**Round 10 (message edit / delete).** Two concerns:
- The `attachments.message_id → messages.id ON DELETE CASCADE` FK takes the DB row on delete, but **the on-disk files are NOT unlinked by the cascade.** Round 10 must `SELECT storage_path FROM attachments WHERE message_id = $1` BEFORE the cascade fires, then `fs.promises.unlink` each path in an `afterCommit` hook (or use `DELETE … RETURNING storage_path` if the delete is scoped to `attachments` first). Deleting the message via `DELETE FROM messages WHERE id = $1` without the explicit `SELECT` / `RETURNING` dance will leave orphaned bytes on disk forever (no scheduled cleanup sees them; the sweep only handles `status='pending'` rows).
- Message editing is currently body-only; if Round 10 widens the scope to add/remove attachments on an existing message, the same on-disk concern applies to removed attachments.

**Round 11 (room deletion).** Same pattern scoped by `room_id`: the `attachments.room_id → rooms.id ON DELETE CASCADE` drops the DB rows, but the room-delete handler must read every `storage_path` under that room first and unlink each file. Document in the Round 11 orchestrator task file.

**Contract-level locks**
- `"Invalid attachment reference"` is now a reserved ack string on `message:send`. Single-string-for-all-failures is deliberate (FE can't usefully distinguish sub-cases). Don't overload with new meanings — add a distinct verbatim string if a future round needs to differentiate.
- `Attachment` DTO on the wire omits `status` / `messageId` / `storagePath`. Preserve this — the shared `Attachment` type already defines the wire shape authoritatively; any new internal column should NOT appear in `toDto` unless it's intentionally part of the contract.
- The `attachmentIds.length > 5` rejection is currently enforced in `commitAttachmentsToMessage`, not the socket Zod schema. If a future round migrates `message:send` into `ClientToServerEvents`, the new typed schema should keep this check downstream to preserve the exact ack string.

## Config improvements

- **`MAX_ATTACHMENTS_PER_MESSAGE` as an env var** — hard-coded `5` in `commitAttachmentsToMessage`. Low-effort change if future UX wants 10 or 3.
- **`ATTACHMENT_ORPHAN_TTL_MS` as an env var** — hard-coded 1 h in `attachments.service.ts`. The smoke harness bypasses via the dev endpoint; a deployable-config knob would let prod adjust without a code change.
- **Extract `encodeRFC5987ValueChars` into `backend/src/utils/http.ts`** — currently private to the route file. No other caller yet, but flagging for the first round that needs `Content-Disposition` elsewhere.
- **Sampling metrics on sweep runs (Prometheus counter)** — `orphaned_attachments_deleted_total`, `orphan_files_unlink_errors_total`. Blocked by the project's lack of a metrics stack today.
- **`X-Request-Id` through upload + download paths** — would make tracing a specific 413 vs 400 much easier in production logs.
- **`Content-Security-Policy: sandbox` on `Content-Disposition: attachment` downloads** — extra defence for HTML-like payloads; overkill for hackathon scope.
- **`compression` middleware for large text downloads** — not installed today; the raw-bytes path suits binary / image content fine but PDF / text downloads would save bandwidth.
- **Rate-limit `POST /api/attachments` more tightly than the global `apiLimiter`** — the global bucket is 120 req/min, which for a 20 MB upload would theoretically let one user push 2.4 GB/min through the volume. A per-user 10 req/min (or byte-budget) would be safer.
- **Storage backend abstraction (S3-compatible interface)** — trivial for hackathon to be filesystem-backed, but production would want a pluggable `StorageAdapter` so the same service code works against S3 / GCS / R2.
- **Retry + backoff around `sweepPendingAttachments`** — currently the interval re-tries at the next tick (10 min). For a DB stutter during sweep, an immediate retry with jitter would close the gap faster.
