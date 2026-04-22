# Round 7 — Bugs

No bugs found.

## Scenarios verified

Tester run: 2026-04-22, Playwright MCP against http://localhost:4300.

Test users: `alice_qa@example.com` / `bob_qa@example.com` (`Password123!`), already friends, shared `general-qa` public channel, open DM (id `9dc69684-7c4a-4640-af4d-0ab95412253c`).

Method: alice signed in via UI (tab 0). Bob's sockets simulated in tab 1 via `socket.io-client` (4.8.1) loaded from CDN and connected with bob's JWT from `POST /api/auth/login`. This faithfully exercises the server's presence fan-out path without conflicting on tab 0's localStorage. Self-state behaviour on alice's tab was exercised against the real Angular app.

1. **Render sites present (all 4)** — from `/chat`, alice's DOM has `app-presence-dot` on: friend row (LEFT of avatar), DM row (LEFT of avatar), DM header (LEFT of `alternate_email` icon + `bob_qa` heading), room rail for general-qa (LEFT of each username including alice's own row). Children order of each container confirmed.
2. **Online state** — bob's socket connects; within ~1 s all four alice-side bob dots flip to `bg-tertiary` with `aria-label="Presence: Online"` and `mat-tooltip="Online"`.
3. **AFK state via `presence:idle`** — bob emits `presence:idle` from a sole active socket; within ~1 s alice sees all four bob dots flip to `bg-outline` with label `Presence: Away from keyboard`, tooltip `Away from keyboard`.
4. **Back to Online via `presence:active`** — bob emits `presence:active`; within ~1 s dots flip back to `bg-tertiary` / `Online`.
5. **Offline on last-socket disconnect** — bob's only socket calls `disconnect()`; within ~1 s all bob dots flip to `bg-surface-dim` with label `Presence: Offline`.
6. **Self-dot visibility-change → AFK** — dispatched `visibilitychange` with `visibilityState='hidden'` on alice's tab; alice's own dot in the rail flipped immediately to `bg-outline` / afk. Visibility → `visible` flipped it back to online.
7. **Self-dot 60 s idle timer** — after ~65 s of no activity on alice's tab (verified zero queued events via a capture-phase listener the tester installed), alice's self dot transitioned to afk. Dispatching a `mousedown` flipped it back to online within 1 s.
8. **Self-dot never Offline** — across all scenarios (including bob offline, multiple socket disconnects, 60 s idle, visibility-hidden), alice's own dot stayed in `online`/`afk` only. Never observed `bg-surface-dim` on the self row.
9. **Multi-tab aggregate — any active tab keeps online** — bob opens two sockets (S1, S2). S1 idle + S2 active → alice still sees bob Online. Both idle → alice sees bob afk (within ~1 s). Both disconnected → Offline (within ~1 s).
10. **Snapshot-on-connect merge after re-login** — alice signs out + signs back in; presence map re-hydrates from `presence:snapshot` on the fresh socket; bob's dots render Online immediately (not after a live update).
11. **Logout lifecycle** — sign-out emitted no console errors; activity listeners detach + `selfState` reset; on re-login, activity tracker restarts and snapshot-on-connect re-seeds the map.
12. **Ban-lock coexistence (smoke)** — DM row retains dot LEFT of avatar; Round-6 ban-lock slot is reserved to the LEFT of the overflow menu, no layout collision observed. Did not actually block bob (kept the test state clean for future rounds).

## Compliance checks

- Console: `0 errors, 0 warnings` for the full test session (all logs across navigations and the 4 presence-state cycles).
- Design system — presence dot renders with utility classes only: `bg-tertiary` (online), `bg-outline` (afk), `bg-surface-dim` (offline). `border-color: rgb(233, 231, 235)` resolves through `--mat-sys-*` inside the component SCSS (the sanctioned SCSS-only escape hatch). No inline `style="..."` on any `.presence-dot`. Size is `10px × 10px` computed from `0.625rem` — matches design spec.
- Grep of `frontend/src/app/shared/presence-dot.component.{ts,scss}` + `frontend/src/app/core/presence/*.ts` for `#[0-9a-f]{3,6}`, `rgb(`, `\d+px`, `var(--mat-sys-*)` in templates → zero matches.
- Snapshot-on-connect semantics observed: the third socket (re-login) receives `presence:snapshot` with bob already in `online` state; prior live entries are not blown away by the merge (reasoned from code inspection + observed behaviour on re-login — local map not reset on snapshot arrival).

## Round-6 carry-over

- **Bug #1 from Round 6 (FriendsService empty on hard page reload)** — not re-exercised in this round. Round-7 scope is presence dots; the dev summary flagged that `APP_INITIALIZER` migration is still deferred. Entry remains Open in `plans/round-6/bugs.md` and is not copied here (tracker for Round 7 is this file; prior bugs stay in their round's file per workflow).

## Summary
- Open: 0
- Fixed (pending verification): 0
- Verified: 0
- Won't fix: 0
