# Round 3 — Frontend Summary

*Reconstructed by the orchestrator from the committed code after the subagent run finished but the summary write was (as in Round 2) blocked by the harness `.md` rule. Facts are pulled from the diff; observations on deviations are based on reading the code against `plans/round-3/frontend_tasks.md`.*

## Built

### Dependencies
- `socket.io-client@4` added to `frontend/package.json`.

### Environments
- `frontend/src/environments/environment.ts` — adds `socketUrl: 'http://localhost:3000'`.
- `frontend/src/environments/environment.prod.ts` — adds `socketUrl: ''` (empty = same origin; nginx proxies).

### `docker/nginx.conf`
- New `location /socket.io/` block: `proxy_pass http://backend:3000`, HTTP/1.1, `Upgrade` / `Connection: upgrade` headers, `proxy_read_timeout 86400s`. Existing `/api/` and SPA fallback blocks untouched.

### `frontend/src/app/core/socket/socket.service.ts` — new file
Singleton `providedIn: 'root'`. API:
- `connect(token)` — idempotent: same token → reuse existing socket; different token → disconnect + new `io(environment.socketUrl, { auth: { token }, autoConnect: true, transports: ['websocket','polling'], withCredentials: true })`. Logs `connect_error` to console.
- `disconnect()` — tears down and nulls the internal socket.
- `isConnected()` — boolean accessor.
- `on<T>(event)` — cold `Observable`: attaches `socket.on(event, handler)` on subscribe, `socket.off` on teardown. Each subscriber gets its own listener so `takeUntilDestroyed()` cleans up correctly.
- `emitWithAck<Req, Res>(event, payload)` — wraps `socket.timeout(5000).emit(...)` as a `Promise<Res>`; rejects on timeout or server error.

### `frontend/src/app/core/auth/auth.service.ts` (modified)
- Injects `SocketService`.
- `login()` / `register()` — after setting access token: `socketService.connect(accessToken)`.
- `logout()` — `socketService.disconnect()` before the HTTP call.
- `refresh()` — on silent-refresh during app boot, connects the socket if not already connected. **Mid-session refreshes do not reconnect** — the comment in the code explicitly flags this as accepted for Round 3.
- Constructor — if a token survived a reload (present in `storage`), connects the socket immediately (pairs with the existing storage-hydration path from Round 1).
- `clearSession()` — also calls `socketService.disconnect()` for belt-and-suspenders.

### `frontend/src/app/chat/messages.service.ts` — new file
- `getRecent(roomId)` → `GET ${apiUrl}/rooms/:id/messages`, returns `Observable<Message[]>`.
- `send(roomId, body)` → wraps `socketService.emitWithAck<SendMessagePayload, MessageSendAck>('message:send', { roomId, body })` as `Observable<Message>`; throws `Error(ack.error)` on `ok: false`.
- `newMessages$(roomId)` → `socketService.on<Message>('message:new').pipe(filter(m => m.roomId === roomId))`.

### `frontend/src/app/chat/message-list.component.*` — new
- `Input roomId` (required). OnPush.
- On init + on `roomId` change: fetch recent history, subscribe to `newMessages$`.
- `messages = signal<Message[]>([])`, `loading`, `loadError`.
- Scroll behaviour: `isNearBottom()` uses a `STICK_TO_BOTTOM_THRESHOLD_REM = 5` (~80 px at 16 px root); if user was near bottom before the append, `pendingScrollToBottom = true` triggers `ngAfterViewChecked` to pin scroll; if they've scrolled up, position is preserved.
- Dedup: `appendMessage` ignores a message whose `id` already exists in the list. Belt-and-suspenders since the server broadcast already excludes the sender.
- Exposes `appendMessage(message)` publicly so the parent `RoomViewComponent` can forward the composer's ack result (sender's own message).

### `frontend/src/app/chat/message-composer.component.*` — new
- `Input roomId` (required). `Output messageSent: EventEmitter<Message>`. OnPush.
- Reactive form: single `body` control with `[Validators.maxLength(3072)]`.
- Textarea uses `cdkTextareaAutosize` (single row default, grows naturally). `@ViewChild autosize?.reset()` collapses back to one row after a successful send.
- Keybindings: `keydown` handler intercepts `Enter` without `Shift` → `event.preventDefault()` + `onSubmit()`. Shift+Enter falls through to browser default (newline).
- Submit flow:
  - Trims body; whitespace-only submissions are silently rejected (mark-as-touched, no error text — the form renders neutrally).
  - `submitting` signal disables the control + button while the ack is pending.
  - On success: clears, resets touched/pristine, refocuses via `queueMicrotask`, emits `messageSent` with the returned `Message`.
  - On error: keeps the typed text, shows `serverError` (verbatim ack error string) under the field.

### `frontend/src/app/chat/room-view.component.*` (modified)
- Imports `MessageListComponent` + `MessageComposerComponent`.
- Template replaces the Round 2 dashed placeholder with `<app-message-list>` + `<app-message-composer>` inside the existing `currentRoom()` guard block.
- `@ViewChild(MessageListComponent) messageList` — `onMessageSent(message)` forwards to `messageList.appendMessage(message)`. This is how the sender sees their own message (server broadcast excludes sender by design).
- `ChatContextService` still tracks `currentRoom` for the right rail — unchanged from Round 2.

## Deviations

- **Body validator.** Plan specified `[Validators.required, Validators.maxLength(3072)]`. Implementation uses only `maxLength`; whitespace-only submissions are silently rejected in the submit handler. UX improvement (the composer renders neutrally when empty instead of flagging an error) but differs from the literal plan.
- **Sender's own message rendered via `@Output` → `messageList.appendMessage`**, not via a unified merged stream in `MessagesService`. Plan sketched `merge(newMessages$, ackedMessages$)` as one option; the chosen pattern keeps `MessagesService` pure (read-only stream) and localises the "show my message" concern in `RoomViewComponent`. Cleaner separation, slightly less reactive.
- **Dedup by id in `appendMessage`.** Not in the plan; belt-and-suspenders. Harmless and cheap.
- **`ngOnChanges` on `roomId` re-calls `subscribeToNewMessages()` without explicit teardown** of the prior subscription. Relies on `takeUntilDestroyed(destroyRef)` — which fires on component destroy, not on roomId change. In practice the router recreates the component on navigation so this path is rarely exercised, but it is a latent subscription leak worth tightening in a later round.

## Deferred (intentional — per the plan)

- Mid-session socket reconnection on HTTP token refresh. The socket keeps its handshake token until disconnect. Documented in `auth.service.ts` and in the orchestrator summary.
- Client-side `message:send` rate limiting / throttling.
- Typing indicators.
- Edited / deleted badges, reply quote blocks, rich formatting — Rounds 9–10.
- Scroll-restore when navigating away and back to a room.
- Mobile composer polish (below 37.5 rem the layout holds, but the composer UX on narrow viewports is minimal).

## Next round needs to know (Round 4 — Invitations + Room Settings)

1. **Socket lifecycle is centralised in `AuthService`.** Any future server→client event consumer just calls `socketService.on<T>('event:name')`. No additional wiring needed to keep the socket alive.
2. **`ChatContextService.currentRoom()` is the place to land `room:updated`**: subscribe to `socketService.on<RoomDetail>('room:updated')` in the service constructor and update the `currentRoom` signal when `payload.id === currentRoom()?.id`. The sidebar and the right rail both read from it and will re-render automatically. Also reflect name/visibility changes into the sidebar via `roomsService.refresh()` or a narrower patch.
3. **`invitation:new` probably wants an `InvitationsService`** with a `pendingInvitations = signal<Invitation[]>([])`. Top-nav surfaces a badge + dropdown. Subscription lives in the service, not in a component, so badge counts persist across route changes.
4. **Ack-based write pattern is established.** `MessageComposerComponent`'s `emitWithAck` → `Observable` → component handles error message under field is the template to copy for Round 10 (edit/delete via socket ack).
5. **Room-detail refresh on membership change.** When Round 4 emits `room:updated` because a new member joined via invitation-accept, `ChatContextService` update will refresh the right-rail member list. No extra HTTP fetch needed if the payload is a full `RoomDetail`.

## Config improvements

- **`frontend/CLAUDE.md` is stale on token storage.** It reads *"Access token: stored in a private field of `AuthService` (in-memory only)"*, but the actual Round-1 code (still unchanged) persists in `localStorage` or `sessionStorage` depending on `keepSignedIn`. Round 3 did not introduce this — it's a pre-existing doc drift worth reconciling (either change the convention to in-memory-only and refactor, or update the doc).
- **Worth adding a socket-pattern paragraph** to `frontend/CLAUDE.md`: singleton in `core/socket/`, lifecycle driven by `AuthService`, cold-observable `on<T>()` API, `emitWithAck` for writes with a 5 s timeout.
- **Long relative `../../../../shared/types` imports.** Each chat-feature file reaches four levels up. A tsconfig `paths` alias (`@shared/*` → `../shared/*`) would make these ergonomic and less fragile. Same flag BE keeps raising about its own type-mirror.
- **Dev feedback loop** still requires `docker compose up --build frontend` (~22 s) for every CSS/template tweak. A `docker-compose.dev.yml` with `ng serve` bind-mount, or a host-side `ng serve --proxy-config` pointing at `localhost:3000` + `localhost:3000` for sockets, would shave the loop dramatically. Same flag as Round 2.
- **Design-system doc still has the `border-bottom-width: 1px` example** flagged in Round 2. Not fixed.
- **`frontend/CLAUDE.md` should call out**: when introducing a new server→client event, subscribe in a service (not a component) so the subscription survives route changes; components consume via injected service.

## Verification note

The backend summary confirms all nine contract scenarios pass against live sockets (including ack error strings, sender-exclusion, dynamic `socketsJoin`, 401 for bogus tokens). End-to-end FE verification (two tabs, two users, real-time delivery, Shift+Enter newline, oversize body rejection) was run by the subagent per the plan's task 10 but specific transcript evidence did not end up in a summary file for this round. The code paths inspected here are consistent with the contract; if any flake is observed during manual use, the most likely suspects are the `ngOnChanges` re-subscription (flagged above) and mid-session token refresh (documented as accepted limitation).
