# Round 4 — Bugs Found During Verification

Three distinct bugs in Round 4 frontend, with different severities and root causes. All backend checks from `backend_work_summary.md` passed — these are frontend-only.

## 🔴 Bug 1 — Live invitation socket events never reach the badge (critical)

**Symptom:** Alice invites bob while bob's tab is open — badge stays at `0`. Only a fresh login (which triggers HTTP `fetchInitial`) shows the invitation.

**Proof:** An independently-connected debug socket (also authenticated as bob, via socket.io-client CDN) *did* receive `invitation:new` from the backend, but bob's in-app badge didn't update. So the backend fan-out is correct and the bug is strictly on the frontend socket path.

**Root cause:** `SocketService.on<T>()` returns a cold Observable whose subscribe function early-returns if `this.socket` is null:

```ts
on<T>(event) { return new Observable(obs => {
  if (!this.socket) return () => {};   // ← silently no-ops forever
  const handler = p => obs.next(p); this.socket.on(event, handler);
  return () => this.socket?.off(event, handler);
}); }
```

`InvitationsService` (root-scoped) subscribes in its **constructor**. DI order: `AuthService` injects `InvitationsService` + `SocketService` → both are constructed first → `InvitationsService` subscribes while `socket = null` → a no-op teardown is registered → no handler ever attached. Then `AuthService` constructor body calls `socketService.connect()`, but the subscription is already dead.

**Fix options (simplest first):**
- (a) Make `SocketService` buffer subscribers and re-attach `socket.on(...)` on every `connect()`. A small `Set<{event, handler}>` plus a hook at the end of `connect()` does it.
- (b) Have `InvitationsService` subscribe via an `effect()` that waits for an `isConnected` signal on `SocketService`.
- (c) Defer `InvitationsService` socket subscription to a `setTimeout(0)` / `queueMicrotask` inside the constructor so `AuthService.connect()` runs first. Fragile.

Recommended: (a). It's a single-digit-line change and makes all future root-scoped subscribers safe.

## 🟡 Bug 2 — Room-view header doesn't refresh on `room:updated`

**Symptom:** Alice renames a room bob is viewing → bob's **sidebar** updates live (new name visible), but the **room header / title** still shows the old name.

**Why sidebar works but header doesn't:**
- `RoomsService.on('room:updated')` subscribes in its constructor, **but** `RoomsService` is first injected by route components (sidebar, room-view) — by then the socket is connected. Subscription attaches properly. Sidebar works.
- `ChatContextService.on('room:updated')` has the same timing — also works, `currentRoom()` signal updates correctly.
- Problem: `RoomViewComponent` keeps its **own local `room` signal** set once at route load (`this.room.set(detail)`), and its template reads `room()`, not `chatContext.currentRoom()`. So when the context signal updates, the header doesn't.

**Fix:** make the `RoomViewComponent` template read from `chatContext.currentRoom()` directly (drop the local `room` signal or sync it from the context).

## 🟢 Bug 3 — `matBadgeHidden` isn't hiding the `0` badge

**Symptom:** With no pending invitations, a small "0" bubble is visible next to the mail icon instead of being hidden.

**Evidence:** Template correctly binds `[matBadge]="pendingCount()"` + `[matBadgeHidden]="pendingCount() === 0"`. In the DOM, the `mat-badge-content` element has only the `mat-badge-active` class — no `mat-badge-hidden` class — so Material's hide logic isn't firing. Possibly a Material M3 quirk around falsy vs zero, or the directive re-rendering at the wrong time.

**Fix:** one of:
- Bind `matBadge` to a value that is `null` when `pendingCount() === 0` (Material hides the badge entirely when the value is nullish).
- Gate the whole badge element behind `@if (pendingCount() > 0)`.
- Add a conditional class on the host that sets `display: none` when zero (belt-and-suspenders).

---

## Extras noticed during verification (not full bugs, but deviations from plan)

- **Settings tab is selected by default** in the Manage Room dialog instead of Invitations (plan ordered Invitations first). Minor UX.
- **No "Invited @bob" success banner** after a successful invite. Plan (task 5, Invitations tab) specified a transient success line; dialog clears the input but gives no feedback.
- **Invite user button on the right rail** is enabled rather than the Round 2 visual-only placeholder. Not a bug; plan task 8 made this optional. Worth confirming its click behaviour in a follow-up.

---

## What was confirmed working

- Manage Room dialog structure: two tabs (Invitations + Settings), close button, form prefill (name / description / visibility radio), Save-disabled-until-dirty, character counters.
- `POST /api/rooms/:id/invitations` → 201, returns fully denormalised `Invitation` with `roomName` and `invitedByUsername`.
- `PATCH /api/rooms/:id` → 200 with updated `RoomDetail`; backend broadcasts `room:updated` to `room:<id>` (debug socket received it).
- `fetchInitial()` after a successful `login()` populates the `pending` signal — badge and dropdown show the real count after fresh login.
- Backend fan-out to `user:<id>` and `room:<id>` works (verified via independently-connected debug socket).
- `RoomsService` room:updated subscription — sidebar renames live.

## Verification method

Two logged-in Playwright browser tabs (`alice@test.dev` in tab 0, `bob@test.dev` in tab 1), with an extra debug socket.io-client connection injected into tab 1 to observe raw backend broadcasts. Network requests captured via `browser_network_requests`. API probes (e.g. direct `fetch('/api/invitations')`) used to confirm backend state independent of the app's UI.
