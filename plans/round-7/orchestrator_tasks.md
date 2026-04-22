# Round 7 — Orchestrator Tasks

## Goal
Lock the contract for user presence (online / AFK / offline) across sockets + tabs: the new `PresenceState` type, the client-side AFK rule (per requirement §2.2.2), the Socket.io event shapes (`presence:active`, `presence:idle`, `presence:snapshot`, `presence:update`), the server-side aggregation rule, the interest-set fan-out rule, and the snapshot-on-connect behaviour so BE and FE can wire presence dots onto friends, DM peers, and room members.

## Scope
Round 7 from `plans/master-plan.md` — presence dots on friends list, DM headers, DM rows, and room member rail, consistent across multiple tabs (requirement §2.2).

Out of scope:
- Active sessions management UI (requirement §2.2.4 — already shipped in Round 1).
- Unread badges (Round 12).
- Account deletion cascade (unscheduled — requirement §2.1.5).
- Presence for anonymous viewers, typing indicators, "last seen at" timestamps — not in requirements.

## Design decisions (locked during planning — record as rationale on the contract)

### Q1 — What is AFK, and how long before it's set?
Per requirement §2.2.2: a user is AFK when they have not interacted with **any** of their open browser tabs for **more than 1 minute**. If at least one tab is active, the user is `online`. We lock the AFK threshold at **60,000 ms (60 s)** enforced client-side per tab. The server trusts the client's per-socket `active | idle` transitions.

### Q2 — Which FE events signal activity?
The FE-side idle timer is reset by any of the following DOM events on `document`, attached once at the root (activity tracker service):
- `mousedown`, `mousemove`, `wheel`, `scroll` (with `{ capture: true, passive: true }` to catch bubbled + scrolling contexts)
- `keydown`
- `pointerdown`, `touchstart` (mobile / touch laptops)
- `visibilitychange` — special: `document.visibilityState === 'hidden'` → immediate transition to `idle` (no waiting for the 60s timer); `visible` → immediate transition to `active`

The service does NOT send a wire event on every DOM event. It only sends a socket event on **transitions**:
- `active → idle`: emit `presence:idle` to the server (no payload)
- `idle → active`: emit `presence:active` to the server (no payload)

Result: at most 2 wire events per 60 s window per tab. Negligible load at 300-user scale.

### Q3 — Where in the Angular app does FE listen?
A root-scoped `PresenceActivityService` under `frontend/src/app/core/presence/`, constructed eagerly by `AuthService` (same pattern used for `DmsService`, `UserBansService`, `FriendsService`). Listener attachment happens inside `NgZone.runOutsideAngular` so activity-triggered callbacks do not thrash change-detection. The service starts when `authService.isAuthenticated` flips true (login / session restore), stops on logout.

### Q4 — How do we test?
- **BE smoke** (`backend-developer`): standalone `tmp/round-7/smoke.js` driving two-to-three users with multiple sockets each via `socket.io-client`, asserting on the exact wire shape of `presence:snapshot` and `presence:update` across connect / idle transition / reconnect / disconnect / multi-tab scenarios. Scenarios listed in the backend task file.
- **FE exercise** (`frontend-developer`): `How to exercise this` in the FE work summary — explicit steps for a tester using two browser sessions + two tabs each to observe ● / ◐ / ○ cycling on friend rows, DM headers, DM rows, and the room member rail. Tester runs Playwright MCP from `/fix-bugs` mode or post-round verification.

### Q5 — Client→Server presence signals: separate events or heartbeat?
We lock two separate explicit events for clarity:
- `presence:active` — fired when the tab transitions from idle to active.
- `presence:idle` — fired when the tab transitions from active to idle (60 s timer expired or page hidden).

No payload on either event (the sending socket's userId is already in `socket.data.user`). Alternative heartbeat model (`presence:heartbeat { active: boolean }` every N seconds) was rejected because it wastes bandwidth and obscures transition semantics. Server-driven timers were rejected because they require per-socket state machines; client-driven transitions are simpler to reason about.

### Q6 — Server-side aggregation: per-socket vs per-user
Server tracks per-socket state (`active | idle`) and computes per-user aggregate:
- `online` — at least one of the user's sockets is currently `active`.
- `afk` — the user has ≥1 connected socket but **all** of them are `idle`.
- `offline` — the user has zero connected sockets.

This matches requirement §2.2.3 ("multi-tab: online if any tab active; AFK only if all tabs idle for >1 min; offline only when all tabs closed").

Only aggregate-state deltas are broadcast. A socket transitioning `active → idle` does NOT emit `presence:update` if another socket of the same user is still `active` (aggregate stays `online`).

### Q7 — Who receives a user's presence updates (interest set)?
For a user X, the set of recipients for `presence:update` about X is:
- X's **friends** (from the `friendships` table)
- X's **DM peers** (the OTHER user on every `rooms` row with `type='dm'` that X is a member of)
- X's **room co-members** (every user who shares a `type='channel'` room membership with X)

Server emits `presence:update` via `emitToUser(interestedUserId, 'presence:update', { userId: X, state })` for each user in that set. X themselves are excluded — they track their own state locally in the FE's `PresenceActivityService`.

At 300 simultaneous users / ~50 friends / ~20 rooms average per user (requirement §3.1), the interest-set size stays in the low hundreds per broadcast — linear scan is fine for hackathon scope.

### Q8 — Snapshot on connect
On each successful socket `connection`, after joining `user:<userId>` and `room:<roomId>` for each of the caller's rooms, the server computes the caller's interest set (friends ∪ DM peers ∪ room co-members), looks up each one's current aggregate state from the in-memory presence registry, and emits `presence:snapshot` to THAT socket only (not the fan-out `user:<userId>` room — snapshots are per-socket, not per-user, so that reopening a tab doesn't blast the same payload to every other tab).

Users absent from the registry (no connected sockets) are returned as `state='offline'`.

### Q9 — Socket churn: what about reconnect flashes?
A transient disconnect+reconnect (network blip, laptop suspend) will fire `offline` on disconnect and `online` on reconnect. We ACCEPT the brief flash for Round 7 — the 2-second propagation target (requirement §3.2) absorbs it. A grace-period refinement (hold "offline" for 5 s after last-socket-disconnect) is listed in **Config improvements** for a later polish pass.

### Q10 — Does the user see their own presence?
Yes. The FE layers self-state on top of the server-sourced map using the local activity tracker (the server never emits updates about the caller back to themselves). The room member rail's self row shows ● when the tab is active, ◐ when idle. Self-state never goes offline (the user is by definition online when the UI is rendering).

## Dependencies
- `plans/master-plan.md` §Round 7 bullets.
- `requirements.txt` §2.2 (Presence), §2.7.2 (low-latency updates), §3.2 (propagation <2s), §3.1 (300-user scale).
- `shared/api-contract.md` — current state (Socket Events section is where presence events land; Rooms / Friends / DM / User Ban sections are unchanged).
- `shared/types/` — existing exports (`socket.ts` currently only carries `ServerToClientEvents`; Round 7 introduces a new `presence.ts` module and also a `ClientToServerEvents` interface for the two new client→server events).
- `plans/round-6/orchestrator_work_summary.md` §Next round needs to know — three-consumer union for `user:<id>` presence subscriptions (`FriendsService.friends().map(f => f.userId) ∪ chatContext.currentRoom().members.map(m => m.userId) ∪ roomsService.roomsSignal().filter(r => r.type === 'dm').map(r => r.dmPeer!.userId)`), deduped by userId. DM sidebar row + DM header both reserved a presence-dot slot.
- `plans/round-6/backend_work_summary.md` §Next round needs to know — `dmPeer.userId` is always populated on DM rooms from both `listRoomsForUser` and `getRoomDetail`; no FE fallback needed.
- `plans/round-6/frontend_work_summary.md` §Next round needs to know — DM sidebar row presence slot lives to the LEFT of the avatar; DM header presence slot lives to the LEFT of `@username`. The ban-lock icon renders adjacent to — not instead of — the presence dot slot.

## Tasks

### 1. Create `/shared/types/presence.ts`
New file.

```ts
export type PresenceState = 'online' | 'afk' | 'offline';

export interface UserPresence {
  userId: string;
  state: PresenceState;
}

export interface PresenceUpdatePayload {
  userId: string;
  state: PresenceState;
}

export interface PresenceSnapshotPayload {
  presences: UserPresence[];
}
```

Rationale:
- `UserPresence` is the shared row shape reused by both snapshot-list and map-value.
- `PresenceUpdatePayload` and `PresenceSnapshotPayload` are distinct event payloads to keep event→payload pairing explicit in the `ServerToClientEvents` map and to match the existing pattern (`FriendRemovedPayload`, `UserBanAppliedPayload`, etc.).

### 2. Update `/shared/types/index.ts`
Append `export * from './presence';` between the existing `./user-ban` and `./socket` exports so all downstream imports (`import { PresenceState } from '@shared'`) resolve via the barrel.

### 3. Update `/shared/types/socket.ts`
Add presence events on BOTH directions. The file currently exports only `ServerToClientEvents`; Round 7 introduces `ClientToServerEvents` since presence is the first feature where the client emits typed custom events on its own (pre-Round-7 client→server traffic was `message:send` handled ad-hoc in `backend/src/socket/io.ts`).

```ts
import type { Message } from './message';
import type { RoomDetail } from './room';
import type { Invitation, InvitationRevokedPayload } from './invitation';
import type {
  FriendRequest,
  FriendRequestAcceptedPayload,
  FriendRequestCancelledPayload,
  FriendRequestRejectedPayload,
  FriendRemovedPayload,
} from './friend';
import type { UserBanAppliedPayload, UserBanRemovedPayload } from './user-ban';
import type { PresenceUpdatePayload, PresenceSnapshotPayload } from './presence';

export interface ServerToClientEvents {
  // ... existing entries unchanged ...
  'message:new': Message;
  'room:updated': RoomDetail;
  'invitation:new': Invitation;
  'invitation:revoked': InvitationRevokedPayload;
  'friend:request:new': FriendRequest;
  'friend:request:cancelled': FriendRequestCancelledPayload;
  'friend:request:accepted': FriendRequestAcceptedPayload;
  'friend:request:rejected': FriendRequestRejectedPayload;
  'friend:removed': FriendRemovedPayload;
  'dm:created': RoomDetail;
  'user:ban:applied': UserBanAppliedPayload;
  'user:ban:removed': UserBanRemovedPayload;
  'presence:update': PresenceUpdatePayload;      // NEW
  'presence:snapshot': PresenceSnapshotPayload;  // NEW
}

export type ServerToClientEvent = keyof ServerToClientEvents;

export interface ClientToServerEvents {
  'presence:active': void;  // NEW — no payload
  'presence:idle': void;    // NEW — no payload
  // Note: 'message:send' is deliberately NOT added here in Round 7.
  // It uses an ack callback + a separate SendMessagePayload / MessageSendAck
  // typing pair that predates this interface. Migrating it is out of scope
  // (low-value churn for hackathon timeline). Flag for a future typing pass.
}

export type ClientToServerEvent = keyof ClientToServerEvents;
```

Notes:
- `void` as the payload type lets callers emit `socket.emit('presence:active')` without arguments.
- The `message:send` note is deliberate: the Round 3 wiring uses `SendMessagePayload` + ack callback and wouldn't benefit from a type migration today. Round 7 does not touch `message:send`.

### 4. Extend `/shared/api-contract.md`

#### 4a. Extend the `## Socket Events` section with a new `### Client → Server events` block

Append a second `presence:active` / `presence:idle` subsection under `### Client → Server events` (the existing `#### message:send` stays untouched, in the same block).

**`presence:active`**
- Payload: none (empty event).
- Fired by the FE when the tab transitions from `idle` to `active` — i.e. first user interaction after an idle window, or `visibilitychange → visible`.
- Server: updates the emitting socket's per-socket state to `active`; recomputes the user's aggregate; emits `presence:update` to the interest set only if the aggregate state changed.

**`presence:idle`**
- Payload: none (empty event).
- Fired by the FE when the tab transitions from `active` to `idle` — i.e. 60 s passes without a qualifying user-interaction event, OR `visibilitychange → hidden` (immediate, no wait).
- Server: updates the emitting socket's per-socket state to `idle`; recomputes the user's aggregate; emits `presence:update` to the interest set only if the aggregate state changed.

**Rules** (append to the existing top-of-`## Socket Events` rules or add a new `### Presence` sub-block):
- FE AFK threshold: 60,000 ms per tab without a qualifying interaction (requirement §2.2.2).
- Server aggregation: a user is `online` iff at least one of their connected sockets is `active`; `afk` iff ≥1 socket is connected but all are `idle`; `offline` iff no sockets connected.
- Only aggregate-state transitions trigger a `presence:update` broadcast. A socket flipping `active → idle` while another socket stays `active` is silent on the wire.
- Per-user `presence:update` fan-out is restricted to the caller's **interest set**: friends ∪ DM peers ∪ room co-members. The changed user themselves is NOT in their own fan-out (FE tracks self locally).
- On each successful `connection`, the server emits `presence:snapshot` to the newly-connected socket (not the user fan-out) with the current state of every user in the caller's interest set. Users with no connected sockets default to `state='offline'`.
- Presence updates should propagate end-to-end in ≤ 2 s (requirement §3.2) — no artificial delays server-side.

#### 4b. Extend the `## Socket Events` section with two new `### Server → Client events` blocks

Append these between the existing `user:ban:removed` block and the `### Error envelope` block.

**`presence:update`**
- Payload: `PresenceUpdatePayload` (`{ userId, state }`).
- Fired to `user:<interestedUserId>` for every user in the changed user's interest set (friends, DM peers, room co-members), whenever the changed user's aggregate `online | afk | offline` state transitions.
- NOT fired to the changed user themselves.
- Recipients apply the update to their local presence map; the UI re-renders the dot next to any sidebar row, DM header, or room member rail entry keyed on `userId`.

**`presence:snapshot`**
- Payload: `PresenceSnapshotPayload` (`{ presences: UserPresence[] }`).
- Fired to a single socket (not the user fan-out `user:<id>`) after it successfully connects and subscribes to its `user:` / `room:` channels. Payload contains every user in the caller's interest set, each with its current aggregate state.
- Consumer semantics: the FE replaces its local presence map with the snapshot contents on receipt (any prior entries for userIds not present in the snapshot should NOT be cleared — the snapshot is authoritative only for the interest set). New sockets on an already-authenticated browser session can fold the snapshot in without losing prior state from a previous connection.

#### 4c. Housekeeping sweep
- Grep `shared/api-contract.md` for `Round [0-9]+[a-z]?\b` and confirm no stale round references. Round 6 left a handful of references to Round 7 (for presence), Round 8 (attachments), Round 9 (pagination), Round 11 (moderation), Round 12 (unread) — preserve those, update the Round 7 ones to historical form ("Presence was introduced in Round 7 via …" is NOT needed; just drop "Round 7 adds …"-style forward references if any exist).
- Verify the existing `### On connect` block in `## Socket Events` still reads correctly after the new `presence:snapshot` emission is called out. Recommendation: append a bullet to the `### On connect` step list: "3. Server emits `presence:snapshot` to the newly-connected socket (see §`presence:snapshot` below) — Round 7."

### 5. No new types or endpoints beyond presence
No HTTP endpoint is introduced. Presence flows exclusively through Socket.io. Do not add `GET /api/presence/*` — the `presence:snapshot` event already covers the initial-state fetch need, and any HTTP layer would duplicate the auth + interest-set logic.

### 6. Agent description updates — one-liner about socket-events source of truth
Both Round-5 and Round-6 orchestrator summaries flagged that `.claude/agents/backend-developer.md` and `.claude/agents/frontend-developer.md` don't call out `shared/types/socket.ts` as authoritative for event names + payloads. Round 7 adds two client→server and two server→client events, which raises the consequence of drift. Add a single line to each agent description:

- `backend-developer.md` — under the `## Source of truth` bullet list: "For socket events, `shared/types/socket.ts` is authoritative (both `ServerToClientEvents` and `ClientToServerEvents`) — do not invent new event names, and prefer `emitToUser` / `emitToRoom` from `backend/src/socket/io.ts` over hand-rolled `io.in(...).emit(...)`."
- `frontend-developer.md` — under the `## Source of truth` bullet list: "For socket events, `shared/types/socket.ts` is the contract — event names and payload shapes must match. Outgoing client events are typed via `ClientToServerEvents`."

This closes the drift loop the last two rounds flagged.

### 7. No master-plan update
Round 7 bullet in `plans/master-plan.md` still reads accurately after this round's scope. Do not edit.

## Wrap-up
Write `plans/round-7/orchestrator_work_summary.md` with:
- **Built** — files touched under `/shared/` (`presence.ts` new; `index.ts` + `socket.ts` + `api-contract.md` extended), the four new socket events, the `ClientToServerEvents` introduction and its scope (presence only — `message:send` deliberately unmigrated), the two agent-description one-liners, and whether the `### On connect` housekeeping bullet landed cleanly.
- **Deviations** — any shape changes BE or FE pushed back during implementation. Likely pressure points: (a) whether `presence:snapshot` fires per-socket vs per-user (per-socket is locked — if BE pushes back, hold firm: per-user would spam every tab on every new-tab open); (b) whether `ClientToServerEvents` adoption should retrofit `message:send` in the same round (scope creep — the task file says no).
- **Deferred** — grace-period on socket disconnect (5 s hold before emitting `offline`) to smooth network-blip flashes; per-user broadcast to the user themselves (could help multi-tab own-dot sync but adds wire volume and FE already handles it locally); typing indicators (not in requirements); "last seen at" timestamps (not in requirements); `ClientToServerEvents` retrofit of `message:send` (scope creep, future typing pass).
- **Next round needs to know**
  - For Round 8 (attachments): no presence coupling. The DM-ban gate on `message:send` already prevents sends from a blocked user; attachment endpoints (if Round 8 adds a separate upload route) need to replicate that gate, same as flagged by Round 6.
  - For Round 9 (pagination): no coupling. Presence is a socket-only surface; HTTP pagination is orthogonal.
  - For Round 11 (moderation): when admins remove a member from a room, the removed user's interest set shrinks (they no longer share that room). The server must recompute the interest set and NOT emit further `presence:update` about that user to the room's remaining members. Flag for the Round-11 backend agent — the interest-set query in `presence.service` is the authoritative place to gate this.
  - For Round 12 (unread + public catalog): no coupling.
- **Config improvements** — grace-period hold on last-socket disconnect (a 5-second debounce before emitting `offline` smooths network-blip flashes); BehaviorSubject / Subject for the per-socket state map vs plain `Map` (future refactor); whether a dedicated Socket.io "presence" namespace (`/presence`) would reduce fan-out cost (not worth it at 300-user scale); whether the snapshot should support server-side pagination for users with very large interest sets (post-hackathon).
