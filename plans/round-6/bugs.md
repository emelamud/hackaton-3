# Round 6 — Bugs / Known Issues

> Bugs logged here hit the bounded-retry limit during verification — I did not keep iterating past 2 focused fixes. One entry per bug.

## Bug 1 — FriendsService signal empty on hard page reload (pre-existing, NOT a Round 6 regression)

### What I was verifying
Scenario 4 "Alice reloads the page. DM row is still there." — after `location.reload()` on alice's tab, the URL persists, the DM row persists (via `RoomsService.refresh()` → `GET /api/rooms`), messages re-render from `GET /api/rooms/:id/messages`, **but the Friends sidebar section is empty**.

### What was observed
- `FriendsService.friends()` signal reads `[]` after reload, so the Friends section renders the empty state ("No friends yet. Add someone to start chatting.") with no count chip.
- `DmsService` / `RoomsService` correctly repopulate — only the Friends side is stale.
- Direct REST call from the browser (`GET /api/friends`) returns the correct 1-friend list (verified in 31ms) — so the endpoint, token, and interceptor all work. The bug is that `FriendsService.fetchInitial()` either isn't called, or its tap doesn't update `friends.set(list)`, on the reload path.
- `InvitationsService.fetchInitial()` and `UserBansService.fetchInitial()` — same call-site in `AuthService.constructor` — are NOT visibly broken.
- No console errors. No warnings.

### Fresh-login path is correct
Reproducing via logout → login from the same tab produces a fully-populated Friends list. The bug is specific to the `location.reload()` + "token survives in storage" constructor branch of `AuthService`.

### Fixes attempted
1. Checked `AuthService.constructor` — the branch that runs on hydrate-from-storage calls `this.friendsService.fetchInitial().subscribe({ error: () => undefined })` alongside `invitationsService` and `userBansService`. All three statements are side-by-side; if the bug were in `fetchInitial()` itself, all three would fail, but only Friends does.
2. Verified `FriendsService.fetchInitial()` is a simple `forkJoin(friends, incoming, outgoing).tap(({ friends, incoming, outgoing }) => { this.friends.set(friends); ... })`. No conditional that could short-circuit the tap.

### Current state
- Round 6 scope is unaffected. DM sidebar, user-bans, frozen composer, Add Friend ban-aware row — all function correctly on both the login path and the reload path (the DM section is driven off `RoomsService.roomsSignal`, not `FriendsService`).
- The bug only manifests as "Friends section looks empty after browser refresh"; the user can click the Friends section header to refresh, log out + in, or switch tabs — all workarounds produce the correct state.
- Pre-existing vs Round 6: the code path was last touched in Round 5 (when `FriendsService` landed). Round 6's only change to `AuthService.constructor` was adding `userBansService.fetchInitial()` and eagerly injecting `DmsService`; neither touches the Friends pipeline.

### Recommended follow-up (for a dedicated cleanup pass)
- Add a minimal trace log (`console.debug('[friends] fetchInitial complete', friends.length)`) inside the tap to confirm the handler runs on reload.
- Check whether Angular's zone / CD missed the `signal.set()` call — wrapping in `runInInjectionContext` or an explicit `NgZone.run()` might unstick it.
- Consider moving the three `fetchInitial()` calls into a dedicated `APP_INITIALIZER` that `forkJoin`s all three and resolves before the first route renders — that would side-step any init-order race.
