# Round 7 — Backend Work Summary

## Built

### New service — `backend/src/services/presence.service.ts`
In-memory registry with two module-level maps:
- `users: Map<userId, { sockets: Map<socketId, 'active'|'idle'>, aggregate: PresenceState }>`.
- `socketToUser: Map<socketId, userId>` for O(1) disconnect lookup.

Exported API:
- `handleConnect(socketId, userId) → { changed, state }` — fresh sockets start as `'active'`; first socket for a user creates the entry with `aggregate: 'online'` (returns `changed: true`); additional sockets just add + recompute.
- `handleDisconnect(socketId) → { userId, changed, state }` — pops from both maps; if the user's `sockets` map becomes empty the entry is deleted and `state: 'offline'` is returned with `changed: true`; otherwise re-aggregates.
- `setSocketActivity(socketId, activity) → { userId, changed, state }` — no-op when the socket is gone (races with disconnect) or when the transition is a repeat of the current activity.
- `getUserPresence(userId) → 'offline'` when absent, else the cached aggregate.
- `snapshotForUsers(userIds) → UserPresence[]`.
- `__resetForTests()` — test helper; resets the maps. Prod code never calls it.

Aggregate rule is `online` iff ≥1 socket is `active`, `afk` iff ≥1 socket is connected but all are `idle`, `offline` iff 0 sockets (entry deleted). Pure in-memory, no DB, no timers, no side-effects at import time.

### New service — `backend/src/services/presence-interest.service.ts`
Single SQL `UNION` via `db.execute<InterestRow>(sql\`…\`)`:

```sql
SELECT DISTINCT other_user_id FROM (
  SELECT friend_user_id AS other_user_id FROM friendships WHERE user_id = $1
  UNION
  SELECT rm_other.user_id AS other_user_id
  FROM room_members rm_caller
  JOIN room_members rm_other
    ON rm_other.room_id = rm_caller.room_id
   AND rm_other.user_id <> rm_caller.user_id
  WHERE rm_caller.user_id = $1
) agg
WHERE other_user_id <> $1
```

Returns `string[]` userIds. The DM-peer case is naturally covered by the co-members arm because DMs are `rooms` rows with `type='dm'` and two `room_members`. `SELECT DISTINCT` collapses the friend-AND-co-member overlap so the caller doesn't need a de-dup pass.

### Extended `backend/src/socket/io.ts`

On every new `connection` (after the existing `user:<id>` / `room:<roomId>` joins):
1. `presenceService.handleConnect(socket.id, userId)` registers the socket as `active` and returns the change-flag/state.
2. `presenceInterestService.getInterestSet(userId)` resolves the interest set ONCE per connect and is reused for both the snapshot and the self-broadcast.
3. `socket.emit('presence:snapshot', { presences: snapshotForUsers(interest) })` — emitted to THIS socket only (not the `user:<id>` fan-out) so opening a second tab does not re-hydrate the first.
4. If the aggregate flipped (e.g. `offline → online` on first tab), `emitToUser(otherId, 'presence:update', { userId, state })` loops over the interest set.

New `socket.on('disconnect', …)` handler: delegates to `handleDisconnect`, broadcasts via `emitToUser` if the aggregate changed.

New `socket.on('presence:active'|'presence:idle', …)` handlers: share a private `broadcastActivity(activity)` closure that calls `setSocketActivity`, then fans out via `emitToUser` if the aggregate flipped.

All fan-out uses the existing typed `emitToUser` helper — no hand-rolled `io.in(...).emit(...)`.

### Smoke harness — `tmp/round-7/smoke.js`
Drives all 12 scenarios from the task file against the live backend (`localhost:3000`). Uses `node-fetch` for the 3 registration + befriend + channel-create + DM-open HTTP calls and `socket.io-client` for 6 total sockets (S1, S2, S3, S4, S1', Sa, Sb). Each socket has `__snapshots` / `__updates` arrays populated by `.on('presence:snapshot'|'presence:update', …)` handlers; the script slices those arrays around each action to capture per-scenario deltas.

#### Raw observed payloads

```
[setup] {"aId":"f1c0b642-...","bId":"539f1073-...","cId":"dcb87762-..."}

[1]  {"S1_snapshot":{"presences":[]},"assertEmpty":true}

[2]  {
  "S2_snapshot": {"presences":[{"userId":"f1c0b642-...","state":"online"}]},
  "S2_snapshot_has_alice_online": true,
  "S1_updates_for_bob": [{"userId":"539f1073-...","state":"online"}]
}

[3]  {
  "S3_snapshot": {"presences":[{"userId":"539f1073-...","state":"online"}]},
  "S3_has_bob_online": true,
  "S2_updates_for_alice": [],
  "S1_self_updates": []
}

[4]  {"S2_updates_for_alice":[]}

[5]  {
  "S2_updates_for_alice": [{"userId":"f1c0b642-...","state":"afk"}],
  "expect": "{ userId: alice, state: 'afk' }"
}

[6]  {
  "S2_updates_for_alice": [{"userId":"f1c0b642-...","state":"online"}],
  "expect": "{ userId: alice, state: 'online' }"
}

[7]  {
  "S2_updates_for_alice": [{"userId":"f1c0b642-...","state":"afk"}],
  "expect": "{ userId: alice, state: 'afk' } (S1 was sole active; S3 still idle)"
}

[8]  {
  "S2_updates_for_alice": [{"userId":"f1c0b642-...","state":"offline"}],
  "expect": "{ userId: alice, state: 'offline' }"
}

[9]  {
  "S4_snapshot": {"presences":[]},
  "S2_updates_about_carol": [],
  "S1prime_updates_about_carol": []
}

[10] {
  "S4_updates_for_alice_after_join": [{"userId":"f1c0b642-...","state":"afk"}],
  "S2_updates_for_alice_after_join": [{"userId":"f1c0b642-...","state":"afk"}]
}

[11] {
  "S2_updates_for_alice_after_DM": [{"userId":"f1c0b642-...","state":"online"}],
  "count": 1
}

[12] {
  "Sb_updates_for_freshAlice": [{"userId":"893ee2e6-...","state":"afk"}]
}

[done] all 12 scenarios executed
```

Key transitions verified:
- **Scenario 2**: bob connects → alice's S1 receives `{ userId: bob, state: 'online' }`; bob's S2 snapshot contains `{ userId: alice, state: 'online' }`.
- **Scenario 5**: both of alice's sockets idle → bob sees `{ userId: alice, state: 'afk' }`.
- **Scenario 6**: first socket flips back to active → bob sees `{ userId: alice, state: 'online' }`.
- **Scenario 8**: last socket disconnects → bob sees `{ userId: alice, state: 'offline' }`.
- **Scenario 11**: DM + friend overlap resolves to exactly ONE broadcast (`count: 1`) — `SELECT DISTINCT` in the interest query collapses the duplicate edge.

### Verification gate
- `pnpm build` in `backend/` — clean.
- `pnpm lint` in `backend/` — clean.
- `docker compose up -d --build backend` — rebuilt and restarted cleanly; container log shows `Backend running on port 3000` after migrations.
- All 12 smoke scenarios observed the expected payloads above.

## Deviations

- **`Server<ClientToServerEvents, ServerToClientEvents>` generic NOT adopted.** Task 3d said "consider adopting" — I chose not to. The legacy `socket.on('message:send', async (payload, ack?) => {…})` handler uses a callback-shape that is not expressible inside the current `ClientToServerEvents` union (which types every listed event as `() => void`). Pulling `message:send` into that union would force a wider shared-type refactor (typed ack variants) that the Round 7 task file explicitly leaves out-of-scope. The string-literal event names on `socket.on('presence:active', …)` still type-check against the runtime client. This matches the "runtime-only" branch the task file anticipated as acceptable.
- **Scenario 7 variant chosen.** The task file offered two acceptable variants for "alice disconnects S1". I picked the first (S1 `active`, S3 `idle`) so the disconnect triggers a broadcast — the smoke log for scenario 7 confirms `{ alice, afk }` is broadcast.

## Deferred

- **HTTP presence endpoint** (`GET /api/presence/*`) — deliberately not added per task 4. The `presence:snapshot` event covers the initial-state fetch need.
- **Grace-period debounce on last-socket disconnect.** A reload (new tab opens, old socket disconnects) currently surfaces a brief `online → offline → online` flap to peers. A 5 s hold before emitting `offline` would dampen this; flagged in Config improvements.
- **Per-socket token bucket on `presence:active|idle`.** The client only emits on transitions (capped at ≤2/min per tab by client-side debounce), so the abuse surface is small. Flagged in Config improvements.
- **Integration tests (Jest + Supertest)** — project-wide hackathon deferral; the smoke harness is the verification artifact.

## Next round needs to know

- **Round 8 (attachments):** no presence coupling. An attachment upload doesn't transition presence.
- **Round 9 (pagination):** no presence coupling. Presence is per-userId, not per-message.
- **Round 11 (moderation / room admin):** when an admin removes a member from a room, the removed user's co-membership edge disappears from `room_members` — the NEXT time either user's presence transitions, `getInterestSet` returns the new (smaller) set. **No explicit edge-invalidation is needed** on the remove path. Same principle applies to room deletion and friendship removal: stale interest edges self-heal on the next transition. Document this so the Round 11 planner doesn't over-engineer a "recompute and re-broadcast everyone's aggregate" step.
- **Round 12 (unread):** no presence coupling.
- **Presence state is in-memory and process-local.** If Round 10 (scaling) ever introduces a second backend replica, `presence.service` will need replacement — either a Redis-backed registry or sticky routing per user. Shout-out for the infra planner.
- **`socket.data.user` is set by the JWT middleware before the connection handler runs.** Round 7 relies on `socket.data.user.id` being populated synchronously; if a future round changes that wiring, the `handleConnect(socket.id, userId)` call site will need review.

## Config improvements

- **Grace-period debounce (5 s) on last-socket disconnect.** Would dampen the `online → offline → online` flicker when a user reloads a tab. Requires a per-userId `setTimeout` + cancel on reconnect. Low complexity, high UX payoff.
- **Per-socket rate-limit on `presence:active`/`presence:idle`.** Token bucket with capacity 10, refill 1/sec would defend against a compromised client spamming transitions. Currently trusted because the client only emits on real transitions (≤2/min).
- **Drizzle-native `.union()` for `getInterestSet`.** The raw SQL works, but a typed `db.select(…).union(db.select(…))` would let the TS compiler validate the column names. Cost is ~15 lines of extra ceremony. Low priority; the query is stable and small.
- **`getInterestSet` is called on every single aggregate-state transition.** For a user with N friends and M rooms this is a small query, but a high-tab-count "chatty" user could exercise it more than strictly necessary. A per-user in-memory cache (TTL 30–60 s, invalidated on `friend:*`, `room:*`, `dm:*` events) would reduce DB pressure. Flag for a post-hackathon scaling pass.
- **Presence metrics endpoint (`GET /api/presence/metrics`).** Useful for an admin dashboard (counts of online/afk/offline, avg sockets/user). Out of scope; flagged.
