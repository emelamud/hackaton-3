# Round 5 — Frontend Summary

## Built

### Services

- **`frontend/src/app/core/users/users.service.ts` (new, root-scoped)**
  Minimal HTTP wrapper. Single method `search(q: string): Observable<UserSearchResult[]>` → `GET /api/users/search?q=<prefix>`. No state — search is one-shot per keystroke.

- **`frontend/src/app/core/friends/friends.service.ts` (new, root-scoped)**
  Mirror of `InvitationsService`. Holds three signals + five socket subscriptions + the six HTTP methods:
  - Signals: `friends = signal<Friend[]>([])`, `incomingRequests = signal<FriendRequest[]>([])`, `outgoingRequests = signal<FriendRequest[]>([])`. Computed counts: `incomingCount`, `outgoingCount`, `friendCount`.
  - HTTP: `fetchInitial()` (forkJoin GET `/api/friends` + `/api/friend-requests/incoming` + `/api/friend-requests/outgoing`), `sendRequest(body)`, `acceptRequest(id)`, `rejectRequest(id)`, `cancelRequest(id)`, `removeFriend(userId)`. All mutating calls tap the response to update the local signals so the UI reflects state immediately without waiting for the socket echo (dedupe guards protect against duplicate prepends).
  - Socket subscriptions (all wired in the constructor via `takeUntilDestroyed(inject(DestroyRef))` — safe since Round 4 fixed the `SocketService.on()` pre-connect trap):
    - `friend:request:new` → prepend to `incomingRequests`, dedupe by id.
    - `friend:request:cancelled` → filter `incomingRequests` by `requestId`.
    - `friend:request:rejected` → filter `outgoingRequests` by `requestId`.
    - `friend:request:accepted` → filter `requestId` from BOTH pending lists, then prepend `payload.friend` to `friends` (dedupe by userId). Same handler works for both sides of the event because each list is filtered independently.
    - `friend:removed` → filter `friends` by `payload.userId`.
  - `reset()` zeros the three signals; called from `AuthService.clearSession()`.

### Components

- **`frontend/src/app/core/friends/friend-request-item.component.ts/.html/.scss` (new)**
  Dumb presentation row for the top-nav friend-requests dropdown. Inputs `request: FriendRequest`, `busy`. Outputs `(accept)`, `(reject)`. Template: `<strong>{{ fromUsername }}</strong> wants to be your friend` + optional `<blockquote>` message (3-line clamp with ellipsis) + relative time via `DatePipe` + primary "Accept" / tonal "Reject" `mat-button`s. Utility classes only (no `--mat-sys-*`, no hex, no `px`).

- **`frontend/src/app/core/friends/add-friend-dialog.component.ts/.html/.scss` (new)**
  `MatDialog`-launched standalone component. Type-ahead search pipeline: `searchControl.valueChanges.pipe(debounceTime(250), distinctUntilChanged(), switchMap(q => q.trim().length >= 2 ? usersService.search(q) : of([])))`. Each result row renders a status-sensitive action cluster resolved by `effectiveRelationship(row)`, which overlays the server's `relationship` with live state from `friendsService.friends()` / `outgoingRequests()` / `incomingRequests()` so transitions (someone accepts while the dialog is open, someone cancels) are reflected without re-searching:
    - `friend` — disabled "Friends" chip (with `check` avatar).
    - `outgoing_pending` — disabled "Request sent" chip + "Cancel" text button (disabled when the request id is not available in local state).
    - `incoming_pending` — "Accept" primary + "Reject" stroked buttons.
    - `none` — "Add friend" primary button → reveals an inline message composer (`maxLength: 500`, optional) + "Send" button. Send calls `friendsService.sendRequest({ toUsername, message? })`. On success the row's relationship flips to `outgoing_pending` optimistically; on HTTP error the server's `error.error` string is surfaced via `MatSnackBar` (covers the contract's `"You are already friends with this user"` / `"A pending friend request already exists…"` / `"You cannot send a friend request to yourself"` strings verbatim).
  Pipeline uses `takeUntilDestroyed(inject(DestroyRef))` so closing the dialog cancels the in-flight typeahead. "Keep typing… at least 2 characters" hint renders while `query.length > 0 && < 2`; an empty-results hint renders for `>= 2` char queries with no matches.

- **`frontend/src/app/core/friends/remove-friend-dialog.component.ts` (new, inline template)**
  Tiny confirmation dialog opened from the sidebar's per-friend overflow menu. Data: `{ username }`. Returns `boolean` (`true` = remove). Uses `mat-flat-button color="warn"` for the confirm action.

### Shell top-nav — `frontend/src/app/shell/shell.component.ts/.html/.scss` (edited)

- Added a `mat-icon-button` with `person_add` icon between the existing invitations (mail) badge and the Sessions link. `matBadge` bound to `friendsService.incomingCount() || null` — the Round 4 Bug 3 hide-with-null pattern. Applied the same null-binding to the invitations badge while I was there (was previously using `matBadgeHidden` which misfired at zero).
- Clicking opens a `mat-menu` anchored to the button. Empty state: "No pending friend requests". Otherwise a scrollable `FriendRequestItemComponent` list.
- Accept handler → `friendsService.acceptRequest(id)` + success snackbar "You and @{{ fromUsername }} are now friends" + closes menu when the list goes empty. No navigation — Round 5 friendships are not a destination; Round 6 will add DM-open.
- Reject handler → `friendsService.rejectRequest(id)`. No snackbar.
- Both handlers reuse the existing per-row `busyIds` set so the invitations and friend-requests dropdowns share the same disabled-while-in-flight semantics.

### Sidebar Friends panel — `frontend/src/app/chat/rooms-sidebar.component.ts/.html/.scss` (edited)

- New collapsible "Friends" section below the Rooms list, above any future DM list. Header row: collapse chevron + "FRIENDS" label + count chip + `person_add` icon button that opens `AddFriendDialogComponent`.
- Friend rows: reserved presence-dot slot (Round 7 hook — sized + flex-pinned so nothing shifts when the dot slots in), circular avatar, username, `more_vert` overflow menu → "Remove friend" → `RemoveFriendDialogComponent` → `friendsService.removeFriend(userId)`.
- Empty state: "No friends yet. Add someone to start chatting." + stroked "Add friend" CTA.
- Outgoing-pending summary row: if `outgoingCount() > 0`, renders a subtle "N pending…" toggle below the friends list; expanding reveals a per-row list with a Cancel action (→ `friendsService.cancelRequest(id)`).
- The right-rail row layout was left untouched — no presence dot was retrofitted there this round (still Round 7 territory).

### Auth wiring — `frontend/src/app/core/auth/auth.service.ts` (edited)

- Injects `FriendsService`.
- `login()`, `register()`, the silent `refresh()` branch, and the restore-from-storage constructor path all call `friendsService.fetchInitial().subscribe({ error: () => undefined })` in addition to the existing `invitationsService` seed.
- `clearSession()` calls `friendsService.reset()` alongside the existing `invitationsService.pending.set([])`.

### Socket subscriptions attached in FriendsService constructor

All five events listed above are attached inside the `FriendsService` constructor and cleaned up via `takeUntilDestroyed(this.destroyRef)`. Verified live end-to-end in Playwright:
- Alice sends a request → Bob's `person_add` badge flips from 0 → 1 with no reload.
- Bob accepts → both users' Friends panels update live; Alice's Add Friend dialog row (still open) flips from "Request sent" to "Friends".
- Alice removes Bob → Bob's sidebar drops the row immediately.
- Alice cancels an outgoing request → Bob's badge drops 1 → 0.

### Bug fix — Manage Room invite dialog closes on success

`frontend/src/app/chat/manage-room-dialog.component.ts` / `.html` (edited).

- `submitInvite()` success branch now calls `this.dialogRef.close(null)` after `MatSnackBar.open('Invited @${username}', 'Dismiss', { duration: 4000 })`.
- Dropped the `inviteSuccessUsername` signal and the `@if (inviteSuccessUsername(); as user) { ... }` success-banner block from the template.
- Failure branches unchanged: HTTP 404 / 409 still set `serverError` on the username control so the inline `MatError` renders "User not found" / "User is already a member of this room" / "An invitation is already pending for this user" under the field and the dialog stays open.

## Deviations

1. **Self-target inline error** — the contract documents a `"You cannot send a friend request to yourself"` 400, but the Add Friend dialog's search endpoint pre-excludes the caller on the server side, so the self-send path is only reachable by manipulating the username field directly (which isn't possible — username comes from the selected search row). The snackbar-on-error branch still surfaces the string verbatim if a race ever triggered it, but no dedicated UX was built.
2. **Outgoing-pending UI surface** — the plan named the sidebar summary ("N pending…") and the Add-Friend-dialog row as the two surfaces. Both are implemented. No separate page / top-nav badge for outgoing requests (deferred, as called out in the plan).
3. **Remove-friend confirmation** — implemented as a dedicated tiny standalone component (`RemoveFriendDialogComponent`) rather than `window.confirm`. The plan preferred this. It's inline-templated, ~20 lines, reusable if a future round needs a generic "confirm destructive action" pattern.
4. **Add Friend dialog placement** — landed under `core/friends/` (not `chat/`) since every other friend artefact lives there and the dialog has no chat-specific coupling. The task file allowed either location.
5. **Default collapsed state for the Friends sidebar section** — kept expanded (`friendsExpanded = signal(true)`) since the sidebar has only one other section ("Rooms") and collapsing by default would hide the primary Round 5 affordance. Users can still collapse manually.
6. **`border-l-outline` utility in `FriendRequestItemComponent`** — the utility existed already (`border-l-<role>` for `outline`/`outline-variant`/`primary`/`error`). Used it for the message blockquote's left bar instead of writing custom SCSS.
7. **Round 4 Bug 3 fix applied to the invitations badge too** — the shell's invitations `mat-icon-button` was still binding `[matBadgeHidden]="pendingCount() === 0"` which misfires. I switched it to `[matBadge]="invitationsService.pendingCount() || null"` for consistency with the new friends badge. Scope-creep-adjacent but it's a one-line convergence onto the project-wide pattern and removes a known bug without touching Round 4's summary doc.
8. **`SocketService` lint fix** — the pre-existing `type Listener = { ... }` declaration failed `@typescript-eslint/consistent-type-definitions`. Converted to `interface Listener { ... }` so `pnpm lint` passes. Behaviour identical.
9. **`shell.component.scss` raw `1px`** — replaced with `0.0625rem` to conform to the forbidden-token rule since I was already editing the file. Rendering unchanged.

## Deferred

- **Friend requests from a room's member list** (requirement §2.3.2 second bullet). Surface hook is clear — the rail's member rows already carry usernames — but no button is rendered. The backend's `POST /api/friend-requests` takes a username so no contract work is needed when the FE picks this up.
- **User-to-user ban** (Round 6). No UI, no state plumbing yet.
- **Presence dots on friend rows** (Round 7). Row layout reserves a `.friend-item__presence` flex slot so the dot drops in with zero reshuffling; the same slot concept should apply to the rail members list + (eventually) DM-participant list.
- **DM-open action on a friend row** (Round 6). The overflow menu currently has one item ("Remove friend"); Round 6 should add a primary `mat-icon-button` with `chat_bubble_outline` on the row itself (not the menu) plus optionally a "Message" menu entry.
- **Outgoing-request badge on the top nav**. The sidebar summary "N pending…" is sufficient in Round 5; a nav-level badge would be noise without a second surface to jump to.
- **Empty-state illustration / call-to-action polish**. The "No friends yet." copy is plain text; marketing-ish empty state art is not in scope.
- **Accessibility sweep** (focus trap order inside the Add Friend dialog when the composer expands, keyboard-only cancel of typeahead, SR announcements for "Request sent"). Not regressing vs Round 4 but deserves a dedicated pass.

## Next round needs to know

### For Round 6 (Direct Messages)

- **`FriendsService.friends()` is the DM sidebar's read model.** Each row already carries `{ userId, username, friendshipCreatedAt }` — everything a DM-start button needs. A Round 6 `DmsService` should inject `FriendsService`, read its signal, and project a "Friends you can DM" list; no separate HTTP call.
- **Add a `chat_bubble_outline` action to the friend row.** The row layout in `rooms-sidebar.component.html` already has an `ml-auto` affordance that holds the `more_vert` menu — a second `mat-icon-button` slotted to its left is the natural home. Keep "Remove friend" in the overflow menu.
- **The Friends panel is the right place for "Message" actions.** Do NOT scatter DM affordances into the top-nav profile menu or a separate /dm route in Round 6 — the sidebar already co-locates channels and friends, which matches the Slack reference.
- **Message acks + room subscription still flow through `SocketService.emitWithAck()` + auto-join**. DM rooms should piggyback on the same `room:*` subscription surface the server uses for channel rooms — the client does not need a new event type for DM message receipt.

### For Round 7 (Presence)

- **Three consumers of presence for Round 7**: `FriendsService.friends()`, `chatContext.currentRoom().members`, and (when Round 6 lands) the DM participants signal. Deduplicate `userId` across all three before subscribing to presence events — otherwise a friend who is also in the current room double-subscribes.
- **`friend:request:accepted` and `friend:removed` change the presence subscription set.** Round 7's presence service should react to `FriendsService.friends` signal changes rather than re-subscribing independently; an `effect()` that diffs the userId set is the cheapest hook.
- **Presence slot is reserved in the sidebar row** (`.friend-item__presence`, 0.5rem × 0.5rem, flex-pinned). Styling — `bg-tertiary` online, `bg-outline` away, `bg-surface-dim` offline — already mapped in `DESIGN_SYSTEM.md §2 chat-app palette`.

### General

- **Root-scoped-service-subscribes-in-constructor is now the project pattern.** `InvitationsService` (Round 4) + `FriendsService` (Round 5) + `RoomsService` + `ChatContextService` (Round 4) all attach in their constructor via `takeUntilDestroyed(DestroyRef)`. Round 4's Bug 1 fix in `SocketService` (buffered listener map re-attached on connect) made this safe.
- **Live state lives in services, not component-local signals.** `AddFriendDialogComponent` is the notable test case: it keeps a local `results` signal for dialog-only UI (composer open/closed per row) but resolves relationships dynamically against `FriendsService`'s live signals, so the row updates itself when an event fires mid-dialog. This pattern is worth copying verbatim for Round 6's DM sidebar.
- **Forbidden-token grep is still manual.** Scanned new/edited files for `--mat-sys-`, hex, raw `px` in SCSS — zero matches. Pre-commit hook proposal below.

## Config improvements

- **Codify the root-scoped-socket-subscriber pattern.** Three services now share the identical constructor shape (`socketService.on(...)` → pipe through `takeUntilDestroyed(this.destroyRef)` → subscribe with a signal `.update(list => ...)`). A mixin or base class feels like overkill, but a one-paragraph recipe in `.claude/agents/frontend-developer.md` ("root-scoped services may subscribe to `SocketService.on()` in their constructor; the buffered-listener fix in Round 4 makes this safe") would prevent a future feature from re-inventing it unsafely.
- **`SocketService.on()` typed-event map.** All five Round 5 events + three Round 4 events + `message:new` / `room:updated` are string literals. A `SocketEventMap` type (analogous to the contract's `Server → Client events` table) mapped on `on<K extends keyof SocketEventMap>(event: K): Observable<SocketEventMap[K]>` would eliminate the cast-per-call in every constructor. Zero runtime cost.
- **`matBadge` null-binding is the project standard.** Round 4 Bug 3 → `[matBadge]="count() || null"` is how both the friends and invitations badges hide at zero in Round 5. Worth adding a one-line rule to `DESIGN_SYSTEM.md §7` ("badges: bind the value; use `null` for hide, never `matBadgeHidden`").
- **Dialog close-on-success should be the default.** Round 4 Bug 0 (this round's Task 0) is the second round in a row where a dialog's success path didn't close. The design system could grow a "dialog submit flows always `dialogRef.close(result)` on success; stay-open-on-error is the exception that must be documented inline". Counter-example: the search typeahead inside the Add Friend dialog intentionally stays open after a "Send" (next user can be added without reopening). So the rule needs a "the submit is the dialog's primary action" qualifier.
- **Pre-commit forbidden-token scan.** `rg -l '\-\-mat-sys-|#[0-9a-fA-F]{3,8}\b' frontend/src/ && rg -l '\bpx\b' frontend/src/**/*.scss` in a husky pre-commit would catch drift without a human checklist. Round 4 asked for this; Round 5 hit three near-misses (one genuine `1px` in `shell.component.scss` that I fixed, two template expressions that build warnings caught before commit).
- **Playwright browser session fragility.** During verification the Chrome wedged itself into a stale `SingletonLock` mid-round; subsequent `mcp__playwright__browser_navigate` calls failed with "Browser is already in use". I could not recover without manual process kill. A teardown helper (or a `--isolated` default for the MCP config) would prevent this blocking future verification sessions.
