# Round 5 Orchestrator — Summary

## Built

### `/shared/types/friend.ts` (new)
Exports:
- `Friend` — `{ userId, username, friendshipCreatedAt }` (the OTHER user from the caller's POV — caller never appears in their own friends list).
- `FriendRequest` — `{ id, fromUserId, fromUsername, toUserId, toUsername, message: string | null, createdAt }` (both usernames denormalised).
- `CreateFriendRequestBody` — `{ toUsername, message?: string }`.
- `FriendRequestCancelledPayload` — `{ requestId }`.
- `FriendRequestAcceptedPayload` — `{ requestId, friend: Friend }` (per Q5 — separate payloads to each side, each carrying the OTHER user).
- `FriendRequestRejectedPayload` — `{ requestId }`.
- `FriendRemovedPayload` — `{ userId }` (id of the user who initiated the removal).
- `UserSearchRelationship` — `'self' | 'friend' | 'outgoing_pending' | 'incoming_pending' | 'none'`.
- `UserSearchResult` — `{ id, username, relationship }` (server-computed relationship; `'self'` defined for completeness but server always excludes the caller).

### `/shared/types/index.ts` (updated)
Added `export * from './friend';` after the existing `invitation` export.

### `/shared/api-contract.md` (updated)

**New top-level `## User Search Endpoint` section** (placed between `## Invitation Endpoints` and `## Friend Endpoints`):
- Auth preamble.
- Summary table with `GET /api/users/search?q=<prefix>`.
- Per-endpoint block documenting: case-insensitive `ILIKE q || '%'` semantics, self-exclusion, deterministic ordering (exact match first then alphabetical), 20-row cap, and the server-side `relationship` computation (joins against `friendships` + `friend_requests`).
- Error strings: `"Search query must be at least 2 characters"`.

**New top-level `## Friend Endpoints` section** (placed between `## User Search Endpoint` and `## Socket Events`):
- Auth preamble, Rules block (symmetric friendship storage is an implementation detail the client never sees; unordered-pair uniqueness for pending requests; atomic accept; ban semantics deferred to Round 6).
- Summary table with all 8 endpoints (1 friends list, 1 remove-friend, 6 friend-request endpoints including the split incoming/outgoing GETs).
- Per-endpoint blocks with exact error strings preserved verbatim:
  - `"You cannot send a friend request to yourself"`
  - `"You are already friends with this user"`
  - `"A pending friend request already exists between you and this user"`
  - `"Friend request not found"`
  - `"Not a friend"`
  - `"User not found"` (reused from Round 4)
  - `"Forbidden"` (reused on 403s)
- Explicit Q5 spelled out on the accept endpoint: two emissions, each side receives the OPPOSITE user in `friend`.

**Extended `## Socket Events` — five new Server → Client event blocks**:
- `friend:request:new` → `user:<toUserId>`, payload = full `FriendRequest`.
- `friend:request:cancelled` → `user:<toUserId>`, payload = `{ requestId }`.
- `friend:request:accepted` → fired **twice** (once per side) with the OPPOSITE user in `friend`; payload = `{ requestId, friend }`.
- `friend:request:rejected` → `user:<fromUserId>`, payload = `{ requestId }` (unlike invitations, reject IS notified to the sender — Q4).
- `friend:removed` → `user:<otherUserId>`, payload = `{ userId }`.

No new `On connect` subscription state — all five events target `user:<id>`, which is already joined on connect from Round 3.

### Contract housekeeping sweep
Patched two stale round references (flagged by the Round 4 orchestrator summary as outstanding):
- `### POST /api/rooms/:id/leave` — "room deletion is Round 5a" → "Round 11" (Round 11 owns moderation + deletion per `master-plan.md`).
- `### GET /api/rooms/:id/messages` — "Round 5 introduces `?before=<messageId>&limit=`" → "Round 9 introduces ..." (pagination moved to Round 9 in the reordered plan).

All other `Round N` references in the file are historical (documenting what shipped in which round, e.g. "in Round 3 ...") and were left intact.

## Deviations
None from the planning task file.

## Deferred

- **Friend requests initiated from a room's member list** (requirement §2.3.2 second bullet). The endpoint surface is username-neutral so a later round can add a "Send friend request" button in the rail member rows with zero contract change.
- **User-to-user ban** (requirement §2.3.5). Deferred to Round 6 (DMs) because the ban predicate only matters for personal messaging — blocking a user in Round 5 would have no observable effect since rooms are the only messaging surface. Round 6 will add a `user_bans` table + the corresponding endpoints and gate `POST /api/dm` + DM `message:send` on it.
- **Friend-request expiry**. Not in requirements; pending requests live until explicitly actioned.
- **Outgoing-request badge count**. Only the incoming-request count is surfaced as a top-nav badge (mirror of invitations). Outgoing requests are visible inside the sidebar / dialogs.
- **`GET /api/friend-requests` combined endpoint**. Split into `/incoming` and `/outgoing` up-front because the FE `fetchInitial` concurrently loads both with `forkJoin` — a single endpoint returning both lists would have forced client-side partitioning for no benefit.
- **Friendship-ordering canonical row**. Q1 locked the two-row symmetric design. No canonical `(low, high)` row to revisit.
- **`friend:removed` fired on account deletion**. Account deletion is not implemented yet (requirement §2.1.5 is a future round). When it lands, the same event channel should be reused so the removed user's friends see the deletion live.

## Next round needs to know

### For Round 6 (Direct Messages)

- **Friendship is the DM gate.** Round 6's `POST /api/dm` should check `SELECT 1 FROM friendships WHERE user_id = $caller AND friend_user_id = $other` before upserting the DM room. The symmetric storage means a single lookup is sufficient — no `LEAST/GREATEST` dance. 404 or 403 on failure is an orchestrator decision for Round 6 (lean 403 `"You must be friends to send a direct message"`).

- **User-to-user ban is the second DM gate.** Round 6 needs to add a `user_bans` table keyed by `(blocker_user_id, blocked_user_id)` with `ON DELETE CASCADE` on both user FKs. `POST /api/dm` and any subsequent DM `message:send` must check for a row in either direction. On ban, the existing DM history is frozen but preserved (requirement §2.3.5). The ban also terminates friendship — Round 6 will delete the two `friendships` rows atomically when `POST /api/user-bans` fires.

- **`Friend.userId` is the DM-target identifier.** A friend row carries exactly the data a "Start DM" button needs: the friend's userId + username. No extra lookup.

### For Round 7 (Presence)

- **Friends are the primary presence consumer.** The `listFriends` query is the canonical input for deciding who to snapshot in `presence:snapshot`. Room-members rail and (eventually) DM participants are the other two consumers — Round 7 can aggregate all three on the server or just have the client dedupe userIds across its three lists.

- **Friend add / remove events imply presence list changes.** `friend:request:accepted` adds a user to the friends list (new presence subscription); `friend:removed` drops a user (no longer relevant). Round 7's presence service should piggyback on the existing `FriendsService` signals rather than re-subscribing independently.

### For Round 11 (Moderation)

- No interaction. Friends and rooms are orthogonal surfaces — no shared state, no shared socket channels.

### For general socket consumers

- Three FE services now subscribe to user-scoped events (`InvitationsService` → `invitation:*`; `FriendsService` → `friend:*`; ChatContextService / RoomsService → `room:updated`). The pattern is established. If a fourth consumer materialises and starts feeling like duplication, that's the signal to lift a typed event bus on top of `SocketService` — but three separate consumers remain cheaper than a generic abstraction.

## Config improvements

- **Stale round references in the contract.** Round 4 orchestrator flagged this; this round swept two more. The sweep is still not exhaustive — any future addition should pass a quick grep for `Round [0-9]+[a-z]?\b` as a hygiene step.
- **`backend/src/types/shared.ts` mirroring.** Fifth round carrying hand-copied types. Rounds 2, 3, and 4 all flagged this. Time to bite the bullet: relax `rootDir` in `backend/tsconfig.json` and have BE import from `/shared/types/` directly, or add a pre-build copy script.
- **Typed `emit` wrapper over `getIo().in('user:<id>').emit(event, payload)`.** Rounds 3, 4, 5 now all use the same pattern. A tiny `emitToUser(userId, event, payload)` + `emitToRoom(roomId, event, payload)` helper in `backend/src/socket/io.ts` would centralise the event-name strings (so they stay in sync with the contract) and prevent typo regressions in future rounds.
- **Agent-config socket convention.** Round 3 and Round 4 summaries both asked for a short paragraph in `.claude/agents/backend-developer.md` and `.claude/agents/frontend-developer.md` about socket conventions (ack on writes, broadcast via `room:<id>` / `user:<id>`, subscribe-in-services-not-components). Still unaddressed; this round reinforces the need — five new events all follow the unwritten convention.
- **Master plan line for Round 5.** The current master plan bullet describes the deliverable and the endpoints at a high level; consistent with prior rounds and doesn't need changes. If Round 6's DM plan introduces the ban surface, that bullet will need a small edit.
