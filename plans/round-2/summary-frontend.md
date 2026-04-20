# Round 2 (sub-round 2a) — Frontend Summary

## Built

All new code lives under `frontend/src/app/chat/`:

- **`rooms.service.ts`** — `list()`, `create()`, `get()`, `join()`, `leave()` matching the contract; `roomsSignal: Signal<Room[]>` + `refresh()` that fetches and pushes into the signal.
- **`chat-context.service.ts`** — `currentRoom: Signal<RoomDetail | null>`, `setCurrentRoom()`, `clear()`. Shared between `RoomViewComponent` (writer) and `RoomRailComponent` (reader).
- **`chat-layout.component.*`** — 3-col grid `16rem 1fr 18rem`, hosts sidebar / `<router-outlet>` / rail. Media queries collapse the rail below 77.5rem, narrow the sidebar below 56.5rem, and hide it entirely below 37.5rem.
- **`rooms-sidebar.component.*`** — Rooms header + `[+]` icon, `<mat-form-field>` search with reactive `FormControl`, grouped `mat-nav-list` sections (Public / Private), loading spinner + error card + empty-state + no-match state.
- **`create-room-dialog.component.*`** — ReactiveFormsModule (`name` 3–64 required, `description` 0–500 optional, `visibility` radio default public). `submitting` signal disables submit + locks form. On 409: sets a `nameTaken` control-level error AND a `nameServerError` signal so the `<mat-error>` block actually renders; cleared eagerly on `valueChanges`. On 400: snackbar with server message. Success refreshes the sidebar and navigates to `/chat/:id`.
- **`room-view.component.*`** — `paramMap.pipe(switchMap(roomsService.get))`. Header + dashed placeholder. Writes into `ChatContextService`; `clear()` on destroy. 403/404 → snackbar + navigate `/chat`. 401 left to the interceptor.
- **`room-rail.component.*`** — placeholder when no room; when loaded: name with visibility icon, visibility badge (`Public` → primary-container, `Private` → secondary-container), description, owner row, disabled `Invite user` / `Manage room` buttons with tooltips, member list with avatar initials + tertiary presence-dot placeholder + role labels.
- **`empty-state.component.*`** — centered icon + headline + description at `/chat`.
- **`app.routes.ts`** (modified) — `/chat` is the nested layout with children `''` → `EmptyStateComponent`, `:roomId` → `RoomViewComponent`. `authGuard` inherited from the parent shell route.
- **Shell** — untouched per task 9.

## Deviations

- **Right-rail data-sharing choice.** The plan allowed either `ActivatedRoute.firstChild?.paramMap` or a shared service. Went with `ChatContextService` (signal-based) because (1) the rail needs the full `RoomDetail` (members, owner, visibility) so reading only the id would force a second HTTP call on every navigation; (2) `RoomViewComponent` already fetches the detail via `paramMap → switchMap(roomsService.get)`, so writing it into a shared signal is zero-extra-cost; (3) Round 3 will need a single source of truth for the active room anyway (socket subscribe/unsubscribe depends on it), so this is the natural extension point.
- **409 handling sets a control-level error.** `<mat-error>` only renders when the MatFormField's error state is true, which requires the `FormControl` itself to carry an error. So the dialog sets both `nameServerError` (for the message text) and `control.setErrors({ nameTaken: true })`. Side effect: the submit button stays disabled until the user edits the name — which is the correct UX (you cannot resubmit the same taken name).
- **Empty-state and rail placeholder coexist.** The plan implied one or the other; kept both so the rail stays present as real estate even when no room is picked. The rail shows a lighter "Pick a room to see details" hint.
- **`description` trimmed and omitted when empty.** The contract allows `0–500` so `""` would be valid, but we send `undefined` instead. Matches `description?: string` in the request type.
- **Border-width redundancy on sidebar/rail/view.** Utility classes like `border-r-outline-variant` already include `0.0625rem` width, but host SCSS also sets `border-right-width: 0.0625rem; border-right-style: solid;` belt-and-suspenders. No hex, no px, no `--mat-sys-*`. Same pattern already in `shell.component.scss`.

## Deferred (intentional — per the plan)

- **Mobile drawer polish.** Below 37.5rem the sidebar is hidden entirely — no hamburger toggle, no `mat-drawer` overlay. Rooms remain reachable by URL; layout doesn't explode; discoverability on phones is limited. Revisit in Round 3/4 with `BreakpointObserver`.
- **Visual-only rail buttons.** `Invite user` and `Manage room` render `disabled` with tooltips pointing at Round 5b (invitations) and Round 5a (management).
- **Presence dots.** All avatars show a static tertiary-colored dot. Real presence is Round 3c.
- **Message list + composer.** The dashed placeholder in the room view is the slot Round 3 fills.
- **Join/leave buttons in the UI.** `rooms.service.ts#join()` and `leave()` are implemented, but no UI triggers them yet — join needs a public-room browser (Round 4/5), leave needs a confirm dialog.

## Next round needs to know (Round 3 — real-time / 2b)

1. **`ChatContextService.currentRoom()` is the right socket-lifecycle hook.** Recommendation: inject `SocketService` into `ChatContextService` and put an `effect()` in the context service constructor that emits `join-room` / `leave-room` as the signal changes. This keeps components free of socket lifecycle code and matches the "context service owns the active-room subscription" idea flagged in the plan.
2. **Message-list slot.** `room-view.component.html` has a single `.room-view__messages` flex-1 container with a dashed placeholder. Replace its contents with `<app-messages-list [roomId]="r.id" />` and add `<app-message-composer [roomId]="r.id" />` as a sibling footer (not inside the scroll area). The host `:host` + `.room-view` already use `display: flex; flex-direction: column` with `min-height: 0`, so a scrollable messages region + fixed composer works out of the box.
3. **Socket auth.** Build the socket client with `auth: { token: authService.getAccessToken() }`. The HTTP interceptor already handles 401 → refresh; pipe the rotated token into the socket by exposing it as a `BehaviorSubject`/signal on `AuthService` and reconnecting on change.
4. **Live room-list updates.** After `room-created` / `member-joined` events, call `roomsService.refresh()` or add a narrower `patchRoom(detail)` method. The signal-based sidebar updates automatically.
5. **Live member-list updates on the rail.** When `member-joined` / `member-left` fires, either re-`GET /api/rooms/:id` or mutate `ChatContextService.currentRoom()` locally. The latter is cheaper once the socket event payloads are finalized.
6. **Error-handling convention.** Follow the room-view pattern for future endpoints: 401 → interceptor, 403 → snackbar + navigate, 404 → snackbar + navigate.

## Config improvements

- **`docs/DESIGN_SYSTEM.md` shell-topbar example uses `border-bottom-width: 1px`** — a `px` unit in a SCSS recipe that agents copy. Change to `0.0625rem`.
- **Design-system skill should explicitly state** that `border-{side}-<role>` utilities already include the 0.0625rem hairline, so agents don't layer `border-width` on top.
- **`frontend/CLAUDE.md` could add** a one-liner naming `ChatContextService` as the canonical pattern for "state shared between a router-outlet component and a sibling panel".
- **Linting gotcha.** `@typescript-eslint/no-unused-vars` does not honor underscore-prefixed destructuring renames (`{ key: _drop, ...rest }`). Either use `delete obj['key']` or add an eslint override. Worth mentioning in `frontend-developer.md`.
- **Dev feedback loop.** Each frontend change required a full `docker compose up --build frontend` (~22s). A `pnpm -C frontend dev` script running `ng serve --proxy-config` against `localhost:3000` would cut the loop dramatically. Or a `docker-compose.dev.yml` that bind-mounts and uses `ng serve` in the container.
- **Harness rule blocked the subagent `Write` of this summary file** even though the task explicitly requires writing it. Orchestrator had to persist it instead. Consider relaxing the rule for `plans/round-*/summary-*.md` paths.

## Verification evidence (all PASS)

- Registered `r2tester@example.com` / `r2tester`, redirected to `/chat`, empty state + "No rooms yet" visible.
- Created public `r2-room-alpha` — dialog closed, sidebar updated under Public Rooms, route became `/chat/<uuid>`, room view + rail rendered.
- Retried creating `r2-room-alpha` — inline `Room name already taken` mat-error under the name field, submit stayed disabled until edit.
- Created private `r2-room-secret` — grouped under Private Rooms with lock icon, rail badge `Private` with secondary-container styling.
- Reloaded `/chat/<uuid>` — session restored via refresh-token cookie, room re-loaded without auth loss.
- Toggled `theme-dark` class — all surfaces swapped cleanly, no contrast regressions.
- Resized to 800px — right rail hidden, layout held. 500px — sidebar hidden, main view full-width, no horizontal scroll.
- DevTools console — only the expected two 409s from the duplicate-name test; zero other errors or warnings.
- Forbidden-token scan (`--mat-sys-`, hex literals, raw `px` in SCSS, inline `style="..."`) across `frontend/src/app/chat/**` — no matches.
- `pnpm lint` — all files pass. `pnpm exec ng build` — bundle generation complete.
