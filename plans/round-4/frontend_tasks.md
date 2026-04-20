# Round 4 — Frontend Tasks

## Goal
Surface pending invitations in the top nav (live badge + dropdown with Accept / Reject), build the Manage Room dialog with **Invitations** + **Settings** tabs, wire `room:updated` into `ChatContextService` + `RoomsService` so sidebar / rail / header refresh live on edits or new-member joins, and enable the currently-disabled "Manage room" button in the right rail.

## Dependencies
- `shared/api-contract.md` — new §Invitation Endpoints, new `PATCH /api/rooms/:id`, extended §Socket Events (`invitation:new`, `invitation:revoked`, `room:updated`). Read the Rules preambles and exact error strings.
- `shared/types/invitation.ts` — `Invitation`, `CreateInvitationRequest`, `InvitationRevokedPayload`
- `shared/types/room.ts` — new `PatchRoomRequest`
- `frontend/CLAUDE.md` — folder structure, service patterns, form conventions
- `frontend/docs/DESIGN_SYSTEM.md` + `.claude/skills/design-system/SKILL.md` — **mandatory** before writing components (no `--mat-sys-*`, no hex, no `px`, no inline style)
- `plans/round-3/frontend_work_summary.md` §Next round needs to know — already sketches this round's plumbing (`InvitationsService` shape, `ChatContextService` as `room:updated` landing spot, subscribe-in-services rule)

**Do not modify `/shared/`.** If a contract tweak is needed, stop and flag it to the orchestrator.

## Tasks

### 1. Invitations service — `frontend/src/app/core/invitations/invitations.service.ts` (new)
Goes under `core/` (not `chat/`) because the notification UI lives in the top nav and must work regardless of which route the user is on. Same placement rationale as `core/socket/`.

Shape:

```ts
@Injectable({ providedIn: 'root' })
export class InvitationsService {
  readonly pending = signal<Invitation[]>([]);
  readonly pendingCount = computed(() => this.pending().length);

  // Called from AuthService after login / successful refresh
  fetchInitial(): Observable<Invitation[]>;   // GET /api/invitations

  accept(invitationId: string): Observable<RoomDetail>;  // POST /api/invitations/:id/accept
  reject(invitationId: string): Observable<void>;        // POST /api/invitations/:id/reject
  revoke(invitationId: string): Observable<void>;        // DELETE /api/invitations/:id (used from Manage Room → Invitations tab if we render sent-invites; not strictly needed in Round 4)

  // Private: wired in constructor via effect() / socket subscription
  // - socketService.on<Invitation>('invitation:new') → prepend to pending()
  // - socketService.on<InvitationRevokedPayload>('invitation:revoked') → filter out by id
}
```

Lifecycle:
- Subscribe to the two socket events **in the constructor**, using `takeUntilDestroyed(inject(DestroyRef))`. The service is a root-scoped singleton so it effectively lives for the app lifetime — no teardown concern in practice, but use the idiomatic pattern.
- `AuthService.login()`, `AuthService.register()`, and successful `AuthService.refresh()` call `invitationsService.fetchInitial().subscribe()` to seed the list after (re)auth. On `logout()`, clear the signal.
- Do **not** dedupe in the service — if the same invitation arrives twice (socket + initial fetch race), rely on id-based `some()` check before prepend.

### 2. Wire `InvitationsService` into `AuthService`
Edit `frontend/src/app/core/auth/auth.service.ts`:
- Inject `InvitationsService`.
- `login()` / `register()` / `refresh()` (in the socket-connect branch) → call `invitationsService.fetchInitial().subscribe()`.
- `clearSession()` / `logout()` → `invitationsService.pending.set([])`.

### 3. Top-nav invitations badge — extend `frontend/src/app/shell/shell.component.*`
Round 1 shell has the top nav. Add a new control between the nav links and the Sessions / profile dropdown:

- `mat-icon-button` with a `mail` (or `notifications`) icon.
- Wrap in `matBadge` = `invitationsService.pendingCount()`, hidden when count is 0 (`matBadgeHidden`).
- Clicking opens a `mat-menu` anchored to the button. Menu content:
  - Empty state: "No pending invitations" (subtle, centred).
  - Otherwise a scrollable list of `InvitationItemComponent` rows — see task 4.

Keep the shell responsive rules from Round 1 untouched; the badge button is just one more item in the existing right-side cluster.

### 4. Invitation item — `frontend/src/app/core/invitations/invitation-item.component.*` (new)
Dumb presentation component used inside the top-nav dropdown. Input: `invitation: Invitation`. Template:

- Line 1: "**{{ invitation.invitedByUsername }}** invited you to **#{{ invitation.roomName }}**"
- Line 2: relative time from `createdAt` (reuse the `DatePipe` pattern from `message-list.component`; no custom relative-time lib).
- Two `mat-button`s: "Accept" (primary) and "Reject" (tonal/outlined).

Outputs: `(accept)="..."`, `(reject)="..."` — parent wires these to the service calls. On accept success, navigate to `/chat/:roomId`; on reject, no navigation. The parent closes the `mat-menu` after a click.

Use `text-*` utility classes for colour; no `--mat-sys-*` raw usage, no hex, no `px`.

### 5. Manage Room dialog — `frontend/src/app/chat/manage-room-dialog.component.*` (new)
`MatDialog`-launched component. Data: `RoomDetail` (passed via `MAT_DIALOG_DATA`). Shape:

- `mat-tab-group` with two tabs for Round 4:
  - **Invitations** (first tab)
  - **Settings** (second tab)

The dialog title reads `Manage room: #{{ data.name }}`. Close button in the header.

#### Invitations tab
- Show the tab only if the room is **private** (Q3 = 3a — inviting public rooms is disallowed). For public rooms, render a small info card: "This room is public — no invitation needed."
- Any member of a private room may invite (Q1 = 1a) — no role gate in the UI.
- ReactiveFormsModule form: one `username` control, `Validators.required`, trim before submit.
- "Send invite" button; `submitting` signal disables while in flight.
- On submit: `invitationsHttp.createForRoom(roomId, { username })` (see task 6 — a narrow HTTP method that wraps `POST /api/rooms/:id/invitations`). On success: show a transient "Invited @{{ username }}" success line under the form, clear the input. On ack error: surface the exact server error string (e.g. `"User not found"`, `"User is already a member of this room"`, `"An invitation is already pending for this user"`) under the field using the same `MatError` + control-level `setErrors({ serverError: true })` pattern used in Round 2's Create Room dialog.
- Round 4 does **not** render a list of pending invitations the caller has sent. Flag as deferred.

#### Settings tab
- Visible to anyone in the room; form fields are **editable only if** the caller is `owner` or `admin` (Q2 = 2b). Derive from `data.members.find(m => m.userId === authService.currentUser()?.id)?.role`.
  - Non-owner/admin → show fields but disable them, with a note: "Only the room's owner or admins can edit these settings."
- Form controls (`ReactiveFormsModule`):
  - `name` — `Validators.required`, `Validators.minLength(3)`, `Validators.maxLength(64)`, pre-filled with `data.name`.
  - `description` — `Validators.maxLength(500)`, pre-filled with `data.description ?? ''`.
  - `visibility` — `mat-radio-group` (`public` / `private`), pre-filled with `data.visibility`.
- "Save changes" button — disabled unless form is dirty (`form.dirty`) and valid.
- On submit: build a `PatchRoomRequest` with **only changed fields**. If `description` was cleared (empty string), send `null`. Call `roomsService.patch(roomId, body)` → `PATCH /api/rooms/:id`.
- On success: close the dialog with the returned `RoomDetail`. (The `room:updated` socket broadcast will refresh sidebar + rail automatically — no manual list push needed.)
- On 409 (`Room name already taken`): inline `MatError` under the name field using the same Round-2 409 pattern.
- On 403 / 400: snackbar with the server error string.

Fresh `mat-icon-button`/`mat-form-field`/`mat-radio-group`/`mat-tab-group` imports only — standalone component with per-dialog `imports: [...]`.

### 6. Extend `frontend/src/app/chat/rooms.service.ts`
Add two narrow HTTP methods alongside the existing `list()` / `create()` / `get()` / `join()` / `leave()`:

- `patch(id: string, body: PatchRoomRequest): Observable<RoomDetail>` — `PATCH ${baseUrl}/${id}`.
- `createInvitation(roomId: string, body: CreateInvitationRequest): Observable<Invitation>` — `POST ${baseUrl}/${roomId}/invitations`.

Do **not** push `room:updated` results into `roomsSignal` from this method — that lives in the socket subscription set up in task 7.

### 7. Wire `room:updated` into the client — two subscribers
This event fires for any room-state change (PATCH, invitation accept). Two independent consumers update their own slices of state.

#### 7a. `ChatContextService` (update existing)
Edit `frontend/src/app/chat/chat-context.service.ts`:
- Inject `SocketService`.
- In the constructor, subscribe to `socketService.on<RoomDetail>('room:updated')` with `takeUntilDestroyed`.
- On event: if `payload.id === currentRoom()?.id`, call `setCurrentRoom(payload)`. Otherwise ignore.
- Effect: the open room-view header, the right-rail members list, and anything else that reads `currentRoom()` refresh automatically.

#### 7b. `RoomsService` (update existing)
Edit `frontend/src/app/chat/rooms.service.ts`:
- Inject `SocketService`.
- In the constructor, subscribe to `socketService.on<RoomDetail>('room:updated')` with `takeUntilDestroyed`.
- On event: `roomsSignal.update(list => list.map(r => r.id === payload.id ? toSidebarShape(payload) : r))`. If the room isn't already in the list (accepter's first sighting after `invitation:accept`), append it instead.
- `toSidebarShape(detail: RoomDetail): Room` just strips `members` down to the list shape used by `GET /api/rooms` — `{ id, name, description, visibility, ownerId, createdAt, memberCount }`.
- Effect: sidebar rows rename live, the new accepter sees the room pop into their sidebar without a `refresh()`, and `memberCount` stays in sync.

Both subscriptions attach at service construction and live for the app lifetime. No extra teardown logic beyond the `takeUntilDestroyed(inject(DestroyRef))` pattern.

### 8. Enable the "Manage room" button — edit `frontend/src/app/chat/room-rail.component.*`
The button exists but is disabled (Round 2 placeholder).
- Remove the `disabled` attribute (or make it conditional: disable when `chatContext.currentRoom()` is null, which already is the "no room" rail state).
- Click handler: `dialog.open(ManageRoomDialogComponent, { data: this.chatContext.currentRoom()!, ... })`.
- No need to do anything with the result: `room:updated` broadcast handles state refresh.

Keep the "Invite user" button as it is (visual-only in Round 2). The real invitation flow is the Manage Room → Invitations tab now; the rail button can be deferred to a later polish pass or wired to directly open the dialog on the Invitations tab as a convenience — do whichever is shorter. If wired, pass an `initialTab: 'invitations'` value through `MAT_DIALOG_DATA`.

### 9. No shell layout / sidebar surgery
Task 3 adds one icon button to the existing toolbar cluster. Do **not** restructure the shell nav or alter the sidebar. The Round 2 "Public Rooms / Private Rooms / Contacts" placeholders stay as-is.

### 10. Verification (mandatory — per `.claude/agents/frontend-developer.md`)
- Run `docker compose up` with the Round 4 backend in place.
- Load Playwright MCP via `ToolSearch`: `select:mcp__playwright__browser_navigate,mcp__playwright__browser_click,mcp__playwright__browser_type,mcp__playwright__browser_snapshot,mcp__playwright__browser_console_messages,mcp__playwright__browser_take_screenshot,mcp__playwright__browser_tabs,mcp__playwright__browser_fill_form,mcp__playwright__browser_wait_for`.

Scenarios to exercise end-to-end:

1. Log in as alice (`alice@test.dev / Passw0rd!`). Create a **private** room "alice-secret".
2. In a second browser tab (same Playwright session), log in as bob (`bob@test.dev / Passw0rd!`). Confirm the top-nav badge count is `0`.
3. As alice, open the private room → right rail → "Manage room" → Invitations tab → enter `bob` → Send invite.
4. Bob's tab: badge shows `1` live (no reload). Click the badge → see alice → #alice-secret invitation with Accept / Reject.
5. Click **Accept**: dialog closes, navigates to `/chat/<alice-secret-id>`, room-view + rail render; sidebar shows the room under Private Rooms with `memberCount: 2`. Alice's tab: rail member list now shows bob (live, no reload).
6. As alice, Manage room → Settings tab → rename to "alice-core", save. Both tabs' room header / sidebar / rail update to the new name within ~2 s with no reload.
7. As bob (member, not owner/admin), Manage room → Settings tab → fields should be disabled with the "Only the room's owner or admins can edit these settings" note. Attempting to submit via DevTools → ignored (form invalid because pristine, plus the PATCH would 403 anyway).
8. As alice, try renaming to a name already used by another room → inline 409 "Room name already taken" under the name field.
9. As alice, try inviting a non-existent user `ghost` → inline "User not found" under the username field.
10. As alice, invite `bob` again (already member) → inline "User is already a member of this room".
11. As alice, revoke flow: invite bob to some other private room; before bob accepts, have alice (inviter) revoke via Manage Room → Invitations → (skipped if no sent-invites list; alternative: call `invitationsService.revoke()` from DevTools, or defer the revoke UI to a future round and just rely on BE coverage). If no UI path, document the deferred revoke-from-UI explicitly and trust the BE smoke test for `invitation:revoked`.
12. On reject flow: have alice invite bob; bob rejects via the top-nav dropdown. Badge drops to zero. Alice's UI is unchanged (reject doesn't notify the inviter in Round 4).
13. Dark mode toggle — no contrast regressions.
14. Resize to <56.5 rem — dialog still scrollable, top-nav badge still visible.
15. Forbidden-token scan: `--mat-sys-` / hex literals / raw `px` in SCSS across new / edited files — zero matches.

## Wrap-up
Write `plans/round-4/frontend_work_summary.md` with:
- **Built** — services, components, shell nav additions, socket subscriptions added to existing services
- **Deviations** — especially how the revoke-from-UI decision was handled (task 11), any tab-scaffolding choices that differed
- **Deferred** — sent-invites list inside the Manage Room dialog, room deletion button in the Settings tab (Round 11), admin-level revoke, room:updated on public join/leave (backend-side decision documented in the contract), presence dots in the rail (still Round 7)
- **Next round needs to know** — for Round 5 (Message History + Pagination): where the infinite-scroll hook will sit relative to the now-auto-refreshing `ChatContextService`; for Round 11 (moderation): the Settings tab already hides fields by role — extending to Members / Admins / Banned tabs plugs into the same `mat-tab-group`
- **Config improvements** — any friction from wiring two service-level socket subscribers (duplication vs. central bus), design-system gaps (tab styling, badge placement), CLAUDE.md additions — e.g. "live state refreshes land in services, not components"
