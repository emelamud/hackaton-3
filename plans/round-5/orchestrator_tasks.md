# Round 5 — Orchestrator Tasks

## Goal
Define `Friend`, `FriendRequest`, and user-search types; add the friends + friend-requests HTTP endpoints and a `/api/users/search` endpoint to `/shared/api-contract.md`; specify the socket event surface (`friend:request:new`, `friend:request:cancelled`, `friend:request:accepted`, `friend:request:rejected`, `friend:removed`) so FE and BE can build the Friends feature.

## Scope
Round 5 from `plans/master-plan.md` — friend requests + friends list + user search. Out of scope:
- User-to-user ban (requirement §2.3.5) — belongs with DMs (Round 6) since the ban predicate only matters for personal messaging. We'll note ban-adjacency in the rules block but not implement it.
- DMs (Round 6) — friendship is a prerequisite but `open DM` is Round 6.
- Friend requests from "a user list in a chat room" (requirement §2.3.2 second bullet) — deferred; Round 5 only ships the by-username flow. The endpoint is username-neutral so the room-member UI shortcut is a zero-contract-change follow-up.

## Design decisions (locked during planning)

- **Q1 — friendship storage shape: `1b`**, two symmetric rows in a single `friendships` table (`user_id`, `friend_user_id`, `created_at`), inserted/deleted as a pair inside a transaction. Reason: `GET /api/friends` becomes a one-index query; avoids `LEAST`/`GREATEST` ordering noise everywhere. BE owns the "insert pair atomically" invariant.

- **Q2 — duplicate-request guard: `2b`**, a pending friend request is unique per **unordered pair** (either direction). If A→B is pending and B tries to send B→A, server returns `409 { error: "A pending friend request already exists between you and this user" }`. Implemented as a `uniqueIndex` on `(LEAST(from_user_id, to_user_id), GREATEST(from_user_id, to_user_id))` or, equivalently, the BE does the lookup itself. Avoids the "two pending in opposite directions" trap.

- **Q3 — self-request: `3a`**, sending to yourself returns `400 { error: "You cannot send a friend request to yourself" }`. No UI filtering is required; the server enforces.

- **Q4 — rejection notification: `4a`**, rejecting a friend request emits `friend:request:rejected` to the **sender** so their outgoing-pending list clears live. This differs from the Round 4 invitation-reject decision (silent to inviter) because friend requests are a two-way negotiation where the sender has an ongoing UI affordance (cancel button + outgoing count), while invitations don't expose sent-state in the UI yet.

- **Q5 — accept broadcast: `5a`**, `friend:request:accepted` is emitted **separately to each side** with the correct `friend` payload (the other user, from that recipient's POV). Simpler FE wiring — each side just prepends the received `friend` into its own friends signal.

- **Q6 — unfriend notification: `6a`**, `DELETE /api/friends/:userId` emits `friend:removed` to the other side with `{ userId: <remover's id> }` so the removed user's friends list and sidebar update live. Symmetric intent; requirement §2.3.4 says "may remove another user" and doesn't specify silent removal.

- **Q7 — user-search surface: `7a`**, `GET /api/users/search?q=<prefix>` returns a richer `UserSearchResult[]` with a `relationship` field so the FE can render the correct action button (Add Friend / Friends / Pending / Accept) without a second lookup. Prefix match is case-insensitive, `min 2` chars, capped at 20 results, self excluded.

## Dependencies
- `plans/master-plan.md` §Round 5 bullets
- `requirements.txt` §2.3 (Contacts / Friends)
- `shared/api-contract.md` — current state (auth, rooms, invitations, messages, socket events)
- `shared/types/` — existing exports (`user.ts`, `auth.ts`, `room.ts`, `message.ts`, `invitation.ts`)
- `plans/round-4/orchestrator_work_summary.md` §Next round needs to know — `invitation:new` + `invitation:revoked` are the template pattern for this round's user-scoped socket events
- `plans/round-4/frontend_work_summary.md` §Next round needs to know — `InvitationsService` pattern (root-scoped, badge-in-top-nav, socket event → signal mutation) generalises directly to friend requests; Bug 1 (pre-connect subscription) was fixed, so a root-scoped `FriendsService` subscribing in its constructor is now safe

## Tasks

### 1. Create `/shared/types/friend.ts`
Export:

```ts
export interface Friend {
  userId: string;              // the OTHER user's id (not the caller's)
  username: string;
  friendshipCreatedAt: string;
}

export interface FriendRequest {
  id: string;
  fromUserId: string;
  fromUsername: string;        // denormalised
  toUserId: string;
  toUsername: string;          // denormalised
  message: string | null;
  createdAt: string;
}

export interface CreateFriendRequestBody {
  toUsername: string;
  message?: string;            // optional text, trimmed, max 500 chars
}

export interface FriendRequestCancelledPayload {
  requestId: string;
}

export interface FriendRequestAcceptedPayload {
  requestId: string;
  friend: Friend;              // the OTHER party from the recipient's POV — see Q5
}

export interface FriendRequestRejectedPayload {
  requestId: string;
}

export interface FriendRemovedPayload {
  userId: string;              // id of the user who removed the friendship
}

export type UserSearchRelationship =
  | 'self'
  | 'friend'
  | 'outgoing_pending'
  | 'incoming_pending'
  | 'none';

export interface UserSearchResult {
  id: string;
  username: string;
  relationship: UserSearchRelationship;
}
```

Notes:
- `Friend.userId` is deliberately "the OTHER user" — callers never need to see their own id in their own friends list. Saves a FE filter step.
- `FriendRequest` denormalises both usernames so the incoming-requests dropdown and outgoing-pending list each render without a second fetch.
- `UserSearchResult.relationship` is orchestrator-locked: the BE computes it once; FE never recomputes.

### 2. Update `/shared/types/index.ts`
Append `export * from './friend';` after the existing `invitation` export.

### 3. Extend `/shared/api-contract.md`

#### 3a. Add a new top-level `## User Search Endpoint` section (after `## Invitation Endpoints`, before `## Socket Events`)

**Auth**: requires `Authorization: Bearer <accessToken>`. `401` on missing / invalid token.

**Summary**:

| Method | Path | Query | Success | Errors |
|--------|------|-------|---------|--------|
| GET | `/api/users/search` | `?q=<prefix>` | `200 UserSearchResult[]` (up to 20, self excluded, case-insensitive prefix match, `relationship` pre-computed) | `400` `q` shorter than 2 chars |

Per-endpoint block:
- **Query**: `q` required, trimmed, min 2, max 64 characters. Comparison is case-insensitive prefix (`username ILIKE q || '%'`).
- **Self**: the caller is always excluded from results.
- **Ordering**: exact case-insensitive match first (if any), then alphabetical by username. Deterministic so the FE can rely on stable ordering.
- **Relationship computation** (BE-side, one query wide):
  - `self` — never emitted; caller is excluded.
  - `friend` — a row in `friendships` exists in either direction.
  - `outgoing_pending` — a row in `friend_requests` with `from_user_id = caller` and `to_user_id = result`.
  - `incoming_pending` — a row in `friend_requests` with `from_user_id = result` and `to_user_id = caller`.
  - `none` — otherwise.
- **Errors**: `400 { "error": "Search query must be at least 2 characters" }`.

#### 3b. Add a new top-level `## Friend Endpoints` section (after `## User Search Endpoint`, before `## Socket Events`)

All friend endpoints require `Authorization: Bearer <accessToken>`.

**Rules**:
- Friendships are symmetric. `GET /api/friends` returns the caller's friends from the caller's POV (`Friend.userId` is the other user).
- Removing a friend is unilateral — no confirmation — and emits `friend:removed` to the other side.
- A friend request is unique per **unordered pair** of users (Q2). Creating a second request while any pending request exists between the two users returns `409`, regardless of direction.
- Sending a friend request to an existing friend returns `409 { error: "You are already friends with this user" }`.
- Sending to self returns `400 { error: "You cannot send a friend request to yourself" }`.
- Only the recipient may `accept` or `reject`; only the sender may `cancel` (DELETE) a pending request.
- Accept is atomic: inside a single transaction, the request row is deleted and two symmetric `friendships` rows are inserted. Re-posting accept on a stale request → `404 "Friend request not found"`.
- Round 5 does NOT implement user-to-user ban (requirement §2.3.5). Ban semantics land with DMs (Round 6) because they only gate personal messaging.

**Summary** (friendships + friend-requests):

| Method | Path | Body | Success | Errors |
|--------|------|------|---------|--------|
| GET | `/api/friends` | — | `200 Friend[]` (caller's friends, newest first) | — |
| DELETE | `/api/friends/:userId` | — | `204` + `friend:removed` emitted to the other side | `404` not a friend |
| POST | `/api/friend-requests` | `CreateFriendRequestBody` | `201 FriendRequest` + `friend:request:new` emitted to recipient | `400` self-target / validation, `404` username not found, `409` already friends / pending exists |
| GET | `/api/friend-requests/incoming` | — | `200 FriendRequest[]` (where caller is `toUserId`, newest first) | — |
| GET | `/api/friend-requests/outgoing` | — | `200 FriendRequest[]` (where caller is `fromUserId`, newest first) | — |
| POST | `/api/friend-requests/:id/accept` | — | `200 Friend` + `friend:request:accepted` emitted to BOTH sides (each side receives the opposite `friend` payload) | `403` not the recipient, `404` not found |
| POST | `/api/friend-requests/:id/reject` | — | `204` + `friend:request:rejected` emitted to sender | `403` not the recipient, `404` not found |
| DELETE | `/api/friend-requests/:id` | — | `204` + `friend:request:cancelled` emitted to recipient | `403` not the sender, `404` not found |

Per-endpoint detail blocks — preserve these error strings verbatim:
- `"You cannot send a friend request to yourself"`
- `"You are already friends with this user"`
- `"A pending friend request already exists between you and this user"`
- `"User not found"` (reuse the Round 4 string — same meaning: target username doesn't resolve)
- `"Friend request not found"` (404 on accept / reject / cancel)
- `"Not a friend"` (404 on `DELETE /api/friends/:userId` when no friendship row exists)
- `"Forbidden"` — reused on 403 (accept/reject by non-recipient, cancel by non-sender)
- `"Search query must be at least 2 characters"`

`POST /api/friend-requests` body validation:
- `toUsername` required, trimmed, 1–64 chars.
- `message` optional, trimmed, max 500 chars. Empty string after trim → stored as `null`.

`POST /api/friend-requests/:id/accept` success body is the `Friend` from the caller's POV (i.e. the OTHER user — the original sender). The corresponding emission to the sender's `user:<senderId>` room carries `FriendRequestAcceptedPayload` with `friend` = the **recipient** (again: from the sender's POV, the "friend" is the other party).

#### 3c. Extend the `## Socket Events` section

Append **Server → Client** event blocks for five new events. Payloads match the `/shared/types/friend.ts` exports above.

`friend:request:new`
- Payload: `FriendRequest` (fully denormalised — both usernames + optional message).
- Fired to `user:<toUserId>` after `POST /api/friend-requests` succeeds.
- The recipient's tabs render a notification. Sender does NOT receive a self-broadcast (they already have the 201 response).

`friend:request:cancelled`
- Payload: `FriendRequestCancelledPayload` (`{ requestId }`).
- Fired to `user:<toUserId>` after `DELETE /api/friend-requests/:id` succeeds. Recipient's pending-request row disappears live.
- NOT fired to sender — they already own the action.

`friend:request:accepted`
- Payload: `FriendRequestAcceptedPayload` (`{ requestId, friend }`).
- Fired **separately** to both sides:
  - To `user:<senderId>`: `friend.userId` = the recipient.
  - To `user:<recipientId>`: `friend.userId` = the sender.
- Each side prepends `payload.friend` to their local friends signal and removes the `requestId` from whichever pending list held it.

`friend:request:rejected`
- Payload: `FriendRequestRejectedPayload` (`{ requestId }`).
- Fired to `user:<senderId>` (the sender) after `POST /api/friend-requests/:id/reject`. Recipient already knows; not broadcast back to them.
- Sender's outgoing-pending list clears live.

`friend:removed`
- Payload: `FriendRemovedPayload` (`{ userId }` — the id of the user who initiated the removal).
- Fired to `user:<otherUserId>` after `DELETE /api/friends/:userId` succeeds. Recipient's friends list entry disappears live.

No new client → server events. No changes to `On connect` subscription state — friend events all go to `user:<id>`, which is already joined on connect.

### 4. Contract housekeeping (opportunistic)
While editing `/shared/api-contract.md`, sweep these if they're quick:
- Round 4 orchestrator summary flagged that the Round 2 "Round 2a / Round 5b" cleanup may not have been exhaustive. Grep for any lingering `Round 2a`, `Round 5a`, `Round 5b` strings and normalise to the current round-numbering. Do NOT rewrite sentences beyond the numbering swap.
- The Rooms Endpoints section references Round 5 for the paginated `?before=` extension (`GET /api/rooms/:id/messages`). Round 5 as reordered no longer owns pagination — pagination is Round 9. Update the inline reference: "Round 9 introduces `?before=<messageId>&limit=` and keeps the same response shape."

### 5. No agent description changes
`.claude/agents/backend-developer.md` and `.claude/agents/frontend-developer.md` already cover Socket.io + HTTP patterns. Nothing to update.

### 6. No master plan update
Round 5 stays as the master plan describes it. If scope-cuts emerge during BE/FE implementation (e.g. postponing `friend:removed` broadcast to Round 11), the deciding agent will flag and the orchestrator will re-sync in the `_work_summary`.

## Wrap-up
Write `plans/round-5/orchestrator_work_summary.md` with:
- **Built** — files touched under `/shared/`, final event + endpoint list, the sweep of stale round references
- **Deviations** — any shape changes BE or FE pushed back during implementation
- **Deferred** — friend requests from the chat-room user list (requirement §2.3.2 second bullet, deferred to a later polish pass); user-to-user ban (Round 6 with DMs); friend-request expiry (not in requirements); listing outgoing-request count as a badge (only incoming are badged in this round)
- **Next round needs to know** — for Round 6 (DMs): the `friendships` row is the gate for `POST /api/dm` upsert; user-to-user ban adds a second gate in Round 6. For Round 7 (presence): the friends list is the primary consumer of presence events, so the presence snapshot can key off the caller's friends query. For Round 11 (moderation): no interaction — friends and rooms are orthogonal surfaces.
- **Config improvements** — any socket-layer / contract conventions worth folding back after seeing how Round 5 plays out (e.g. should we promote `user:<id>` broadcast helpers into a typed emit wrapper now that invitations + friends both use them?)
