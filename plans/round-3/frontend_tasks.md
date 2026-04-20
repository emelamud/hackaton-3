# Round 3 — Frontend Tasks

## Goal
Replace the dashed placeholder inside `RoomViewComponent` with a real message list (loads last 50 via HTTP, appends live messages from Socket.io) and a message composer (Enter sends, Shift+Enter newlines, send via socket emit with ack). Stand up a single app-wide socket client driven by auth state; keep it alive across navigation.

## Dependencies
- `shared/api-contract.md` §Rooms Endpoints (new `GET /api/rooms/:id/messages`) and §Socket Events — read the transport block, the ack contract, and the error-string list; exact strings matter
- `shared/types/message.ts` — `Message`, `SendMessagePayload`, `MessageSendAck`
- `frontend/CLAUDE.md` — service patterns, auth flow, form conventions
- `frontend/docs/DESIGN_SYSTEM.md` + `.claude/skills/design-system/SKILL.md` — **mandatory** before writing components (no `--mat-sys-*`, no hex, no `px`, no inline style)
- `plans/round-2/frontend_work_summary.md` — flagged `ChatContextService` as socket-lifecycle hook. **That recommendation is superseded** by the Round 3 contract: subscriptions are managed server-side (auto-subscribe on connect, dynamic sync on create/join/leave), so components do **not** emit `room:join` / `room:leave`. `ChatContextService.currentRoom()` stays as-is for rendering, not for socket wiring.

**Do not modify `/shared/`.** If a contract tweak is needed, stop and flag it to the orchestrator.

## Tasks

### 1. Install socket.io-client
- `pnpm -C frontend add socket.io-client@4`

### 2. Environments — add socket URL
- `frontend/src/environments/environment.ts`: add `socketUrl: 'http://localhost:3000'`
- `frontend/src/environments/environment.prod.ts`: add `socketUrl: ''` (empty = same origin; nginx will proxy `/socket.io/`)
- Confirm `angular.json` `fileReplacements` for prod still picks up the right file (established in Round 1).

### 3. Update nginx for WebSocket proxying — `docker/nginx.conf`
Add a `location /socket.io/` block alongside the existing `location /api/`:

```
location /socket.io/ {
  proxy_pass http://backend:3000;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_read_timeout 86400s;
}
```

The `Upgrade` / `Connection: upgrade` headers are required for WebSockets. Do **not** remove or alter the existing `/api/` block or SPA fallback.

### 4. Socket service — `frontend/src/app/core/socket/socket.service.ts`
Singleton, `providedIn: 'root'`. Put this under `core/` (not `chat/`) because it is app-wide, not feature-local. Consistent with `core/auth/` from Round 1.

Shape:

```ts
@Injectable({ providedIn: 'root' })
export class SocketService {
  private socket: Socket | null = null;

  connect(token: string): void;       // idempotent; reconnects if token changed
  disconnect(): void;
  isConnected(): boolean;

  on<T>(event: string): Observable<T>;                        // wraps socket.on / off for unsubscribe
  emitWithAck<Req, Res>(event: string, payload: Req): Promise<Res>;   // wraps ack callback; applies 5 s timeout
}
```

Details:
- `connect(token)` — if a socket already exists with the same token, no-op. If it exists with a different token, `disconnect()` and create a fresh `io(environment.socketUrl, { auth: { token }, autoConnect: true, transports: ['websocket', 'polling'] })`. Leave reconnection to socket.io defaults — it handles transient drops for us.
- `on<T>(event)` — returns a cold `Observable` that attaches `socket.on` on subscribe and detaches on unsubscribe. Use `new Observable(observer => { … return () => socket.off(event, handler); })`. Don't share a single subscription across components; each component's `takeUntilDestroyed()` should detach its own listener.
- `emitWithAck` — uses socket.io v4's timeout API: `socket.timeout(5000).emit(event, payload, (err, res) => { … })`. Reject on timeout or `err`; resolve with `res` otherwise.

### 5. Wire socket lifecycle to auth state
Edit `core/auth/auth.service.ts` (or a small sibling `socket-bootstrap.ts`, your call — pick whichever keeps `AuthService` lean):

- After a successful `login()` / `register()` / `refresh()` that produces an access token → call `socketService.connect(token)`.
- In `logout()` → call `socketService.disconnect()` before navigation.
- The existing `APP_INITIALIZER` already runs `refresh()` on app boot; piping into the same hook gets "socket connects after silent refresh" for free.
- **Do not** reconnect on every HTTP `refresh()` response — Round 3 accepts that long-lived sockets hold their original token until disconnect. Flag in summary as a known limitation for a future round.

### 6. Messages service — `frontend/src/app/chat/messages.service.ts`
Separate from `rooms.service.ts`. Mirror the service style (HttpClient via `inject()`, methods that return `Observable`).

```ts
getRecent(roomId: string): Observable<Message[]>   // GET /api/rooms/:id/messages
send(roomId: string, body: string): Observable<Message>   // wraps socket emit+ack
newMessages$(roomId: string): Observable<Message>   // filtered stream from socket 'message:new'
```

- `send` — builds `SendMessagePayload`, calls `socketService.emitWithAck<SendMessagePayload, MessageSendAck>('message:send', payload)`. If `ack.ok === true`, emit `ack.message` on the Observable and complete. If `ack.ok === false`, throw an `Error(ack.error)`.
- `newMessages$(roomId)` — `socketService.on<Message>('message:new').pipe(filter(m => m.roomId === roomId))`. The socket is subscribed to every room the user is in, so the component must filter.

### 7. `MessageListComponent` — `frontend/src/app/chat/message-list.component.*`
Inputs: `roomId: string` (required).

On init:
- Call `messagesService.getRecent(roomId)` → populate `messages = signal<Message[]>([])` (keep ascending order as returned).
- Subscribe to `messagesService.newMessages$(roomId)` → append to the signal (mutate via `update`).
- Use `takeUntilDestroyed()` so nothing leaks when the user navigates between rooms.

Render:
- `mat-list` (or a `@for` over a plain scrollable container — pick whichever respects the design system's `.chat-grid` density). Each row: `<span class="text-primary">{{ m.username }}</span> <span class="text-on-surface-variant">{{ formatTime(m.createdAt) }}</span> — {{ m.body }}`. Keep it minimal for Round 3; rich formatting / reply quote blocks / edited badge come in Rounds 9–10.
- Preserve multiline bodies — use `white-space: pre-wrap` on the body span (no `px`, set via a utility or custom SCSS token).

Scroll behaviour:
- On first paint, scroll to bottom.
- On new message arrival, scroll to bottom **only if** the user was within ~80 px of the bottom before the append ("at bottom" heuristic). If they've scrolled up to read history, respect that position.
- Implementation: ViewChild a scrollable element, compare `scrollHeight - scrollTop - clientHeight` before appending. Standard chat pattern.

Do not add infinite scroll, "load more" button, or scroll-restore-on-back — those land in Round 5.

### 8. `MessageComposerComponent` — `frontend/src/app/chat/message-composer.component.*`
Inputs: `roomId: string` (required).

Form (`ReactiveFormsModule`):
- Single `body` control: `[Validators.required, Validators.maxLength(3072)]`. Trim before send; reject whitespace-only submissions client-side.
- `MatFormField` (outline), `MatInput` with `cdkTextareaAutosize` (`cdkAutosizeMinRows=1`, `cdkAutosizeMaxRows=8`).
- Send button (`mat-icon-button` with `send` icon) next to the textarea.

Keybindings:
- **Enter** submits.
- **Shift+Enter** inserts a newline (default textarea behaviour — let the browser handle it; just intercept Enter-without-Shift in `keydown`).
- **Submit button** also submits.

Submit flow:
- `submitting = signal(false)`. Disable the field + button while pending.
- Call `messagesService.send(roomId, body.trim())`.
- On success: clear the control, refocus the textarea.
- On error (ack error or 5-second timeout): show the error text under the field (use `MatError` with a signal-backed server-error, same pattern as the Round 2 create-room 409 handler). Re-enable the field. Do **not** drop the typed text on failure — user can retry.

### 9. Hook into `RoomViewComponent` — `frontend/src/app/chat/room-view.component.html`
Replace the dashed placeholder block (currently inside `.room-view__messages`) with:

```html
@if (currentRoom(); as r) {
  <app-message-list [roomId]="r.id" class="room-view__messages" />
  <app-message-composer [roomId]="r.id" class="room-view__composer" />
}
```

Keep the existing header (`# room.name` + description) untouched. The room-view host already uses `display: flex; flex-direction: column; min-height: 0;` per the Round 2 summary, so the list (`flex: 1 1 auto; overflow: auto`) + composer (flex: 0 0 auto) layout works without structural changes.

Do **not** modify `ChatContextService` — it still tracks the currently-viewed room for the right rail. It does not drive socket subscriptions (see Dependencies).

### 10. Verification (mandatory — per `.claude/agents/frontend-developer.md`)
- Run `docker compose up` with the Round 3 backend already deployed.
- Load the Playwright MCP browser tools with `ToolSearch`: `select:mcp__playwright__browser_navigate,mcp__playwright__browser_click,mcp__playwright__browser_type,mcp__playwright__browser_snapshot,mcp__playwright__browser_console_messages,mcp__playwright__browser_take_screenshot,mcp__playwright__browser_press_key,mcp__playwright__browser_tabs,mcp__playwright__browser_wait_for`.

Scenarios to exercise end-to-end:
1. Log in as `alice@test.dev / Passw0rd!`, open a pre-existing room. Confirm the composer appears and `message-list` renders history (if any).
2. Type a message, press Enter → composer clears, message appears at the bottom, scroll auto-sticks.
3. In a second browser tab, log in as `bob@test.dev / Passw0rd!`, navigate to the same room (after joining if needed), send a message → alice's tab shows it live **without reload**, within ~2 s of send.
4. In the same tab (as alice), hit Shift+Enter → newline inserted, no send. Then Enter → multi-line message renders with the newline preserved.
5. Try to send a 4000-char message — composer shows the ack error string under the field (the verbatim string from the contract).
6. Scroll up in a busy room, then receive a new message → scroll position is preserved (no forced auto-scroll when the user has scrolled away from the bottom).
7. Reload a room page — history re-fetches, socket reconnects, live messages still flow.
8. Toggle dark mode — no contrast regressions.
9. Resize to <56.5 rem — composer + list still usable (mobile polish is intentionally minimal per Round 2 deferred list).
10. Grep your own diff: no `--mat-sys-*`, no hex literals, no `px` in SCSS.

Check DevTools console — only expected log/debug lines, no errors.

## Wrap-up
Write `plans/round-3/frontend_work_summary.md` with:
- **Built** — services, components, nginx tweak
- **Deviations** — scroll-anchor implementation choice, any error-handling nuances, whether the socket was wired via AuthService or a sibling bootstrap
- **Deferred** — rate-limit UX (no client-side throttle), mid-session token refresh → socket reconnect, typing indicators, rich formatting, edited/deleted badges
- **Next round needs to know** — for Round 4 (Invitations + Room Settings): how the sidebar should refresh on `room:updated`, where the `invitation:new` listener should live (probably a `InvitationsService` plus a top-nav badge). Also note how `ChatContextService.currentRoom()` should react to `room:updated` when the open room is the one edited
- **Config improvements** — design-system friction, missing utility classes, `frontend/CLAUDE.md` additions (e.g. a canonical entry about the socket-in-core pattern), dev-loop fixes (the "Dev feedback loop" item from Round 2 is still open)
