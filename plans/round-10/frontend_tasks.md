# Round 10 — Frontend Tasks

## Goal
Add message actions to the chat UI: per-message hover toolbar (reply / edit / delete — edit+delete author-only), reply preview in the composer, rendered reply quote block above each reply message, inline edit mode on a message row, delete confirmation, and live application of `message:edit` / `message:delete` socket broadcasts.

## Dependencies
- `/shared/api-contract.md` — READ the Round-10 sections: `## Message Endpoints` (PATCH + DELETE under `/api/messages/:id`), extended `message:send` payload (new `replyToId`, new ack error `'Invalid reply target'`), new `message:edit` + `message:delete` socket events, and the extended `Message` wire shape (`editedAt: string | null` always present; `replyTo?: ReplyPreview | null` with the omit-vs-null distinction). **Do not modify `/shared/` — if something is wrong or missing, report to orchestrator.**
- `/shared/types/message.ts` — `Message.editedAt`, `Message.replyTo`, `ReplyPreview`, `EditMessageRequest`, `MessageDeletedPayload`, `SendMessagePayload.replyToId?`.
- `/shared/types/socket.ts` — the new `ServerToClientEvents` entries.
- Design system (MANDATORY): `.claude/skills/design-system/SKILL.md` + `frontend/docs/DESIGN_SYSTEM.md`. No hex, no `px`, no `--mat-sys-*` direct in templates/SCSS, utilities first, `mat-*` components preferred.
- Existing frontend surfaces:
  - `frontend/src/app/chat/messages.service.ts` — extend with `edit`, `delete`, `onEdit$`, `onDelete$`.
  - `frontend/src/app/chat/message-list.component.ts` / `.html` / `.scss` — extend with hover toolbar, inline edit mode, reply quote rendering, edit/delete socket subscriptions.
  - `frontend/src/app/chat/message-composer.component.ts` / `.html` / `.scss` — extend with a "replying to" chip (reply preview) and `replyToId` on send.
  - `frontend/src/app/chat/room-view.component.ts` — wires composer ↔ message-list for the reply-target handoff (lifting state).
  - `frontend/src/app/core/unread/unread.service.ts` — NOTE: no change required for Round 10; unread count on a deleted message stays stale until next `GET /api/unread`. Documented in orchestrator Config improvements.
- Prior round summaries (context already compacted below; re-read only if a decision seems off):
  - `plans/round-9/frontend_work_summary.md` — pagination anchor-preservation, `messages` WritableSignal is the source of truth, `onAttachmentLoaded` + `isNearBottom()` behaviour.
  - `plans/round-12/frontend_work_summary.md` — `UnreadService` owns `room:read`; don't duplicate socket subscriptions.

## Tasks

### 1. Extend `MessagesService` — edit / delete HTTP + socket streams

In `frontend/src/app/chat/messages.service.ts`:

**`edit(messageId, body)`** — returns `Observable<Message>`:
```ts
edit(messageId: string, body: string): Observable<Message> {
  return this.http.patch<Message>(
    `${environment.apiUrl}/messages/${messageId}`,
    { body } satisfies EditMessageRequest,
  );
}
```

**`delete(messageId)`** — returns `Observable<void>`:
```ts
delete(messageId: string): Observable<void> {
  return this.http.delete<void>(`${environment.apiUrl}/messages/${messageId}`);
}
```

**`editedMessages$()`** — returns `Observable<Message>` from `this.socketService.on('message:edit')`. All edits across all rooms; consumer filters by `roomId`.

**`deletedMessages$()`** — returns `Observable<MessageDeletedPayload>` from `this.socketService.on('message:delete')`.

**Extend `send(...)`** to accept `replyToId?: string`. When present, include it on the `SendMessagePayload`:
```ts
send(roomId: string, body: string, options?: { attachmentIds?: string[]; replyToId?: string }): Observable<Message> {
  const payload: SendMessagePayload = { roomId, body };
  if (options?.attachmentIds?.length) payload.attachmentIds = options.attachmentIds;
  if (options?.replyToId) payload.replyToId = options.replyToId;
  // ... rest unchanged
}
```
Migrate the one existing caller (`message-composer.component.ts`) to the new options-object signature. Keep it type-safe — do NOT overload; a single options argument keeps it readable.

### 2. `MessageListComponent` — hover toolbar + author gating

In `frontend/src/app/chat/message-list.component.ts` / `.html`:

- Inject `AuthService` (needed for the `message.userId === currentUser().id` author check).
- Inject `MatMenuModule`, `MatDialog`, `MatSnackBar`, `MatTooltipModule`.
- Add an `@Output() replyRequested = new EventEmitter<Message>()` — the list emits UP to `room-view` when the user clicks Reply on a row, so the composer can show its "replying to" chip. Do NOT try to reach into the composer from the list directly — keep the component boundary clean.
- Template: on each `@for (msg of messages(); track msg.id)` row, wrap the existing body + attachments in a container that renders a hover-revealed toolbar on the right edge. Use CSS `:hover` + `opacity` transition for the hover reveal (keep it keyboard-accessible via `:focus-within` too). Utility classes only — no hex, no `px`.
- Toolbar buttons (in order): Reply (always visible), Edit (only when `msg.userId === authService.currentUser()?.id`), Delete (same author-only guard). Use `mat-icon-button` with `reply` / `edit` / `delete` Material icons, plus `matTooltip` for each.
- Click handlers:
  - `onReplyClick(msg)` → `this.replyRequested.emit(msg)`.
  - `onEditClick(msg)` → enter inline edit mode (task 3).
  - `onDeleteClick(msg)` → open a confirmation dialog (task 4).

### 3. Inline edit mode on a message row

In `MessageListComponent`:

- Add a signal `editingMessageId = signal<string | null>(null)` — when non-null, the matching row renders in edit mode.
- Add a private FormControl `editControl = new FormControl('', { nonNullable: true, validators: [Validators.maxLength(3072)] })` — one shared control, reset on entering edit mode.
- `onEditClick(msg)`: set `editingMessageId.set(msg.id)`, `editControl.setValue(msg.body)`, then focus the textarea in the next microtask (`queueMicrotask(() => this.editTextarea?.nativeElement.focus())` — use `@ViewChildren` indexed by message id OR a single viewchild via dynamic template ref binding).
- Template for an editing row: replace the body with an `<textarea matInput cdkTextareaAutosize>` + Save / Cancel `mat-button`s. Attachments stay visible above the textarea (they are NOT editable in Round 10 — flagged in orchestrator D12).
- Save handler: validate locally (trimmed length 1–3072 unless the message has ≥1 attachment — look at `msg.attachments?.length`). Call `messagesService.edit(msg.id, editControl.value)`. On success: `messages.update(list => list.map(m => m.id === updated.id ? updated : m))`, `editingMessageId.set(null)`. On error: snackbar with the verbatim server error string (use the same `HttpErrorResponse.error.error` extraction pattern the catalog page uses), keep edit mode open.
- Cancel handler: `editingMessageId.set(null)` — discards.
- Keyboard affordances: `Esc` in the textarea cancels; `Ctrl+Enter` saves. `Enter` alone inserts a newline (consistent with the composer's multiline behaviour — check the composer for the exact pattern and reuse it).

### 4. Delete confirmation dialog

Create a tiny dialog component `frontend/src/app/chat/message-delete-dialog.component.ts` (+ `.html` / `.scss` if needed; or inline the template — 10 lines). Use `MatDialog` + `MatDialogRef` + `MAT_DIALOG_DATA`.

Copy: "Delete this message? This can't be undone."
Buttons: Cancel (stroked), Delete (flat, warn color — use `mat-flat-button color="warn"` or the design-system's equivalent error role utility — do NOT hand-pick a hex).

Flow: `MessageListComponent.onDeleteClick(msg)` → open dialog → if confirmed, `messagesService.delete(msg.id)` → on success: `messages.update(list => list.filter(m => m.id !== msg.id))` (the socket broadcast will also fire and be a no-op reconcile, see task 6). On error: snackbar with the server error string.

### 5. Reply quote block above a reply message

In `MessageListComponent.html`, for each message with `msg.replyTo !== undefined` (i.e. the field is present — could be `null` or a ReplyPreview), render a quote block ABOVE the body:

- `msg.replyTo === null` → render a muted "Replying to a deleted message" line. Small, dimmed (use the on-surface-variant utility or muted-text utility — NOT hand-picked grey).
- `msg.replyTo !== null` (ReplyPreview) → render `@<username>: <bodyPreview>` in a quote-style block. Use Material's standard surface-variant background + left-border accent (achieve via utility classes where possible; the design system has a `border-l-*` or `bg-surface-variant` utility — read `frontend/docs/DESIGN_SYSTEM.md` to confirm the exact class names before writing new SCSS).
- Clicking the quote block SHOULD jump to the target message if it's currently in the loaded `messages()` array. Implement as: `scrollToMessage(id)` — find the `<div data-message-id="$id">` element and `scrollIntoView({ behavior: 'smooth', block: 'center' })`. If the target is not loaded (replyTo id not in `messages()`), do nothing — the FE does NOT load older pages to find a reply target in Round 10. Flag as a config improvement.

Render a "(edited)" indicator after the body when `msg.editedAt !== null`. Use muted utility text (same dimming as the reply quote). Do NOT style bold / italic — follow the Slack-ish convention of a small grey "(edited)" suffix.

### 6. Socket subscriptions — `message:edit` + `message:delete`

In `MessageListComponent.ngOnInit`, subscribe to `messagesService.editedMessages$()` and `messagesService.deletedMessages$()` with `takeUntilDestroyed(this.destroyRef)`:

- `edit` handler: if `updated.roomId === this.roomId`, `messages.update(list => list.map(m => m.id === updated.id ? updated : m))`. If the updated message is NOT in the current list (e.g. it scrolled off an evicted page — not possible today, but defensive), drop it.
- `delete` handler: if `payload.roomId === this.roomId`, `messages.update(list => list.filter(m => m.id !== payload.messageId))`. Also: if `editingMessageId() === payload.messageId`, exit edit mode (`editingMessageId.set(null)`) — the author's own deletion-from-another-tab race.

Reconciliation note: for the author's initiating tab, the HTTP response has already mutated local state. The broadcast arrives shortly after, fires the same map/filter, and is a no-op. This is cheaper than trying to track "who initiated" — embrace the redundancy.

Edge case: room swap while a pending edit/delete is in flight. The component is reused; `ngOnChanges` calls `resetPaginationState()` (Round 9). Ensure the reset also clears `editingMessageId` — just call `editingMessageId.set(null)` inside `resetPaginationState()`.

### 7. Composer — "replying to" chip + sending `replyToId`

In `frontend/src/app/chat/message-composer.component.ts`:

- Add an `@Input() replyTarget: Message | null = null` (or use a signal via `@Input({ alias: ... })`).
- Add an `@Output() replyTargetCleared = new EventEmitter<void>()` — fired when the user clicks × on the chip.
- Template: when `replyTarget !== null`, render a chip ABOVE the textarea (below the attachment previews):
  - Icon: `reply`
  - Text: `Replying to @<username>: <first 80 chars of body>`
  - × button: `mat-icon-button` with `close` icon; click → `replyTargetCleared.emit()`.
  - Use `mat-chip` if it fits; otherwise a div with utility classes matching the design-system chip style.
- Send handler: pass `replyToId: this.replyTarget?.id` (when non-null) to `messagesService.send(...)`. On send success, clear the reply target via `replyTargetCleared.emit()` (parent owns the state).
- On send FAILURE with the new ack string `'Invalid reply target'`: snackbar ("The message you were replying to is no longer available."), then `replyTargetCleared.emit()` so the composer unfreezes. Do NOT retry automatically.

### 8. Room-view — lift reply-target state

In `frontend/src/app/chat/room-view.component.ts`:

- Add a signal `replyTarget = signal<Message | null>(null)`.
- Bind `<app-message-list [roomId]="..." (replyRequested)="replyTarget.set($event)">`.
- Bind `<app-message-composer [roomId]="..." [replyTarget]="replyTarget()" (replyTargetCleared)="replyTarget.set(null)">`.
- Clear the reply target when the user navigates away from or switches rooms (add `replyTarget.set(null)` to the `paramMap` / room-swap effect).

### 9. Author gating visual

The hover toolbar's Edit and Delete buttons MUST be hidden (not just disabled) when the caller is not the author. Implement via `@if (msg.userId === currentUserId())` (signals — `currentUserId = computed(() => this.authService.currentUser()?.id ?? null)`).

The author's OWN reply button should still render — replying to your own message is fine (e.g. adding a follow-up). This matches Slack behavior.

DM ban additional concern: if the user is banned in the open DM, the ENTIRE toolbar should hide (no reply, no edit, no delete — everything is frozen). Reuse the existing `isComposerFrozen` pattern from the composer (source likely `UserBansService` — read it before writing new code). If there's no pre-existing signal, derive: `isDmFrozen = computed(() => room.type === 'dm' && userBansService.hasBanWith(otherUserId()))` — but check for the existing pattern first.

### 10. Verification gate (per frontend-developer.md "Implement mode")

Before writing the summary:
- `pnpm build` in `frontend/` — zero errors, zero TS warnings.
- `pnpm lint` in `frontend/` — zero warnings / errors.
- Design-system spot-check on your diff:
  - `git diff -- frontend/` | grep for any new `--mat-sys-` direct usage, any hex (`#[0-9a-f]{3,6}`), any `px` suffix. Zero hits expected. (Exception: `0px` in existing SCSS is fine if you didn't touch it.)
- Do NOT run Playwright MCP. Do NOT start `ng serve`. Do NOT browse — per the agent frontmatter for Implement mode.

## Wrap-up
Write `plans/round-10/frontend_work_summary.md` following the frontend-developer Implement-mode template:

- **Built** — one bullet per feature, file paths included.
- **How to exercise this** — per feature (reply flow, edit flow, delete flow, multi-tab edit/delete sync, reply-to-deleted rendering, edited indicator): route, setup prerequisites, user steps, expected visible state. The tester will drive from this, so be explicit. Call out browser devtools hints (e.g. "Network tab shows PATCH /api/messages/:id").
- **Deviations** — anything you did differently from the task file; why.
- **Deferred** — anything flagged but out of scope (attachment editing, jump-to-reply-target-loading-older-pages, unread-live-update-on-delete, etc.).
- **Next round needs to know** — specifically flag: any signal names or socket-subscription ownership decisions that a future round (e.g. Round 11 moderation, or a later polish round) must respect to avoid double-subscribing.
- **Config improvements** — ex: shared "muted-text" utility audit, `MessageActionToolbar` extraction to a standalone dumb component if you'd do it again, IntersectionObserver-based reply-target loader.
