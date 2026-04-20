# Round 3 Orchestrator — Summary

## Built

### `/shared/types/message.ts` (new)
- `Message` — `{ id, roomId, userId, username, body, createdAt }`
- `SendMessagePayload` — `{ roomId, body }` (socket emit payload)
- `MessageSendAck` — discriminated union `{ ok: true, message } | { ok: false, error }`

### `/shared/types/index.ts` (updated)
- Added `export * from './message';` after the existing room export.

### `/shared/api-contract.md` (updated)
- Appended `GET /api/rooms/:id/messages` to the Rooms Endpoints summary table.
- Added a per-endpoint block for `GET /api/rooms/:id/messages` — 403 `"Not a room member"` / 404 `"Room not found"`, ascending order, hardcoded up-to-50 limit, pagination explicitly deferred to Round 5.
- Added a brand-new top-level `## Socket Events` section covering:
  - Transport (Socket.io v4, path `/socket.io/`, CORS, dev vs prod URL)
  - Handshake (`auth.token`, `verifyAccessToken()` shared with `requireAuth`, `socket.data.user`)
  - Auto-subscription model on connect — `user:<userId>` + `room:<roomId>` per membership; **no client-side `room:join` / `room:leave`** events in Round 3
  - REST handlers keep subscriptions synced via `socketsJoin` / `socketsLeave` on create/join/leave
  - `message:send` contract with mandatory ack, exact error strings (`"Body must be between 1 and 3072 characters"`, `"Not a room member"`, `"Room not found"`, `"Invalid payload"`)
  - `message:new` broadcast shape, sender-excluded via `socket.to(...)`
  - Token-refresh note: socket keeps handshake token until disconnect (known limitation)

## Deviations
None from the planning task file. Two minor wording choices made in the contract:
- Added `"Invalid payload"` as a fourth ack-error string to cover malformed input (was implicit in the backend plan's "zod guard on the socket payload" — now explicit in the contract so both sides can assert on it).
- Token-refresh limitation promoted from a wrap-up note to a labelled subsection in `## Socket Events` — cheap to document, expensive to miss.

## Deferred
- `editedAt`, `deletedAt`, `replyToId` on `Message` — Round 10 (Message Actions).
- `attachments` on `Message` — Round 9 (Attachments).
- `typing:start` / `typing:stop` events — not on the master plan, left to a future polish pass.
- Cursor-paginated history (`?before=`) — Round 5 (Message History + Pagination).
- `invitation:new` + `room:updated` events — Round 4 (Invitations + Room Settings); the Round 3 server-pushed subscription pattern is the blueprint.
- Mid-session socket re-authentication on HTTP token refresh — left as a documented limitation. Harmless until server starts enforcing mid-session token validity.
- Account-deletion semantics on messages — Round 3 uses `ON DELETE CASCADE` on `messages.user_id`. Violates a loose reading of requirement §2.1.5 ("membership in other rooms is removed" suggests messages in those rooms should persist). Revisit when the account-deletion round lands — either `ON DELETE SET NULL` + nullable `user_id` or a denormalised `username` column so attribution survives.

## Next round needs to know

### For Round 4 (Invitations + Room Settings)
- **Follow the same server-pushed subscription pattern** established here — the REST handler that creates/accepts/revokes an invitation should emit directly via `getIo().in('user:<userId>').emit('invitation:new', payload)`, not wait for a client-initiated subscribe.
- When an invitation is **accepted**, the accepter also needs to be `socketsJoin`-ed to `room:<id>` inside the same REST handler — do this immediately after inserting the `room_members` row so the new member receives `message:new` events without a reconnect.
- `room:updated` events should go to `room:<id>` (not `user:<userId>`) — all members of an edited room need to see rename / visibility / description changes.
- `room:updated` payload probably mirrors `Room` (the sidebar shape) plus any member-level fields the rail needs. Decide whether to send full `RoomDetail` (simple, slightly heavier) or a delta; consistent shape beats minimal bytes at this scale.

### For every subsequent round
- Any new Client → Server event should use an ack callback and a `{ ok, … }` discriminated union. Error strings live in the contract verbatim.
- Any new Server → Client event should target a server-side socket.io room (`user:<id>` or `room:<id>`), not individual socket ids. This keeps multi-tab behaviour uniform and keeps the FE free of socket lifecycle bookkeeping.

## Config improvements

- **Socket-layer convention section worth adding to `.claude/agents/backend-developer.md`**: "When adding a socket event, update `/shared/api-contract.md` §Socket Events first; ack on writes; broadcasts via `room:<id>` / `user:<id>` keys; exact error strings."
- **Frontend counterpart for `.claude/agents/frontend-developer.md`**: "Server → Client events arrive on every tab for every room the user belongs to — filter by `roomId` on consumption; don't rely on client-side subscription bookkeeping."
- **Renumber-sweep outstanding**: the Rooms Endpoints "Rules" block in `/shared/api-contract.md` still references "Round 2a" and "Round 5b". Not a correctness issue, just a stale pointer after the flat-numbering sweep. Worth a one-line fix next time we touch the file.
- **`backend/src/types/shared.ts` mirroring**: third round carrying types by hand. Round 2 already flagged this; adding a fourth carry for Round 3 and continuing to punt. Separately plan a cleanup round or accept a tsconfig path-alias change as a one-shot fix.
