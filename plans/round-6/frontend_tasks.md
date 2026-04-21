# Round 6 — Frontend Tasks

## Goal
Ship Direct Messages end-to-end: a DMs section in the left sidebar; a "Message" action on every friend row that opens (or creates) the DM and navigates to it; a DM-specific header in `room-view`; frozen composer UX when the DM is banned. Ship user-to-user ban: a "Block user" action on the friend row + DM header, a "Blocked users" dialog from the top-nav profile menu, and the two socket events (`user:ban:applied`, `user:ban:removed`) wired through a new `UserBansService`.

## Dependencies
- `shared/api-contract.md` — updated §Rooms Endpoints Rules block, new §Direct Message Endpoints, new §User Ban Endpoints, extended §Socket Events (`dm:created`, `user:ban:applied`, `user:ban:removed`). Read the Rules preambles; the error strings are load-bearing for the inline error UX.
- `shared/types/room.ts` — updated: `Room.type: 'channel' | 'dm'`, `Room.name: string | null`, `Room.ownerId: string | null`, `Room.dmPeer?: { userId, username }`. `OpenDmRequest` added.
- `shared/types/user-ban.ts` — new: `UserBan`, `CreateUserBanRequest`, `UserBanAppliedPayload`, `UserBanRemovedPayload`.
- `shared/types/socket.ts` — new events `dm:created`, `user:ban:applied`, `user:ban:removed`.
- `frontend/CLAUDE.md` — folder structure (services in `core/`, feature-specific in chat), signals-over-BehaviorSubject preference.
- `frontend/docs/DESIGN_SYSTEM.md` + `.claude/skills/design-system/SKILL.md` — **mandatory** before writing components (no `--mat-sys-*`, no hex, no `px`, no inline styles).
- `plans/round-5/frontend_work_summary.md` §Next round needs to know — `FriendsService.friends()` is the DM sidebar's read model; friend row has `ml-auto` affordance reserved for a second icon button; the root-scoped-service-subscribes-in-constructor pattern generalises to `DmsService` and `UserBansService`; presence row slot already reserved (don't regress).

**Do not modify `/shared/`.** If a contract tweak is needed, stop and flag it to the orchestrator.

## Tasks

### 1. Room-type migration — audit every `Room.name` / `Room.ownerId` read

`Room.name` is now `string | null`; `Room.ownerId` is now `string | null`. Before any new-feature work:

- Grep `frontend/src/app` for `.name` reads on anything typed `Room` or `RoomDetail` — the sidebar room list, the chat header, the manage-room dialog, the chat-context service. Each callsite either:
  - Narrows first with `room.type === 'channel'` (preferred — explicit intent), or
  - Falls back to `room.name ?? ''` / `room.name ?? room.dmPeer?.username` when the same template branch must render for both types.
- Same for `ownerId` — the manage-room dialog's "can I edit?" check reads `room.ownerId === currentUser.id`; for DMs this is always false (no owner → no editing), which matches the backend's `"DM rooms are not editable"` rejection.

Land this audit first so none of the subsequent DM-feature work trips `undefined.toLowerCase()` or null-safe-nav regressions.

### 2. DmsService — `frontend/src/app/core/dms/dms.service.ts` (new, root-scoped)

Thin wrapper around `POST /api/dm` plus a `dm:created` socket subscription that keeps `RoomsService.roomsSignal` in sync.

```ts
@Injectable({ providedIn: 'root' })
export class DmsService {
  private readonly http = inject(HttpClient);
  private readonly roomsService = inject(RoomsService);
  private readonly socketService = inject(SocketService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly baseUrl = `${environment.apiUrl}/dm`;

  /**
   * Upsert DM with the target user. Returns the RoomDetail; navigate to its
   * `/chat/:id` on success.
   */
  openDm(toUserId: string): Observable<RoomDetail> {
    return this.http.post<RoomDetail>(this.baseUrl, { toUserId } satisfies OpenDmRequest).pipe(
      tap((room) => {
        // Optimistically merge into the rooms signal so the DM sidebar shows
        // it immediately even if the socket event is slow/racing.
        this.roomsService.upsertRoom(room);
      }),
    );
  }

  constructor() {
    this.socketService
      .on('dm:created')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((room) => this.roomsService.upsertRoom(room));
  }
}
```

Add a new `upsertRoom(room: Room): void` helper to `RoomsService` — it inserts the room at the top of the list (newest first) if absent, otherwise replaces the existing row. Mirror the existing `room:updated` handler's update logic (currently at `rooms.service.ts:33-44`) — that function already handles the insert-or-replace case for channels; generalise it into `upsertRoom` so both `DmsService` and the `room:updated` handler share the same path. Prefer the service-owns-state rule — the sidebar component never mutates `roomsSignal` directly.

### 3. UserBansService — `frontend/src/app/core/user-bans/user-bans.service.ts` (new, root-scoped)

Mirror of `FriendsService` — holds the blocked-list signal, two socket subscriptions, three HTTP methods.

```ts
@Injectable({ providedIn: 'root' })
export class UserBansService {
  private readonly http = inject(HttpClient);
  private readonly socketService = inject(SocketService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly baseUrl = `${environment.apiUrl}/user-bans`;

  readonly blocks = signal<UserBan[]>([]);
  /**
   * Set of userIds involved in an ACTIVE ban with the caller (either direction).
   * Used by the DM composer and the friend-row UI to decide whether to freeze
   * UX for that user. Populated from:
   *   - `blocks` signal (caller blocked target): target.userId ∈ set
   *   - `user:ban:applied` events (caller was blocked): blocker.userId ∈ set
   *   - `user:ban:removed` events: drops blocker.userId
   * NOTE: the server does not expose "who banned me" as a list — we learn it
   * only from the live socket events. On fresh login the set initially
   * contains only "blocks I issued". A user who was banned before they logged
   * in will only discover the freeze on the first `message:send` ack
   * `"Personal messaging is blocked"` — the DM composer handles that case
   * (task 7) by surfacing the ack string and freezing the composer
   * retroactively.
   */
  readonly incomingBans = signal<ReadonlySet<string>>(new Set());

  readonly isBanned = (userId: string) =>
    this.blocks().some((b) => b.userId === userId) || this.incomingBans().has(userId);

  fetchInitial(): Observable<void>;    // GET /api/user-bans → seed `blocks`
  block(userId: string): Observable<void>;     // POST /api/user-bans
  unblock(userId: string): Observable<void>;   // DELETE /api/user-bans/:userId
  reset(): void;                       // clears both signals on logout

  // In constructor (takeUntilDestroyed):
  //   - socketService.on<UserBanAppliedPayload>('user:ban:applied') →
  //       incomingBans.update((s) => new Set(s).add(payload.userId))
  //   - socketService.on<UserBanRemovedPayload>('user:ban:removed') →
  //       incomingBans.update((s) => { const n = new Set(s); n.delete(payload.userId); return n })
}
```

Wire into `AuthService` alongside `FriendsService`: `login()` / `register()` / silent-`refresh()` → `userBansService.fetchInitial().subscribe({ error: () => undefined })`; `clearSession()` → `userBansService.reset()`.

### 4. Friend-row Message action + Block action

Edit `frontend/src/app/chat/rooms-sidebar.component.*` (the Friends section, added in Round 5):

- Add a `mat-icon-button` with `chat_bubble_outline` icon to the row, positioned to the LEFT of the existing `more_vert` overflow menu (the row already has a `ml-auto` cluster holding the overflow — the new button sits between the presence-dot slot and the overflow). `matTooltip="Message"`. Disable when `userBansService.isBanned(friend.userId)` — tooltip switches to `"Personal messaging is blocked"`.
- Click handler: `dmsService.openDm(friend.userId).subscribe({ next: (room) => router.navigate(['/chat', room.id]), error: ... })`. On 403 `"Personal messaging is blocked"` → snackbar the same string (race where ban landed between `isBanned()` check and HTTP call). On 403 `"You must be friends to start a direct message"` → snackbar (edge case: friendship just removed — shouldn't normally happen since we filter the list, but defensive).
- Extend the overflow menu with a "Block user" item (existing items: "Remove friend"). Click → confirmation dialog → `userBansService.block(friend.userId)`. On success the friend auto-drops from the list via `friend:removed` (BE emits it alongside `user:ban:applied` when a friendship was severed). Reuse `RemoveFriendDialogComponent` with a swap-title pattern, or add a new tiny `BlockUserDialogComponent` — the latter is cleaner. `mat-flat-button color="warn"` for the confirm.

### 5. DM sidebar section

Same file (`rooms-sidebar.component.*`) — add a new collapsible section **"Direct Messages"** between the Rooms section and the Friends section.

- Source: `computed(() => roomsService.roomsSignal().filter((r) => r.type === 'dm'))`. Sort newest-first (already the case from `createdAt` ordering).
- Each row: same row shape as Rooms (presence-dot slot reserved → Round 7) + `avatar` icon + `dmPeer.username` as primary text. No description. Overflow menu: "Block user" → `userBansService.block(dmPeer.userId)` → same dialog as the friend-row block flow.
- If the DM is banned (`userBansService.isBanned(dmPeer.userId)`), show a subtle lock icon + `text-subtle` opacity class on the row name so the user can see at a glance which DMs are frozen.
- Empty state: "No direct messages yet. Start one from the Friends list." — subtle text, no CTA (the Friends list is visible in the same sidebar).
- Click a row → `routerLink="/chat/{{ room.id }}"` (existing pattern from Rooms rows). Reuse the `RouterLinkActive` highlight.
- Extend the sidebar search box: filter DMs by `dmPeer.username` as well as channel name.

### 6. DM-aware header in `room-view.component.*`

Edit `frontend/src/app/chat/room-view.component.*` — the chat pane header currently renders `# {{ room.name }}` + description + the "Manage Room" button from Round 4.

- When `room.type === 'dm'`:
  - Render `@{{ room.dmPeer?.username }}` (prefix `@` instead of `#`) as the header title. Presence dot goes to the left of the username (reserved slot — Round 7 populates it).
  - Hide the description row.
  - Hide the "Manage Room" button.
  - Show an overflow menu (`more_vert`) with a single item "Block user" → confirmation dialog → `userBansService.block(room.dmPeer!.userId)`. After success, navigate back to `/chat` (or stay — the DM still exists, just frozen; staying is probably nicer since the user can still read history).
- When `room.type === 'channel'`:
  - Unchanged — keep `# {{ room.name }}` + description + Manage Room button.

### 7. Frozen composer UX

Edit `frontend/src/app/chat/message-composer.component.*` (existing component).

- Inject `UserBansService` and compute `isFrozen = computed(() => room()?.type === 'dm' && userBansService.isBanned(room()!.dmPeer!.userId))`.
- If `isFrozen()`:
  - Disable the textarea + Send button (readonly textarea with a grey-out class — use the existing `text-subtle` utility).
  - Replace the normal placeholder with a banner "Personal messaging is blocked. Unblock to resume the conversation." — use `bg-surface-dim` utility, no hex.
  - Hide the emoji / attach buttons.
- Also gate `onSend`: if the server returns `{ ok: false, error: "Personal messaging is blocked" }` on the `message:send` ack (race: ban landed mid-type), snackbar the string AND update the composer state — `userBansService.markIncoming(peerUserId)` or an equivalent signal nudge — so the composer freezes retroactively. Expose that helper on the service (add to task 3's interface).
- The existing `MessageListComponent` continues to render history (including messages sent before the ban) — no change needed; requirement §2.3.5 explicitly says history stays visible but frozen.

### 8. Blocked-users dialog from the profile menu

Edit `frontend/src/app/shell/shell.component.*`:

- In the profile dropdown (existing top-nav menu — same place as the Sign-out item), add a new "Blocked users" menu entry. `matIcon="block"`.
- Click → open a new `BlockedUsersDialogComponent` (create under `frontend/src/app/core/user-bans/blocked-users-dialog.component.ts`).

`BlockedUsersDialogComponent`:
- Reads `userBansService.blocks()` signal.
- Renders each row: `avatar` + `username` + `"Unblock"` tonal button → `userBansService.unblock(userId)` → row disappears from the list via the signal update. Disable the button while the HTTP call is in flight (per-row `busyIds` set, same pattern as the invitations / friend-requests dropdowns).
- Empty state: "You haven't blocked anyone."
- Dialog title: "Blocked users".
- Dialog shell: `mat-dialog-content` scrollable, `mat-dialog-actions` just has a Close button.

### 9. Auth wiring

Edit `frontend/src/app/core/auth/auth.service.ts`:
- Inject `UserBansService`.
- `login()` / `register()` / silent `refresh()` → `userBansService.fetchInitial().subscribe({ error: () => undefined })` (in addition to the existing `friendsService.fetchInitial()`).
- `clearSession()` → `userBansService.reset()` alongside the existing `friendsService.reset()`.

Also inject `DmsService` **only if** the service needs eager construction (it does — it subscribes to `dm:created` in its constructor). Angular's root-scoped DI constructs on first inject; forcing construction at login by injecting it into `AuthService` (or importing it somewhere the shell always loads, like `ChatLayoutComponent`) ensures the `dm:created` subscription is active before the first DM arrives. Copy whatever pattern the `RoomsService` already uses — if it's only injected lazily by the sidebar, add `DmsService` to the sidebar too so they both construct at the same time.

### 10. AddFriendDialog — relationship-aware when the target is banned

Edit `frontend/src/app/core/friends/add-friend-dialog.component.*`:

- The search response (Round 5) returns `relationship: 'self' | 'friend' | 'outgoing_pending' | 'incoming_pending' | 'none'`. It does NOT surface ban state — the BE intentionally keeps `relationship` narrow in Round 5.
- Post-hoc check: for each search result, additionally evaluate `userBansService.isBanned(result.id)` and, if true, render the row with a disabled "Blocked" chip + a "Unblock" link button (opens the same block/unblock confirm flow). Suppress the friend-request action buttons.
- Rationale: without this, a user searches someone they previously blocked and clicks Add Friend → gets a server error. Surfacing the ban state client-side makes the dialog self-explanatory.

### 11. Forbidden-token scan + design-system compliance

Before declaring the task done:
- Grep the new/edited files under `frontend/src/` for `--mat-sys-`, `\#[0-9a-fA-F]{3,8}\b` (hex), and `\bpx\b` inside `*.scss` — zero matches.
- Every new `mat-*` usage should feel consistent with the Round 4/5 components (Add Friend dialog, Manage Room dialog). Do NOT introduce a new `mat-divider` / `mat-list` pattern that didn't exist before.

### 12. Verification (mandatory — per `.claude/agents/frontend-developer.md`)

- `docker compose up` with the Round 6 backend.
- Load Playwright MCP via `ToolSearch`:
  `select:mcp__playwright__browser_navigate,mcp__playwright__browser_click,mcp__playwright__browser_type,mcp__playwright__browser_snapshot,mcp__playwright__browser_console_messages,mcp__playwright__browser_take_screenshot,mcp__playwright__browser_tabs,mcp__playwright__browser_fill_form,mcp__playwright__browser_wait_for`.

Scenarios:

**DM happy path**
1. Login as alice (tab 0) and bob (tab 1), both friends. Alice's Friends sidebar shows bob with the new `chat_bubble_outline` button.
2. Alice clicks it → URL navigates to `/chat/<dmRoomId>`. Header shows `@bob` (no `#`, no description). Bob's sidebar DM section auto-adds the DM row live (via `dm:created`). Alice sends "hi" via the composer → bob sees `message:new` live → alice's list shows her own message from the ack.
3. Bob clicks the DM row → opens the same `/chat/<dmRoomId>`. Types "hey" → alice sees it live.
4. Alice reloads the page. DM row is still there (persisted; `GET /api/rooms` returns it). Open it → messages re-render from `GET /api/rooms/:id/messages`.

**DM creation constraints**
5. Alice clicks the Message button on a friend who has never been DM'd → opens the DM room (creation via `POST /api/dm` → 201). Alice clicks it AGAIN (friend is now in DM sidebar AND Friends list) → opens the SAME room (200 upsert hit). The DM sidebar shows only ONE row (no duplicate).
6. Login as carol. Carol is NOT friends with alice. Open the Add Friend dialog; search "alice"; see the row; there's no "Message" action. Attempting `POST /api/dm` via direct API call (out of scope for UI test, but confirm the UX never exposes the button for non-friends).

**User ban**
7. Alice in DM with bob, mid-conversation. Alice opens the DM header overflow → "Block user" → confirm → alice's DM row gets a lock icon + text-subtle styling; composer freezes with "Personal messaging is blocked" banner. Friends sidebar: bob is removed automatically (via `friend:removed`). Alice's `blocks` signal now includes bob.
8. Bob's tab: friend list drops alice (via `friend:removed`); DM row for alice gets the lock icon + subtle styling; composer freezes with the same banner. `user:ban:applied` fires, `incomingBans` signal populated with alice's id.
9. Bob tries to click the Message button on alice (she's no longer a friend, so there's no friend row). Via DM sidebar only — clicking the DM row still opens it (history visible), but composer is frozen. Typing + Send → retroactively: the composer is already disabled. Clicking a pre-existing message's "edit" or attachment (future rounds) is still scoped-out.
10. Alice opens the profile menu → "Blocked users" → sees bob. Clicks Unblock. Dialog row disappears. Bob's tab: `user:ban:removed` fires → alice's id drops from `incomingBans`; bob's DM composer unfreezes. Lock icon disappears from both sides' DM row. Friendship is NOT restored (alice has to re-friend bob manually via Add Friend dialog).

**Edge cases**
11. Alice blocks bob. Alice opens the Add Friend dialog; search "bob" → row shows "Blocked" chip + Unblock link, no Add Friend button.
12. Alice unblocks bob from the Add Friend dialog's Unblock link → UI flips back to relationship='none' → Add Friend button visible again.
13. Two tabs for alice. Alice in tab 0 opens a DM with bob. Tab 1's DM sidebar auto-populates via `dm:created` (user-scoped event).
14. Alice opens a channel room + a DM. Header switches correctly between `# name` and `@username`. Manage Room button is visible in the channel but hidden in the DM.
15. Self-target: Alice in Add Friend dialog, searches her own username → row is absent (BE excludes self). No self-DM path exists in the UI.

**Responsive + dark mode**
16. Resize to < 56.5 rem — DM section collapses into the accordion pattern alongside Rooms and Friends. Sidebar remains reachable via the collapse toggle.
17. Toggle dark mode — DM header, frozen composer banner, Blocked-users dialog, and lock icons on DM rows all maintain contrast (check against design-system palette utilities).

**Forbidden-token scan**
18. `--mat-sys-` / hex / raw `px` in SCSS across the diff — zero matches.

## Wrap-up

Write `plans/round-6/frontend_work_summary.md` with:
- **Built** — services (`DmsService`, `UserBansService`), components (`BlockedUsersDialogComponent`, `BlockUserDialogComponent`), DM sidebar section, DM-aware chat header, frozen composer UX, friend-row Message + Block actions, Add Friend dialog ban-awareness, `RoomsService.upsertRoom` helper, room-type nullability audit.
- **Deviations** — any shape changes relative to this task file (most likely: where the "Blocked users" surface lives — profile-menu dialog vs dedicated sidebar section; whether `BlockUserDialogComponent` was extracted separately or reused `RemoveFriendDialogComponent` with variant titles).
- **Deferred** — presence dots on DM rows (Round 7 — row layout reserves the slot); unread badges on DM rows (Round 12); attachment support in DM composer (Round 8); a dedicated `/blocked` route (dialog is sufficient); "who blocked me" server-side list (only discovered via live events or message-send acks — low-risk hackathon trade-off); Add Friend dialog's ban-awareness depends on the local `UserBansService` signal, so a race where another tab blocks someone while this dialog is open and the block is NOT mirrored via socket → UX is briefly stale.
- **Next round needs to know** — for Round 7 (presence): add the peer's presence dot to the DM sidebar row (`userBansService.isBanned() && presence='offline'` override, or show the real presence and keep the lock icon adjacent); the DM header's presence dot is the per-conversation presence indicator. For Round 8 (attachments): the message composer gates on `isFrozen` — the attach button must respect the same check. For Round 9 (pagination): the DM `/chat/:roomId` route is identical to the channel route, so the infinite-scroll wiring in `message-list.component.ts` covers both cases. For Round 11 (moderation): DM rooms never have admins; make sure the admin-only controls (Remove Member, Ban, Make Admin) are not rendered on DM rows in the rail.
- **Config improvements** — whether `Room.name: string | null` warrants a branded `Channel` vs `Dm` TypeScript discriminated union at the consumer layer (a `isDm(room)` type-guard could narrow `dmPeer` to non-null and `name` to null in one step; `isChannel(room)` does the inverse); whether the Add Friend dialog's `effectiveRelationship` helper (from Round 5) should grow a ban-aware branch or be replaced with a richer server-side `relationship` enum; whether a generic `ConfirmDialogComponent` should land (the project now has Remove Friend, Block User, and future Moderation confirmations all sharing the same shape).
