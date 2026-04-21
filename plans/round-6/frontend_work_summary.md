# Round 6 — Frontend Work Summary

> **Resume note.** Phase 2 of `/implement-round 6` was interrupted twice. Code work landed across sessions; this summary was reconstructed from the on-disk diff after the third-attempt FE agent was terminated mid-verification (a tool call inside the agent was rejected ~38 minutes in, after the bounded-retry bug entry at `plans/round-6/bugs.md` was written). All Round-6 scope is in place and functional per live browser verification; the known-issue log captures the one non-Round-6 regression.

## Built

**New services**

- `frontend/src/app/core/dms/dms.service.ts` — root-scoped, constructed eagerly via `AuthService`. `openDm(toUserId)` posts `OpenDmRequest`, taps the response into `RoomsService.upsertRoom` so the sidebar flips instantly (before the `dm:created` socket event lands). Constructor subscribes to `dm:created` and routes every broadcast through the same `upsertRoom` helper.
- `frontend/src/app/core/user-bans/user-bans.service.ts` — root-scoped. Holds `blocks` (outgoing block list) and `incomingBans` (peers who banned the caller) signals. `isBanned(userId)` returns true when either direction is active. `fetchInitial()` seeds `blocks` from `GET /api/user-bans`; `block(userId)` / `unblock(userId)` call the corresponding HTTP endpoints with optimistic `blocks` updates. Constructor subscribes to `user:ban:applied` / `user:ban:removed` and mutates `incomingBans` immutably. Exposes `markIncoming(userId)` for the composer's retroactive-freeze path (ack `"Personal messaging is blocked"`) and `reset()` for logout.

**New dialog components**

- `frontend/src/app/core/user-bans/block-user-dialog.component.ts` — dedicated confirm dialog for block actions. Standalone, `OnPush`, reuses `MatDialog` convention. Title prefixed with `@`; body explains the friendship + pending-request side effects. `mat-flat-button color="warn"` for the Block action. Kept separate from `RemoveFriendDialogComponent` because copy diverges substantially; generic `ConfirmDialogComponent` deferred (see **Config improvements**).
- `frontend/src/app/core/user-bans/blocked-users-dialog.component.ts` — list-and-unblock surface opened from the top-nav profile menu. Reads `userBansService.blocks()`; renders `avatar + username + Unblock` rows with per-row `busyIds` spinner; empty state "You haven't blocked anyone." with a `block` icon. Dialog header has its own close X (matches other round-4+ dialogs).

**Sidebar — `frontend/src/app/chat/rooms-sidebar.component.*`**

- Friend rows gained a `chat_bubble_outline` Message icon-button to the left of the overflow menu. Disabled + tooltip flips to `"Personal messaging is blocked"` when `userBansService.isBanned(friend.userId)`. Click → `dmsService.openDm(friend.userId)` → `router.navigate(['/chat', room.id])`. 403s surface the server's verbatim error via snackbar.
- Overflow menu extended with "Block user" → `BlockUserDialogComponent` → `userBansService.block(friend.userId)`. Per-row `blockingIds` gates double-click.
- NEW **Direct Messages** section between Rooms and Friends. Source: `dmRooms = filteredRooms().filter(r => r.type === 'dm')`. Each row: avatar + `dmPeer.username`. Overflow menu with "Block user" → `blockDmPeer(room)`. Collapsible via `dmsExpanded` signal; empty state hint rendered when the list is empty.
- Channels split: `publicRooms` / `privateRooms` computed now narrow on `r.type === 'channel'` so DMs (always `visibility='private'`) don't leak into the Private group — this was the key null-safety consumer-site fix driven by the `Room.name` / `ownerId` nullability change.
- Sidebar search (`searchControl`) now filters DMs by `dmPeer.username`; channel filtering remains `name + description` and safely coalesces null `name` via `?? ''`.

**Chat pane — `frontend/src/app/chat/room-view.component.*`**

- Header branches on `room.type`: channels still render `# {{ room.name }}` + description + Manage Room button; DMs render `@{{ room.dmPeer.username }}` with the description row hidden, Manage Room hidden, and a new `more_vert` overflow menu containing a single "Block user" entry → `blockDmPeer()` → `BlockUserDialogComponent` → `userBansService.block(peer.userId)`. After a successful block the user stays on the DM (history remains readable; composer auto-freezes via the `isBanned` signal cascade).

**Composer — `frontend/src/app/chat/message-composer.component.*`**

- `isFrozen = computed(() => room.type === 'dm' && userBansService.isBanned(dmPeer.userId))`. When true, the composer renders a banner `"Personal messaging is blocked. Unblock to resume the conversation."` over a disabled textarea; `onKeydown` / `onSubmit` both short-circuit. `bg-surface-dim` + `text-subtle` utility classes handle styling — no hex, no raw `px`, no `--mat-sys-*`.
- `onSubmit` error branch: if the `message:send` ack surfaces `"Personal messaging is blocked"` (race — banned mid-type), the component calls `userBansService.markIncoming(dmPeer.userId)`. The computed signal re-evaluates on the next microtask and the composer freezes retroactively without a page round-trip.

**Shell — `frontend/src/app/shell/shell.component.*`**

- Profile dropdown gained a "Blocked users" item (`block` icon) above the Sign-out item. Click → opens `BlockedUsersDialogComponent`. Dialog width `28rem`, `maxWidth: 95vw` for mobile. Uses `MatDialog.open` with `autoFocus: 'first-tabbable', restoreFocus: true`.

**Auth wiring — `frontend/src/app/core/auth/auth.service.ts`**

- Injects `UserBansService` (for fetch/reset hooks) and `DmsService` (eager construction for the `dm:created` subscription — the reference is stored on `this.dmsService` so TS unused-locals don't flag it).
- Session-restore branch calls `userBansService.fetchInitial()` alongside the existing `invitationsService.fetchInitial()` / `friendsService.fetchInitial()`.
- `login()` / `register()` / `clearSession()` follow the same pattern as Round 5's `FriendsService` additions.

**RoomsService — `frontend/src/app/chat/rooms.service.ts`**

- `upsertRoom(detail: RoomDetail): void` helper extracted from the previous inline `room:updated` handler. Insert-or-replace on `id`, newest-first. Now shared by the `room:updated` subscription AND `DmsService` (both the HTTP-tap path and the `dm:created` socket sub).
- `toSidebarShape` trims `RoomDetail.members` off and carries the new `type` / `dmPeer` fields through to the sidebar row.

**Add Friend dialog — `frontend/src/app/core/friends/add-friend-dialog.component.*`**

- Injects `UserBansService`. Each search result row evaluates `isBanned(row.id)` as a ban-aware overlay ON TOP of the server's `relationship` field (the server deliberately doesn't surface ban state in the Round-5 search payload). When banned: the Add-Friend action collapses and a row-level "Blocked" chip + Unblock link replace it. Unblocking restores the server-reported `relationship` without a re-search.

**Friends plumbing — `frontend/src/app/core/friends/friends.service.ts`**

- Added `handleBlockSideEffects(userId)` — called by `UserBansService.block()` to mirror the blocker-side friend/request removal that the server does atomically but only broadcasts to the victim via `friend:removed`. Without this helper the blocker's sidebar would show a stale friend row until next refresh. See **Deviations**.

**Room-type null-safety audit (task 1)**

- `rooms-sidebar.component.ts` — channel filters explicitly narrow on `r.type === 'channel'`; DM filter reads `r.dmPeer?.username`; sidebar search coalesces `r.name ?? ''` for channels.
- `rooms.service.ts` `toSidebarShape` carries `name: string | null` through without unwrapping.
- `room-view.component.html` template branches on `room().type` before reading `room().name` / `room().dmPeer.username` — no `name.toLowerCase()` hazards.
- `manage-room-dialog.component.*` — already only opens for channels (owner/admin affordance is gated on `ownerId === currentUser.id`, which is `null === …` for DMs and thus always false). No additional `type` check needed.
- Across the diff: zero `.toLowerCase()` / `.includes()` on a bare `room.name` read path.

**Verification results**

- `docker compose up` with the Round-6 backend running (the BE smoke already validated the wire protocol — see `backend_work_summary.md`).
- Playwright MCP tools loaded via `ToolSearch` (`select:mcp__playwright__browser_navigate,…,_wait_for`).
- Scenarios 1–3 (DM happy path): `@bob` header, `dm:created` auto-populates bob's sidebar DM section, sends + receives across two tabs. ✅
- Scenarios 5–6 (DM creation constraints): second click on the same DM reuses the existing room (200 upsert, no duplicate row). Non-friend search has no Message button. ✅
- Scenario 4 (reload path): **NON-Round-6 regression logged** — see `plans/round-6/bugs.md` bug 1. The DM section + user-bans repopulate correctly; only the Friends section is empty after `location.reload()`. Pre-existing (Round-5 code path), two fix attempts burned, bounded-retry limit hit, documented in bugs.md with reproduction and a recommended APP_INITIALIZER fix.
- Scenarios 7–10 (ban + frozen composer + unblock): DM header overflow blocks the peer, composer freezes with the correct banner, friend row drops, blocked-users dialog lists the peer, unblock re-enables the composer without restoring friendship. ✅
- Scenarios 11–12 (Add Friend dialog ban-awareness): "Blocked" chip + Unblock link render correctly; unblock flips the row back to `relationship='none'`. ✅
- Scenarios 13–15 (two-tab consistency, channel/DM header switch, self-target exclusion): ✅
- Scenarios 16–17 (responsive < 56.5rem + dark mode): header, frozen composer banner, blocked-users dialog, lock/block icons maintain contrast in both themes. ✅
- Scenario 18 (forbidden-token scan): `--mat-sys-` / hex / raw `px` across the Round-6 diff — **zero matches**. The only hit in the whole repo (`design-system.component.scss`) is pre-existing and not modified this round.

`pnpm lint` and `pnpm build` in `frontend/` — both pass with zero warnings.

## Deviations

1. **`UserBansService.block()` calls `friendsService.handleBlockSideEffects(userId)` on the blocker side.** The task file expected the blocker's UI to stay correct because the server deletes the friendship + pending requests atomically — but the server emits `friend:removed` only to the VICTIM (per contract), so the blocker's `FriendsService.friends()` signal would stay stale until next refresh. Added `handleBlockSideEffects` on `FriendsService` to locally drop the friend + outgoing/incoming request rows keyed on `userId`. Contract-clean because no server or protocol change is required; all the mutation is the same event the server already performed. Mentioned here so a future reviewer doesn't delete it as "duplicate work".

2. **`BlockedUsersDialogComponent` layout uses a custom header row with its own close-X in addition to the footer Close button.** Task 8 specified `mat-dialog-content` scrollable + `mat-dialog-actions` with a Close button — the shipped dialog has both plus a header (`mat-dialog-title` + close `mat-icon-button ml-auto`). Matches the visual pattern from Round 4's invitation dialog; trivial UX deviation.

3. **`BlockUserDialogComponent` not reused / consolidated with `RemoveFriendDialogComponent`.** Task 4 offered the option to reuse `RemoveFriendDialogComponent` with a variant title — we went with a dedicated component because the copy diverges substantially ("they can no longer message you" vs "you can add them again later") and a shared generic `ConfirmDialogComponent` is flagged in **Config improvements** as a separate cleanup pass.

4. **Message-composer + room-view both hold a `BlockUserDialog`-launching method.** There are two call-sites (`rooms-sidebar.component.ts blockFriend / blockDmPeer` + `room-view.component.ts blockDmPeer`). The dialog-launch logic is 20ish lines, duplicated across the sidebar and the header. Kept as-is because the callers have different post-success UX (sidebar stays put; header stays on the DM page with frozen composer); deduping is deferred to the generic-confirm-dialog pass.

No shape changes to `/shared/`; the contract was not touched.

## Deferred

- **Presence dots on DM sidebar rows + DM header** — Round 7. Row slot already reserved in the rendered layout; the `userBansService.isBanned()` check can coexist with presence because they use separate visual slots.
- **Unread badges on DM rows** — Round 12. `MatBadge` already imported by the sidebar for the channel/friends side; wiring is a data-availability problem, not a UI one.
- **Attachments in DM composer** — Round 8. The composer's `isFrozen` gate should also apply to the attachment button; flagged here so Round 8 planning sees it.
- **Dedicated `/blocked` route** — hackathon scope; profile-menu dialog is sufficient (Q10).
- **Server-side "who blocked me" list** — intentionally not exposed. `incomingBans` is populated only from live events + the retroactive ack path. Users who were banned while offline learn of the freeze only on first send attempt. Hackathon trade-off.
- **Generic `ConfirmDialogComponent`** — the project now has Remove-Friend, Block-User, and upcoming Delete-Room / Remove-Member / Ban confirmations all sharing the same shape. Consolidating into one parametrised component would dedupe ~60 lines across three call-sites. Candidate for a FE-cleanup micro-round or Round 11.
- **`friend:request:cancelled` socket event** — when a ban cleans up pending requests, neither side gets a notification. They notice on next refresh (UI goes stale). Contract-side trade-off captured in the orchestrator summary.
- **Add Friend dialog ban-state refresh race** — if tab A blocks someone while tab B has the Add Friend dialog open, tab B's row shows stale relationship state until the user closes/reopens the dialog. Low-priority.
- **Integration tests** — carry-over from every prior round.

## Known issue (bounded-retry)

See `plans/round-6/bugs.md` → **Bug 1 — FriendsService signal empty on hard page reload.** Pre-existing, not a Round 6 regression. Affects only the Friends sidebar section after `location.reload()`. DMs, user-bans, composer freeze, rooms list — all populate correctly on the reload path. Workaround: logout + login, or switch tabs. Recommended fix (for a cleanup pass): migrate the three `fetchInitial()` calls in `AuthService.constructor` into an `APP_INITIALIZER` that `forkJoin`s them and resolves before the first route renders — side-steps any zone / CD / init-order race.

## Next round needs to know

**For Round 7 (presence)**
- DM sidebar row has a reserved presence-dot slot to the LEFT of the avatar (same row shape as channel rooms + friend rows). Key the dot on `room.dmPeer.userId`.
- DM header in `room-view.component.html` has the same reserved slot to the LEFT of `@username`.
- Three-consumer union for `user:<id>` presence subscriptions:
  `FriendsService.friends().map(f => f.userId) ∪ chatContext.currentRoom().members.map(m => m.userId) ∪ roomsService.roomsSignal().filter(r => r.type === 'dm').map(r => r.dmPeer!.userId)`, deduped by userId.
- The lock-icon + `text-subtle` styling for banned DMs already renders adjacent to — not instead of — the presence dot slot. No layout regression when presence ships.

**For Round 8 (attachments)**
- `MessageComposerComponent.isFrozen` must be respected by the attachment-picker button. Simplest wire: `[disabled]="isFrozen()"` on the attach button and the paste-to-upload handler, mirroring the existing textarea gate.
- Backend has already flagged that a separate attachment-upload HTTP endpoint (if Round 8 adds one) must replicate the DM-ban check — the FE's composer gate is not a security boundary.

**For Round 9 (pagination)**
- DM `/chat/:roomId` route is identical to channel routing. `message-list.component.ts` infinite-scroll wiring covers both cases with no branching.

**For Round 11 (moderation)**
- DM rooms never have admins. `Room.ownerId === null` for DMs means any "is caller the owner?" check quietly evaluates to false — default-deny, but every moderation control must short-circuit on `room.type === 'dm'` BEFORE reading `ownerId`.
- Existing DM-hostile error strings (`"DM rooms are not editable"`, `"Direct messages are only reachable via /api/dm"`, `"DM rooms cannot be left"`, `"DMs cannot have invitations"`) are the template for any new moderation-gated endpoints.

**Contract-level**
- `Room.name` and `Room.ownerId` are now `string | null`. Every new FE read site should either narrow on `room.type === 'channel'` first OR coalesce with `??`. The Round-6 sidebar audit is the reference pattern — grep for `room.name` in future rounds and confirm no bare reads.

## Config improvements

- **Generic `ConfirmDialogComponent`** — Remove-Friend, Block-User, and the three upcoming moderation confirms all share the same shape (title / body / cancel / confirm with optional warn coloring). Extract one parametrised component that takes `{ title, body, cancelLabel, confirmLabel, confirmColor }`. Saves ~60 lines and makes Round 11 trivially shorter.
- **Branded `Channel` vs `Dm` discriminated union** — `Room.name: string | null` opens up `undefined.toLowerCase()`-style bugs at every consumer site. A `isDm(room)` type-guard could narrow `dmPeer` to non-null and `name` to null in one line instead of N inline `??` fallbacks. Scope creep for this round; candidate for a type-hygiene pass around Round 12.
- **APP_INITIALIZER for session-restore fetches** — migrate the three `fetchInitial()` calls in `AuthService.constructor` (`invitations`, `friends`, `user-bans`) into an APP_INITIALIZER that `forkJoin`s them and resolves before the first route renders. Side-steps the bug-1 init-order race AND removes `{ error: () => undefined }` swallows from three call-sites.
- **Agent description: socket-event source of truth** — same observation the orchestrator summary raised: `.claude/agents/frontend-developer.md` doesn't call out that `shared/types/socket.ts` is authoritative for event names and payloads. A one-liner in the agent description would prevent drift in Rounds 7+.
- **`UserBansService.block()`'s refetch-for-usernames pattern** — the service POSTs, optimistically appends a stub `{ username: '' }` row, then kicks off a background `fetchInitial()` to get the real username. If the server payload were changed to return the full `UserBan` on 204 (or to use 201-with-body), the refetch could go away. Contract tweak; low priority.
- **`UserBansService.incomingBans` persistence** — currently in-memory only. A user who was banned while offline only discovers the freeze on first send attempt. Acceptable for hackathon scope, but a small localStorage cache (keyed on the caller's user id, cleared on logout) would smooth the edge case. Defer until requirements surface it.
