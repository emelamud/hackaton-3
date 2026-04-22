# Round 9 — Frontend Work Summary

## Built

**Modified — `frontend/src/app/chat/messages.service.ts`**
- Replaced `getRecent(roomId): Observable<Message[]>` with
  `getHistory(roomId, options?: { before?: string; limit?: number }): Observable<MessageHistoryResponse>`.
- Builds `HttpParams` from the optional fields — omits `before` / `limit` entirely when not supplied so the BE applies its defaults.
- `MessageHistoryResponse` is imported from `@shared`; no bare-array shape remains (zero callers depend on the old signature — grep confirmed only `message-list.component.ts` touched `getRecent`).
- `send(...)` and `newMessages$(...)` untouched.

**Modified — `frontend/src/app/chat/message-list.component.ts`**
- Added three pagination signals alongside the existing `messages` / `loading` / `loadError`:
  - `hasMore: WritableSignal<boolean>` — driven by `res.hasMore` on every fetch response.
  - `loadingMore: WritableSignal<boolean>` — true only while a paginate-up request is in flight.
  - `loadMoreError: WritableSignal<boolean>` — surfaces the retry CTA; cleared by `retryLoadMore()`.
- Added three private fields for anchor preservation: `pendingAnchorRestore` (boolean flag), `capturedScrollHeight`, `capturedScrollTop`.
- Renamed `loadRecent()` → `loadInitial()`. It now calls `getHistory(roomId)` with no cursor, pulls `messages` + `hasMore` off the response, sets `pendingScrollToBottom = true` so the initial paint lands at the bottom (unchanged Round-3 behaviour).
- `onScroll()` is bound to the `#scrollContainer` `(scroll)` event. Bails early when `!hasMore() || loadingMore() || loadMoreError()`. When `el.scrollTop < 4 * rootFontSizePx` it fires `loadMore()`. Uses `LOAD_MORE_TRIGGER_REM = 4` as a module-scope const.
- `loadMore()`:
  1. Bails if there are no messages (nothing to anchor on).
  2. Captures `el.scrollHeight` and `el.scrollTop` into the private fields and sets `pendingAnchorRestore = true`.
  3. Fires `getHistory(roomId, { before: current[0].id })`.
  4. On `next`: dedupes by id against the existing `messages()` snapshot (same pattern as `appendMessage`), prepends via `messages.update(list => [...deduped, ...list])`, updates `hasMore`, clears `loadingMore`. Includes a defensive guard — if the cursor message is no longer in the list (e.g. the user swapped rooms mid-flight and the pending request resolves after `resetPaginationState`), the response is dropped and the anchor-restore flag is cleared.
  5. On `error`: clears `loadingMore`, sets `loadMoreError`, clears `pendingAnchorRestore` (there is nothing new in the DOM to restore against).
- `retryLoadMore()` clears `loadMoreError` and re-invokes `loadMore()`.
- `ngAfterViewChecked` now has two drain branches, anchor-restore first:
  - `pendingAnchorRestore` → `el.scrollTop = capturedScrollTop + (el.scrollHeight - capturedScrollHeight)`. The delta approach keeps the user glued to the same visible message as the prepended rows add to the top.
  - `pendingScrollToBottom` → pins to the bottom (unchanged).
  On the same tick only one should ever be set; the ordering is defensive.
- `ngOnChanges` room-swap branch now calls a new private `resetPaginationState()` which clears `messages`, `hasMore`, `loadingMore`, `loadMoreError`, `pendingAnchorRestore`, and the captured scroll fields — then `loadInitial()` + re-subscribe. Ensures a fresh 50-newest after any room swap, with no pagination state leaking across rooms.
- `onAttachmentLoaded()` kept verbatim — it still re-runs `isNearBottom()` and re-pins to the bottom only when the user is near-bottom. A scrolled-up user reading old history is NOT near-bottom, so images resolving inside the prepended page do not re-pin; the anchor-preservation delta keeps them glued in place.
- Imported `MatButtonModule` for the Retry button in the top-of-list error card.

**Modified — `frontend/src/app/chat/message-list.component.html`**
- Added `(scroll)="onScroll()"` to the `#scrollContainer` div.
- Inserted a top-of-list region BEFORE the `@for` message loop with three mutually-exclusive states:
  - `loadingMore()` → `mat-progress-spinner` (diameter 20) + "Loading older messages…".
  - `loadMoreError()` → `bg-error-container text-on-error-container` card with `error_outline` icon, "Could not load older messages.", and a `mat-button` Retry.
  - `!hasMore() && messages().length > 0` → `history` icon + "Start of conversation" sentinel.
- All three use the shared `message-list__top-state` helper class for centered flex layout; colour / spacing / typography come from utility classes (no inline styles, no hex, no `px`, no `--mat-sys-*`).
- Existing empty-state (`No messages yet. Say hi!`) and the `@for` body rendering (including Round-8 attachments block) unchanged.

**Modified — `frontend/src/app/chat/message-list.component.scss`**
- Added `.message-list__top-state { display: flex; align-items: center; justify-content: center; border-radius: 0.5rem; }` — pure layout only, no colours/sizes that a utility already provides.

## How to exercise this

All scenarios require the Round-9 BE with at least one channel seeded to ~125 messages (the BE smoke harness does this; the tester can also post 125 messages via a scratch script). Login as a channel member and navigate to `/chat/<historyChannelId>`.

### 1. Initial open — scroll to bottom
- Route: `/chat/<historyChannelId>`.
- Expected: full-pane loader ("Loading messages…") briefly, then the pane paints at the bottom of the newest 50 messages.
- The top-of-list region does NOT render a spinner or sentinel (scrollTop is ~ scrollHeight − clientHeight, nowhere near the top).

### 2. Scroll up to trigger pagination
- Note the username + timestamp of the message currently at the TOP of the visible viewport.
- Scroll up until `scrollTop` drops below ~4rem (about 64 px at a 16 px root).
- Expected: the top-of-list spinner appears with "Loading older messages…". After the fetch completes, 50 older messages prepend above the previously-visible slice.
- The message you noted in step 1 stays in roughly the same pixel row — the viewport does NOT jump to a new place (the `scrollTop` is restored as `captured + (newHeight − oldHeight)`).

### 3. Continue paginating to the floor
- Repeat scroll-up → spinner → prepend until the server returns `hasMore: false` (2–3 pages for a 125-message room).
- Expected: once `hasMore()` is false, the top-of-list region switches to the "Start of conversation" sentinel (`history` icon + the text).
- Further scrolls to the top do NOT re-fire the fetch (the scroll handler short-circuits on `!hasMore()`). Confirm via devtools Network tab — no additional `GET /api/rooms/:id/messages?before=...` calls.

### 4. Live send while scrolled up
- In session A, scroll to the top of the channel (or near it) so you are NOT near the bottom.
- In session B (a second browser / incognito), send a message to the same channel.
- Expected in session A: the new message appends silently at the bottom; the viewport does NOT jump down, because `isNearBottom()` is false and the Round-3 "stick to bottom only when at bottom" gate still applies.
- Scroll manually to the bottom in session A → the new message is visible there.

### 5. Paginated page containing images
- Use a channel whose older history interleaves image messages (the BE seed harness does this).
- Scroll up far enough to pull in a page that contains at least one image.
- Expected: as each `<img>` `blob:` URL resolves, the image fires its `(loaded)` event. Because you are NOT near-bottom, `onAttachmentLoaded()` does not re-pin to the bottom — the anchor-restore branch of `ngAfterViewChecked` has already placed the viewport, and subsequent height changes from image resolution do NOT reset it. The message you were anchored on stays put.

### 6. Room swap resets pagination
- In channel A, paginate up ~2 pages (so the in-memory array holds ~150 messages).
- Click another room in the sidebar.
- Navigate back to channel A.
- Expected: the initial 50-newest load fresh (NOT the 150 you had before). Devtools Network shows a single `GET /api/rooms/<channelA>/messages` with no `before=`. `hasMore()` and `loadingMore()` are reset; no residual spinner or sentinel; no anchor-restore flicker.

### 7. Pagination error + retry
- Have an already-loaded channel (newest page rendered). Then kill the backend: `docker compose stop backend`.
- Scroll up to trigger `loadMore()`.
- Expected: the top-of-list error card appears with "Could not load older messages." + a Retry button. The spinner is gone.
- Restart the backend (`docker compose start backend`, and re-auth if needed).
- Click Retry. Expected: `loadMoreError()` clears, the spinner shows briefly, the older page prepends, anchor holds. Further scroll-up fires additional `loadMore()` calls normally.

### 8. Empty room
- Create a new channel and do NOT post any messages. Navigate to `/chat/<emptyChannelId>`.
- Expected: the full-pane loader shows briefly, then the empty-state paints: `chat_bubble_outline` + "No messages yet. Say hi!".
- No top-of-list spinner, error card, or "Start of conversation" sentinel renders — all three are guarded on `messages().length > 0` (implicit for the sentinel via the `!hasMore() && messages().length > 0` condition, and for the other two via `loadMore`'s early bail when the list is empty).
- Sending a first message via the composer appends it normally.

### 9. Exactly-50 room
- Use a channel with exactly 50 messages (the BE's default page size).
- Expected: initial load paints all 50 and sets `hasMore=false`. The "Start of conversation" sentinel shows at the top of the list immediately (because `!hasMore() && messages().length > 0`).
- Scroll up does NOT fire any `GET ...?before=...` request (confirmed via devtools Network tab); the scroll handler short-circuits on `!hasMore()`.

## Deviations

1. **Stale-response guard in `loadMore()`.** Added a defensive check at the start of the `next` callback: if the cursor id captured at request time is no longer present in `messages()`, the response is dropped. This covers the edge where the user swaps rooms mid-flight — `takeUntilDestroyed` does NOT unsubscribe on room swap (the component is reused), so a stale request from the previous room could otherwise prepend to the new room's thread. The task file didn't call this out explicitly; the guard is cheap and strictly defensive.

2. **`resetPaginationState()` helper.** Extracted the room-swap reset into a private method so the same code runs on every swap, rather than inlining the 6 lines in `ngOnChanges`. No behavioural difference from the task file spec.

3. **`LOAD_MORE_TRIGGER_REM = 4` lives as a module-scope const.** Same pattern as `STICK_TO_BOTTOM_THRESHOLD_REM`. Promoting to environment or runtime config is flagged under Config improvements.

4. **Anchor-restore does not use `requestAnimationFrame`.** `ngAfterViewChecked` fires after layout, so `el.scrollHeight` is already updated when we read it. No flicker observed in manual code-path reasoning; if slower machines show jitter, a `requestAnimationFrame` double-buffer (flagged in Config improvements) can be dropped in without changing the public API.

5. **No sentinel-vs-empty-state conflict.** The "Start of conversation" sentinel is gated on `messages().length > 0`; the empty-state is gated on `messages().length === 0`. They are mutually exclusive by construction — no special-case copy needed for a one-message room.

## Deferred

- `IntersectionObserver`-based trigger (flagged in the task file §6). The scroll handler is enough for the hackathon scale. Moving to `IntersectionObserver` would complicate room-swap because the observed target (the first message) is recycled, and offers no perf win at 50-per-page.
- Virtual scrolling / windowed rendering via Angular CDK's `<cdk-virtual-scroll-viewport>` (inverted). Fine to defer at Round 9's scale (125 × active room).
- LRU eviction of very-old pages once the user has scrolled back past some threshold. Needed only if memory profiling flags long sessions; not urgent.
- Persisted "last-read" scroll position across room swap. Round 12's unread work is the natural place to land it.
- Animated entry for prepended pages.
- Retry with exponential backoff on `loadMoreError`. Current UX: one-click Retry; if the BE is still down, the error card reappears.
- Cancel-in-flight on room swap. Today the in-flight request runs to completion but is dropped in the `next` callback via the stale-cursor guard. Using `takeUntil(roomIdSwap$)` would be cleaner but adds a Subject; the guard is sufficient.
- Integration / e2e test coverage — carry-over from prior rounds.

## Next round needs to know

- `MessagesService.getRecent` no longer exists. Any future caller must use `getHistory(roomId, opts?)` and read from `.messages` on the response.
- `MessageListComponent.messages` is still the full in-memory array (growing as the user paginates). Rooms with very long histories will accumulate hundreds of `Message` rows in memory — combined with `AttachmentsService.objectUrlCache` (flagged in Round 8 §Next round needs to know), image-heavy deep-history scrolls will keep blobs alive. LRU caps on both arrays should be considered together.
- The scroll-anchor delta math (`scrollTop = captured + (scrollHeight - capturedHeight)`) assumes prepended rows add to `scrollHeight` between the `loadMore()` capture and the `ngAfterViewChecked` restore. If a future round introduces async "skeleton → hydrated" rendering where the pre-hydration height differs from the post-hydration height, the restore may over- or under-correct by that delta. The existing `onAttachmentLoaded` re-pin path does NOT help here (it only triggers when near-bottom). A `ResizeObserver` on the scroll container (flagged under Config improvements) would be the more general fix.
- The top-of-list Retry is a one-shot — clicking it clears `loadMoreError` and immediately re-fires `loadMore()`. If the BE is still down, the error card reappears after the round-trip. No circuit-breaker / backoff; acceptable for the hackathon.
- `onScroll()` runs on every scroll event (no throttling). For very fast scroll gestures this means several handler calls per frame, but each one short-circuits in O(1) after checking the signals and computing `triggerPx`. If CPU profiling flags this, an `rxjs` `auditTime(16)` wrap could debounce to one-per-frame.
- The Round-9 BE's `"Invalid cursor"` 400 error string (from the contract) surfaces as `loadMoreError = true` via the generic `error` branch. No user-facing differentiation between "cursor points at a message in another room" and a transient network failure — both get "Could not load older messages." If a future round needs more granular messaging, branch on the error status/body inside `loadMore`'s `error` handler.

## Config improvements

- Promote `LOAD_MORE_TRIGGER_REM` (currently 4rem) and `STICK_TO_BOTTOM_THRESHOLD_REM` (currently 5rem) to a single `chatUx` const map or environment knob; one place to tune scroll heuristics.
- Wrap the anchor-restore in `requestAnimationFrame` if slower machines show a one-frame flicker on prepend. Cheap insurance.
- Swap the child-image `(loaded)` re-pin path (Round 8) for a `ResizeObserver` on `#scrollContainer`. More general — catches any height change (expanded multi-line messages, future embeds, video thumbnails), not just image resolution.
- `IntersectionObserver` on the first rendered message as the paginate trigger (swap out the `onScroll` pixel check). More semantic; marginal perf win.
- LRU cap on `MessageListComponent.messages` per room (e.g. 500 rows) combined with an LRU on `AttachmentsService.objectUrlCache`. Together they bound steady-state memory on long image-heavy sessions.
- Throttle `onScroll()` to one call per animation frame via `rxjs` `auditTime(16)` if profiling shows excessive calls on fast scroll gestures.
- Cancel-in-flight via `takeUntil(roomSwap$)` instead of the stale-cursor guard — fractionally more elegant, same observable behaviour for the user.
