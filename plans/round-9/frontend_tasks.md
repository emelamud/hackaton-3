# Round 9 — Frontend Tasks

## Goal
Ship infinite-scroll-upwards on the message list: load older pages via `?before=<messageId>&limit=50`, preserve the user's scroll anchor when prepending, show a top-of-list loading spinner during fetch, and render an end-of-history sentinel when the floor is reached — without regressing the Round-3/6/7/8 scroll behaviours (initial-scroll-to-bottom, stick-to-bottom on new messages, image-resolution re-anchor).

## Dependencies
- `/shared/api-contract.md` — rewritten `### GET /api/rooms/:id/messages` (`?before=`, `?limit=`, `MessageHistoryResponse`, new `Invalid cursor` error string).
- `/shared/types/message.ts` — new `MessageHistoryResponse { messages: Message[]; hasMore: boolean }`.
- **Do not modify `/shared/`.** If a contract / type change is needed, report to the orchestrator.
- `frontend/CLAUDE.md` — folder structure, services, routing.
- `.claude/skills/design-system/SKILL.md` + `frontend/docs/DESIGN_SYSTEM.md` — utility classes, no hex / no `px` / no `--mat-sys-*` / no inline style.
- `plans/round-8/frontend_work_summary.md` §Next round needs to know — Round-8 flagged that the `(loaded)` output on `MessageAttachmentComponent` drives the "re-pin to bottom when near-bottom" logic. Round 9 must NOT break this path; the scroll-anchor logic for pagination must coexist with the existing `pendingScrollToBottom` flag.

## Tasks

### 1. Extend `MessagesService` — `frontend/src/app/chat/messages.service.ts`

Replace the existing `getRecent(roomId)` with a paginated `getHistory` call that returns the new response shape. Keep a thin backward-compatible shim if any other caller depends on `getRecent` (grep — only `message-list.component.ts` calls it today, so a clean rename is fine).

```ts
getHistory(
  roomId: string,
  options: { before?: string; limit?: number } = {},
): Observable<MessageHistoryResponse> {
  let params = new HttpParams();
  if (options.before) params = params.set('before', options.before);
  if (options.limit != null) params = params.set('limit', String(options.limit));
  return this.http.get<MessageHistoryResponse>(
    `${this.baseUrl}/${roomId}/messages`,
    { params },
  );
}
```

Delete / rename `getRecent` — it no longer matches the wire shape. Leave `send(...)` and `newMessages$(...)` untouched (Round 8 shapes still correct).

### 2. Rewrite pagination state in `MessageListComponent` — `message-list.component.ts`

Add these signals alongside the existing `messages`, `loading`, `loadError`:

```ts
readonly hasMore = signal(false);           // true when older pages exist server-side
readonly loadingMore = signal(false);       // true while a paginate-up fetch is in flight
readonly loadMoreError = signal(false);     // surface retry CTA on the top spinner
```

Private fields for the anchor-preservation restore:

```ts
private pendingAnchorRestore = false;
private capturedScrollHeight = 0;
private capturedScrollTop = 0;
```

#### 2a. Initial load

Rename `loadRecent()` → `loadInitial()`. It now calls `getHistory(roomId)` (no cursor, default limit):

```ts
this.messagesService.getHistory(this.roomId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
  next: (res) => {
    this.messages.set(res.messages);
    this.hasMore.set(res.hasMore);
    this.loading.set(false);
    this.pendingScrollToBottom = true;   // unchanged: scroll to bottom on first paint
  },
  error: () => { this.loading.set(false); this.loadError.set(true); },
});
```

Room-swap path (`ngOnChanges` for `roomId`) must also reset `hasMore` + `loadingMore` + `loadMoreError` + clear any pending anchor-restore state:

```ts
this.messages.set([]);
this.hasMore.set(false);
this.loadingMore.set(false);
this.loadMoreError.set(false);
this.pendingAnchorRestore = false;
this.loadInitial();
this.subscribeToNewMessages();
```

#### 2b. Paginate-up trigger

Bind a scroll handler on the `#scrollContainer` element. Fire the fetch when the user scrolls near the top AND there's more to load AND we're not already loading.

Template:
```html
<div
  #scrollContainer
  class="message-list__scroll px-5 py-4"
  (scroll)="onScroll()"
>
```

Handler:
```ts
onScroll(): void {
  const el = this.scrollContainer?.nativeElement;
  if (!el) return;
  if (!this.hasMore() || this.loadingMore() || this.loadMoreError()) return;

  const rootFontSize =
    parseFloat(getComputedStyle(document.documentElement).fontSize || '16') || 16;
  const triggerPx = 4 * rootFontSize;  // ~4rem from the top
  if (el.scrollTop < triggerPx) {
    this.loadMore();
  }
}
```

`loadMore()` captures the anchor snapshot, sets the pending-restore flag, fires the request, and on response prepends + dedupes:

```ts
private loadMore(): void {
  const el = this.scrollContainer?.nativeElement;
  if (!el) return;
  const current = this.messages();
  if (current.length === 0) return;          // nothing to anchor on

  this.loadingMore.set(true);
  this.capturedScrollHeight = el.scrollHeight;
  this.capturedScrollTop = el.scrollTop;
  this.pendingAnchorRestore = true;

  this.messagesService
    .getHistory(this.roomId, { before: current[0].id })
    .pipe(takeUntilDestroyed(this.destroyRef))
    .subscribe({
      next: (res) => {
        const existingIds = new Set(current.map((m) => m.id));
        const deduped = res.messages.filter((m) => !existingIds.has(m.id));
        this.messages.update((list) => [...deduped, ...list]);
        this.hasMore.set(res.hasMore);
        this.loadingMore.set(false);
      },
      error: () => {
        this.loadingMore.set(false);
        this.loadMoreError.set(true);
        this.pendingAnchorRestore = false;   // nothing to restore; abort
      },
    });
}
```

#### 2c. Anchor-preservation — extend `ngAfterViewChecked`

Existing logic drains `pendingScrollToBottom`. Add the anchor-restore branch BEFORE the bottom-pin drain (anchor-restore is a prepend-side operation; bottom-pin is an append-side operation; on the same tick only one can be set, but evaluate anchor-restore first out of defensive ordering):

```ts
ngAfterViewChecked(): void {
  if (this.pendingAnchorRestore && this.scrollContainer) {
    const el = this.scrollContainer.nativeElement;
    const delta = el.scrollHeight - this.capturedScrollHeight;
    el.scrollTop = this.capturedScrollTop + delta;
    this.pendingAnchorRestore = false;
  }
  if (this.pendingScrollToBottom && this.scrollContainer) {
    const el = this.scrollContainer.nativeElement;
    el.scrollTop = el.scrollHeight;
    this.pendingScrollToBottom = false;
  }
}
```

The delta approach keeps the user glued to the same visible message even as multi-image pages expand height asynchronously — because attachment blobs resolving later fire through `onAttachmentLoaded()`, which already tests `isNearBottom()` before re-pinning. A scrolled-up user is not near-bottom, so images inside the prepended slice do NOT trigger a bottom re-pin. Confirm this coexistence in manual testing (exercise item 5 below).

### 3. Render the pagination UI in `message-list.component.html`

Inside the scroll container, BEFORE the `@for (m of messages(); ...)` block, add a top-of-list region that shows one of three states: loading, error+retry, or end-of-history sentinel (when `!hasMore() && messages().length > 0`).

```html
<div #scrollContainer class="message-list__scroll px-5 py-4" (scroll)="onScroll()">
  @if (loadingMore()) {
    <div class="message-list__top-state gap-2 py-3">
      <mat-progress-spinner diameter="20" mode="indeterminate" />
      <span class="text-label-small text-on-surface-variant">Loading older messages…</span>
    </div>
  } @else if (loadMoreError()) {
    <div class="message-list__top-state bg-error-container text-on-error-container gap-2 p-2">
      <mat-icon>error_outline</mat-icon>
      <span class="text-body-small">Could not load older messages.</span>
      <button mat-button type="button" (click)="retryLoadMore()">Retry</button>
    </div>
  } @else if (!hasMore() && messages().length > 0) {
    <div class="message-list__top-state gap-2 py-3 text-on-surface-variant">
      <mat-icon>history</mat-icon>
      <span class="text-label-small">Start of conversation</span>
    </div>
  }

  @if (messages().length === 0) {
    <div class="message-list__empty ...">…existing empty state…</div>
  } @else {
    @for (m of messages(); track trackById($index, m)) {
      …existing message row markup…
    }
  }
</div>
```

Keep the Round-8 body/attachments rendering inside the `@for` block unchanged.

`retryLoadMore()`:
```ts
retryLoadMore(): void {
  this.loadMoreError.set(false);
  this.loadMore();
}
```

Design-system compliance:
- No hex, no `px`, no `--mat-sys-*`, no inline `style`.
- `message-list__top-state` layout: add a small SCSS block (`display: flex; align-items: center; justify-content: center;`) in `message-list.component.scss`. Utility classes cover padding / gap / colour.

### 4. Loading state for the INITIAL page unchanged

The existing full-pane `loading()` state (spinner + "Loading messages…") still covers the first fetch. Pagination uses the top-of-list spinner (task 3) and does NOT replace the full-pane loader — the old messages stay visible while older ones stream in.

### 5. Deduplication semantics

Dedupe on prepend (see task 2b). Also keep the existing dedupe in `appendMessage(message)` (Round-3 behaviour) — it already filters by id. No new dedupe code needed for live messages.

Edge case: during a pagination fetch, a new `message:new` arrives via the socket. `appendMessage` appends at the bottom; the prepend path from pagination runs independently and only modifies the top of the list. The `messages.update(list => [...deduped, ...list])` is a functional replacement of the signal; Angular's signal API serialises reads/writes per change-detection tick, so the two updates don't race at the signal level. Both paths filter by id, so even if a rare broadcast somehow overlaps a paginated message, the second one is dropped.

### 6. Do NOT use `IntersectionObserver`

The scroll handler is enough for the hackathon scale. `IntersectionObserver` on the first message would be marginally more elegant but adds complexity around `roomId` swap (the observed target is recycled) and doesn't benefit the 50-per-page flow. Flag as a Config Improvement in the wrap-up.

### 7. How to exercise this (write into `frontend_work_summary.md`)

Set up a channel with at least 125 messages — easiest via the Round-9 BE smoke harness running first, OR by having the tester run a one-off script that posts 125 messages. Then open that channel in the browser.

1. **Initial open — scroll to bottom**
   - Route: `/chat/<historyChannelId>`.
   - The pane paints directly at the bottom of the last 50 messages.
   - No top spinner visible (scrollTop is ~scrollHeight; not near the top).

2. **Scroll up to trigger pagination**
   - Scroll up to the top of the visible 50 messages.
   - When scrollTop drops below ~4rem, the top-of-list spinner appears with "Loading older messages…".
   - After the fetch completes, 50 older messages prepend above the previously-visible ones.
   - The user's visible message stays in view — the window doesn't jump. Verify by noting the username+timestamp of the message at the top of the visible area BEFORE scrolling up, confirming it's still visible at the same pixel-row AFTER the prepend.

3. **Continue paginating to the floor**
   - Repeat scroll-up → spinner → prepend until the server returns `hasMore: false`.
   - Once at the floor, the top of the list renders the "Start of conversation" sentinel (history icon + label).
   - Further scrolls to the top do NOT re-fire the fetch (spinner does not reappear).

4. **Live send while scrolled up**
   - With the user scrolled to the top of history, open a second browser session as another channel member.
   - Send a message from session B.
   - In session A (scrolled up), the new message appends silently at the bottom — but the user's viewport stays put on the old history. (Round-3's "stick to bottom only when at bottom" logic still applies.)
   - Scroll to the bottom → the new message is visible.

5. **Paginated page containing images**
   - Ensure the channel's older history includes some image messages (the harness interleaves them).
   - Scroll up to trigger a page that includes images. When the page prepends, each image fires its `(loaded)` event as the blob resolves.
   - The viewport does NOT re-pin to the bottom (the user is not near-bottom). The visible message stays pinned where the anchor-restore put it.

6. **Room swap resets pagination**
   - Paginate up a few pages in channel A (load ~200 messages into the DOM).
   - Click another room in the sidebar.
   - On returning to channel A, the initial 50-newest are loaded fresh (not 200). The top sentinel / spinner state is clean.

7. **Pagination error + retry**
   - Kill the backend (e.g. `docker compose stop backend`). Scroll up in an already-loaded channel.
   - Top-of-list error card appears: "Could not load older messages." + Retry button.
   - Restart the backend and click Retry. The page loads; normal flow resumes.

8. **Empty room**
   - Open an empty channel (create one as the tester, don't send any messages).
   - Pane shows the existing "No messages yet. Say hi!" empty state.
   - No top spinner or sentinel renders (both guarded on `messages().length > 0`).

9. **Exactly-50 room**
   - Open a channel with exactly 50 messages.
   - Initial load fills the pane; `hasMore === false`.
   - Scrolling up shows the "Start of conversation" sentinel at the top; no additional fetch fires.

### 8. Verification gate (FE side)
- `pnpm lint` in `frontend/` — clean.
- `pnpm build` in `frontend/` — clean, no warnings.
- `pnpm exec tsc --noEmit -p tsconfig.app.json` — clean. Key assertion: `MessageHistoryResponse` resolves through `@shared`.
- Design-system spot-check of the diff: `grep -rnE '#[0-9a-fA-F]{3,6}|var\(--mat-sys|[0-9]+px|style="'` against the modified FE files — zero matches.
- No `innerHTML`, no `bypassSecurityTrust*` anywhere in the diff.
- **Do NOT use Playwright MCP.** Do not start `ng serve`. Do not browse. That's the `frontend-tester` agent's job after the round lands.

## Wrap-up
Write `plans/round-9/frontend_work_summary.md` with sections: **Built**, **How to exercise this** (items 1–9 above, refined based on what actually shipped), **Deviations**, **Deferred**, **Next round needs to know**, **Config improvements**.

Likely deviations worth flagging:
- If the scroll trigger threshold ends up different (e.g. 2rem instead of 4rem) based on feel, note it.
- If the anchor-restore math needed a `requestAnimationFrame` wrapper because `ngAfterViewChecked` fired before layout committed, note the workaround.
- If you extract the scroll math into a helper / directive, say where.
- If the "Start of conversation" sentinel ends up conflicting with the empty-state copy in a one-message room, note the guard.

Likely deferrals:
- `IntersectionObserver`-based trigger (see task 6).
- Virtual scrolling / windowed rendering for very long histories (Angular CDK `<cdk-virtual-scroll-viewport>` + inverted mode). Fine for Round 9's scale (125 × active room).
- LRU eviction of very-old pages once the user has scrolled back past a threshold (memory ceiling).
- Persisted scroll position across `roomId` swap ("return to last-read"). Round 12 will likely touch this when unread lands.
- Animated entry for prepended pages.

Likely config improvements:
- Promote the pagination trigger threshold (`4rem`) to a component const or environment knob.
- LRU cap on the in-memory message array per room.
- `requestAnimationFrame` double-buffering on anchor restore if visible flicker shows up on slower machines.
- Re-evaluate prepending strategy once virtual scroll lands.
