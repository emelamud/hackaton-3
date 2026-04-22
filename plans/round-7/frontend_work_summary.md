# Round 7 — Frontend Work Summary

## Built

**New services**

- `frontend/src/app/core/presence/presence.service.ts` — root-scoped. Holds a `signal<ReadonlyMap<string, PresenceState>>` keyed by userId. Eagerly constructed by `AuthService` so its two socket subscriptions (`presence:snapshot` + `presence:update`) attach before the socket's first snapshot lands. Snapshot handler **merges** into the existing map (never replaces) so a new tab / reconnect doesn't wipe live entries. `stateFor(userId)` returns a per-userId `computed` that falls back to `'offline'` for unknown ids; consumers get a lightweight reactive handle per render site. `reset()` clears the map on logout, same pattern as `FriendsService.reset()` / `UserBansService.reset()`.
- `frontend/src/app/core/presence/presence-activity.service.ts` — root-scoped. Owns the tab's own-user activity tracker. `selfState = signal<'online' | 'afk'>('online')` (never `'offline'` — offline is a server-aggregated "no sockets connected" state which, by construction, is never the state of the tab rendering the dot). `start()` attaches `mousedown / mousemove / wheel / scroll / keydown / pointerdown / touchstart` on `document` plus `visibilitychange`, all captured inside `NgZone.runOutsideAngular` so mousemoves don't trigger change detection. `reportActivity` transitions to `online` and (re)starts the 60 s AFK timer; `visibilitychange → hidden` transitions to `afk` immediately, `→ visible` falls back through `reportActivity`. The zone is re-entered only on transitions (≤ 2/minute in practice), which is also when `socketService.emit('presence:active' | 'presence:idle')` fires — never per event. `stop()` is idempotent: clears the timer, removes all listeners, resets `selfState` to `'online'` for the next session.

**SocketService — `frontend/src/app/core/socket/socket.service.ts`**

- New generic `emit<E extends keyof ClientToServerEvents>(event: E): void` overload that resolves `socket.emit('presence:active')` / `socket.emit('presence:idle')` via the shared `ClientToServerEvents` contract. Event-name typos are now compile errors. `message:send` is deliberately NOT in `ClientToServerEvents` (per shared contract comment) so its `emitWithAck` ad-hoc signature is untouched. If the socket isn't connected when a presence transition fires, the emit is a silent no-op — the server recomputes per-socket state on connect and snapshots back.

**Shared component — `frontend/src/app/shared/presence-dot.component.ts` (+ `.scss`)**

- Standalone, `OnPush`, `MatTooltipModule` import. `[userId]` is a `input.required<string>()`. Internal `state` computed branches to `activity.selfState()` when `userId === auth.currentUser().id`, otherwise `presence.stateFor(userId)()`. Renders a 0.625 rem circle with a 1 px ring (`border: 0.0625rem solid map.get(tokens.$ds-colors, surface-container-high)`) for contrast against avatar backgrounds; colour comes from the design-system palette map (`bg-tertiary` online / `bg-outline` afk / `bg-surface-dim` offline, per `DESIGN_SYSTEM.md` §2). Tooltip copy is verbatim "Online" / "Away from keyboard" / "Offline"; `aria-label="Presence: <tooltip>"`.

**Render-site integrations (four call sites)**

- **Friend rows** — `rooms-sidebar.component.html`. Reserved `<span class="friend-item__presence">` slot replaced with `<app-presence-dot [userId]="friend.userId" />` to the LEFT of the avatar.
- **DM sidebar rows** — same file. Reserved `<span class="dm-item__presence">` slot replaced with `<app-presence-dot [userId]="peer.userId" />` inside an `@if (room.dmPeer; as peer)` guard. Still LEFT of the avatar; the existing ban-lock icon continues to render LEFT of the overflow menu, so the two icons occupy distinct slots and do not collide.
- **DM header** — `room-view.component.html`. Reserved `<span class="room-view__presence">` replaced with `<app-presence-dot [userId]="peer.userId" />` to the LEFT of the `alternate_email` icon and the `@username` heading.
- **Room member rail** — `room-rail.component.html`. Restructured the member row: the old decorative `<span class="presence-dot bg-tertiary">` that was glued to the avatar's bottom-right has been removed, and a live `<app-presence-dot [userId]="member.userId" />` now sits LEFT of the username (flex-wrapped in `.member-row__title` with `gap-2`). Self-row hits the same code path — the presence dot's internal self branch swaps in `selfState`.

**SCSS cleanup**

- Removed the `width/height` hard-pins on `.friend-item__presence` / `.dm-item__presence` / `.room-view__presence` (they were placeholder sizing for reserved slots); sizing now flows from the component's own SCSS (`:host { display: inline-flex; ... }`). Layout rules reduced to `flex-shrink: 0; align-self: center` — pins flex behavior without constraining the dot.
- Removed the `.presence-dot` rule from `room-rail.component.scss` (the old absolutely-positioned decorative dot). The `member-row__avatar` lost `position: relative` — no longer needed.

**AuthService lifecycle wiring — `frontend/src/app/core/auth/auth.service.ts`**

- Injects both `PresenceService` (eager construction for socket subscriptions — retained on `this.presenceService` so TS unused-locals / tree-shaking don't drop it) and `PresenceActivityService`. Follows the exact pattern already used for `DmsService` / `UserBansService`.
- `presenceActivityService.start()` called from:
  - constructor (session-restore path — only when `this.accessToken` is truthy)
  - `login()` `tap`
  - `register()` `tap`
  - `refresh()` `tap` (idempotent — no-op if already started)
- `presenceActivityService.stop()` + `presenceService.reset()` called from `clearSession()` (logout / failed refresh).

**Design-system compliance**

- Spot-check of the Round-7 diff against new `var(--mat-sys-*)`, hex colours, `rgb()`, named colours, `px` literals, and inline `style="..."`: **zero matches** in modified FE sources, zero matches in the new `core/presence/` + `shared/` files.
- `presence-dot.component.scss` uses `map.get(tokens.$ds-colors, surface-container-high)` for the contrast ring — the sanctioned escape hatch per `DESIGN_SYSTEM.md` §1 (SCSS token-map lookup for dynamic-contrast use cases).

**Verification gate**

- `pnpm lint` in `frontend/` — clean, `All files pass linting.`
- `pnpm build` in `frontend/` — clean, application bundle generated in 12.8 s, no warnings.
- `pnpm exec tsc --noEmit -p tsconfig.app.json` — clean, `socket.emit('presence:active')` resolves through `ClientToServerEvents`; `presence:snapshot` / `presence:update` handlers resolve their payloads through `ServerToClientEvents` (shared types).

## How to exercise this

Route: `/chat` (authenticated). Two signed-in sessions needed for every presence scenario — one in the primary browser, one in a private/incognito window. `alice` and `bob` below must already be **friends** (use the Add Friend flow from the sidebar if not). The tester drives from this list verbatim.

1. **Friend-row presence dot — online state**
   - Alice signed in, sidebar expanded, Friends section visible.
   - Bob signs in from a private window.
   - Within ≤ 2 s alice's Friends row for bob renders a green `●` dot LEFT of bob's avatar. Hover the dot — tooltip reads `Online`.

2. **Friend-row presence dot — AFK transition**
   - Bob alt-tabs away from his window (or just stops moving the mouse / typing) for 60 s.
   - Within ≤ 2 s after the 60 s elapse, alice's row for bob flips the dot to the amber/grey `◐` (`bg-outline`) — the afk state. Tooltip reads `Away from keyboard`.
   - Bob returns focus and moves the mouse. Alice's dot flips back to green `●` within ≤ 2 s.

3. **Friend-row presence dot — tab hidden shortcut**
   - Bob minimises his browser (or switches to a different OS app so the tab is `document.hidden`).
   - Alice sees the dot flip to afk **immediately** (no 60 s wait) — `visibilitychange → hidden` path.
   - Bob brings the tab back to visible. Alice sees the dot flip to online within ≤ 2 s.

4. **Friend-row presence dot — offline state**
   - Bob closes his browser window entirely (not just the tab — confirm no bob session survives).
   - Within ≤ 2 s alice's row for bob flips to `○` (`bg-surface-dim`). Tooltip `Offline`.

5. **DM sidebar row — mirrors friend-row state**
   - From alice's sidebar Friends section, click the `chat_bubble_outline` icon on bob's row to open / create the DM. A row appears in the Direct Messages section with bob's name.
   - The DM row renders a presence dot LEFT of bob's avatar, matching the friend-row state in real time (test: flip bob online → afk → offline and confirm the DM row dot and the friend row dot move in lockstep).
   - Ban-lock coexistence (optional): block bob via the DM row overflow. The lock icon appears LEFT of the overflow menu; the presence dot remains LEFT of the avatar. Unblock restores the normal row.

6. **DM header presence dot**
   - Alice clicks the DM row to navigate to `/chat/<dmRoomId>`. The header renders `<presence dot> [@] bob` — dot LEFT of the `@`-icon and `bob` heading.
   - Dot state tracks bob's aggregate state in real time (same test matrix as step 2–4; move bob online / afk / offline and watch the header dot).
   - Self-dot note: the DM header does NOT render a self dot (the header names the peer). That's intentional.

7. **Room member rail — other members**
   - Both alice and bob are members of a shared channel (e.g. `#general` from prior rounds). Alice opens that channel.
   - The right rail shows Members. Each row has a dot LEFT of the username (ahead of the role chip).
   - Bob's row tracks his state live (online / afk / offline as above).

8. **Room member rail — self dot**
   - Same channel, alice's own row in the Members list.
   - The dot starts at `●` (green, `Online`).
   - Alice stops interacting with her own tab for 60 s — her own dot flips to `◐` (afk, `Away from keyboard`).
   - Alice moves the mouse — dot flips back to `●` instantly (the activity event fires synchronously and the transition emits `presence:active`, which re-renders the self-dot on the next tick).
   - Self dot never goes to `○`. That's by design (the tab rendering the dot is, by definition, connected).

9. **Multi-tab aggregate — any active tab keeps user online**
   - Bob opens a second tab, same account, also signed in.
   - Bob alt-tabs away from tab 1 (or otherwise stops interacting with tab 1). Tab 2 remains active with bob moving the mouse periodically.
   - Alice's view of bob (friend row / DM row / DM header / member rail) stays `●` online — because the server aggregates state across bob's two sockets.
   - Bob now stops interacting with tab 2 as well (or minimises the whole browser). After 60 s across both tabs, bob's aggregate flips to afk and alice's dots all transition to `◐` within ≤ 2 s.

10. **Full disconnect → offline**
    - Bob closes all tabs. Alice's dots for bob all flip to `○` offline within ≤ 2 s.
    - Bob signs back in from one tab. Alice's dots return to `●` online.

11. **Snapshot-on-connect merge semantics**
    - With alice and bob both online, open a third tab for alice (same account).
    - The third tab's presence map is seeded by a `presence:snapshot` fired to just that socket on connect. Verify in alice's third tab: her Friends row for bob, any open DM header, and any member rail she loads render bob as `●` online — i.e. the third tab picked up bob's state without waiting for a live `presence:update`.

12. **Logout + re-login lifecycle**
    - Alice signs out via the profile menu. Confirm no console errors (the activity-tracker listeners detach + `selfState` resets). The socket closes; the presence map clears.
    - Alice signs back in. Confirm:
      - Presence snapshot arrives and re-hydrates the map (her friend row for bob renders the correct state immediately, not after a live update).
      - The activity tracker restarts (sit idle 60 s → bob's view of alice flips to `◐`; move mouse → back to `●`).

## Deviations

1. **Palette tokens — ship with `bg-outline` for afk, `bg-surface-dim` for offline, not `bg-secondary` / `bg-surface-variant`.** The task-file snippet sketched `tertiary / secondary / surface-variant`. The design-system palette (`DESIGN_SYSTEM.md` §2 "Chat-app palette mapping") is explicit: online → `bg-tertiary`, away → `bg-outline`, offline → `bg-surface-dim`. Followed the design-system truth, not the sketch. No token invention — all three classes already exist in `_utilities-color.scss`.
2. **Template uses utility classes (`bg-tertiary` / `bg-outline` / `bg-surface-dim`) for the dot fill, not `$ds-colors` map reads in `.scss`.** The task sketch referenced `map.get($ds-colors, …)` inside `&.is-online { background-color: … }` selectors. Utility classes in the template are the cheaper / canonical path per `DESIGN_SYSTEM.md` §1 (token-map reads are the escape hatch for pseudo-class / dynamic-contrast states — not for plain background-color variants). Only the contrast ring uses the token map.
3. **Member-rail restructure.** The pre-existing member rail had a decorative `<span class="presence-dot bg-tertiary">` positioned absolutely at the avatar's bottom-right — always green, never live. Per the task ("LEFT of each member username"), the dot moved out of the avatar slot into `matListItemTitle` as part of a flex container with `gap-2`. The absolutely-positioned SCSS block is deleted along with its `position: relative` anchor on `member-row__avatar`. Visual change: the avatar no longer carries a green corner notch; instead the row reads `<dot> username <role chip>`. Matches the DM header and sidebar-row conventions.
4. **`PresenceDotComponent` imports `AuthService` for self-identity.** The task-file sketch uses `auth.currentUser()?.id`. Considered threading the self-id in as an `@Input` to avoid the `AuthService` coupling but kept the direct inject — the dot is already a cross-cutting leaf component that lives in `app/shared`, and `AuthService` is already root-scoped.
5. **`reportActivity` runs a `setTimeout` from inside `NgZone.runOutsideAngular`, but `transitionTo` re-enters the zone only on state changes.** The service deliberately does NOT debounce `reportActivity` itself — each qualifying DOM event fires a fresh 60 s timer (old one cleared). Cheap because the zone re-entry path is gated on the no-op check `if (this.selfState() === state) return;`. Flagged in **Config improvements** as a micro-optimisation opportunity.

## Deferred

- **Grace-period flash smoothing on reconnect.** Server-side concern (buffer the "offline" broadcast for ~500 ms during a known socket drop). Not a FE fix.
- **Tooltip i18n.** Strings hardcoded to English. Consistent with the rest of the app.
- **Own-dot polish — match the exact "rounded avatar corner" treatment.** The dot styling is homogeneous across all four sites (sidebar / header / rail). The avatar no longer has an overlay-style dot.
- **`ConfirmDialogComponent` consolidation** — still deferred from Round 6. Not a Round-7 dependency.
- **APP_INITIALIZER migration for session-restore fetches** — still deferred from Round 6 bug 1. Presence snapshot lands via the socket, not an HTTP fetchInitial, so the existing race doesn't affect Round 7.
- **Integration / e2e tests** — carry-over from every prior round.
- **Configurable AFK threshold** — 60 s is a hard-coded class constant. If the product ever wants a per-user or per-workspace idle value, it becomes a `PRESENCE_CONFIG` injection token. Not warranted today.

## Next round needs to know

- **For Round 8 (attachments)** — the DM composer's `isFrozen` gate from Round 6 is untouched. Presence has no coupling to the composer's ban freeze. The attachment button wiring is still `[disabled]="isFrozen()"`.
- **For Round 9 (pagination)** — no coupling. `message-list` doesn't read presence.
- **For Round 11 (moderation)** — when a user is removed from a room, the member rail re-renders from `chatContext.currentRoom().members`, which the server already updates via `room:updated`. The stale user's `<app-presence-dot>` disappears with the row. No presence-specific cleanup required. Ditto for channel leaves.
- **For Round 12 (unread)** — no coupling. Presence and unread render in different parts of the row (presence left of avatar, unread badge right of row).
- **Self-presence invariants**
  - `PresenceActivityService.selfState` is the ONLY source of truth for the own user's dot. The server intentionally omits self from fan-out.
  - Never depend on `PresenceService.stateFor(selfId)` returning something useful — it returns `'offline'` always (the server never populates self in the snapshot / update stream).
  - The `PresenceDotComponent` handles the branching internally; consumers just pass `[userId]`. Don't special-case self at call sites.
- **AFK threshold** — locked at 60 s (60_000 ms) per contract §Presence rules (requirement §2.2.2). A matching constant on the backend enforces nothing — the server trusts client transitions. If you change the FE constant, you silently shift product semantics; gate any such change through `shared/api-contract.md`.
- **Socket `emit<E>` typing** — `ClientToServerEvents` is now the compile-time contract for payloadless client emits. Add new events to `shared/types/socket.ts` via the orchestrator; do NOT widen the FE `emit` signature ad-hoc.

## Config improvements

- **Debounce `reportActivity` to skip timer churn under heavy mousemove.** Current implementation clears + re-sets the 60 s `setTimeout` on every qualifying event — correct for the 60 s "since last event" semantics but cheap to tighten: throttle to once per (say) 250 ms. Measurable only under pathological mouse traffic; cosmetic today.
- **`PresenceService.stateFor(userId)` caches a computed per call.** Each `<app-presence-dot>` instance creates its own. For a large member rail (dozens of rows) this is still cheap — `computed` is light — but a `WeakMap<userId, Signal<PresenceState>>` cache inside the service would deduplicate across re-renders. Candidate for Round 13 polish.
- **Selector-based activity detection vs. document-wide.** Current listeners are attached at `document` with `capture: true`. If the app ever embeds a third-party iframe whose mousemoves should NOT count as presence (e.g. a floating chat widget), we'd need scoping. Not actionable today.
- **Move `app/shared/` into a proper barrel file.** `app/shared/` was a fresh folder this round (first standalone utility component). Later rounds may add more shared components; a `app/shared/index.ts` re-export keeps imports tidy once the list grows past 2.
- **Selective re-export of `ClientToServerEvents` from a FE-local aggregator** so consumers don't have to remember which types live in `@shared`. Minor; path is fine today.
- **`selfState` as a tri-state (`online | afk | offline`)** with `offline` only on explicit logout — current "never offline" design is pragmatic but doesn't model "socket-disconnected-while-tab-still-open" (e.g. server restart mid-session, user sees a stale online dot). Backend already trusts the FE transitions; flipping self to offline would require a wiring hook on `socket.disconnect`. Deferred, low priority.
