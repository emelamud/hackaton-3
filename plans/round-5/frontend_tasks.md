# Round 5 — Frontend Tasks

## Goal
Ship the Friends feature end-to-end: a Friends panel in the left sidebar, an incoming-friend-requests badge + dropdown in the top nav (mirror of the Round 4 invitations badge), an "Add Friend" dialog with type-ahead user search, and live Socket.io-driven updates for all five friend events. Also: fix the Round 4 regression where **the Manage Room "Send invite" button does not close the dialog on success**.

## Dependencies
- `shared/api-contract.md` — new §User Search Endpoint, new §Friend Endpoints, extended §Socket Events (`friend:request:new`, `friend:request:cancelled`, `friend:request:accepted`, `friend:request:rejected`, `friend:removed`). Read the Rules preambles and exact error strings.
- `shared/types/friend.ts` — `Friend`, `FriendRequest`, `CreateFriendRequestBody`, the four payload types, `UserSearchResult`, `UserSearchRelationship`.
- `frontend/CLAUDE.md` — folder structure, service patterns, form conventions.
- `frontend/docs/DESIGN_SYSTEM.md` + `.claude/skills/design-system/SKILL.md` — **mandatory** before writing components (no `--mat-sys-*`, no hex, no `px`, no inline style).
- `plans/round-4/frontend_work_summary.md` §Next round needs to know — `InvitationsService` pattern (root-scoped, badge-in-top-nav, socket event → signal mutation) generalises directly to this round. Bug 1 (`SocketService.on()` pre-connect trap) was FIXED in Round 4 cleanup, so a root-scoped `FriendsService` subscribing in its constructor is now safe. Bug 2 (component-local room signal shadowing `chatContext.currentRoom()`) is the counter-example — keep live state in services, not component-local copies.
- `plans/round-4/bugs.md` — context for task 0 (the invite-dialog-close fix).

**Do not modify `/shared/`.** If a contract tweak is needed, stop and flag it to the orchestrator.

## Tasks

### 0. Bug fix — Manage Room dialog: close on successful invite
Observed regression (user-reported, 2026-04-21): in `frontend/src/app/chat/manage-room-dialog.component.ts`, the `submitInvite()` success branch resets the form and shows a success line but keeps the dialog open. The user's expected behaviour: a successful invite closes the dialog.

**Fix**:
- In `submitInvite()` `next` callback (currently at ~`manage-room-dialog.component.ts:151-159`), after the invitation succeeds, call `this.dialogRef.close(null)` (or the `Invitation` payload — whichever the caller expects; `null` keeps parity with the existing "settings tab no-op" close path).
- Drop the now-unused `inviteSuccessUsername` signal + its template binding (the transient success line). If you want to keep a toast, wire the success up through `MatSnackBar` instead with `"Invited @<username>"` using the existing `snackBar` injection. Snackbar is optional — closing the dialog is the required change.
- On failure (HTTP error), preserve the current inline `MatError` behaviour — the dialog must stay open so the user can correct the username.

**Scope note**: this is a Round 4 bug being fixed in Round 5. Record it in the Round 5 FE summary under **Built → Bug fixes**, not under **Round 4 follow-up** (the Round 4 summaries are frozen).

### 1. User-search + friends HTTP plumbing
#### 1a. `frontend/src/app/core/users/users.service.ts` (new, root-scoped)
Minimal HTTP wrapper. No signals yet — search is a one-shot query triggered by the Add Friend dialog.

```ts
@Injectable({ providedIn: 'root' })
export class UsersService {
  private http = inject(HttpClient);
  private base = `${environment.apiUrl}/users`;

  search(q: string): Observable<UserSearchResult[]> {
    return this.http.get<UserSearchResult[]>(`${this.base}/search`, { params: { q } });
  }
}
```

Goes under `core/users/` because no other users-centric state lives anywhere yet. If a users folder already exists (e.g. inside `core/auth/`), keep this service in its own folder — it is not auth-specific.

#### 1b. `frontend/src/app/core/friends/friends.service.ts` (new, root-scoped)
The Round 5 analogue of `InvitationsService`. Holds three signals + the five socket subscriptions + the HTTP methods.

```ts
@Injectable({ providedIn: 'root' })
export class FriendsService {
  readonly friends = signal<Friend[]>([]);
  readonly incomingRequests = signal<FriendRequest[]>([]);
  readonly outgoingRequests = signal<FriendRequest[]>([]);

  readonly incomingCount = computed(() => this.incomingRequests().length);
  readonly friendCount = computed(() => this.friends().length);

  fetchInitial(): Observable<void>;   // forkJoin: GET /api/friends + incoming + outgoing
  sendRequest(body: CreateFriendRequestBody): Observable<FriendRequest>;   // POST /api/friend-requests
  acceptRequest(id: string): Observable<Friend>;                          // POST /api/friend-requests/:id/accept
  rejectRequest(id: string): Observable<void>;                            // POST /api/friend-requests/:id/reject
  cancelRequest(id: string): Observable<void>;                            // DELETE /api/friend-requests/:id
  removeFriend(userId: string): Observable<void>;                         // DELETE /api/friends/:userId

  // Private, wired in constructor via takeUntilDestroyed:
  // - socketService.on<FriendRequest>('friend:request:new') → prepend to incomingRequests
  // - socketService.on<FriendRequestCancelledPayload>('friend:request:cancelled') → filter incomingRequests by requestId
  // - socketService.on<FriendRequestRejectedPayload>('friend:request:rejected') → filter outgoingRequests by requestId
  // - socketService.on<FriendRequestAcceptedPayload>('friend:request:accepted') →
  //     - filter incomingRequests and outgoingRequests by requestId (the event fires on both sides — whichever list held it gets the filter)
  //     - prepend payload.friend to friends (dedupe by userId)
  // - socketService.on<FriendRemovedPayload>('friend:removed') → filter friends by userId
}
```

Lifecycle notes:
- Subscribe to all five events in the constructor with `takeUntilDestroyed(inject(DestroyRef))`. Root-scoped so it lives the whole app.
- All signal mutations use `.update(list => ...)`.
- Dedupe by id/userId before prepending (belt-and-suspenders — if `fetchInitial()` and a socket event race, we don't want duplicates).

#### 1c. Wire `FriendsService` into `AuthService`
Edit `frontend/src/app/core/auth/auth.service.ts`:
- Inject `FriendsService`.
- `login()` / `register()` / successful `refresh()` → `friendsService.fetchInitial().subscribe()`.
- `clearSession()` / `logout()` → reset all three signals to `[]`.

Mirror exactly how `InvitationsService` is wired today (Round 4 addition in this same file).

### 2. Top-nav friend-requests badge
Extend `frontend/src/app/shell/shell.component.*` — add one new control to the right-side cluster, between the existing invitations (mail) badge and the Sessions / profile dropdown.

- `mat-icon-button` with a `person_add` icon.
- `matBadge` bound to `friendsService.incomingCount() || null` — binding to `null` when zero is the Round-4 Bug-3 pattern (matBadgeHidden was unreliable; nullish value is the robust hide).
- Click opens a `mat-menu` anchored to the button. Menu content:
  - Empty state: "No pending friend requests" (subtle, centred).
  - Otherwise a scrollable list of `FriendRequestItemComponent` rows — see task 3.

Keep the shell responsive rules untouched. The new icon button slots alongside the Round 4 invitations badge.

### 3. Friend-request item — `frontend/src/app/core/friends/friend-request-item.component.*` (new)
Dumb presentation component used inside the top-nav dropdown.

Input: `request: FriendRequest`.
Template:
- Line 1: "**{{ request.fromUsername }}** wants to be your friend"
- Line 2 (if `request.message`): blockquote-style `text-subtle` rendering of the message, max-height clamped to ~3 lines, overflow `ellipsis`.
- Line 3: relative time from `createdAt` (reuse the `DatePipe` pattern from `message-list.component.ts`).
- Two `mat-button`s: "Accept" (primary) and "Reject" (tonal/outlined).

Outputs: `(accept)="..."`, `(reject)="..."` — parent wires these to `friendsService.acceptRequest(id)` / `rejectRequest(id)`. On success the parent closes the `mat-menu` (Material's default menu auto-close on button click is fine).

Use utility classes only — no `--mat-sys-*`, no hex, no `px`.

### 4. Add Friend dialog — `frontend/src/app/chat/add-friend-dialog.component.*` (new) OR `frontend/src/app/core/friends/add-friend-dialog.component.*`
`MatDialog`-launched standalone component. Opened from the left-sidebar "Add friend" button (task 5) and optionally from the top-nav menu (deferred).

Data: none passed via `MAT_DIALOG_DATA`. All state is local.

Shape:
- Dialog title: "Add a friend".
- Close button in the header.
- `mat-form-field` with `matInput` and the `formControl` bound to a `searchControl`. Placeholder: "Search by username". `Validators.minLength(2)`.
- Debounced type-ahead — `searchControl.valueChanges` piped through `debounceTime(250)`, `distinctUntilChanged()`, `switchMap(q => q.trim().length >= 2 ? usersService.search(q) : of([]))`. Results land in a `results = signal<UserSearchResult[]>([])`.
- Results list: each row shows `username` and a status-sensitive action button:
  - `relationship === 'none'`: "Add friend" button → opens the request form.
  - `relationship === 'friend'`: disabled "Friends" chip.
  - `relationship === 'outgoing_pending'`: disabled "Request sent" chip + "Cancel" link button → calls `friendsService.cancelRequest(<outgoingRequestId>)`. **Note**: the search response does not include the request id. The FE must look it up in `friendsService.outgoingRequests()` by `toUserId === result.id`. If not present (race with incoming socket-cancel), disable the Cancel control.
  - `relationship === 'incoming_pending'`: "Accept" / "Reject" buttons → same cross-reference against `friendsService.incomingRequests()` for the `requestId`.
- When "Add friend" is clicked, reveal an inline `mat-form-field` with a `message` control (`maxLength: 500`, optional) and a "Send" button. Submit calls `friendsService.sendRequest({ toUsername: result.username, message: trimmedMessage || undefined })`. On success: update the row's displayed `relationship` to `'outgoing_pending'` immediately (optimistic — the socket event will also arrive momentarily but we don't want UI lag). On HTTP error, surface the server error string via `MatSnackBar`.
- Closing the dialog does not cancel pending typeahead observable — use `takeUntilDestroyed(inject(DestroyRef))`.

**Do not** render the entire friends list inside this dialog — that's the sidebar panel's job. This dialog is for adding.

Design-system compliance reminder: all buttons are `mat-button` / `mat-icon-button`; chips are `mat-chip`; layout uses flex utilities. No raw hex, no `px`.

### 5. Friends panel — extend `frontend/src/app/chat/rooms-sidebar.component.*`
The left sidebar currently renders "Rooms" (from Round 2). Add a collapsible "Friends" section underneath, following the existing sidebar section pattern.

- Heading row: "Friends" + a small `mat-icon-button` with a `person_add` icon → opens `AddFriendDialogComponent`. Counter chip showing `friendsService.friendCount()` when > 0.
- List: render `friendsService.friends()`. Each row:
  - Username (primary text).
  - Overflow menu (`mat-icon-button` with `more_vert` + `mat-menu`): "Remove friend" → confirm via `MatDialog` or just a `window.confirm` (prefer `MatDialog` with a tiny confirmation component; if one already exists for room deletion later, reuse it) → `friendsService.removeFriend(userId)`.
- Empty state: "No friends yet. Add someone to start chatting." with a "Add friend" button that opens the same dialog.

No presence dots yet — presence is Round 7. Leave space in the row layout so the dot can slot in without reshuffling.

Outgoing-pending indicator: if `friendsService.outgoingRequests().length > 0`, render a subtle collapsed summary row "N pending…" that expands into the outgoing list on click (each row has a "Cancel" button → `friendsService.cancelRequest(id)`). Keep this minimal — the primary UX affordance is the Add Friend dialog flow, not managing outgoing requests from the sidebar.

### 6. Accept / reject handling in the top-nav menu
In `shell.component.ts` (where the menu is defined in task 2), the accept handler:
1. Calls `friendsService.acceptRequest(requestId)`.
2. On success the `friends` signal already has the new friend (via the `friend:request:accepted` socket event that fires back at the same user); no component-local state needed.
3. Optional: snackbar "You and @{{ fromUsername }} are now friends".
4. Does NOT navigate — friendship is not a destination in Round 5 (Round 6 adds DM opens).

Reject handler: `friendsService.rejectRequest(requestId)` + optional snackbar. No navigation.

Both handlers close the `mat-menu` after the click (Material's default behaviour).

### 7. `ChatContextService` / `RoomsService` — no changes
Friend events do not interact with room state. No updates to these two services.

### 8. Forbidden-token scan + design-system compliance
Before declaring the task done:
- Grep the new/edited files under `frontend/src/` for `--mat-sys-`, `\#[0-9a-fA-F]{3,8}\b` (hex), and `\bpx\b` inside `*.scss` — zero matches.
- Visual check in Playwright (task 10): rows and chips should inherit the existing Slack-inspired density. New components should not introduce one-off spacing.

### 9. Verification (mandatory — per `.claude/agents/frontend-developer.md`)
- `docker compose up` with the Round 5 backend.
- Load Playwright MCP via `ToolSearch`:
  `select:mcp__playwright__browser_navigate,mcp__playwright__browser_click,mcp__playwright__browser_type,mcp__playwright__browser_snapshot,mcp__playwright__browser_console_messages,mcp__playwright__browser_take_screenshot,mcp__playwright__browser_tabs,mcp__playwright__browser_fill_form,mcp__playwright__browser_wait_for`.

Scenarios:

**Bug-fix regression (task 0)**
1. As alice, create a private room. Open Manage Room → Invitations. Invite `bob` (valid, existing user). **Dialog closes** on success. Sidebar / rail reflect new member via `room:updated` broadcast as before.
2. Invite `ghost` → inline "User not found" under the username field; dialog stays open.
3. Invite `bob` again → inline "User is already a member of this room"; dialog stays open.

**Friends — happy path**
4. Login as alice (tab 0) and bob (tab 1). Both see `person_add` badge = 0 initially.
5. Alice opens the Friends panel → "Add friend" → search "bo" → sees bob with "Add friend" button. Click → reveal message field → type "hi" → Send. Button row flips to "Request sent" + Cancel.
6. Bob's tab: `person_add` badge goes to 1 (live, no reload). Open dropdown → sees "alice wants to be your friend" + message "hi" + relative time + Accept/Reject.
7. Bob clicks Accept. Dropdown closes. Bob's Friends panel shows alice. Alice's Friends panel shows bob — all live via `friend:request:accepted`. Alice's Add Friend search result row (if still open) updates from "Request sent" to "Friends".
8. Alice opens `...` on bob's row → "Remove friend" → confirm → bob disappears from alice's list. Bob's tab: bob's own list updates live (bob is removed) via `friend:removed`.

**Friends — reject / cancel**
9. Alice sends a friend request to bob. Bob rejects. Alice's outgoing-pending indicator clears live via `friend:request:rejected`.
10. Alice sends a friend request to bob. Before bob reacts, alice opens the outgoing-pending section in the sidebar → Cancel. Bob's badge drops to 0 live via `friend:request:cancelled`.

**Friends — edge cases**
11. Alice searches her own username → row appears hidden (self-exclusion on BE).
12. Alice and bob are friends. Alice opens Add Friend, searches "bob" → row shows "Friends" chip. No action buttons.
13. Alice sends request; tries again (resend) → inline snackbar / MatError with `"A pending friend request already exists between you and this user"`.
14. Alice and bob are already friends. Alice sends request → snackbar / MatError `"You are already friends with this user"`.
15. Search `a` (one char) → empty result list (client-side minLength filter skips the request).
16. Search `<` special chars → request sent as-is; backend returns whatever matches. No client crash.

**Responsive + dark mode**
17. Resize to < 56.5 rem — Friends panel collapses into the accordion pattern from the Round 2 sidebar. Badge on top nav remains visible.
18. Toggle dark mode — no contrast regressions on Friends chips / Accept / Reject buttons.

**Forbidden-token scan**
19. `--mat-sys-` / hex / raw `px` in SCSS across the diff — zero matches.

## Wrap-up
Write `plans/round-5/frontend_work_summary.md` with:
- **Built** — services (`FriendsService`, `UsersService`), components (`AddFriendDialog`, `FriendRequestItem`), shell nav additions, sidebar Friends panel, socket subscriptions attached in the `FriendsService` constructor, **Bug fix: Manage Room invite dialog closes on success**.
- **Deviations** — any shape / UX changes relative to this task file (e.g. where the Remove Friend confirmation lives; whether outgoing-pending gets a dedicated sidebar row or is folded into the Add Friend dialog).
- **Deferred** — friend requests from a room member list (requirement §2.3.2 second bullet — orchestrator-side deferral), user-to-user ban (Round 6), presence dots on friend rows (Round 7), DM-open action on a friend row (Round 6), outgoing-request badge.
- **Next round needs to know** — for Round 6 (DMs): the Friends panel is where "Message" actions belong; each friend row should grow a `mat-icon-button` with `chat_bubble_outline` that calls the to-be-built DM service. `FriendsService.friends()` is the list the DM sidebar reads. For Round 7 (presence): the `friends` signal + DM participants + room-members rail are the three consumers — wherever the presence subscription lands, it should dedupe userIds across all three.
- **Config improvements** — whether the root-scoped-service-subscribes-in-constructor pattern (now used by `InvitationsService` + `FriendsService`) warrants a mixin or shared base class; whether `SocketService.on()` should expose a typed-event map; whether the dialog-close-on-success pattern should be codified in the design system as a default (Round 4 Bug 0 is the counter-example). Also note whether `matBadge` null-binding vs `matBadgeHidden` is now the project-wide standard (Bug 3 from Round 4 pushed toward null-binding — confirm in this round).
