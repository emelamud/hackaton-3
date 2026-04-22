# Round 8 — Frontend Tasks

## Goal
Ship the client half of attachments: upload-first UX in the composer (attach button + drag-and-drop + paste handler + per-attachment comment input), an `AttachmentsService` that handles uploads + blob caching + object-URL lifecycle, and a render path in the message list that shows inline images (click → new tab) and download cards for non-images — with zero `innerHTML`, no `bypassSecurityTrust*`, no Markdown.

## Dependencies
- `/shared/api-contract.md` — `## Attachment Endpoints` (new) for the REST shapes; extended `#### message:send` for the `attachmentIds` payload + `Invalid attachment reference` ack string.
- `/shared/types/` — `Attachment`, `AttachmentKind`, `UploadAttachmentResponse`; extended `Message.attachments?` and `SendMessagePayload.attachmentIds?`.
- **Do not modify `/shared/`.** If a contract / type change is needed, report to the orchestrator.
- `frontend/CLAUDE.md` — folder structure, services, routing.
- `.claude/skills/design-system/SKILL.md` + `frontend/docs/DESIGN_SYSTEM.md` — utility classes, no hex / no `px` / no `--mat-sys-*` / no inline style. All attachment UI must comply.
- `plans/round-7/frontend_work_summary.md` §Next round needs to know — DM composer's `isFrozen()` gate is untouched; the attach button must respect it (disabled when frozen) in the same way the send button does.

## Tasks

### 1. New service — `frontend/src/app/core/attachments/attachments.service.ts`

Root-scoped. Owns upload HTTP calls, blob caching, object-URL lifecycle, and logout cleanup.

Shape (approximate — adjust types/names as needed; surface must cover these cases):

```ts
@Injectable({ providedIn: 'root' })
export class AttachmentsService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.apiUrl}/attachments`;

  /** Cache of fetched bytes, keyed by attachmentId. */
  private readonly blobCache = new Map<string, Blob>();
  /** Cache of live object URLs, keyed by attachmentId. Lifecycle-managed. */
  private readonly objectUrlCache = new Map<string, string>();

  /**
   * Upload a single file with progress events. Returns an Observable that
   * emits UploadEvent-style progress updates and finally the created
   * Attachment DTO. The caller (composer) drives the progress UI from
   * these events.
   */
  upload(file: File, roomId: string, comment: string | null): Observable<UploadEvent> {
    const form = new FormData();
    form.append('file', file);
    form.append('roomId', roomId);
    if (comment) form.append('comment', comment);
    return this.http.post<UploadAttachmentResponse>(this.baseUrl, form, {
      reportProgress: true,
      observe: 'events',
    }).pipe(
      map((ev) => this.mapHttpEventToUploadEvent(ev)),
      filter((ev): ev is UploadEvent => ev !== null),
    );
  }

  /**
   * Lazily fetch and cache the blob for an attachment. Emits null until the
   * fetch resolves, then the object URL. Consumers bind this to [src] /
   * [href] directly.
   *
   * Implementation detail: returns a signal<string | null> so templates can
   * use it without async pipe.
   */
  objectUrlFor(attachmentId: string): Signal<string | null> { … }

  /**
   * Clear all cached blobs and revoke all object URLs. Called on logout.
   */
  reset(): void {
    for (const url of this.objectUrlCache.values()) {
      URL.revokeObjectURL(url);
    }
    this.objectUrlCache.clear();
    this.blobCache.clear();
  }
}
```

Key points:
- The HttpClient auth interceptor (already in place from Round 1) adds the Bearer token automatically — do NOT add a second auth mechanism here.
- `objectUrlFor` uses a per-attachmentId pending Promise to dedupe concurrent reads. A second `<img>` for the same attachmentId does NOT trigger a second HTTP fetch.
- `URL.createObjectURL(blob)` is the only place we create URLs. `URL.revokeObjectURL(url)` in `reset()` prevents memory leaks across the session lifecycle.
- Error model: `upload()` errors surface as `HttpErrorResponse` — the composer maps `413` → "File too large", `400` with `"Unsupported file type"` → "This file type isn't supported", `403` with `"Personal messaging is blocked"` → trigger the same `userBansService.markIncoming(peerId)` path the composer already uses on `message:send` failures.
- `objectUrlFor` error path: on a 403 (lost access after leaving the room) OR a 404 (orphan sweep races), return `null` forever; the template shows a placeholder card (broken image fallback handled at the template level).
- No `DomSanitizer` calls. `blob:` URLs are allowed through `SecurityContext.URL` by default.

**Lifecycle wiring — `AuthService`**:
Follow the exact pattern already used for `DmsService` / `UserBansService` / `PresenceService`:
- Inject `AttachmentsService` in `AuthService` so it's eagerly constructed (no lazy-injection edge cases).
- Call `attachmentsService.reset()` from the existing `clearSession()` path (logout + failed refresh). This revokes all object URLs before the next user signs in — critical for preventing cross-session blob leaks.
- No `start()` / `stop()` analogue needed; the service is stateless on login.

### 2. Extend `MessagesService.send`

Currently: `send(roomId: string, body: string): Observable<Message>`.
New signature: `send(roomId: string, body: string, attachmentIds?: string[]): Observable<Message>`.

Update the payload construction:
```ts
const payload: SendMessagePayload = { roomId, body };
if (attachmentIds && attachmentIds.length) {
  payload.attachmentIds = attachmentIds;
}
```
Keep the ack envelope handling unchanged — `ack.message.attachments` is already typed via the shared `Message` extension, so no extra work on the FE to surface it.

### 3. Extend the composer — `message-composer.component.*`

This is the bulk of the UI work. New responsibilities:

#### 3a. Upload queue state
- `pendingAttachments = signal<PendingAttachment[]>([])` where:
  ```ts
  interface PendingAttachment {
    localId: string;              // uuid generated client-side, used as *ngFor trackBy
    file: File;
    previewObjectUrl: string | null; // for images, a local blob URL of the File before upload
    uploadProgress: number;       // 0..1
    uploadError: string | null;
    serverAttachmentId: string | null; // populated after upload ack
    commentControl: FormControl<string>;
  }
  ```
- Max 5 pending at once (matches BE cap, D2). Attach button is `[disabled]="pendingAttachments().length >= 5 || isFrozen() || submitting()"`.

#### 3b. Attach button
Add a `mat-icon-button` inside the composer, LEFT of the textarea (before `mat-form-field`):
```html
<button
  mat-icon-button
  type="button"
  class="composer__attach"
  [disabled]="pendingAttachments().length >= MAX_ATTACHMENTS || isFrozen() || submitting()"
  aria-label="Attach files"
  (click)="fileInput.click()"
>
  <mat-icon>attach_file</mat-icon>
</button>
<input
  #fileInput
  type="file"
  multiple
  hidden
  (change)="onFilesPicked($event)"
/>
```
- `<input type="file" multiple hidden>` keeps the native file picker accessible without polluting the visual layout.
- `onFilesPicked(event)` reads `event.target.files`, reset the input's `value=''` afterwards so the same file can be re-picked (Chrome doesn't fire `change` twice for the same path otherwise), then calls `enqueueFiles(fileList)`.

#### 3c. Drag-and-drop
Bind `dragover` / `drop` / `dragleave` on the composer's host element (or on the whole chat main pane — either works, pick the former for clearer UX). Set a `dragActive = signal(false)` to paint a drop-target highlight (`border-primary`, `bg-primary-container`, etc.).
```ts
@HostListener('dragover', ['$event']) onDragOver(ev: DragEvent) {
  ev.preventDefault();
  this.dragActive.set(true);
}
@HostListener('dragleave') onDragLeave() { this.dragActive.set(false); }
@HostListener('drop', ['$event']) onDrop(ev: DragEvent) {
  ev.preventDefault();
  this.dragActive.set(false);
  if (this.isFrozen()) return;
  if (ev.dataTransfer?.files?.length) {
    this.enqueueFiles(ev.dataTransfer.files);
  }
}
```

#### 3d. Paste handler
Listen on the textarea's `paste` event:
```ts
onPaste(event: ClipboardEvent): void {
  if (this.isFrozen()) return;
  const items = event.clipboardData?.items;
  if (!items) return;
  const files: File[] = [];
  for (const item of items) {
    if (item.kind === 'file') {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  if (files.length) {
    event.preventDefault();
    this.enqueueFiles(files);
  }
  // Otherwise: plain text paste — let the default paste happen.
}
```
Wire `(paste)="onPaste($event)"` on the `<textarea>`.

#### 3e. `enqueueFiles(files)` logic
- Reject if `isFrozen()`.
- Trim the count so total `pendingAttachments().length + files.length <= 5`. Overflow → show a mat-snackbar toast "You can attach at most 5 files per message" and drop the extras.
- For each file:
  - Create a local `PendingAttachment` entry with `localId = crypto.randomUUID()`, `previewObjectUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : null`, `uploadProgress = 0`, `serverAttachmentId = null`.
  - Subscribe to `attachmentsService.upload(file, currentRoom.id, null)` and update the entry's `uploadProgress` on each progress event. On final response: set `serverAttachmentId`. On error: set `uploadError` and surface the error message inline on the chip (see 3g).
- The `commentControl` on each entry is a plain `FormControl<string>('', [Validators.maxLength(200)])`.

Memory: when removing a pending attachment (user clicks X), revoke the `previewObjectUrl` if set. When the message is successfully sent, revoke all previews in one pass.

#### 3f. Pending-attachment rail (above the textarea)
Render the queue as a horizontal flex row of chips above the text input, each chip:
- For images: a 4rem × 4rem thumbnail using `previewObjectUrl` as `<img [src]>`.
- For files: a `mat-icon` (`insert_drive_file`) + filename (truncated to 20 chars).
- Overlay upload progress: either a `mat-progress-bar` at the chip's bottom (value `uploadProgress * 100`) or a `mat-progress-spinner` centered. Pick the progress bar — cleaner with multiple chips side by side.
- Remove button: `<button mat-icon-button><mat-icon>close</mat-icon></button>` top-right.
- A small `<input matInput>` or a compact text field below the chip for the optional comment, bound to `[formControl]="entry.commentControl"`. Placeholder: "Add a comment (optional)". This directly addresses requirement §2.6.3 and the wireframe's `comment:` line.
- Error state: if `uploadError` is set, paint the chip border red and show the error under the filename in `text-label-small text-on-error`.

Layout hint: the rail is `display: flex; gap: 0.5rem; flex-wrap: wrap`. Each chip is roughly `max-width: 10rem`. Use `gap-2` + existing utility classes; custom SCSS only for the thumbnail sizing.

#### 3g. Submit logic
The `onSubmit()` method needs several updates:
- Precondition: disallow submit while ANY pending attachment has `serverAttachmentId === null` and `uploadError === null` (i.e. uploads still in flight). Show a tooltip / subtle disabled state on the send button: "Waiting for uploads…".
- If any `uploadError` is set, the user must remove those entries before they can submit. (Clearer UX than a partial send.)
- Allow submit if `pendingAttachments().length >= 1` even if `body.trim()` is empty — per contract §4 task (D3/D5), attachment-only messages are valid.
- Build the submit payload:
  ```ts
  const attachmentIds = this.pendingAttachments()
    .filter((a) => a.serverAttachmentId !== null && !a.uploadError)
    .map((a) => a.serverAttachmentId!);
  ```
- If any entry has a non-empty comment control, those comments were already persisted at upload time (we pass `null` at upload and don't support comment-after-upload). **Correction**: we need the comment at upload time. Re-architect: upload happens on "Send" click, not on file select. See §3h below.

#### 3h. Upload timing — decision
Two options:
- **(A)** Upload on file pick (progress shown immediately, comment captured later but we'd need to support a comment update endpoint — contract has none).
- **(B)** Upload on Send click (comments captured cleanly, but no progress while user is typing).

The contract does NOT support a separate comment update. **Ship option (B) as a first-pass — uploads fire on Send**, sequentially (simpler error handling) with all comments taken from the `commentControl` values at that moment. Progress still renders in the rail as each upload runs; the Send button flips to a spinner.

This is a deviation from the "upload-first as files land" UX I sketched in the composer section above — update the approach to "upload-on-send" to honor the contract. Mark the alternative (upload on pick + support a comment-update endpoint) in the Config Improvements section of the wrap-up.

Sequentially:
```ts
async onSubmit() {
  // … existing guards …
  this.submitting.set(true);
  try {
    const uploadedIds: string[] = [];
    for (const entry of this.pendingAttachments()) {
      const comment = entry.commentControl.value.trim() || null;
      const att = await firstValueFrom(
        this.attachmentsService.upload(entry.file, currentRoom.id, comment).pipe(
          filter((ev) => ev.kind === 'final'),
          map((ev) => (ev as FinalEvent).attachment),
        ),
      );
      entry.serverAttachmentId = att.id;
      uploadedIds.push(att.id);
    }
    const message = await firstValueFrom(
      this.messagesService.send(currentRoom.id, body, uploadedIds.length ? uploadedIds : undefined),
    );
    this.messageSent.emit(message);
    this.resetComposer();
  } catch (err) {
    // Surface the error; do NOT clear the composer. User can retry.
  } finally {
    this.submitting.set(false);
  }
}
```

Error handling priorities (for UX consistency):
- Upload failure for an individual file → mark that chip's `uploadError`, keep the others. Do NOT proceed with the `message:send` partial — require the user to either remove the failing entry or retry.
- `message:send` failure → same existing error path as today. If the error is `"Invalid attachment reference"` (shouldn't happen in a happy path, but could if the session's attachments got swept or cross-room state drifted), show "Attachments expired; please re-attach" and clear the pending rail.
- `"Personal messaging is blocked"` → reuse the existing Round 6 freeze path (`userBansService.markIncoming(peerId)`).

### 4. Render attachments in message rows — `message-list.component.*`

Today the template renders `message.body` as a single `<p>`. Extend:

#### 4a. New dumb component — `frontend/src/app/chat/message-attachment.component.ts`
Standalone, `OnPush`, takes `attachment: Attachment` as an `input.required<Attachment>()`. Internally branches on `attachment.kind`:

```html
@if (att().kind === 'image') {
  <a
    class="message-attachment message-attachment--image"
    [href]="objectUrl()"
    target="_blank"
    rel="noopener"
    [attr.aria-label]="'Open ' + att().filename + ' in a new tab'"
  >
    @if (objectUrl(); as url) {
      <img [src]="url" [alt]="att().filename" class="message-attachment__image" />
    } @else {
      <div class="message-attachment__placeholder bg-surface-container p-4 gap-2">
        <mat-icon class="text-on-surface-variant">image</mat-icon>
        <span class="text-label-small text-on-surface-variant">Loading…</span>
      </div>
    }
  </a>
} @else {
  <a
    mat-stroked-button
    class="message-attachment message-attachment--file gap-2"
    [href]="objectUrl()"
    [download]="att().filename"
    [attr.aria-label]="'Download ' + att().filename"
  >
    <mat-icon>attach_file</mat-icon>
    <span class="text-body-medium">{{ att().filename }}</span>
    <span class="text-label-small text-on-surface-variant">{{ formatSize(att().sizeBytes) }}</span>
  </a>
}
@if (att().comment) {
  <p class="text-body-small text-on-surface-variant m-0">{{ att().comment }}</p>
}
```

- `objectUrl()` is a `Signal<string | null>` from `attachmentsService.objectUrlFor(att().id)`.
- `formatSize(bytes)` is a tiny helper: `< 1024` → `"X B"`, `< 1048576` → `"X KB"`, else → `"X.Y MB"`.
- No `innerHTML`, no `bypassSecurityTrust*`.
- The image `<img>` is CSS-constrained: `max-width: 24rem; max-height: 18rem; object-fit: contain;` to keep the message pane readable even with max-size 3 MB images.

Styling lives in `message-attachment.component.scss`. Use utility classes + minimal custom SCSS for the image sizing constraint only. Design-system spot check: no hex, no `px`, no `--mat-sys-*`, no inline style.

#### 4b. Wire it into `message-list.component.html`
Inside the per-message block, after the body `<p>`, render:
```html
@if (message.attachments?.length) {
  <div class="message__attachments gap-2">
    @for (att of message.attachments; track att.id) {
      <app-message-attachment [att]="att" />
    }
  </div>
}
```
Layout: `display: flex; flex-direction: column; gap: 0.5rem;` so multiple attachments stack vertically. Utility classes cover this.

#### 4c. Scroll-anchor interaction
Images inside the scrollable history can change their rendered height as they load (the object URL resolves async). This breaks the "stick to bottom" logic in `message-list.component.ts` — by the time the image is fully rendered, we've already decided whether to scroll. Two mitigation options:
- (A) Reserve vertical space: on each `Attachment`, we don't carry dimensions from the BE (no thumbnail step), so we can't reserve exactly. But we can constrain the `<img>` to a fixed max-height in CSS, which limits the delta to at most the image's natural height vs the 18rem cap.
- (B) On the `<img>` `load` event inside `message-attachment.component.ts`, emit a `loaded` output the message-list listens to; message-list re-checks `isNearBottom()` + re-sets `pendingScrollToBottom` if the user was anchored to the bottom.

Ship option (B) — it's 10 lines in the leaf component and ~5 lines in the list. Without it, opening a chat with a recent image at the bottom paints above the fold and the user has to scroll down manually.

### 5. Handle `message:new` with attachments
No code change: the existing `newMessages$(roomId)` subscription in `message-list.component.ts` passes the full `Message` to `appendMessage`, and the new template renders `message.attachments` automatically when populated.

**DM screen behaviour across the ban**: if the alice⇄bob DM has prior attachments and bob bans alice, alice can still see the old images because the BE's download endpoint does NOT check the ban (read access to frozen history). Tester should verify this (see §6 exercise step 10).

### 6. How to exercise this (write verbatim into `frontend_work_summary.md`)

Two authenticated sessions (primary browser + private window) as per Round 7. Both users must be members of a shared channel (or opened a DM as friends).

1. **Attach button — image upload + send (single-browser smoke)**
   - Route: `/chat/<someChannelId>`.
   - Click the paper-clip icon next to the composer → file picker opens.
   - Pick a single PNG (~500 KB). A chip appears in the pending rail above the textarea: thumbnail, filename, progress-bar at 0.
   - Optionally type a comment in the per-attachment comment field.
   - Optionally type a body in the textarea.
   - Click Send. The chip's progress bar fills to 100%, the message lands in the message list with the inline image rendered, `<img>` source is a `blob:` URL.
   - Click the image → opens full-size in a new browser tab.

2. **Attach button — file (non-image) upload + send**
   - Same flow but with a `.pdf` or `.zip`.
   - Chip shows the file icon + filename. After send, the message row renders a `mat-stroked-button` download card with filename + human-readable size.
   - Click → browser downloads the file with the original filename (via `Content-Disposition: attachment`).

3. **Drag-and-drop upload**
   - Drag an image file from the desktop onto the composer area.
   - The drop target highlights (`border-primary`, `bg-primary-container`).
   - On drop, the file appears in the pending rail exactly like the picker flow.
   - Type a body + click Send.

4. **Paste upload**
   - Take a screenshot (Win+Shift+S on Windows, Cmd+Shift+4 on Mac).
   - Click into the composer textarea → Ctrl/Cmd+V.
   - A chip appears with the pasted image thumbnail. Filename will be something like `image.png` (browser default for clipboard images).
   - Type a body + Send.

5. **Multiple attachments (up to 5)**
   - Pick 4 images at once via the file picker.
   - Pending rail shows 4 chips side by side.
   - Try to pick a 6th → UI refuses (attach button disabled; OR if the overflow path fires, a mat-snackbar "You can attach at most 5 files per message" shows and the extras are dropped).
   - Type a body + Send → all 5 (or 4) render in the message row stacked vertically.

6. **Remove a pending attachment**
   - Attach 3 images. Click the × on one.
   - Chip disappears; remaining 2 stay. Upload count reflects the removal (attach button re-enables).

7. **Per-attachment comment (requirement §2.6.3)**
   - Attach a single image, type "latest requirements" in the per-attachment comment field, leave the main textarea blank, click Send.
   - Message row renders the image AND the `comment: latest requirements` line beneath it.
   - (Empty body + one attachment is a valid send per D3.)

8. **Size cap failure**
   - Pick a 5 MB PNG. After upload fires, the chip's progress bar turns red, and an inline error "File too large" shows on the chip. Send is disabled until the user removes the failing chip.

9. **Unsupported type**
   - Pick a `.exe` or similarly odd file (if your OS exposes one). The file uploads as `kind='file'` (arbitrary types are allowed per requirement §2.6.1) and works like any other download card.
   - This step is informational — the requirements allow arbitrary types. "Unsupported" only fires on missing/empty Content-Type.

10. **DM ban gate**
    - Peer bans the caller.
    - Composer flips to the existing frozen banner (Round 6 behaviour unchanged). The attach button is not rendered.
    - Scroll up through prior DM history — images from before the ban still render (read access preserved per requirement §2.3.5). Click one → opens in a new tab.

11. **Lost-access cleanup**
    - User leaves a channel they have attachments in.
    - Navigate to a different room and back (the leave flow should route you away — verify the sidebar drops the channel).
    - Prior attachments rendered during the session may still show blob URLs from the cache — that's fine. A fresh browser session (or re-fetching) will return 403, and `objectUrlFor` will return null (placeholder card renders).

12. **Logout + re-login lifecycle**
    - Upload + send an image. Sign out.
    - Confirm: no console errors, no blob-URL leaks in devtools memory panel (the `reset()` call in `AuthService.clearSession()` revoked the URLs).
    - Sign back in, open the same channel. The prior image re-renders (fresh fetch — the blob cache is empty after `reset()`).

### 7. Verification gate (FE side)
- `pnpm lint` in `frontend/` — clean.
- `pnpm build` in `frontend/` — clean, no warnings.
- `pnpm exec tsc --noEmit -p tsconfig.app.json` — clean. Key assertion: `Message.attachments` and `SendMessagePayload.attachmentIds` resolve through `@shared`.
- Design-system spot-check of the diff: `grep -rnE '#[0-9a-fA-F]{3,6}|var\(--mat-sys|[0-9]+px|style="'` against the new and modified FE files — zero matches.
- No `innerHTML`, no `bypassSecurityTrustUrl`, no `bypassSecurityTrustResourceUrl`, no `bypassSecurityTrustHtml` anywhere in the diff.
- **Do NOT use Playwright MCP.** Do not start `ng serve`. Do not browse. That's the `frontend-tester` agent's job after the round lands.

## Wrap-up
Write `plans/round-8/frontend_work_summary.md` with sections: **Built**, **How to exercise this** (items 1–12 above, refined based on what actually shipped — test every path, don't paste verbatim), **Deviations**, **Deferred**, **Next round needs to know**, **Config improvements**.

Likely deviations worth flagging:
- If you end up shipping upload-on-pick instead of upload-on-send (option A in §3h), call that out — it's a UX upgrade but requires a follow-up for comment editing.
- If drag-and-drop ends up scoped to the textarea only (not the whole composer host), note the scope.
- If the `MAX_ATTACHMENTS` constant ends up somewhere other than the composer file, say where.
- If the paste handler accidentally swallows plain-text pastes because of over-eager `preventDefault`, flag it (the code above gates on `item.kind === 'file'` — keep that gate tight).
- If the `loaded` event plumbing for scroll anchoring (§4c option B) ships differently or gets deferred, note the UX trade.

Likely deferrals:
- Retry button on a failed upload (currently the user has to remove + re-add the file).
- Parallel (vs sequential) uploads inside a single `onSubmit()` — simpler error model ships first.
- Drag-out-of-chip reordering of pending attachments.
- Inline image zoom / pan controls (we open full-size in a new tab — the browser's native zoom is sufficient).
- Lightbox modal (`MatDialog`) for images — deliberately rejected per D5, new tab is the locked design.
- Thumbnail placeholders sized from EXIF dimensions (FE has no knowledge of dimensions before the blob resolves).
- Integration / e2e tests — carry-over from every prior round.

Likely config improvements:
- Re-evaluate upload-on-pick + comment-update endpoint once the first-pass UX is tested.
- Pre-validate file size client-side before the upload round-trip fires (saves bandwidth on obvious rejects).
- Per-file retry button.
- `AttachmentsService.objectUrlFor` currently keeps blobs in memory forever across a session; consider an LRU cap (e.g. last 100 blobs retained) for users scrolling through long image-heavy history.
- Thumbnail pipeline if 3 MB images feel heavy in long scroll history.
