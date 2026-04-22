# Round 8 — Backend Tasks

## Goal
Ship the server half of attachments: filesystem-backed upload endpoint, membership-gated download endpoint, schema + migration for the `attachments` table, `message:send` handler extension to commit `attachmentIds` atomically with a new message, orphan sweep, DM-ban gate replication, and a smoke harness covering the contract.

## Dependencies
- `/shared/api-contract.md` — `## Attachment Endpoints` (new) + `#### message:send` extension (`attachmentIds`, `Invalid attachment reference` ack string, body-or-attachments rule, atomic commit) + `#### message:new` note about populated `attachments`.
- `/shared/types/attachment.ts` — `Attachment`, `AttachmentKind`, `UploadAttachmentResponse`.
- `/shared/types/message.ts` — extended `Message.attachments?: Attachment[]` and `SendMessagePayload.attachmentIds?: string[]`.
- **Do not modify `/shared/`.** If a contract / type change is needed, report to the orchestrator.
- `backend/CLAUDE.md` — route vs service separation, Drizzle conventions, error handling.
- `docker-compose.yml` — the orchestrator adds `uploads_data:/app/uploads`. Your code reads `process.env.UPLOADS_DIR` (already in `.env.example`) — don't hardcode the path.
- `backend/src/services/dm.service.ts` or equivalent user-ban check the `message:send` handler already uses (`hasBanBetween(userAId, userBId)` — reuse verbatim on the upload endpoint).

## Tasks

### 1. Schema + migration — `attachments` table
Append to `backend/src/db/schema.ts`:

```ts
export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id').notNull().references(() => rooms.id, { onDelete: 'cascade' }),
    uploaderId: uuid('uploader_id').notNull().references(() => users.id),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    kind: text('kind', { enum: ['image', 'file'] }).notNull(),
    comment: text('comment'),
    storagePath: text('storage_path').notNull(),
    status: text('status', { enum: ['pending', 'attached'] }).notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    attachedAt: timestamp('attached_at', { withTimezone: true }),
  },
  (table) => ({
    attachmentsMessageIdx: index('attachments_message_idx').on(table.messageId),
    attachmentsPendingSweepIdx: index('attachments_pending_sweep_idx')
      .on(table.status, table.createdAt)
      .where(sql`status = 'pending'`),
  }),
);
```

Notes:
- `onDelete: 'cascade'` on both FKs — message delete + room delete both drop attachments rows automatically. **On-disk files are NOT unlinked by this cascade**; that's a Round 10 / Round 11 concern (flagged in the orchestrator summary's "Next round needs to know"). For Round 8, out of scope — we don't support message delete or room delete yet.
- The partial index on `(status, created_at) WHERE status = 'pending'` keeps the orphan-sweep query fast without bloating the main hot path.
- Do NOT add a unique constraint on `storage_path` — UUID collisions are not a real concern and a unique constraint would add write overhead without improving anything.

Run `pnpm db:generate` to produce the migration SQL; commit the generated `.sql` file alongside the schema change. Verify the generated SQL applies cleanly on a fresh DB via `docker compose up` (migrations run on container startup).

### 2. New service — `backend/src/services/attachments.service.ts`

Responsibilities:
- Write the uploaded bytes to `<UPLOADS_DIR>/<yyyy>/<mm>/<attachmentId>` (no original filename on disk). Create directories as needed with `fs.promises.mkdir({ recursive: true })`.
- Insert the pending row.
- Return the shaped `Attachment` DTO (snake_case → camelCase mapping).

Exports (minimum surface):
- `createPendingAttachment({ uploaderId, roomId, filename, mimeType, sizeBytes, kind, comment, buffer }) → Promise<Attachment>` — writes file + inserts row. If the DB insert fails, `fs.unlink` the half-written file (best-effort) before rethrowing.
- `getAttachmentForDownload(attachmentId, callerId) → Promise<{ attachment: Attachment; absolutePath: string }>` — loads the row, enforces the caller's current room membership, returns the resolved absolute path for streaming. Throws `AppError('Attachment not found', 404)` if the row doesn't exist. Throws `AppError('Forbidden', 403)` if the caller is not a current member.
- `commitAttachmentsToMessage({ attachmentIds, callerId, roomId, messageId, tx }) → Promise<Attachment[]>` — inside the provided transaction: validates each id has `uploader_id = callerId`, `room_id = roomId`, `status = 'pending'`, then flips `status = 'attached'`, `message_id = messageId`, `attached_at = now()`. Returns the hydrated attachment rows (with `status='attached'`) for the ack. Throws `AppError('Invalid attachment reference', 400)` on any mismatch (keeps the single-message-per-failure contract from the orchestrator spec).
- `sweepPendingAttachments() → Promise<{ deletedCount: number }>` — deletes DB rows + on-disk files for pending attachments older than 1 hour. Best-effort; swallows individual file-unlink errors (log + continue) so a missing file doesn't block row cleanup.

Implementation notes:
- `kind` computed server-side via a small helper: `mimeType.startsWith('image/') && ALLOWED_IMAGE_MIMES.has(mimeType) ? 'image' : 'file'`. Whitelist: `new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])`.
- Membership check reuses whatever existing helper `messages.service.ts` already calls (`assertRoomMember(userId, roomId)` or equivalent) — don't duplicate logic.
- `getAttachmentForDownload` must NOT leak a disk path or filename in its error messages — the 403/404 bodies are constants.

### 3. New route — `backend/src/routes/attachments.ts`

Two endpoints. Wire under `app.use('/api/attachments', attachmentsRouter)` in the Express entry point.

#### 3a. `POST /api/attachments`
Multipart handler — use `multer` with `memoryStorage()` (we write to the real path inside the service, not wherever `multer` chose). This keeps the disk-layout decision out of the HTTP layer and off the public file namespace.

- `multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 10 } }).single('file')`.
- After multer: run Zod validation on `req.body.roomId` (UUID) and `req.body.comment` (string, max 200, trimmed, empty→null). Missing file → `400 { "error": "File is required" }`.
- **Image-size sub-cap**: if the derived `kind === 'image'` AND `req.file.size > 3 * 1024 * 1024`, return `413 { "error": "File exceeds size limit" }`. Same string as the multer-level limit so the FE can pattern-match a single failure class.
- **MIME sanity sniff**: call a helper that reads the first 12 bytes of `req.file.buffer` and checks the magic signature against the declared `mimeType`. For images we check PNG (`89 50 4E 47`), JPEG (`FF D8 FF`), GIF (`47 49 46 38`), WebP (`52 49 46 46 ?? ?? ?? ?? 57 45 42 50`). Mismatch → `400 { "error": "File content does not match declared type" }`. For `kind='file'` we skip the sniff (arbitrary types can't be reliably sniffed).
- **Unsupported type**: no `Content-Type` on the multipart part, OR a `Content-Type` that's clearly bogus (empty string after lower-casing) → `400 { "error": "Unsupported file type" }`.
- **Membership + DM ban gate**: call the existing membership helper; if the room is `type='dm'`, additionally call `hasBanBetween(callerId, otherParticipantId)`. If a ban exists → `403 { "error": "Personal messaging is blocked" }` (verbatim match with `message:send` ack).
- On success: `res.status(201).json({ attachment })`.

Error ordering (important — clients rely on this to produce the right UX):
1. Auth (401) — handled by the upstream `requireAuth` middleware.
2. Size limit (413) from multer.
3. Missing file (400 "File is required").
4. Body validation (400 validation details).
5. Room lookup (404 "Room not found").
6. Membership (403 "Forbidden").
7. DM ban (403 "Personal messaging is blocked").
8. Unsupported type (400 "Unsupported file type").
9. Image-size sub-cap (413 "File exceeds size limit").
10. Magic-byte sniff (400 "File content does not match declared type").
11. Success (201).

#### 3b. `GET /api/attachments/:id`
- `requireAuth` middleware in front (Bearer token check).
- Call `getAttachmentForDownload(id, callerId)`.
- Headers:
  - `Content-Type: <attachment.mimeType>`
  - `Content-Length: <attachment.sizeBytes>`
  - `Content-Disposition: ${attachment.kind === 'image' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeRFC5987(attachment.filename)}`
  - `X-Content-Type-Options: nosniff`
  - `Cache-Control: private, max-age=0, must-revalidate`
- Body: `fs.createReadStream(absolutePath).pipe(res)`.
- Stream-error handler: if the read stream errors (file unexpectedly gone — races with orphan sweep in theory), destroy the response with a 500 if the headers haven't been sent; otherwise just end the response (the client will see a truncated body).

RFC 5987 helper: small utility `encodeRFC5987ValueChars(str)` — percent-encode everything outside `A-Za-z0-9-._~!$&'()*+,;=:@`. Do NOT just `encodeURIComponent(str)`; that's close but leaves a few chars that break `Content-Disposition` parsers in older browsers.

### 4. Extend `backend/src/socket/io.ts` / `messages.service.ts`

Locate the existing `message:send` handler. Extend:

- Parse `attachmentIds` from the payload (optional array of up to 5 UUIDs).
- Enforce body-or-attachments rule: `body.trim().length >= 1 || (attachmentIds?.length ?? 0) >= 1`. Violation → ack `{ ok: false, error: "Body must be between 1 and 3072 characters" }` (reuse the existing string).
- Wrap the existing single-row insert in a Drizzle transaction (`db.transaction(async (tx) => { … })`):
  1. Insert the `messages` row as today.
  2. If `attachmentIds` is non-empty, call `commitAttachmentsToMessage({ attachmentIds, callerId, roomId, messageId, tx })`.
  3. Load the attached attachments (already returned from step 2) and attach them to the message DTO as `attachments`.
- On any throw inside the transaction, let it bounce; the top-level handler converts it to the appropriate ack string (`"Invalid attachment reference"` for the `AppError(400)` from `commitAttachmentsToMessage`; `"Internal server error"` as a generic fallback).
- Ack shape unchanged (still `{ ok: true, message }`); `message.attachments` is populated when non-empty, omitted otherwise.
- Broadcast: `message:new` to `room:<roomId>` with the SAME DTO (including `attachments`). Continue to exclude the sender socket per Round 3 semantics.

Don't introduce a new event name. Don't break the existing Round 3/6/7 smoke harnesses — the old shape (no `attachmentIds`, no `attachments`) must continue to round-trip unchanged.

### 5. Orphan sweep cron

In `backend/src/index.ts` (or wherever service startup wires happen), register a `setInterval(() => attachmentsService.sweepPendingAttachments(), 10 * 60 * 1000)`. Log the `deletedCount` if > 0 at `info` level; log errors at `warn` level but do not crash the process.

Also call `sweepPendingAttachments()` once at startup (after the DB pool is ready) so a server restart doesn't delay cleanup by up to 10 minutes. Same error-swallowing semantics.

Do NOT use a third-party cron library. `setInterval` is sufficient for hackathon scope and keeps the dependency list lean.

### 6. Ensure the backend container prepares `UPLOADS_DIR` on startup

The Dockerfile already copies the build artifacts; the `UPLOADS_DIR` path is mounted as a volume by docker-compose. Inside the backend service, on startup (before the HTTP server starts listening), call `fs.promises.mkdir(UPLOADS_DIR, { recursive: true })`. This:
- Handles the first-run case where the named volume is empty and missing the directory.
- Is a no-op when the volume already has files.
- Fails fast with a startup crash if the path is unwriteable (better than discovering at first-upload time).

Log the resolved path at startup so deployment issues are visible.

### 7. Smoke harness — `tmp/round-8/smoke.js`

Drives the full Round 8 contract. Reuses the `node-fetch` + `socket.io-client` pattern from Round 7. Produces a structured JSON log keyed per scenario (same style as Round 7) and prints it to stdout.

Setup: register three users (alice, bob, carol), make alice⇄bob friends, create a public channel `#eng` with both as members, open a DM between alice and bob (via `POST /api/dm`). A fourth socket `S-outsider` is carol (not in the channel, not friends with either).

Scenarios (record verbatim payloads — successes and failure ack strings — in the summary):

1. **Happy-path image upload + send** — alice POSTs a 500 KB PNG to `/api/attachments` with `roomId=<eng.id>`, `comment="screenshot"`. Assert: `201`, `attachment.kind='image'`, `attachment.status` absent from wire (server returns the DTO which omits `status`), `filename='smoke.png'`. Then alice `message:send` `{ roomId: eng.id, body: 'here', attachmentIds: [att.id] }`. Assert: ack `ok=true`, `message.attachments.length=1`, `message.attachments[0].id === att.id`.
2. **Broadcast to the other room member** — bob's socket in `#eng` must have received `message:new` with `attachments[0].kind='image'`, same shape as alice's ack. Sender (alice) does NOT receive the broadcast on her own socket (Round 3 semantics unchanged).
3. **Download as a room member** — bob fetches `GET /api/attachments/:id` with his Bearer. Assert: `200`, `Content-Type: image/png`, `Content-Disposition` starts with `inline`, `Content-Length` matches `attachment.sizeBytes`, body bytes match what alice uploaded.
4. **Download as a non-member** — carol fetches `GET /api/attachments/:id`. Assert: `403 { error: "Forbidden" }`.
5. **Download without Bearer** — unauthenticated `GET /api/attachments/:id`. Assert: `401`.
6. **Oversize image upload** — alice uploads a 4 MB PNG. Assert: `413 { error: "File exceeds size limit" }`.
7. **Oversize file upload** — alice uploads a 25 MB `.bin`. Assert: `413 { error: "File exceeds size limit" }` (multer's level).
8. **Bad image magic** — alice uploads a `.png` where the first bytes are actually JPEG (or text). Assert: `400 { error: "File content does not match declared type" }`.
9. **Non-image arbitrary file** — alice uploads a 10 MB `.zip`. Assert: `201`, `attachment.kind='file'`. Download: `Content-Disposition` starts with `attachment`.
10. **Over-cap attachmentIds** — alice uploads 6 small files, then `message:send` with `attachmentIds=[6 ids]`. Assert: `{ ok: false, error: "Invalid attachment reference" }` (use the generic contract error; D2 cap is enforced via the validator).
11. **Wrong-room attachment** — alice uploads against the DM room, then `message:send` against `#eng` with that id. Assert: `{ ok: false, error: "Invalid attachment reference" }`.
12. **Wrong-uploader attachment** — bob tries to `message:send` referencing alice's pending id. Assert: `{ ok: false, error: "Invalid attachment reference" }`. Also verify alice's row is still `pending` afterwards.
13. **Already-attached re-send** — alice sends att-id once (success), then tries to send the same id again in a new message. Assert: `{ ok: false, error: "Invalid attachment reference" }`.
14. **Empty-body + no-attachments send** — `message:send { roomId, body: "" }`. Assert: `{ ok: false, error: "Body must be between 1 and 3072 characters" }` (reused string).
15. **Empty-body + one-attachment send** — `message:send { roomId, body: "", attachmentIds: [id] }`. Assert: `ok=true`, caption-less image message lands. (Keeps the contract open for "image-only" messages.)
16. **DM ban gate on upload** — bob bans alice (`POST /api/user-bans`). Alice tries to upload against the alice⇄bob DM. Assert: `403 { error: "Personal messaging is blocked" }`.
17. **DM ban gate does NOT block existing downloads** — before the ban was applied, alice had uploaded & sent an image in the alice⇄bob DM. After the ban, alice can still `GET /api/attachments/:id` for that message's attachment (read access to frozen history — requirement §2.3.5). Assert: `200` with bytes.
18. **Orphan sweep** — alice uploads a pending attachment, then the harness calls a test-only endpoint or the exported service function directly to force-invoke `sweepPendingAttachments()` with a shortened TTL (inject a `nowProvider` / environment flag, or expose a `__sweepForTests(maxAgeMs)`). Assert the pending row is gone and the on-disk file is unlinked.
19. **Uploaded-by-former-member loses access** — alice uploads + sends in `#eng`, then alice leaves the room (`POST /api/rooms/:id/leave`). alice tries to `GET /api/attachments/:id`. Assert: `403` (requirement §2.6.5 — lost access even for her own uploads).

Verification gate:
- `pnpm build` in `backend/` — clean.
- `pnpm lint` in `backend/` — clean.
- `docker compose up -d --build backend` — rebuilds with the new migration, starts cleanly, log shows `Backend running on port 3000` after migrations, uploads dir created.
- All 19 smoke scenarios observe the expected payloads.

### 8. Do not add HTTP GET for the raw file via `/uploads/…`
Explicitly out of scope. No `express.static(UPLOADS_DIR)`. All access flows through `GET /api/attachments/:id`.

### 9. Do not introduce a new dependency beyond `multer`
`sharp` (thumbnails), `file-type` (mime sniffing library), `mime-types` — none of these are needed. The image magic-byte sniff in task 3 is ~20 lines of hand-rolled byte comparison. Keep the dep list tight.

## Wrap-up
Write `plans/round-8/backend_work_summary.md` with:
- **Built** — per-section summary of the schema migration, the service file, the route file, the `message:send` extension, the sweep cron, the Dockerfile / startup-hook changes, the smoke harness.
- **Deviations** — likely pressure points: (a) whether the magic-byte sniff covers all whitelisted image MIMEs (if you drop WebP or add one, flag it); (b) whether `Content-Disposition` encoding matches modern browsers (some older browsers need the `filename=` legacy form alongside `filename*=` — if you ship both, note it); (c) whether the sweep interval should be an env var (yes is fine; default 10min); (d) whether to reuse the existing `assertRoomMember` helper or copy-paste.
- **Deferred** — thumbnail pipeline, signed URLs, Range support, EXIF stripping, virus scanning, per-room storage quotas, attachment deletion on room delete (Round 11 picks up), on-disk file unlink on message delete (Round 10 picks up), metric emission on sweep runs.
- **Next round needs to know**
  - Round 9 (pagination): `GET /rooms/:id/messages?before=&limit=` must populate `attachments` on each message. Batch-fetch per page to avoid N+1 — `SELECT * FROM attachments WHERE message_id = ANY($messageIds) AND status='attached'` then group by `message_id` in memory.
  - Round 10 (message edit / delete): `ON DELETE CASCADE` on `message_id` takes the row, but on-disk files need explicit unlinking. Add an `afterCommit` hook that reads the `storagePath`s before the cascade deletes the rows (`DELETE … RETURNING storage_path`) and unlinks them.
  - Round 11 (room deletion): same pattern, scoped by `room_id`.
- **Config improvements** — candidate items: make `MAX_ATTACHMENTS_PER_MESSAGE` an env var (currently hard-coded 5); make `ATTACHMENT_ORPHAN_TTL_MS` configurable (currently hard-coded 1 hour); log `X-Request-Id` through the upload + download paths for traceability; sampling metrics on sweep runs for capacity planning; CSP header on downloads (e.g. `Content-Security-Policy: sandbox` for HTML-like files — overkill for hackathon but a candidate); compress `application/pdf` / large text downloads with `compression` middleware (we don't today).
