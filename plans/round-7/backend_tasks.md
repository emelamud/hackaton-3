# Round 7 — Backend Tasks

## Goal
Implement the server-side presence engine: an in-memory registry keyed by userId that aggregates `active | idle` signals across each user's sockets, exposes the tri-state `online | afk | offline` per user, broadcasts `presence:update` to the caller's interest set on every aggregate-state transition, and emits `presence:snapshot` to every newly-connected socket.

## Dependencies
- `shared/types/presence.ts` + `shared/types/socket.ts` (Round 7 orchestrator output — `PresenceState`, `UserPresence`, `PresenceUpdatePayload`, `PresenceSnapshotPayload`, `ServerToClientEvents['presence:update' | 'presence:snapshot']`, `ClientToServerEvents['presence:active' | 'presence:idle']`).
- `shared/api-contract.md` §Socket Events — the Round 7 additions spell out the aggregation rule, the interest set, and the event payloads verbatim.
- Existing infra: `backend/src/socket/io.ts` (`io.on('connection', …)`, `emitToUser`, `emitToRoom`); `backend/src/services/rooms.service.ts` (`listRoomsForUser`, room-member queries); `backend/src/services/friends.service.ts` (friendships query); `backend/src/db/schema.ts` (`friendships`, `roomMembers`, `rooms`).
- `plans/round-6/backend_work_summary.md` §Next round needs to know — `dmPeer.userId` on DM rooms from `listRoomsForUser`; `hasBanBetween` symmetric-ban lookup reusable if needed.
- `.claude/agents/backend-developer.md` — Drizzle, Socket.io, zod, AppError conventions.
- **Do not modify `/shared/`.** If a type or contract change is needed, report it — do not edit.

## Tasks

### 1. New service — `backend/src/services/presence.service.ts`

Owns all presence state. Module-level in-memory maps (no DB — presence is ephemeral and resets on server restart by design):

```ts
import type { PresenceState, UserPresence } from '@shared';

type SocketActivity = 'active' | 'idle';

interface UserEntry {
  // Map<socketId, SocketActivity> — order is insertion order, fine for iteration.
  sockets: Map<string, SocketActivity>;
  // Cached aggregate (recomputed on mutation; exported via getUserPresence).
  aggregate: PresenceState;
}

const users = new Map<string, UserEntry>();
const socketToUser = new Map<string, string>();  // socketId → userId, for O(1) disconnect lookup.
```

Public API (export as named functions):

```ts
export function handleConnect(socketId: string, userId: string): { changed: boolean; state: PresenceState };
export function handleDisconnect(socketId: string): { userId: string | null; changed: boolean; state: PresenceState };
export function setSocketActivity(socketId: string, activity: SocketActivity): { userId: string | null; changed: boolean; state: PresenceState };
export function getUserPresence(userId: string): PresenceState;
export function snapshotForUsers(userIds: string[]): UserPresence[];
```

Semantics:
- `handleConnect(socketId, userId)`:
  - Sockets start as `active` (fresh tab means the user just interacted to open it).
  - If `users` had no entry for `userId`, create one with `aggregate: 'online'` and `sockets: new Map([[socketId, 'active']])`. Return `{ changed: true, state: 'online' }`.
  - If an entry existed:
    - Add the new socket as `active`.
    - Recompute aggregate. If it was `offline` (shouldn't happen — absent user has no entry) OR `afk`, it flips to `online` → `changed: true`. If already `online`, `changed: false`.
  - Also record `socketToUser.set(socketId, userId)`.
- `handleDisconnect(socketId)`:
  - Look up userId via `socketToUser`. If not found, return `{ userId: null, changed: false, state: 'offline' }` (defensive — should never happen).
  - Remove the socket from the user's `sockets` map and from `socketToUser`.
  - If the user's `sockets` map is now empty: delete the `users` entry entirely, return `{ userId, changed: true, state: 'offline' }`.
  - Else recompute aggregate. If it changed (e.g. last `active` socket disconnected → leftover sockets all `idle` → now `afk`), return `{ userId, changed: true, state: <new> }`. Else `{ userId, changed: false, state: <unchanged> }`.
- `setSocketActivity(socketId, activity)`:
  - Look up userId. If the socket doesn't exist in the map (raced with disconnect), return `{ userId: null, changed: false, state: 'offline' }` — the caller (socket handler) will no-op.
  - Mutate the socket's entry in the user's `sockets` map.
  - Recompute aggregate. Return `{ userId, changed, state }`.
- `getUserPresence(userId)` — simple map lookup; `offline` if absent.
- `snapshotForUsers(userIds)` — array-map over `userIds`, returning `[{ userId, state: getUserPresence(userId) }, …]`. Used by the connect-time snapshot fan-out (task 3).

Aggregate recompute helper (internal, not exported):
```ts
function recomputeAggregate(entry: UserEntry): PresenceState {
  let anyActive = false;
  for (const activity of entry.sockets.values()) {
    if (activity === 'active') { anyActive = true; break; }
  }
  if (anyActive) return 'online';
  // At least one socket is connected but all are idle (empty case is handled by caller before recompute).
  return 'afk';
}
```

Implementation notes:
- The service is pure in-memory — do NOT touch the DB. All DB-backed lookups (interest set, friendships, etc.) live in the socket handler which composes the presence service with the existing room/friend services.
- Keep the module side-effect free at import time (no timers, no `setInterval`). The service is a state store; the socket handler drives it.
- Expose a `__resetForTests()` in the same module if it makes smoke-harness runs more deterministic — low cost.

### 2. New service — `backend/src/services/presence-interest.service.ts`

Computes the interest set for a user: friends ∪ DM peers ∪ room co-members. Exported signature:

```ts
export async function getInterestSet(userId: string): Promise<string[]>;
```

Single SQL query preferred — three `UNION`-ed sub-selects against existing tables, deduped. Reference pattern (adapt to Drizzle syntax):

```sql
SELECT DISTINCT other_user_id FROM (
  -- Friends (both directions; friendships is symmetric but stored twice by Round 5's accept tx)
  SELECT friend_user_id AS other_user_id
  FROM friendships
  WHERE user_id = $1

  UNION

  -- Co-members of ANY room the caller is in (channels OR DMs — same query covers both)
  SELECT rm_other.user_id AS other_user_id
  FROM room_members rm_caller
  JOIN room_members rm_other
    ON rm_other.room_id = rm_caller.room_id
   AND rm_other.user_id <> rm_caller.user_id
  WHERE rm_caller.user_id = $1
) agg
WHERE other_user_id <> $1;
```

The DM-peer case is naturally covered by the co-members query (DMs are `rooms` rows with `type='dm'` and 2 `room_members` — the other member is the peer). Dedupe is done via `SELECT DISTINCT`.

Notes:
- Do NOT materialise friendship rows as `friends.userId + friends.friendUserId`. Round 5's summary locked "friendships stored symmetrically" — a single `WHERE user_id = $1` suffices.
- Keep this as a separate service module (not a helper inside `presence.service.ts`) so the in-memory state and the DB-backed interest computation stay in different files. Easier to unit-test in isolation if we ever add tests.
- Return `string[]` (userIds). Callers fan out via `emitToUser` in a simple for-loop.

### 3. Wire `io.ts` — connect / disconnect / client events

In `backend/src/socket/io.ts`, extend the `io.on('connection', …)` handler:

**3a. On connect** (after the existing `user:<userId>` join and the `room:<roomId>` pre-subscription loop):

```ts
const { changed, state } = presenceService.handleConnect(socket.id, userId);

// Snapshot — per-socket, to this socket only (not the user fan-out).
const interest = await presenceInterestService.getInterestSet(userId);
const presences = presenceService.snapshotForUsers(interest);
socket.emit('presence:snapshot', { presences });

// Broadcast our own transition to the interest set if the aggregate changed.
if (changed) {
  for (const otherId of interest) {
    emitToUser(otherId, 'presence:update', { userId, state });
  }
}
```

Notes:
- The snapshot emit is `socket.emit(…)` — direct to this socket — NOT `emitToUser(userId, …)` which would fan out to every other tab and re-hydrate them unnecessarily.
- The interest set is fetched ONCE on connect and reused for the snapshot and the self-broadcast. If a user's interest set changes mid-session (accepts a friend, joins a room, opens a new DM) the existing per-action socket wiring (`socketsJoin`, `friend:request:accepted`, `dm:created`, etc.) doesn't need to be extended — the NEXT presence transition for that user will naturally fan out to the updated set because `getInterestSet` is called fresh on every transition (see 3c).

**3b. On disconnect** (add a `socket.on('disconnect', …)` handler inside the connection block):

```ts
socket.on('disconnect', async () => {
  const { userId: uid, changed, state } = presenceService.handleDisconnect(socket.id);
  if (!uid || !changed) return;
  const interest = await presenceInterestService.getInterestSet(uid);
  for (const otherId of interest) {
    emitToUser(otherId, 'presence:update', { userId: uid, state });
  }
});
```

Notes:
- `handleDisconnect` handles the "last socket gone → state=offline" case and the "still have sockets but last active one left → state=afk" case. The handler only broadcasts when the aggregate changed.
- `getInterestSet` is called AFTER `handleDisconnect`. Even though the disconnected user's rows in `room_members` / `friendships` haven't changed, this is safe — we're querying based on the disconnected user's memberships, not their session.

**3c. On `presence:active` / `presence:idle`** (add two `socket.on` handlers):

```ts
socket.on('presence:active', async () => {
  const { userId: uid, changed, state } = presenceService.setSocketActivity(socket.id, 'active');
  if (!uid || !changed) return;
  const interest = await presenceInterestService.getInterestSet(uid);
  for (const otherId of interest) {
    emitToUser(otherId, 'presence:update', { userId: uid, state });
  }
});

socket.on('presence:idle', async () => {
  const { userId: uid, changed, state } = presenceService.setSocketActivity(socket.id, 'idle');
  if (!uid || !changed) return;
  const interest = await presenceInterestService.getInterestSet(uid);
  for (const otherId of interest) {
    emitToUser(otherId, 'presence:update', { userId: uid, state });
  }
});
```

Notes:
- No zod validation needed — these events have no payload.
- The two handlers are structurally identical; feel free to extract a private helper `broadcastActivity(socket, 'active' | 'idle')` to dedupe.
- No rate-limiting beyond what the activity pattern already enforces (client sends transitions only, ≤ 2/min per tab). If we wanted defence in depth, a simple per-socket token bucket (capacity 10, refill 1/sec) would be sufficient; flag in **Config improvements** if you choose not to add it.

**3d. ClientToServerEvents typing** (optional nicety):
If the `Server` generic of `socket.io` is currently typed as `Server<Events>` in `initSocketIo`, extend it to use the new `ClientToServerEvents` from `@shared`:

```ts
import type { ClientToServerEvents, ServerToClientEvents } from '@shared';
// ...
const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, { … });
```

If the current implementation doesn't use the generic parameter (the file currently just uses `Server`), leaving it as-is is acceptable — the string literal event names in `socket.on('presence:active', …)` will still type-check against the runtime client. Low-priority polish.

### 4. Do NOT add a HTTP endpoint
No `GET /api/presence/*`. The contract is explicit: presence is a Socket.io-only surface. The snapshot event covers the initial-state fetch need.

### 5. Smoke harness — `tmp/round-7/smoke.js`

Stand up 3 users via registration (alice, bob, carol) and drive the scenarios below. For each, capture and log the actual observed event payloads. Use the same style as prior rounds' smoke scripts: `node-fetch` for HTTP, `socket.io-client` for sockets, with `.on('presence:snapshot', …)` / `.on('presence:update', …)` handlers that push into per-client arrays the test asserts against.

Scenario list (each should pass; capture the exact payload in the round summary):

1. **Baseline — alice connects alone.** Alice opens tab1 (socket S1). Assert: S1 receives `presence:snapshot` with `presences: []` (no friends/rooms/DMs yet; interest set empty).

2. **Alice + bob friends; bob connects after alice.** Pre-seed: accept a friend request so alice and bob are friends. Alice's S1 already connected. Bob opens tab1 (socket S2). Assert:
   - S2 receives `presence:snapshot` containing `{ userId: alice.id, state: 'online' }`.
   - S1 receives `presence:update` with `{ userId: bob.id, state: 'online' }` (bob's connect broadcast, alice is in bob's interest set).

3. **Alice's second tab.** Alice opens tab2 (socket S3). Assert:
   - S3 receives `presence:snapshot` with `{ userId: bob.id, state: 'online' }`.
   - NO `presence:update` is broadcast to bob (alice's aggregate stays `online` — S1 was already active).
   - NO `presence:update` is broadcast to alice's S1 (self-fan-out is excluded).

4. **Alice's S1 goes idle.** Fire `socket.emit('presence:active' → 'presence:idle')` on S1. Assert:
   - NO `presence:update` broadcast to bob (S3 still active → aggregate stays `online`).

5. **Alice's S3 also goes idle — aggregate flips to afk.** Fire `presence:idle` on S3. Assert:
   - Bob receives `presence:update` with `{ userId: alice.id, state: 'afk' }` on S2.
   - Alice's S1 and S3 do not receive a self-update.

6. **Alice's S1 becomes active — aggregate flips back to online.** Fire `presence:active` on S1. Assert:
   - Bob receives `presence:update` with `{ userId: alice.id, state: 'online' }` on S2.

7. **Alice disconnects S1.** Assert:
   - NO broadcast (S3 still idle → aggregate recomputes to `afk` only if S1 was the sole active socket; S1 IS the sole active socket → transition online → afk → broadcast. Verify which case your implementation hits). Two variants acceptable; pick one and document:
     - If S1 was `active` and S3 was `idle`: broadcast `{ state: 'afk' }` to bob.
     - If S1 was `idle` (from step 4, re-apply step 6 before this step as an independent variant): no broadcast.

8. **Alice disconnects S3 — last socket gone.** Assert:
   - Bob receives `presence:update` with `{ userId: alice.id, state: 'offline' }` on S2.

9. **Non-friend stranger.** Carol registers, alice and carol are not friends, no shared rooms. Carol connects (socket S4). Assert:
   - S4 receives `presence:snapshot` with `presences: []`.
   - Bob does NOT receive any `presence:update` about carol (carol not in bob's interest set).
   - Alice (re-connect a fresh socket S1') does NOT receive any `presence:update` about carol.

10. **Room co-membership expands the interest set.** Alice creates a channel, invites carol, carol accepts. Assert: carol's interest set NOW includes alice. Alice goes idle → broadcast reaches carol's S4.

11. **DM creates a mutual interest edge.** Alice and bob are already friends; alice POSTs `/api/dm` with bob. Assert: bob's interest set gets alice via the friend edge AND via the DM-peer edge, but `DISTINCT` collapses them — no duplicate `presence:update` broadcast.

12. **Page-hidden immediate idle.** A tab going `visible → hidden` on the client SHOULD emit `presence:idle` immediately (no 60-s wait). Server-side this is indistinguishable from a normal `presence:idle` — the smoke script simulates by emitting `presence:idle` within 5 s of connect. Assert aggregate flips and broadcast fires as usual.

Keep the smoke script bounded — target ≤ 2 minutes total runtime. Use short explicit waits (`await sleep(150)`) for the socket event fan-out to arrive, NOT 60-s real-time waits — the server does not enforce timers, so the test can emit `presence:idle` directly.

### 6. Verification gate before summary
- `pnpm build` in `backend/` must be clean.
- Linter clean.
- Smoke script runs end-to-end, logging the actual payloads for scenarios 1–12. Include the raw payload snippets in the **Built** section of the summary (not just "passed").

## Wrap-up
Write `plans/round-7/backend_work_summary.md` with:
- **Built** — files (`presence.service.ts`, `presence-interest.service.ts`, `io.ts` extensions); the aggregate rule; the interest-set query; the snapshot-per-socket decision; raw smoke-script payload capture for at least scenarios 2, 5, 6, 8 (the key transitions).
- **Deviations** — any shape changes vs the contract. Likely: whether `ClientToServerEvents` was actually wired into the `Server<…>` generic or left as runtime-only.
- **Deferred** — HTTP presence endpoint (deliberate — see task 4); grace-period debounce on disconnect (future polish); per-socket token bucket for `presence:active/idle` (defence in depth).
- **Next round needs to know**
  - For Round 8 (attachments): no presence coupling.
  - For Round 9 (pagination): no presence coupling.
  - For Round 11 (moderation): when an admin removes a member from a room, the removed user's co-membership edge is gone — the NEXT time either user's presence transitions, `getInterestSet` will naturally return the new (smaller) set. No explicit invalidation is needed. Document this so the Round 11 planner doesn't over-engineer an explicit edge-invalidation step.
  - For Round 12 (unread): no presence coupling.
- **Config improvements** — grace-period debounce (5 s hold on last-socket disconnect); per-socket rate-limit on `presence:active/idle` (low priority, high-volume abuse unlikely given client transition semantics); a Drizzle-native `DISTINCT UNION` query vs raw SQL (query is small either way); whether to expose `/api/presence/metrics` for an admin dashboard (out of scope).
