# Round 8 — Frontend Work Summary

## Built

**New — `frontend/src/app/core/attachments/attachments.service.ts`**
- Root-scoped service that owns `POST /api/attachments` uploads + `GET /api/attachments/:id` blob fetching.
- `upload(file, roomId, comment)` streams `HttpEventType.UploadProgress` events as `{ kind: 'progress', progress: 0..1 }` and finally one `{ kind: 'final', attachment: Attachment }`. Errors propagate as `HttpErrorResponse` — the composer maps `413 → 'File too large'`, `400` with `"Unsupported file type"` / `"File content does not match declared type"` → user-readable strings, `403` with `"Personal messaging is blocked"` → triggers the same retroactive-ban path as `message:send`.
- `objectUrlFor(attachmentId)` returns a `Signal<string | null>`. First read per id dedupes the HTTP fetch via a pending-promise map, minted `blob:` URLs are kept in `objectUrlCache`. 403 / 404 / network errors resolve the signal to `null` (template renders a placeholder card).
- `reset()` revokes every `blob:` URL, empties the blob cache, clears the pending-fetch map, and resets every live signal handle. Called from `AuthService.clearSession()`.
- No `DomSanitizer` / no `bypassSecurityTrust*` — Angular allows `blob:` through `SecurityContext.URL` by default.

**Modified — `frontend/src/app/core/auth/auth.service.ts`**
- Imports + eager-injects `AttachmentsService` alongside the existing `DmsService` / `PresenceService` pattern.
- `clearSession()` now calls `attachmentsService.reset()` after the presence wipe.

**Modified — `frontend/src/app/chat/messages.service.ts`**
- `send(roomId, body, attachmentIds?)` now accepts the optional third arg and appends it to the `SendMessagePayload` only when non-empty (pre-Round-8 callers / smoke assertions still round-trip).

**Rewritten — `frontend/src/app/chat/message-composer.component.{ts,html,scss}`**
- Added `pendingAttachments` signal of `PendingAttachment` entries — each carries a `localId`, the raw `File`, a local preview `blob:` URL (images only), upload progress 0..1, upload error string, server-assigned attachment id, and a `FormControl<string>` with `maxLength(200)` for the per-attachment comment.
- New `attach` button (`mat-icon-button`, paper-clip icon) LEFT of the textarea; clicks a hidden `<input type="file" multiple>`. Disabled when at cap (5), frozen (DM ban), or submitting.
- Drag-and-drop — `dragover` / `dragleave` / `drop` host listeners. A dashed-border overlay (`bg-primary-container text-on-primary-container border-primary`) paints while the user is dragging a file over the composer. DND no-ops when `isFrozen()`.
- Paste handler on the textarea — extracts files from `ClipboardEvent.clipboardData.items` where `item.kind === 'file'`; plain-text pastes flow through unchanged.
- Cap of 5 pending attachments enforced FE-side. Overflow shows a mat-snackbar "You can attach at most 5 files per message" and drops the extras.
- Pending-attachment rail above the textarea. Each chip shows: image thumbnail (for images, from a local `URL.createObjectURL(file)`) OR a file-icon tile, the filename (truncated), a close-X button, a `mat-progress-bar` during upload, the error string (in `text-error`) on failure, and a single-line comment input bound to the entry's `commentControl`.
- Upload-on-send (option B from the task file): `onSubmit()` iterates sequentially over `pendingAttachments()`, uploads each file with its current comment, accumulates the returned `attachment.id`s, then fires `messages.send(roomId, body, uploadedIds)`. If any individual upload fails the chip's `uploadError` is set and the overall send stops — the user must remove the chip or retry (removing then re-adding).
- Already-uploaded entries (from a prior failed submit) are detected by `serverAttachmentId !== null` and reused on retry — a second click of Send after a `message:send` failure does NOT re-upload already-committed files.
- Attachment-only messages work: the empty-body guard now accepts an empty body when at least one attachment is queued.
- Error UX priorities:
  - Upload 413 → chip reads "File too large".
  - Upload 400 `"Unsupported file type"` → "This file type isn't supported".
  - Upload 403 `"Personal messaging is blocked"` → `UserBansService.markIncoming(peerId)` freezes the composer.
  - `message:send` ack `"Invalid attachment reference"` → clears the rail and surfaces "Attachments expired; please re-attach".
  - `message:send` ack `"Personal messaging is blocked"` → same retroactive-freeze path as Round 6.
- Memory hygiene: every `URL.createObjectURL(file)` minted for a local preview is revoked when the chip is removed, when the room is swapped, and after a successful send. Server-side blobs are managed by `AttachmentsService` (revoked on logout).

**New — `frontend/src/app/chat/message-attachment.component.{ts,html,scss}`**
- Standalone, OnPush. `input.required<Attachment>()` named `att`.
- Images branch: `<a target="_blank" rel="noopener">` wrapping `<img [src]="objectUrl()" [alt]="att().filename">` with CSS constraints `max-width: 24rem; max-height: 18rem; object-fit: contain`. Image emits a `(loaded)` output on `load`.
- File branch: `<a mat-stroked-button [href]="objectUrl()" [download]="att().filename">` with icon + filename + formatted size (`formatSize()` helper returns `"X B"` / `"X KB"` / `"X.Y MB"`).
- Placeholder card when `objectUrl()` is `null` (pending fetch OR 403/404). Template keys are all Angular interpolation — zero `innerHTML`, zero `bypassSecurityTrust*`, zero inline styles.
- Comment line rendered underneath as a `<p>` when `att().comment` is non-null.

**Modified — `frontend/src/app/chat/message-list.component.{ts,html,scss}`**
- Imports `MessageAttachmentComponent` (standalone) and renders a vertical `<app-message-attachment>` stack under each message row when `m.attachments?.length`.
- Body `<p>` now renders conditionally — an attachment-only message paints just the attachment stack, no empty paragraph.
- New `onAttachmentLoaded()` method wired to the child's `(loaded)` output. Re-runs the `isNearBottom()` check and re-pins `pendingScrollToBottom = true` if the user was anchored to the bottom — prevents async image resolution from pushing the user off the bottom.

## How to exercise this

Two authenticated sessions (primary browser + private window) as per Round 7. Both users must be members of a shared channel (or an open DM as friends).

### 1. Attach button — image upload + send (single-browser smoke)
- Route: `/chat/<someChannelId>`.
- Click the paper-clip icon left of the textarea → file picker opens.
- Pick a single PNG (~500 KB). A chip appears in the pending rail above the textarea: thumbnail, filename, close-X, empty comment input. No progress bar is visible until you click Send.
- Optionally type a comment in the per-attachment comment field.
- Optionally type a body in the textarea.
- Click Send. The chip's progress bar fills to 100% while the upload runs, then the message lands in the message list with the inline image rendered. The `<img src>` is a `blob:` URL (hover devtools).
- Click the image → opens full-size in a new browser tab (URL is the same `blob:` URL).

### 2. Attach button — file (non-image) upload + send
- Same flow but with a `.pdf` or `.zip`.
- Chip shows a file icon + filename. No thumbnail.
- After Send, the message row renders a `mat-stroked-button` download card with `insert_drive_file` → filename → formatted size.
- Click the card → browser downloads the file with the original filename (the BE sets `Content-Disposition: attachment`).

### 3. Drag-and-drop upload
- Drag an image file from the desktop onto the composer area.
- A dashed `bg-primary-container` overlay with "Drop files to attach" paints while the drag is active.
- On drop the file appears in the pending rail exactly like the file-picker flow. The overlay disappears.
- Type a body + click Send. Lands correctly.

### 4. Paste upload
- Take a screenshot (Win+Shift+S / Cmd+Shift+4).
- Click into the composer textarea → Ctrl/Cmd+V.
- A chip appears with the pasted image thumbnail. Filename is the browser-default for clipboard images (e.g. `image.png`).
- Type a body + Send. Lands with the pasted image rendered inline.
- Separately: paste plain text into the textarea → text appears in the textarea normally; no chip is created, no file upload is triggered.

### 5. Multiple attachments (up to 5)
- Pick 4 images at once via the file picker.
- Pending rail shows 4 chips side by side (wraps below the textarea).
- Try to pick 3 more → the rail fills to 5 and a mat-snackbar reads "You can attach at most 5 files per message"; the overflow files are dropped. The attach button is then disabled (cap reached).
- Type a body + Send → all 5 render stacked vertically in the message row.

### 6. Remove a pending attachment
- Attach 3 images. Click the × on one chip.
- Chip disappears; remaining 2 stay. The attach button becomes enabled again (under cap).

### 7. Per-attachment comment (requirement §2.6.3)
- Attach a single image, type "latest requirements" in the per-attachment comment field on the chip, leave the main textarea blank, click Send.
- Message row renders the image AND "latest requirements" as a body-small text line beneath it. (Empty body + one attachment is a valid send per contract D3.)

### 8. Size cap failure (image)
- Pick an image larger than 3 MB. Click Send.
- During upload the BE responds with 413; the chip's upload-error state activates — a `0.125rem` outline on the chip + an inline "File too large" error line under the filename (styled `text-error`).
- The Send button becomes disabled with the tooltip "Remove failed attachments to send".
- Remove the failing chip → Send re-enables.

### 9. Unsupported type
- Pick a `.exe` or similarly odd file. The BE accepts arbitrary types as `kind='file'` per §2.6.1, so it uploads fine and renders as a download card.
- The "Unsupported file type" branch only fires when the BE rejects (e.g. missing Content-Type on the uploaded part). If exercised, the chip shows "This file type isn't supported" in the error slot.

### 10. DM ban gate
- Peer bans the caller.
- Caller's composer flips to the Round 6 frozen banner. The attach button is NOT rendered (the entire composer row is replaced by the frozen banner).
- Paste and drag-and-drop both no-op while frozen (preventDefault never fires the enqueue).
- Scroll up through prior DM history — images uploaded BEFORE the ban still render inline (BE doesn't ban-gate downloads, per §2.3.5). Click → opens in a new tab.

### 11. Lost-access cleanup
- User leaves a channel they have attachments in. The leave flow (existing Round 4 behaviour) navigates the user off the room view.
- Navigate to a different room and back — prior-session blob URLs that are still in `objectUrlCache` will show, but a fresh page load returns 403 from `GET /api/attachments/:id`, and the component falls back to the placeholder card.

### 12. Logout + re-login lifecycle
- Upload + send an image so it's visible in the room history. Sign out.
- Confirm no console errors. Every live `blob:` URL is revoked by `AttachmentsService.reset()` during `clearSession()`.
- Sign back in, open the same room. The prior image re-renders — blob cache was emptied at logout, so this is a fresh `GET /api/attachments/:id` fetch.

## Deviations

1. **Upload-on-send (option B) shipped, matching task file §3h.** Uploads fire sequentially inside `onSubmit()`, not on file pick. Progress bars only animate during the send action, not while the user is composing. This is the documented choice — called out for tester context.

2. **Drag-and-drop is scoped to the composer host (not the whole chat pane).** Cleaner UX: the overlay draws inside the composer box only. Dropping a file higher up in the message-list pane will no-op (browser default download-as-file behavior).

3. **`MAX_ATTACHMENTS` lives in `message-composer.component.ts`** as a module-scope const. Mirrored from the BE's hard-coded 5 (contract D2). If the BE later moves this to an env var, the FE value should follow.

4. **Drop-target highlight is an overlay, not a mutation of the composer background.** An absolutely-positioned `div` with `pointer-events: none` + dashed border draws on top of the composer while `dragActive()` is true. This was simpler than toggling classes on the form element and keeps the input interactions clean.

5. **`removePending` during a submit is disabled via the chip's close button `[disabled]`.** The task file didn't spell this out; allowing mid-upload removal would require canceling the in-flight `HttpClient` request, which complicates state handling for a low-value edge case.

6. **Already-uploaded entries are NOT re-uploaded on retry after a `message:send` ack failure.** If the first attempt uploads N files and then `message:send` fails with something recoverable (not `"Invalid attachment reference"`), the user can click Send again and only the message-send round-trip re-runs. The exception: `"Invalid attachment reference"` clears the rail entirely because the server already told us the pending rows no longer exist.

7. **Chip-level error outline** uses a `0.125rem` (2px — off the 4px grid) outline rather than a border-role utility class. A 1px border on a surface-container chip was too subtle to convey "this failed"; doubling to 2px keeps the chip legible without swapping the background utility. This is the only off-grid geometry in the composer SCSS.

## Deferred

- Retry button on a failed upload. Current UX: user removes the chip and re-adds the file. Future round can add a "Retry" action next to the "Remove" X.
- Parallel (vs sequential) uploads inside `onSubmit()`. Simpler error model ships first.
- Drag-out-of-chip reordering of pending attachments.
- Inline image zoom / pan controls. `target="_blank"` + the browser's native zoom handles it.
- Lightbox modal (`MatDialog`) for images — deliberately rejected per task file D5, new tab is the locked design.
- Thumbnail placeholders sized from EXIF dimensions. FE has no knowledge of dimensions before the blob resolves; placeholder card is a fixed-size rectangle.
- Client-side pre-validation of file size (saves a round trip on oversize files). Not wired yet.
- Comment-edit after upload. Contract has no `PATCH /api/attachments/:id` endpoint — requires a future orchestrator pass.
- Cancelling an in-flight upload when the user clicks the chip's X mid-send. Currently the remove button is `[disabled]` during submit.
- Integration / e2e tests — carry-over from every prior round.

## Next round needs to know

- `Message.attachments?: Attachment[]` is now populated on BOTH the sender's `message:send` ack AND the broadcast `message:new`. `MessageListComponent.appendMessage()` renders the array — no additional work needed in Round 9's pagination path beyond ensuring `GET /rooms/:id/messages?before=…` hydrates `attachments` per message (already flagged in the orchestrator summary).
- `AttachmentsService.objectUrlCache` never evicts within a session. For Round 9 pagination this means a user scrolling through deep history of image-heavy channels will keep ~one `Blob` per distinct image alive in memory for the whole session. If this becomes a measurable concern, add an LRU cap (orchestrator summary already flagged this as a config improvement).
- The composer's drag-and-drop host listeners are anchored on the composer element, not on the chat-pane or the room-view. If a future design wants a full-pane drop zone (e.g. for Slack-style file drops while scrolling), the listeners would need to move up to `RoomViewComponent` and the overlay would need to re-anchor.
- `pendingAttachments` is cleared whenever `roomDetail` input changes (room swap mid-compose). If a future round adds a "draft per room" feature (Round 14 / polish), this wipe must migrate to a per-room draft store.
- `MessageAttachmentComponent` reads `objectUrlFor` eagerly on first render. Because each `<img>` fetches via the service's shared dedupe map, two messages referencing the same `attachmentId` (theoretically impossible — unique per message — but possible if the BE schema ever allows re-attaching) share a single HTTP fetch. No change needed unless re-attach semantics land.
- The `message-list` scroll-anchor interaction now depends on child image `load` events. If a future round renders non-image attachments with a variable size (e.g. video thumbnails), the `(loaded)` output surface should extend to those too.
- `AttachmentsService.reset()` also resets every per-id signal to `null` before emptying the signal-cache. Any future subscriber that retained a `Signal<string | null>` handle across logout will see `null` (placeholder). In practice the only subscriber is `MessageAttachmentComponent`, which is torn down with the message-list on logout.

## Config improvements

- Re-evaluate upload-on-pick + comment-update endpoint once the first-pass UX is tested with real users. Upload-on-pick feels faster but requires a `PATCH /api/attachments/:id` for comments (not in contract).
- Per-file retry button on a failed upload.
- Client-side pre-validation of file size before the upload round-trip (saves bandwidth on obvious rejects).
- LRU eviction inside `AttachmentsService` (cap the live blob cache at e.g. the last 100 attachments). Prevents long sessions from hoarding megabytes of image bytes.
- Move `MAX_ATTACHMENTS` to a shared constant (or an `environment` value) once the BE's `MAX_ATTACHMENTS_PER_MESSAGE` is promoted to env (flagged in the orchestrator summary).
- `MessageAttachmentComponent` could lazy-load images via `IntersectionObserver` instead of fetching on first render. For long histories of image-heavy channels this would cut both network traffic and memory significantly.
- `message-list`'s scroll-anchor heuristic could use `ResizeObserver` on the scroll container instead of leaning on each child's `(loaded)` event — more general, covers any height change (e.g. expanded multi-line messages later).
- Extract `formatSize()` into a shared utility / pipe once more than one component needs it.
