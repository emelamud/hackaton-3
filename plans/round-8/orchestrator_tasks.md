# Round 8 — Orchestrator Tasks

## Goal
Lock the contract for message attachments: the new `Attachment` type, the REST surfaces for upload-first uploads and access-controlled downloads, the `message:send` payload extension with `attachmentIds`, the `Message.attachments` shape, plus the docker-compose volume so uploaded files survive container restarts.

## Scope
Round 8 from `plans/master-plan.md` — attach files/images to messages, recipients see inline image previews, non-image files render as download cards (requirements §2.6.1 – §2.6.5, §3.4).

Out of scope:
- Server-side thumbnail generation (deferred — CSS-constrained inline rendering with click-to-open in a new tab).
- Upload resumability / chunked uploads (20 MB single-shot is fine per §3.4).
- Virus scanning, EXIF stripping, image rotation (deferred; MIME whitelist is the main defense).
- Attachment editing / re-attaching after send (message editing lands in Round 10).
- CDN / cache layer in front of the download endpoint (single-node scale).
- `message:send` migration into `ClientToServerEvents` — still deferred from Round 7.

## Design decisions (locked during planning — recorded in `plans/round-8/planning_qa.md`)

**D1. Upload-first flow.** FE uploads each selected file individually via `POST /api/attachments` (multipart) and receives an `attachmentId`. The user then submits the message through the existing `message:send` socket event with an extended payload carrying `attachmentIds?: string[]`. Server validates each id (uploader match, room match, `status='pending'`), atomically flips them to `status='attached'` + sets `message_id`, then returns the full `Message` (including `attachments`) on the ack. Rationale: shows upload progress, lets the user compose text while bytes are in flight, cleaner error handling, keeps `message:send` as the single authoritative send path.

**D2. Cap of 5 attachments per `message:send`.** Not specified in `requirements.txt`; 5 is a pragmatic upper bound that keeps UI density reasonable and matches the planning Q&A answer. Enforced in the `message:send` validator; also enforced FE-side in the composer (the attach button is disabled once 5 pending attachments are queued).

**D3. Per-attachment `comment` IS in scope.** Requirement §2.6.3 explicitly calls this out ("The user may add an optional comment to an attachment") and the wireframe in §Appendix A shows the `comment:` line under a file card. Optional, max 200 chars, captured at upload time (a text input next to each pending attachment in the composer). Stored on the `attachments` row. Not editable in Round 8.

**D4. `MessageSendAck.message.attachments?: Attachment[]`** — new optional field on the existing `Message` type. Undefined / absent when the message has no attachments (keeps Round 3/6/7 smoke assertions stable). Same field flows through `message:new` for non-sender recipients.

**D5. Open in new tab, not a dialog.** Clicking an inline image opens it full-size in a new browser tab (`target="_blank" rel="noopener"`), not a `MatDialog` lightbox. Cheaper UX, gives the user the browser's native zoom/save/download controls. The download button for non-image files uses the same object-URL + `[download]` attribute pattern.

**D6. Filesystem storage via named docker volume `uploads_data:/app/uploads`.** Parity with `postgres_data`. Not a bind mount — idiomatic, and the `uploads_data` volume persists across `docker compose down/up` just like the DB. `UPLOADS_DIR=/app/uploads` is already in `backend/.env.example` from a prior round, so no env-file change is needed there.

**D7. Authenticated fetch → Blob → object URL on the FE.** No signed query-string URLs, no public `/uploads` serving, no cookie-based auth on a separate route. `GET /api/attachments/:id` uses the same Bearer auth as the rest of `/api/`. FE caches the `Blob` per attachmentId, exposes `objectUrlFor(id)`, and revokes on logout. Angular's DomSanitizer allows `blob:` URLs through `SecurityContext.URL`, so no `bypassSecurityTrust*` is ever called — the sanitization answer is "never insert raw HTML in the first place".

**D8. Orphan sweep.** Attachments uploaded but never committed to a message are cleaned up by a lightweight `setInterval(…, 10 * 60 * 1000)` sweep in the BE. Rows with `status='pending'` older than 1 hour are deleted (DB row + on-disk file). Prevents disk bloat from abandoned uploads without user-visible complexity.

## Dependencies
- `plans/master-plan.md` §Round 8 bullets.
- `requirements.txt` §2.6 (Attachments — supported types, upload methods, metadata, access control, persistence), §3.4 (File Storage — local filesystem, 20 MB max file, 3 MB max image), §2.3.5 / §2.5.1 (DM ban gate on uploads).
- `shared/api-contract.md` — current state; Round 8 adds two new REST endpoints (`POST /api/attachments`, `GET /api/attachments/:id`) and extends `message:send` (ack shape unchanged structurally, but `Message.attachments` now populated when present).
- `shared/types/` — existing exports; Round 8 adds `attachment.ts` and extends `message.ts`.
- `plans/round-7/orchestrator_work_summary.md` §Next round needs to know — confirms no presence coupling; reminder to replicate the DM-ban gate on the upload endpoint (already in Round 6's summary too).
- `plans/round-6/backend_work_summary.md` — the DM ban gate on `message:send` is the canonical shape to replicate on the upload endpoint. `MessageSendAck.error === 'Personal messaging is blocked'` ack string is shared by the upload endpoint's `403` response body.

## Tasks

### 1. Create `/shared/types/attachment.ts`
New file.

```ts
export type AttachmentKind = 'image' | 'file';

export interface Attachment {
  id: string;
  roomId: string;
  uploaderId: string;
  filename: string;        // original file name (from upload form)
  mimeType: string;        // server-sniffed MIME
  sizeBytes: number;       // actual stored size on disk
  kind: AttachmentKind;    // 'image' for whitelisted image MIMEs; 'file' otherwise
  comment: string | null;  // per-attachment optional note (requirement §2.6.3)
  createdAt: string;       // ISO — upload time
}

export interface UploadAttachmentResponse {
  attachment: Attachment;
}
```

Notes:
- `messageId` is deliberately NOT on `Attachment` — the FE reads attachments as part of the enclosing `Message.attachments`, so the back-pointer is implicit. This keeps the type-level parent/child relationship one-way and avoids the FE having to reconcile two indices.
- `kind` is denormalised from `mimeType` on the server for easy FE branching (`<img>` vs download card). Whitelisted image MIMEs (`image/png`, `image/jpeg`, `image/gif`, `image/webp`) map to `'image'`; everything else maps to `'file'`.
- `comment` is nullable; frontend renders the comment line only when present.

### 2. Extend `/shared/types/message.ts`
Add optional `attachments` to `Message` and optional `attachmentIds` to `SendMessagePayload`.

```ts
import type { Attachment } from './attachment';

export interface Message {
  id: string;
  roomId: string;
  userId: string;
  username: string;
  body: string;
  createdAt: string;
  attachments?: Attachment[];   // NEW — present only when non-empty
}

export interface SendMessagePayload {
  roomId: string;
  body: string;
  attachmentIds?: string[];     // NEW — up to 5 ids from prior uploads (D2)
}

export type MessageSendAck =
  | { ok: true; message: Message }
  | { ok: false; error: string };
```

Notes:
- `body` stays required; the `message:send` validator keeps its existing 1–3072-character rule — a message MUST have non-empty body text OR at least one attachment. We enforce "body XOR attachments is non-empty" BE-side (easier to police the contract from one place); see backend task 3. Because the FE composer already rejects empty-body sends, this is a BE-guardrail, not a user-visible change.
- `attachments?: Attachment[]` on `Message` stays optional + absent for empty: existing Round 3 / 6 / 7 smoke assertions that do `expect(msg).toEqual({ id, roomId, userId, username, body, createdAt })` continue to pass unchanged.

### 3. Update `/shared/types/index.ts`
Append `export * from './attachment';` between the existing `./message` and `./invitation` exports so barrel imports resolve `Attachment`, `AttachmentKind`, `UploadAttachmentResponse`.

### 4. Extend `/shared/api-contract.md`

#### 4a. New top-level `## Attachment Endpoints` section
Append AFTER the existing `## Direct Message Endpoints` section (and BEFORE `## User Ban Endpoints`, keeping rough chronological grouping).

Content:

- **Rules**:
  - Authenticated (Bearer). 401 on missing / invalid / expired token.
  - Upload cap: 20 MB for non-image files; 3 MB for image MIMEs (requirement §3.4). Exceeding either → `413 { "error": "File exceeds size limit" }`. Note: 413 (not 400) because `multer` triggers `LIMIT_FILE_SIZE` before our validator runs; the errorHandler maps that to 413 with the verbatim string above.
  - MIME whitelist for image slot (`kind='image'`): `image/png`, `image/jpeg`, `image/gif`, `image/webp`. All other MIMEs are accepted as `kind='file'` up to the 20 MB cap. Unknown / missing `Content-Type` → rejected as `400 { "error": "Unsupported file type" }`.
  - The server performs a magic-byte sniff on the first chunk and rejects if the client-declared MIME contradicts the actual bytes (defense-in-depth): `400 { "error": "File content does not match declared type" }`.
  - Each uploaded row starts `status='pending'` and is invisible to any chat UI until committed. A committed row (`status='attached'`) is permanent until the parent message or room is deleted.
  - Orphan sweep: pending attachments older than 1 hour are deleted (row + on-disk file) by a server-side background job. No client-visible behaviour; documented here so future rounds don't assume pending rows are durable.
  - Room-membership gate on download: caller must be a current member of the attachment's `roomId`. Former members lose read access (requirement §2.6.4 / §2.6.5).
  - DM ban gate on upload: if the target `roomId` is a DM and there's an active `user_bans` row between the two participants (in either direction), `POST /api/attachments` returns `403 { "error": "Personal messaging is blocked" }` — identical string to the `message:send` ack (Round 6), so the FE can reuse the same frozen-composer UX.
  - Per-attachment `comment`: optional; max 200 characters (trimmed); empty-after-trim is stored as `null`.

- **Summary table**:

  | Method | Path | Body | Success | Errors |
  |--------|------|------|---------|--------|
  | POST | `/api/attachments` | `multipart/form-data` — field `file` + optional `roomId` + optional `comment` | `201 UploadAttachmentResponse` | `400` missing file / unsupported type / invalid roomId / oversize comment, `403` not a room member / DM blocked, `404` room not found, `413` file too large |
  | GET | `/api/attachments/:id` | — | `200` binary stream with `Content-Disposition` | `403` not a room member, `404` attachment not found |

- **Endpoint detail: `POST /api/attachments`**
  - Multipart form fields:
    - `file` — required, binary, exactly one.
    - `roomId` — required, UUID, must identify a room the caller is a member of at upload time.
    - `comment` — optional, string, trimmed, 0–200 chars.
  - On success:
    ```json
    {
      "attachment": {
        "id": "uuid",
        "roomId": "uuid",
        "uploaderId": "uuid",
        "filename": "spec-v3.pdf",
        "mimeType": "application/pdf",
        "sizeBytes": 142354,
        "kind": "file",
        "comment": "latest requirements",
        "createdAt": "ISO"
      }
    }
    ```
  - The pending row persists for 1 hour or until committed via `message:send`, whichever comes first.

- **Endpoint detail: `GET /api/attachments/:id`**
  - Response headers:
    - `Content-Type: <attachment.mimeType>`
    - `Content-Length: <attachment.sizeBytes>`
    - `Content-Disposition: inline; filename="<rfc5987-encoded>"` when `kind='image'`; `Content-Disposition: attachment; filename="<rfc5987-encoded>"` otherwise.
    - `X-Content-Type-Options: nosniff`
    - `Cache-Control: private, max-age=0, must-revalidate`
  - Body: raw bytes from disk.
  - Membership check runs BEFORE the file open, so a 403 never leaks disk I/O.
  - No `Range:` header support — single-shot 200 only. Range is out of scope for hackathon.

#### 4b. Extend the `#### message:send` block under `## Socket Events → Client → Server events`

Add the following to the existing Round 3 block (do NOT rewrite it):

- Payload shape updated: `SendMessagePayload` now additionally accepts `attachmentIds?: string[]`. Validation extends with:
  - Each id must be a UUID.
  - Max 5 ids per send (D2).
  - Each id must refer to an attachment row with `status='pending'`, `uploader_id = caller`, and `room_id = payload.roomId`. Any mismatch returns the new ack failure string verbatim: `{ "ok": false, "error": "Invalid attachment reference" }`. Use one string for all three sub-failures — the client can't distinguish "wrong uploader" from "wrong room" from "already attached" at the UX level anyway, so a single generic message keeps the contract tighter.
  - Body vs attachments: require `body.trim().length >= 1` OR `attachmentIds.length >= 1`. A send with empty body AND no attachments returns the existing `{ "ok": false, "error": "Body must be between 1 and 3072 characters" }` (do NOT introduce a new string here — the FE guards against this and an empty+no-attach send is a bug/race either way).
- Ack `message.attachments`: populated when the send referenced `attachmentIds`; omitted otherwise (matches the `Message` type's optional field).
- On success the server atomically flips each referenced attachment's `status` to `'attached'` and sets `message_id` in the same transaction that inserts the message row. Failure partway: the whole send fails with a 500-equivalent ack (`{ ok: false, error: "Internal server error" }`). The pending rows stay `pending` and the sweep eventually cleans them.
- Broadcast: `message:new` to the room carries the same `Message` shape (including `attachments`).

Also extend the existing `#### message:new` subsection under `### Server → Client events` with one sentence: "Round 8: `message.attachments` is populated whenever the message was sent with one or more attachment ids. Absent for attachment-less messages."

#### 4c. Housekeeping
- Grep `shared/api-contract.md` for "Round 8" forward-references; drop any "Round 8 will …" note that's been superseded now that Round 8 is landing. Preserve Round 9+ forward-references.

### 5. Update `docker-compose.yml`
Add a `uploads_data` named volume + mount it into the backend container. Leave everything else untouched.

Diff sketch:

```yaml
services:
  backend:
    # ... existing keys unchanged ...
    volumes:
      - uploads_data:/app/uploads   # NEW

volumes:
  postgres_data:
  uploads_data:                      # NEW
```

Rationale: `uploads_data` is the idiomatic docker-compose convention (matches `postgres_data`); files survive `docker compose down` + `up` without leaking host paths into the repo. Path inside the container (`/app/uploads`) matches `UPLOADS_DIR` in `backend/.env.example`.

### 6. Confirm `backend/.env.example` already carries `UPLOADS_DIR`
Verify-only step. The key is already present (`UPLOADS_DIR=/app/uploads` — added in an earlier round's groundwork pass). If missing, add it; otherwise leave as-is.

### 7. No agent description changes
`.claude/agents/backend-developer.md` already lists `multer` under its stack section (`**File uploads**: \`multer\` (Round 4+)`). Round 8 is when that landed. Optional housekeeping: tighten the wording from "Round 4+" to "Round 8+" OR drop the round number entirely — either is fine; if you touch it, do not restructure the rest of the file.

### 8. No master-plan update
Round 8 bullet in `plans/master-plan.md` still reads accurately after this round's scope. Do not edit. (Same policy as Round 7.)

## Wrap-up
Write `plans/round-8/orchestrator_work_summary.md` with:
- **Built** — files touched under `/shared/` (`attachment.ts` new; `index.ts` + `message.ts` + `api-contract.md` extended), the two new REST endpoints, the `message:send` payload + ack extension, the docker-compose volume.
- **Deviations** — likely pressure points: (a) the `"Invalid attachment reference"` generic ack string vs more specific ones (BE may ask for three distinct strings — hold firm unless compelling reason); (b) upload body form field names — if BE picks different field names (`attachment` instead of `file`) they must update the contract, not silently diverge; (c) whether the `kind` discriminator lives on the `Attachment` type or is computed FE-side from `mimeType` (locked on the type — FE should NOT recompute).
- **Deferred** — thumbnail generation, signed URLs, EXIF stripping, virus scanning, `Range:` header support, message-edit re-attach, orphan-sweep observability (metrics / log volume). Also still deferred from Round 7: `message:send` migration into `ClientToServerEvents`.
- **Next round needs to know**
  - For Round 9 (pagination): `GET /rooms/:id/messages?before=&limit=` must return `attachments` on each `Message` — the cursor endpoint should join / resolve attachments the same way `message:new` does. The JOIN can be a separate query batched over returned ids; denormalise the same way.
  - For Round 10 (message actions): the `messages → attachments` cascade (`ON DELETE CASCADE`) handles message deletion automatically — but the on-disk files are NOT removed by the cascade; the message-delete handler must unlink files via `fs.promises.unlink` in the same transaction's `afterCommit` hook. Same concern for message edits that would remove an attachment (out of Round 10 scope but worth flagging for Round 10's planner).
  - For Round 11 (moderation / room deletion): the `rooms → attachments` cascade handles row deletion; on-disk files must be unlinked by the room-delete handler. Same `afterCommit` pattern. Round 11 planner must read this note.
  - For Round 12 (unread / public catalog): no coupling. Unread counts don't read attachments.
- **Config improvements** — candidate items: thumbnail pipeline (`sharp` dep, adds `thumbnailUrl?: string` on `Attachment`); signed download URLs so image `<img src>` could be used directly (saves the Blob round-trip at the cost of a signing infra); EXIF stripping on image upload; per-room storage quotas; orphan-sweep interval tuning; attachment-count limit as an environment variable instead of a hard-coded 5.
