# Round 8 — Planning Q&A

Decision rationale captured before the task files are written. Referenced from the orchestrator / BE / FE task files.

---

## Q1. Where should we store images & files?

**Decision: local filesystem, bind-mounted into the backend container, one file per attachment by UUID.**

- Requirement §3.4 mandates local filesystem (no S3). Filesystem is also the simplest for hackathon scope — no new service, no new dep, the backend already runs on a single node.
- Path scheme: `<UPLOADS_DIR>/<yyyy>/<mm>/<attachmentId>` where `attachmentId` is a v4 UUID and the directory shards by year/month for reasonable `ls` performance. Original filename is NOT encoded in the disk path — it lives in the DB and comes back on download via `Content-Disposition`.
- `UPLOADS_DIR` is an env var (`UPLOADS_DIR=/app/uploads` inside the container). `.env.example` gets the key.
- Docker: add a named volume `uploads_data:/app/uploads` to `docker-compose.yml` (parity with `postgres_data`). Files persist across `docker compose down` + `up`.
- MIME whitelist enforced on upload (`image/png`, `image/jpeg`, `image/gif`, `image/webp`, plus arbitrary `application/*` / `text/*` / `audio/*` / `video/*` up to the 20 MB cap — requirement §2.6.1 "arbitrary file types").
- Size caps (requirement §3.4): 3 MB for images, 20 MB for other files. Enforced in `multer` limits + a post-write check after sniffing the real type (since the client-declared MIME is untrusted).
- On-disk files are NOT publicly reachable. No static `express.static('/uploads')` route. Downloads flow through the access-controlled endpoint only (see Q2).

---

## Q2. How will FE get the images?

**Decision: authenticated fetch → Blob → object URL. No public file serving, no query-signed URLs.**

- BE exposes `GET /api/attachments/:id` — requires `Authorization: Bearer <accessToken>` and checks room membership before streaming the bytes. Same middleware chain as the existing REST endpoints.
- FE calls `HttpClient.get(url, { responseType: 'blob' })` via an `AttachmentsService`, caches the resulting `Blob` keyed by `attachmentId` in a `Map`, and exposes `objectUrlFor(attachmentId) → string | null` that returns `URL.createObjectURL(blob)` on first read. The service owns `URL.revokeObjectURL` on `reset()` (logout) to avoid leaks.
- In the message row, `<img [src]="attachmentService.objectUrlFor(att.id)">` binds to the object URL. Angular's DomSanitizer allows `blob:` scheme URLs through `SecurityContext.URL`, so no `bypassSecurityTrust*` calls are needed.
- Download of a non-image file = `<a mat-button [href]="objectUrlFor(att.id)" [download]="att.filename">Download</a>` — same cached blob.
- **Why not signed URLs?** Would require token signing infra (HMAC or short-lived JWT with scope=attachmentId) and a parallel unauthenticated route. For the hackathon it's extra surface for zero user-visible gain; membership-enforced auth on a bytes endpoint is strictly simpler.
- **Why not cookie auth on a separate `/files/` route?** Our refresh token already lives in an httpOnly cookie, but the access token does not — introducing a second cookie scope is more complex than reusing the existing Bearer+interceptor pipeline.

**Thumbnails**: NOT generated server-side for Round 8. Images are capped at 3 MB, rendered inline with CSS constraints (`max-width: 24rem, max-height: 18rem, object-fit: contain`), and clicking the image opens it full-size in a dialog (simple `MatDialog` with the object URL). No `sharp` / ImageMagick dependency. If we later find 3 MB inline images too heavy for long scroll history, a thumbnail pass can be added post-round without contract changes (the `Attachment` shape can carry an optional `thumbnailUrl` field).

**Access revocation** (requirement §2.6.4): handled naturally by the membership check on `GET /api/attachments/:id` — if the caller is not currently a member of the attachment's `roomId`, the endpoint returns `403`. No uploader-identity gate — a former member who originally uploaded the file loses access too (requirement §2.6.5).

**DM ban gate**: the attachment download endpoint does NOT gate on user-to-user bans — the file is already in the shared DM room and both participants still have "read" access to frozen history (requirement §2.3.5: "existing personal message history remains visible but becomes read-only/frozen"). The **upload** endpoint DOES replicate the DM-ban gate that `message:send` applies, since a ban blocks new sends.

---

## Q3. Sanitization — we will NOT insert raw HTML

**Decision: no `innerHTML`, no `bypassSecurityTrust*`, no Markdown rendering. Attachments render via Angular property bindings only.**

- Message body: stays as `{{ message.body }}` — Angular's text interpolation HTML-escapes for free. Same as today.
- Attachment rendering: Angular components with property-bound templates:
  ```html
  @if (att.kind === 'image') {
    <img [src]="attachmentService.objectUrlFor(att.id)" [alt]="att.filename" class="message__image" />
  } @else {
    <a mat-button [href]="attachmentService.objectUrlFor(att.id)" [download]="att.filename">
      <mat-icon>attach_file</mat-icon>
      <span>{{ att.filename }}</span>
      <span class="text-label-small text-on-surface-variant">{{ formatSize(att.sizeBytes) }}</span>
    </a>
  }
  @if (att.comment) {
    <p class="text-body-small text-on-surface-variant m-0">{{ att.comment }}</p>
  }
  ```
- `[src]="objectUrl"` passes through Angular's `DomSanitizer` at `SecurityContext.URL` — `blob:` URLs are allowed; any attacker-controlled scheme (`javascript:`, `data:` with HTML payload) would be stripped. We do not call `bypassSecurityTrustUrl` — the whole point is that we never need to.
- `{{ att.filename }}` is escape-interpolated. Even a filename containing literal `<script>` characters renders as text, not HTML.

**Defensive BE headers on `GET /api/attachments/:id`**:
- `X-Content-Type-Options: nosniff` — prevents a `.txt` file served with `Content-Type: text/plain` from being sniffed as HTML/JS.
- `Content-Disposition: attachment; filename="<escaped>"` for non-images (forces download, not in-browser render).
- `Content-Disposition: inline; filename="<escaped>"` for whitelisted image MIMEs.
- `Cache-Control: private, max-age=0, must-revalidate` — the response body embeds access control, so intermediaries must not cache across users.
- The `filename` value is RFC 5987–encoded so quotes / unicode / newlines in the original name cannot inject header lines.

**Rejected alternatives**:
- Markdown rendering with DOMPurify — we're not supporting Markdown in Round 8 (plain-text messages only; rich composition is a later round if ever). Zero benefit for Round 8 scope.
- `[innerHTML]="..."` anywhere — would require active sanitization and widen the attack surface. Not needed; templates can express everything.

---

## Open design decisions — need confirmation

These are decisions that bear on the task file split. Listed with the choice I'd make, so you can confirm / redirect quickly.

### D1. Upload flow: "upload-first" vs "bundle-with-send"

**Recommendation: upload-first, then `message:send` references attachment IDs.**

- User picks file → FE immediately POSTs to `/api/attachments` → BE writes to disk + DB row (attachment status: `'pending'`, `messageId: null`, `userId: <uploader>`, `roomId: <draft>`) → returns `attachmentId`.
- User types text, hits Send → `message:send` payload becomes `{ roomId, body, attachmentIds?: string[] }` → BE validates that every id is `status='pending'`, uploaded by caller, matches `roomId`, then atomically sets `status='attached'`, `messageId=<new>` in the same transaction that inserts the message row.
- Orphan cleanup: a lightweight background sweep deletes `status='pending'` rows + their files older than 1 hour. Runs on a `setInterval(…, 10 * 60 * 1000)` in `backend/src/services/attachments.service.ts`.
- **Why upload-first?** (a) Shows upload progress (chat UX expectation). (b) Lets user compose text while bytes are in flight. (c) Cleaner error handling — an upload failure doesn't discard the user's typed text. (d) `message:send`'s ack envelope stays small; the heavy bytes go over a separate HTTP connection.
- Trade-off: the orphan sweep is extra logic vs the simpler "one multipart POST does everything" approach. For hackathon scope this is a ~20-line cron loop.

Alternative: bundle-with-send via single `POST /api/rooms/:id/messages` multipart. Simpler server-side, but loses progress UX and re-uses an endpoint we don't currently have (messages are created via `message:send` socket, not REST). Net: slightly simpler BE, worse FE UX, and breaks the socket-primary message model.

### D2. Multiple attachments per message

**Recommendation: allow up to 10 attachments per message, enforced on `message:send` ack.**

Matches the master-plan type (`attachments?: Attachment[]`, plural) and common chat UX (Slack lets you attach a clip of multiple screenshots at once). Renders as a stacked column inside the message row.

### D3. Per-attachment comment (requirement §2.6.3)

**Recommendation: in scope for Round 8.**

- Client sets `comment` at upload time (optional form field next to the file preview in the composer) OR leaves it blank.
- Stored on the `attachments` row. Not editable in Round 8 (message editing lands in Round 10).
- Rendered under the file card / below the image with `text-body-small text-on-surface-variant`.

### D4. `message:send` ack shape — include attachments or not

**Recommendation: yes, include `message.attachments` on success.**

The server already needs to resolve attachment rows to set their `messageId`; returning them on the ack lets the sender's UI render without a second fetch. `Message` type gets an optional `attachments?: Attachment[]` field; undefined when the message has none (keeps existing Round 3 smoke assertions stable).

### D5. `message:new` broadcast — same shape as ack

**Recommendation: yes.**

Other room members' sockets receive the same `Message` shape (with `attachments` included). Consistency with the ack and with how we resolve denormalised data everywhere else.

### D6. Schema — separate `attachments` table keyed by `messageId`

**Recommendation:**
```
attachments (
  id              uuid PK,
  room_id         uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  uploader_id     uuid NOT NULL REFERENCES users(id),
  message_id      uuid NULL REFERENCES messages(id) ON DELETE CASCADE,   -- NULL while pending
  filename        text NOT NULL,                                           -- original name, for Content-Disposition
  mime_type       text NOT NULL,
  size_bytes      integer NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('image','file')),          -- FE branch
  comment         text NULL,
  storage_path    text NOT NULL,                                           -- filesystem path, relative to UPLOADS_DIR
  status          text NOT NULL CHECK (status IN ('pending','attached')) DEFAULT 'pending',
  created_at      timestamptz NOT NULL DEFAULT NOW(),
  attached_at     timestamptz NULL
);
CREATE INDEX attachments_message_idx ON attachments(message_id);
CREATE INDEX attachments_pending_sweep_idx ON attachments(status, created_at) WHERE status = 'pending';
```

- `ON DELETE CASCADE` on `messages` handles Round 10's message-delete flow for free.
- `ON DELETE CASCADE` on `rooms` handles Round 11's room-delete flow for free — but the on-disk files still need manual unlink. Round 11 planner carries that over.
- The partial index on `pending` keeps the orphan-sweep query fast.

### D7. Testing scope (smoke harness)

Standard BE approach — `tmp/round-8/smoke.js` covers:
1. Upload a PNG → get `attachmentId`.
2. `message:send` with `{ body: "pic", attachmentIds: [id] }` → ack has `message.attachments[0]` with correct shape.
3. `message:new` on a second socket carries the same payload.
4. `GET /api/attachments/:id` with Bearer → streams bytes, `Content-Disposition` correct.
5. `GET /api/attachments/:id` as a non-member → 403.
6. `GET /api/attachments/:id` without Bearer → 401.
7. Oversize image (4 MB) → 400 on upload.
8. Oversize file (25 MB) → 400 on upload.
9. Bad MIME (`.exe` executable) — reject on upload if it's an image slot, accept for file slot (since "arbitrary file types").
10. Orphan sweep — manually fast-forward / force-invoke the sweep and verify pending rows with ages > TTL are deleted.
11. DM ban gate — ban victim tries to upload in a frozen DM → 403 "Personal messaging is blocked".
12. Paste attachment → upload → send → receive (driven from FE Playwright on a follow-up round, not here).

### D8. Scope cuts (explicitly deferred)

- Server-side thumbnail generation — deferred (see Q2 thumbnails paragraph).
- Image rotation / EXIF stripping — deferred; low risk given our MIME whitelist.
- Upload resumability / chunked uploads — deferred; 20 MB single-shot is fine.
- Virus scanning — deferred; the app is for internal users at hackathon scale.
- Message editing to add / remove attachments — deferred to Round 10.
- CDN / cache layer in front of the download endpoint — deferred; single-node scale.

---

## Follow-up questions for the user

1. **D1 — upload flow**: upload-first with orphan sweep, OR bundle-with-send (single multipart)? I'd pick upload-first for the better UX at small extra BE cost. Confirm?

2. **D2 — max attachments per message**: cap at 10 reasonable, or do you prefer 1 / 5 / unlimited?

3. **D3 — per-attachment comment**: in scope for Round 8 as I've sketched, or defer (render the user's message body only)? Requirement §2.6.3 leans "in scope" but it adds a secondary input to the composer.

4. **Thumbnail strategy**: skip server-side thumbnails, CSS-constrain inline + click-to-enlarge lightbox (my recommendation). Confirm, or would you rather we ship a `sharp`-based thumbnailer this round?

5. **Full-size image viewer**: `MatDialog` with object-URL image (simple), or open in new tab (`target="_blank"` + `rel="noopener"`)? Dialog is slicker; new-tab is cheaper and gives the user the browser's own zoom/save controls.

6. **`message:send` ack enlargement**: OK to extend `MessageSendAck.message.attachments?: Attachment[]`? This is a shared-type change owned by the orchestrator — minor, but worth explicit sign-off since Round 7's smoke harness asserts on the ack shape.

7. **Docker volume name**: `uploads_data` (parity with `postgres_data`), or a bind-mount like `./data/uploads:/app/uploads` so files are visible on the host? Named volume is more idiomatic; bind mount is easier for eyeball inspection during development.
