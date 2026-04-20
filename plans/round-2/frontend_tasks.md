# Round 2 — Frontend Tasks

## Goal
Replace the `/chat` placeholder with the real three-column chat shell. User can create a public room, see their rooms in the left sidebar, click one to open it, and see an empty message pane with basic room info on the right. No real-time, no messages yet.

## Dependencies
- `shared/api-contract.md` §Rooms Endpoints — all request/response shapes
- `shared/types/room.ts` — `Room`, `RoomDetail`, `RoomMember`, `RoomRole`, `RoomVisibility`, `CreateRoomRequest`
- `frontend/CLAUDE.md` — folder structure, service patterns, routing conventions
- `frontend/docs/DESIGN_SYSTEM.md` and `.claude/skills/design-system/SKILL.md` — **mandatory** before writing any component
- `.claude/agents/frontend-developer.md` — hard rules: no `--mat-sys-*` direct use, no hex, no `px`, no inline style
- Existing patterns to copy, **not reinvent**:
  - `frontend/src/app/sessions/sessions.service.ts` — HTTP service shape (replicate for rooms)
  - `frontend/src/app/shell/shell.component.*` — where to mount the new chat layout
  - `frontend/src/app/auth/**` — ReactiveFormsModule + MatFormField + MatInput + submit-disabled pattern (for the Create-Room dialog)

**Do not modify `/shared/`.** If a contract tweak is needed, stop and flag it to the orchestrator.

## Tasks

### 1. Room service — `frontend/src/app/chat/rooms.service.ts`
Mirror `sessions.service.ts`. Use `inject(HttpClient)` + `environment.apiUrl`. Methods:

- `list(): Observable<Room[]>` → `GET /api/rooms`
- `create(body: CreateRoomRequest): Observable<RoomDetail>` → `POST /api/rooms`
- `get(id: string): Observable<RoomDetail>` → `GET /api/rooms/:id`
- `join(id: string): Observable<RoomDetail>` → `POST /api/rooms/:id/join`
- `leave(id: string): Observable<void>` → `POST /api/rooms/:id/leave`

Also expose a `roomsSignal = signal<Room[]>([])` + `refresh()` method that calls `list()` and pushes into the signal. Left-sidebar subscribes to this signal so creating a room updates the list without a full page reload.

### 2. Routing — `frontend/src/app/app.routes.ts`
Replace the single `/chat` child route (currently `chat-placeholder`) with a nested chat layout:

```
{ path: 'chat',
  loadComponent: () => import('./chat/chat-layout.component').then(m => m.ChatLayoutComponent),
  children: [
    { path: '', loadComponent: () => import('./chat/empty-state.component').then(m => m.EmptyStateComponent) },
    { path: ':roomId', loadComponent: () => import('./chat/room-view.component').then(m => m.RoomViewComponent) },
  ],
}
```

Keep `authGuard` on the parent (inherited from the Shell wrapper route established in Round 1).

### 3. Chat layout — `frontend/src/app/chat/chat-layout.component.*`
Three-column responsive layout, desktop-first, collapses below `md` (56.5rem) per the design system.

Structure:
- Host element: `display: grid; grid-template-columns: 16rem 1fr 16rem; height: 100%;` (use the design-system `.chat-grid` utility if one exists; otherwise define locally using tokens — no `px`, no hex).
- Left column: `<app-rooms-sidebar />`
- Center column: `<router-outlet />`
- Right column: `<app-room-rail />` — reads the currently-open room id from the child route param (use `ActivatedRoute.firstChild?.paramMap` or an input set by `RoomViewComponent` via a shared signal service — pick the simpler option and document the choice in the summary).

Below `md`: collapse right column entirely; left column becomes a `mat-drawer` (reuse pattern from requirement §4.1.1 "accordion style after entering a room" — deferred to polish, but the layout must at least not break on mobile).

### 4. Rooms sidebar — `frontend/src/app/chat/rooms-sidebar.component.*`
- Header: "Rooms" label + `[+]` icon button → opens Create Room dialog
- Search input (`MatFormField` appearance=outline, `MatInput`) — filters the room list client-side by name/description, no backend call
- Grouped list:
  - "Public Rooms" group header — `room.visibility === 'public'`
  - "Private Rooms" group header — `room.visibility === 'private'`
- Each row: `# name` + `(memberCount)`, uses `routerLink="/chat/:id"` with `routerLinkActive` to highlight the open room
- On init: `roomsService.refresh()`; subscribe to `roomsService.roomsSignal`
- Empty-state row when `rooms().length === 0`: "No rooms yet. Create one to get started."

Use `mat-list` or `mat-nav-list`. No raw `<ul><li>` for nav items.

### 5. Create Room dialog — `frontend/src/app/chat/create-room-dialog.component.*`
Triggered from the sidebar button. `MatDialog`.

ReactiveFormsModule:
- `name`: required, 3–64 chars
- `description`: optional, 0–500 chars (`mat-input` with `[cdkTextareaAutosize]` or a fixed `rows`)
- `visibility`: `mat-radio-group` — `Public` (default) / `Private`

On submit:
- Disable submit while in-flight (`submitting` signal)
- Call `roomsService.create(form.value)`; on success, close dialog with the `RoomDetail`, call `roomsService.refresh()`, then `router.navigate(['/chat', created.id])`
- On 409 (`Room name already taken`): set a form-level error and surface under the name field. Read the message from the error response `{ error }`.
- Other errors → global snackbar (reuse Round 1's `MatSnackBar` pattern)

### 6. Room view — `frontend/src/app/chat/room-view.component.*`
Loads `RoomDetail` for `:roomId`. Structure:
- Header row: `# room.name` + `room.description` (muted)
- Center area: empty placeholder (dashed border box, text "No messages yet — real-time chat comes in the next round"). This is the slot Round 3 (2b) will fill with the message list + composer.
- On 403 / 404 from `GET /api/rooms/:id`: navigate to `/chat` and show a snackbar ("You don't have access to this room" / "Room not found").

Expose the loaded `RoomDetail` via a `signal<RoomDetail | null>` so the right rail can read it without a second HTTP call. Simplest sharing: inject a small `ChatContextService` that holds `currentRoom = signal<RoomDetail | null>(null)`; `RoomViewComponent` writes it on load and resets on destroy; `RoomRailComponent` reads it.

### 7. Room rail — `frontend/src/app/chat/room-rail.component.*`
Right column content. When `chatContext.currentRoom()` is null: show a subtle "Pick a room to see details" state. When a room is loaded:
- Room info card: name, description, visibility badge (public / private), owner username
- Member list (from `RoomDetail.members`) with placeholder status dot (all `●` online-colored — real presence is Round 3c). Role label next to owner / admin.
- Member count header: `Members (N)`
- Buttons (visual only, disabled for 2a): `[Invite user]`, `[Manage room]` — wired in Round 5.

### 8. Empty state — `frontend/src/app/chat/empty-state.component.*`
Shown when `/chat` is open with no room selected. Centered text + subtle illustration placeholder: "Select a room from the sidebar, or create a new one." Simple component, no service dependencies.

### 9. Update `/chat` nav link in shell
`shell.component.html` currently has top-nav entries "Public Rooms / Private Rooms / Contacts" as visual placeholders (noted in round-1 summary). Leave them visual-only for now — the left sidebar is the real rooms surface. Do not change shell layout.

### 10. Verification (mandatory before writing the summary)
Per `.claude/agents/frontend-developer.md`:
1. Run `docker compose up` (or `pnpm start` against a running backend)
2. Use Playwright MCP:
   - Navigate to `http://localhost:4300`, log in with a registered user
   - Open `/chat` — empty-state visible, left sidebar renders "No rooms yet"
   - Click `[+]`, fill the dialog, submit — sidebar updates, route changes to `/chat/:id`, room view + rail render
   - Try creating a second room with the same name → inline 409 error surfaces under `name`
   - Reload `/chat/:id` → room still loads (no auth loss)
   - Toggle dark mode → no contrast regressions, no `--mat-sys-*`/hex/`px` in diff
3. Check DevTools console — no errors
4. Confirm responsive: resize to <56.5rem, layout doesn't explode

## Wrap-up
Write `plans/round-2/frontend_work_summary.md` with:
- **Built** — components, service, routes
- **Deviations** — anything that differs from this plan or the contract (especially right-rail data-sharing choice)
- **Deferred** — visual-only buttons, mobile drawer polish, presence dots (all intentional)
- **Next round needs to know** — notes for Round 3 (2b / real-time messaging): where the socket client will slot into `RoomViewComponent`, whether `ChatContextService` should own the active-room subscription to keep sockets tied to route lifecycle
- **Config improvements** — design-system skill friction, missing utility classes, useful CLAUDE.md additions
