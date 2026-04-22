# API Contract

Source of truth for all REST endpoints. Both FE and BE must conform to this document.
If a change is needed, report it to the orchestrator — do not modify this file yourself.

## Base URL
All endpoints are prefixed with `/api`.

## Authentication
Authenticated endpoints require `Authorization: Bearer <accessToken>` header.
Refresh token is stored in an httpOnly cookie named `refreshToken`.

## Auth Endpoints

### POST `/api/auth/register`
Register a new user.

**Request body** (`RegisterRequest`):
```json
{ "email": "user@example.com", "username": "alice", "password": "secret123" }
```

**Success** `201`:
```json
{
  "accessToken": "<jwt>",
  "user": { "id": "uuid", "email": "user@example.com", "username": "alice", "createdAt": "ISO" }
}
```
Sets httpOnly `refreshToken` cookie.

**Errors**:
- `409` — email or username already taken: `{ "error": "Email already in use" }` / `{ "error": "Username already taken" }`
- `400` — validation error: `{ "error": "...", "details": [...] }`

---

### POST `/api/auth/login`
Authenticate with email + password.

**Request body** (`LoginRequest`):
```json
{ "email": "user@example.com", "password": "secret123", "keepSignedIn": true }
```

**Success** `200`:
```json
{
  "accessToken": "<jwt>",
  "user": { "id": "uuid", "email": "user@example.com", "username": "alice", "createdAt": "ISO" }
}
```
Sets httpOnly `refreshToken` cookie. Cookie `maxAge` depends on `keepSignedIn`:
- `true` → 30 days
- `false` / omitted → session cookie (expires on browser close)

**Errors**:
- `401` — invalid credentials: `{ "error": "Invalid email or password" }`

---

### POST `/api/auth/logout`
**Auth required.** Invalidates the current session.

**Success** `204` — clears `refreshToken` cookie.

**Errors**:
- `401` — missing/invalid access token

---

### POST `/api/auth/refresh`
Exchange refresh token cookie for a new access token. Rotates the refresh token.

**Success** `200`:
```json
{ "accessToken": "<new-jwt>" }
```
Sets new `refreshToken` cookie with same expiry behaviour as original login.

**Errors**:
- `401` — missing, invalid, or expired refresh token (also clears cookie)

---

### POST `/api/auth/forgot-password`
Request a password reset link. Always returns 204 regardless of whether the email exists (no enumeration).

**Request body** (`ForgotPasswordRequest`):
```json
{ "email": "user@example.com" }
```

**Success** `204`

---

### POST `/api/auth/reset-password`
Reset password using the token from the forgot-password flow.

**Request body** (`ResetPasswordRequest`):
```json
{ "token": "<reset-jwt>", "password": "newSecret456" }
```

**Success** `204`

**Errors**:
- `400` — token invalid or expired: `{ "error": "Reset token is invalid or has expired" }`

---

### GET `/api/auth/sessions`
**Auth required.** List all active sessions for the current user.

**Success** `200`:
```json
[
  {
    "id": "uuid",
    "userId": "uuid",
    "userAgent": "Mozilla/5.0 ...",
    "ipAddress": "192.168.1.1",
    "createdAt": "ISO",
    "expiresAt": "ISO",
    "isCurrent": true
  }
]
```

---

### DELETE `/api/auth/sessions/:id`
**Auth required.** Revoke a specific session.

**Success** `204`

**Errors**:
- `403` — session does not belong to the current user
- `404` — session not found

---

## Rooms Endpoints

All rooms endpoints require `Authorization: Bearer <accessToken>` and return `401 { "error": "..." }` on missing / invalid / expired access tokens.

### Rules
- Room `name` must be unique across the whole system (requirement §2.4.2). Comparison is case-insensitive; the original casing is stored and returned.
- Validation bounds: `name` 3–64 chars (trimmed), `description` 0–500 chars (trimmed, optional), `visibility` must be `"public"` or `"private"`.
- `POST /api/rooms/:id/join` on a private room returns `403` — private rooms are only reachable via invitations (see §Invitation Endpoints below).
- `PATCH /api/rooms/:id` requires `role in ('owner', 'admin')`. Admin promotion lands in a later moderation round, so in practice only owners qualify today.
- Members in `RoomDetail.members` are ordered: owner first, then admins by `joinedAt` ascending, then regular members by `joinedAt` ascending.
- Rooms carry a `type: 'channel' | 'dm'` discriminator (Round 6). All rules above describe `'channel'` behaviour unless otherwise stated. Existing rooms are `'channel'`; DMs are created via `POST /api/dm` (see §Direct Message Endpoints).
- `GET /api/rooms` returns both channels and DMs the caller is a member of, ordered by `createdAt` descending. Callers distinguish via `type`.
- `Room.name` and `Room.ownerId` are `string | null`; they are `null` for DMs and non-null for channels. `Room.dmPeer` (shape `{ userId, username }`) is present only for `type === 'dm'` and always names the OTHER participant from the caller's POV (never the caller themselves).
- DMs (`type='dm'`) cannot be mutated via `PATCH /api/rooms/:id` — returns `400 { "error": "DM rooms are not editable" }`.
- DMs cannot be joined via `POST /api/rooms/:id/join` — returns `403 { "error": "Direct messages are only reachable via /api/dm" }`. The check short-circuits before the membership lookup, so non-members also see this error.
- DMs cannot be left via `POST /api/rooms/:id/leave` — returns `403 { "error": "DM rooms cannot be left" }`. Leaving would break the 2-participant invariant; severance happens through user-to-user ban (see §User Ban Endpoints).
- Posting to `POST /api/rooms/:id/invitations` against a DM returns `400 { "error": "DMs cannot have invitations" }` (DMs have no admins and no invitation flow — requirement §2.5.1).

### Summary

| Method | Path | Body | Success | Errors |
|--------|------|------|---------|--------|
| GET | `/api/rooms` | — | `200 Room[]` (caller's memberships, newest first) | — |
| POST | `/api/rooms` | `CreateRoomRequest` | `201 RoomDetail` (creator auto-joined as `owner`) | `400` validation, `409` name taken |
| GET | `/api/rooms/:id` | — | `200 RoomDetail` | `403` not a member, `404` not found |
| POST | `/api/rooms/:id/join` | — | `200 RoomDetail` (idempotent if already member) | `403` private room, `404` not found |
| POST | `/api/rooms/:id/leave` | — | `204` | `403` owner cannot leave, `404` not a member |
| GET | `/api/rooms/:id/messages` | — | `200 Message[]` (oldest first, up to 50 most-recent) | `403` not a member, `404` not found |
| PATCH | `/api/rooms/:id` | `PatchRoomRequest` | `200 RoomDetail` + `room:updated` broadcast | `400` empty body / validation, `403` not owner/admin, `404` not found, `409` name taken |

---

### GET `/api/rooms`
List rooms the caller is a member of, ordered by `createdAt` descending.

**Success** `200`:
```json
[
  {
    "id": "uuid",
    "name": "engineering",
    "description": "Backend + frontend discussions",
    "visibility": "public",
    "ownerId": "uuid",
    "createdAt": "ISO",
    "memberCount": 12
  }
]
```

---

### POST `/api/rooms`
Create a new room. The creator is auto-joined with `role: "owner"`.

**Request body** (`CreateRoomRequest`):
```json
{ "name": "engineering", "description": "Backend + frontend discussions", "visibility": "public" }
```

**Success** `201` — returns `RoomDetail`:
```json
{
  "id": "uuid",
  "name": "engineering",
  "description": "Backend + frontend discussions",
  "visibility": "public",
  "ownerId": "uuid",
  "createdAt": "ISO",
  "memberCount": 1,
  "members": [
    { "roomId": "uuid", "userId": "uuid", "username": "alice", "role": "owner", "joinedAt": "ISO" }
  ]
}
```

**Errors**:
- `400` — validation error: `{ "error": "...", "details": [...] }`
- `409` — name taken (case-insensitive): `{ "error": "Room name already taken" }`

---

### GET `/api/rooms/:id`
Fetch full room detail including members. Caller must be a member.

**Success** `200` — `RoomDetail` (shape identical to `POST /api/rooms` success body).

**Errors**:
- `403` — caller is not a member: `{ "error": "Forbidden" }`
- `404` — room not found: `{ "error": "Room not found" }`

---

### POST `/api/rooms/:id/join`
Join a public room. Idempotent: calling when already a member returns `200` with the current detail and makes no changes.

**Success** `200` — `RoomDetail`.

**Errors**:
- `403` — room is private (no invitation flow yet): `{ "error": "Private room — invitation required" }`
- `404` — room not found: `{ "error": "Room not found" }`

---

### POST `/api/rooms/:id/leave`
Leave a room. The owner cannot leave their own room (requirement §2.4.5) — they must delete it instead (room deletion is Round 11).

**Success** `204`

**Errors**:
- `403` — caller is the owner: `{ "error": "Owner cannot leave their own room" }`
- `404` — caller is not a member of this room: `{ "error": "Room not found" }`

---

### GET `/api/rooms/:id/messages`
Return up to the 50 most-recent messages in a room, ordered by `createdAt` **ascending** (oldest first, newest last) so clients can append directly to their scrollable list. Caller must be a member.

**Success** `200` — `Message[]`:
```json
[
  {
    "id": "uuid",
    "roomId": "uuid",
    "userId": "uuid",
    "username": "alice",
    "body": "hello team",
    "createdAt": "ISO"
  }
]
```

**Errors**:
- `403` — caller is not a member: `{ "error": "Not a room member" }`
- `404` — room not found: `{ "error": "Room not found" }`

No cursor / `before` parameter in Round 3. Round 9 introduces `?before=<messageId>&limit=` and keeps the same response shape.

---

### PATCH `/api/rooms/:id`
Edit a room's `name`, `description`, and/or `visibility`. Caller must be a member with `role in ('owner', 'admin')`.

**Request body** (`PatchRoomRequest`):
```json
{ "name": "engineering-core", "description": "Updated focus", "visibility": "private" }
```

All fields optional; at least one must be present. `description: null` clears the field; omitting a key leaves it unchanged.

**Success** `200` — `RoomDetail` with the updated values. Server also emits `room:updated` to `room:<id>` carrying the same `RoomDetail` (see §Socket Events).

**Errors**:
- `400` — empty body: `{ "error": "At least one field is required" }`
- `400` — validation error on a present field: `{ "error": "...", "details": [...] }`
- `403` — caller is a non-owner/non-admin member: `{ "error": "Only room owners and admins can edit room settings" }`
- `404` — room not found or caller is not a member: `{ "error": "Room not found" }`
- `409` — another room already has the requested name (case-insensitive): `{ "error": "Room name already taken" }`

Renaming to the current name (possibly in different casing) is a no-op, not a 409.

**Visibility change semantics**: `public → private` keeps existing members; `private → public` opens the room to future catalog / joins. No auto-kick, no membership rewrite.

---

## Invitation Endpoints

All invitation endpoints require `Authorization: Bearer <accessToken>` and return `401 { "error": "..." }` on missing / invalid / expired access tokens.

### Rules
- Invitations exist only for **private** rooms (requirement §2.4.9). Creating an invitation against a public room returns `400`.
- Any current **member** of a private room may create an invitation.
- An invitation is unique per `(roomId, invitedUserId)` — creating a second one while a pending one exists returns `409`.
- Only the invitee may `accept` or `reject` an invitation.
- Only the original inviter may `revoke` (via DELETE) an invitation. (A later moderation round extends this to room admins.)
- `accept` is **idempotent** if the invitee is already a member: the invitation is deleted, no new membership row is inserted, and the response still contains the current `RoomDetail`. No `409` returned.

### Summary

| Method | Path | Body | Success | Errors |
|--------|------|------|---------|--------|
| POST | `/api/rooms/:id/invitations` | `CreateInvitationRequest` | `201 Invitation` + `invitation:new` emitted to invitee | `400` public room / validation, `403` caller not a room member, `404` room or user not found, `409` duplicate pending or already member |
| GET | `/api/invitations` | — | `200 Invitation[]` (caller's pending invitations, newest first) | — |
| POST | `/api/invitations/:id/accept` | — | `200 RoomDetail` + `room:updated` broadcast + caller's sockets joined to `room:<id>` | `403` not the invitee, `404` invitation not found |
| POST | `/api/invitations/:id/reject` | — | `204` | `403` not the invitee, `404` invitation not found |
| DELETE | `/api/invitations/:id` | — | `204` + `invitation:revoked` emitted to invitee | `403` not the inviter, `404` invitation not found |

---

### POST `/api/rooms/:id/invitations`
Create an invitation to a private room.

**Request body** (`CreateInvitationRequest`):
```json
{ "username": "bob" }
```

**Success** `201` — `Invitation`:
```json
{
  "id": "uuid",
  "roomId": "uuid",
  "roomName": "engineering-core",
  "invitedUserId": "uuid",
  "invitedByUserId": "uuid",
  "invitedByUsername": "alice",
  "createdAt": "ISO"
}
```

Server also emits `invitation:new` with the same payload to `user:<invitedUserId>`.

**Errors**:
- `400` — target room is public: `{ "error": "Invitations are only for private rooms" }`
- `400` — validation error: `{ "error": "...", "details": [...] }`
- `403` — caller is not a member of the room: `{ "error": "Forbidden" }`
- `404` — room not found: `{ "error": "Room not found" }`
- `404` — target username does not exist: `{ "error": "User not found" }`
- `409` — invitee is already a member: `{ "error": "User is already a member of this room" }`
- `409` — a pending invitation already exists for this invitee in this room: `{ "error": "An invitation is already pending for this user" }`

---

### GET `/api/invitations`
List the caller's pending invitations (where caller is the invitee), ordered by `createdAt` descending.

**Success** `200` — `Invitation[]` (same shape as POST response body, in array form).

---

### POST `/api/invitations/:id/accept`
Accept an invitation. Creates the `room_members` row, deletes the invitation, subscribes the caller's sockets to `room:<id>`, and broadcasts `room:updated` (with the fresh `RoomDetail`) to `room:<id>`.

**Success** `200` — `RoomDetail` (shape identical to `GET /api/rooms/:id`).

**Errors**:
- `403` — caller is not the invitee: `{ "error": "Forbidden" }`
- `404` — invitation not found: `{ "error": "Invitation not found" }`

Idempotent against a caller who somehow became a member by another path before accepting: the invitation is deleted, no new `room_members` row is inserted, and the response still carries `RoomDetail`.

---

### POST `/api/invitations/:id/reject`
Reject an invitation. Deletes the row silently — the inviter is **not** notified in Round 4.

**Success** `204`.

**Errors**:
- `403` — caller is not the invitee: `{ "error": "Forbidden" }`
- `404` — invitation not found: `{ "error": "Invitation not found" }`

---

### DELETE `/api/invitations/:id`
Revoke an invitation. Deletes the row and emits `invitation:revoked` to `user:<invitedUserId>` so the invitee's UI drops the notification. Only the original inviter may revoke in Round 4.

**Success** `204`.

**Errors**:
- `403` — caller is not the inviter: `{ "error": "Forbidden" }`
- `404` — invitation not found: `{ "error": "Invitation not found" }`

---

## User Search Endpoint

Requires `Authorization: Bearer <accessToken>` and returns `401 { "error": "..." }` on missing / invalid / expired access tokens.

### Summary

| Method | Path | Query | Success | Errors |
|--------|------|-------|---------|--------|
| GET | `/api/users/search` | `?q=<prefix>` | `200 UserSearchResult[]` (up to 20, self excluded, case-insensitive prefix match, `relationship` pre-computed) | `400` `q` shorter than 2 chars |

---

### GET `/api/users/search`
Type-ahead search for users by username prefix. The response carries the caller-relative `relationship` so the UI can render the correct action control without a second lookup.

**Query params**:
- `q` — required, trimmed, 2–64 characters. Comparison is case-insensitive prefix (`username ILIKE q || '%'`).

**Behaviour**:
- The caller is always excluded from results (their own `UserSearchResult` is never emitted; the `'self'` relationship value exists for completeness but never appears in responses).
- Ordering: exact case-insensitive match first (if any), then alphabetical by username. Deterministic so the client can rely on stable ordering for `distinctUntilChanged`-style type-ahead.
- Up to 20 results returned.

**Relationship computation** (server-side, one response):
- `friend` — a `friendships` row exists between caller and result (in either direction — rows are stored symmetrically).
- `outgoing_pending` — a `friend_requests` row with `from_user_id = caller` and `to_user_id = result`.
- `incoming_pending` — a `friend_requests` row with `from_user_id = result` and `to_user_id = caller`.
- `none` — otherwise.

**Success** `200` — `UserSearchResult[]`:
```json
[
  { "id": "uuid", "username": "alice", "relationship": "friend" },
  { "id": "uuid", "username": "alicia", "relationship": "none" }
]
```

**Errors**:
- `400` — query too short: `{ "error": "Search query must be at least 2 characters" }`
- `400` — validation error (e.g. `q` longer than 64): `{ "error": "...", "details": [...] }`

---

## Friend Endpoints

All friend endpoints require `Authorization: Bearer <accessToken>` and return `401 { "error": "..." }` on missing / invalid / expired access tokens.

### Rules
- Friendships are symmetric. `GET /api/friends` returns the caller's friends from the caller's POV (`Friend.userId` is the OTHER user; the caller never appears in their own list).
- Removing a friend is unilateral — no confirmation — and emits `friend:removed` to the other side.
- A friend request is unique per **unordered pair** of users: creating a second request while any pending request exists between the two users returns `409`, regardless of direction.
- Sending a friend request to an existing friend returns `409 { error: "You are already friends with this user" }`.
- Sending to yourself returns `400 { error: "You cannot send a friend request to yourself" }`.
- Only the recipient may `accept` or `reject`; only the sender may `cancel` (DELETE) a pending request.
- Accept is atomic: inside a single transaction, the request row is deleted and two symmetric `friendships` rows are inserted. Re-posting accept on a stale request → `404 "Friend request not found"`.
- Round 5 does **not** implement user-to-user ban (requirement §2.3.5). Ban semantics land with DMs (Round 6) because they only gate personal messaging.

### Summary

| Method | Path | Body | Success | Errors |
|--------|------|------|---------|--------|
| GET | `/api/friends` | — | `200 Friend[]` (caller's friends, newest first) | — |
| DELETE | `/api/friends/:userId` | — | `204` + `friend:removed` emitted to the other side | `404` not a friend |
| POST | `/api/friend-requests` | `CreateFriendRequestBody` | `201 FriendRequest` + `friend:request:new` emitted to recipient | `400` self-target / validation, `404` username not found, `409` already friends / pending exists |
| GET | `/api/friend-requests/incoming` | — | `200 FriendRequest[]` (where caller is `toUserId`, newest first) | — |
| GET | `/api/friend-requests/outgoing` | — | `200 FriendRequest[]` (where caller is `fromUserId`, newest first) | — |
| POST | `/api/friend-requests/:id/accept` | — | `200 Friend` (from the caller's POV — the original sender) + `friend:request:accepted` emitted to BOTH sides (each receives the opposite `friend` payload) | `403` not the recipient, `404` not found |
| POST | `/api/friend-requests/:id/reject` | — | `204` + `friend:request:rejected` emitted to sender | `403` not the recipient, `404` not found |
| DELETE | `/api/friend-requests/:id` | — | `204` + `friend:request:cancelled` emitted to recipient | `403` not the sender, `404` not found |

---

### GET `/api/friends`
List the caller's friends, ordered by `friendshipCreatedAt` descending.

**Success** `200` — `Friend[]`:
```json
[
  { "userId": "uuid", "username": "bob", "friendshipCreatedAt": "ISO" }
]
```

`userId` is the other user's id — the caller never appears in their own list.

---

### DELETE `/api/friends/:userId`
Remove a friendship unilaterally. Both symmetric rows are deleted in one transaction. Emits `friend:removed` to `user:<userId>` so the other party's UI clears the row live.

**Success** `204`.

**Errors**:
- `404` — no friendship exists with this user: `{ "error": "Not a friend" }`

---

### POST `/api/friend-requests`
Create a pending friend request by username. Emits `friend:request:new` to `user:<toUserId>`.

**Request body** (`CreateFriendRequestBody`):
```json
{ "toUsername": "bob", "message": "hey, let's connect" }
```

**Body validation**:
- `toUsername` — required, trimmed, 1–64 characters.
- `message` — optional, trimmed, max 500 characters. Empty-after-trim is stored as `null`.

**Success** `201` — `FriendRequest`:
```json
{
  "id": "uuid",
  "fromUserId": "uuid",
  "fromUsername": "alice",
  "toUserId": "uuid",
  "toUsername": "bob",
  "message": "hey, let's connect",
  "createdAt": "ISO"
}
```

Server also emits `friend:request:new` with the same payload to `user:<toUserId>`.

**Errors**:
- `400` — self-target: `{ "error": "You cannot send a friend request to yourself" }`
- `400` — validation error: `{ "error": "...", "details": [...] }`
- `404` — target username does not exist: `{ "error": "User not found" }`
- `409` — caller and target are already friends: `{ "error": "You are already friends with this user" }`
- `409` — a pending request already exists between the two users (either direction): `{ "error": "A pending friend request already exists between you and this user" }`

---

### GET `/api/friend-requests/incoming`
List the caller's pending **incoming** friend requests (where caller is `toUserId`), newest first.

**Success** `200` — `FriendRequest[]`.

---

### GET `/api/friend-requests/outgoing`
List the caller's pending **outgoing** friend requests (where caller is `fromUserId`), newest first.

**Success** `200` — `FriendRequest[]`.

---

### POST `/api/friend-requests/:id/accept`
Accept an incoming friend request. Inside a single transaction: insert two symmetric `friendships` rows and delete the request row.

**Success** `200` — `Friend` (from the caller's POV — i.e. the original sender):
```json
{ "userId": "uuid", "username": "alice", "friendshipCreatedAt": "ISO" }
```

Server also emits `friend:request:accepted` separately to both sides:
- To `user:<senderId>` with `friend.userId = recipient.id`.
- To `user:<recipientId>` with `friend.userId = sender.id`.

**Errors**:
- `403` — caller is not the recipient: `{ "error": "Forbidden" }`
- `404` — request not found (including the case where it was already accepted / cancelled): `{ "error": "Friend request not found" }`

---

### POST `/api/friend-requests/:id/reject`
Reject an incoming friend request. Deletes the row and emits `friend:request:rejected` to the sender (unlike invitation-reject, which is silent to the inviter — friend requests surface an outgoing-pending UI affordance that needs live updates).

**Success** `204`.

**Errors**:
- `403` — caller is not the recipient: `{ "error": "Forbidden" }`
- `404` — request not found: `{ "error": "Friend request not found" }`

---

### DELETE `/api/friend-requests/:id`
Cancel an outgoing friend request. Deletes the row and emits `friend:request:cancelled` to the recipient so their incoming-requests UI clears live.

**Success** `204`.

**Errors**:
- `403` — caller is not the sender: `{ "error": "Forbidden" }`
- `404` — request not found: `{ "error": "Friend request not found" }`

---

## Direct Message Endpoints

All DM endpoints require `Authorization: Bearer <accessToken>` and return `401 { "error": "..." }` on missing / invalid / expired access tokens.

### Rules
- A DM is an upsertable 1:1 `rooms` row with `type='dm'` and exactly two `room_members` entries. DMs have no owner, no admins; both members carry `role='member'`. `name`, `ownerId`, and `description` are always `null`; `visibility` is `'private'` and is not surfaced in the UI.
- DMs are unique per **unordered pair** of users. `POST /api/dm` is idempotent: a second call for the same pair returns the existing room.
- Starting a DM requires an existing friendship with the target (requirement §2.3.6 — strict friendship gate at creation). Non-friend target → `403 { "error": "You must be friends to start a direct message" }`.
- Starting a DM with a user who has banned the caller (or who the caller has banned) → `403 { "error": "Personal messaging is blocked" }`. The same string appears on `message:send` acks when a ban exists — FE can render the same frozen-composer UX.
- Self-DM is rejected: `400 { "error": "You cannot open a DM with yourself" }`.
- Once the DM exists, subsequent messaging is NOT gated on friendship — only on "no active ban in either direction" (requirement §2.3.5 freeze semantics). Friendship removal alone does not freeze the DM.

### Summary

| Method | Path | Body | Success | Errors |
|--------|------|------|---------|--------|
| POST | `/api/dm` | `OpenDmRequest` | `201 RoomDetail` (first-time create — emits `dm:created` to both participants) or `200 RoomDetail` (idempotent re-hit — no broadcast) | `400` self-target / validation, `403` not friends / banned either direction, `404` target user not found |

---

### POST `/api/dm`
Upsert a direct-message room between the caller and `toUserId`. Idempotent: if the pair already has a DM, the existing `RoomDetail` is returned with status `200` and no socket broadcast fires. First-time creation returns `201` and emits `dm:created` to both participants' `user:<id>` rooms (each side's payload has `dmPeer` populated with the OTHER participant). Both users' existing sockets are joined to `room:<dmRoomId>` before the broadcast so the first `message:new` lands correctly.

**Request body** (`OpenDmRequest`):
```json
{ "toUserId": "uuid" }
```

**Success** `201` (first-time) or `200` (existing) — `RoomDetail`:
```json
{
  "id": "uuid",
  "type": "dm",
  "name": null,
  "description": null,
  "visibility": "private",
  "ownerId": null,
  "createdAt": "ISO",
  "memberCount": 2,
  "dmPeer": { "userId": "uuid", "username": "bob" },
  "members": [
    { "roomId": "uuid", "userId": "uuid", "username": "alice", "role": "member", "joinedAt": "ISO" },
    { "roomId": "uuid", "userId": "uuid", "username": "bob", "role": "member", "joinedAt": "ISO" }
  ]
}
```

**Errors**:
- `400` — self-target: `{ "error": "You cannot open a DM with yourself" }`
- `400` — validation error: `{ "error": "...", "details": [...] }`
- `403` — not friends with target: `{ "error": "You must be friends to start a direct message" }`
- `403` — active ban in either direction: `{ "error": "Personal messaging is blocked" }`
- `404` — target user does not exist: `{ "error": "User not found" }`

---

## User Ban Endpoints

All user-ban endpoints require `Authorization: Bearer <accessToken>` and return `401 { "error": "..." }` on missing / invalid / expired access tokens.

### Rules
- A user-ban is **directional**: the `user_bans` row records `(blocker, blocked)`. Only the original blocker can remove their own ban. Banning a user who has already banned the caller is allowed and creates the mirror row; both rows must be removed (each by its own blocker) to fully clear the pair.
- Creating a ban atomically severs any friendship and cancels any pending `friend_requests` between the two users in either direction. The friend-request cleanup is silent — no `friend:request:cancelled` broadcast fires to either side (the stale outgoing-pending UI refreshes on next fetch).
- Self-ban is rejected: `400 { "error": "You cannot ban yourself" }`.
- DM send to / from a banned user is blocked in either direction regardless of which side issued the ban — see `message:send` ack under §Socket Events.
- Unban does **not** restore friendship (requirement §2.3.5: friendship termination is permanent). The previously-banned user must re-friend manually via the standard friend-request flow.

### Summary

| Method | Path | Body | Success | Errors |
|--------|------|------|---------|--------|
| GET | `/api/user-bans` | — | `200 UserBan[]` (caller's blocked list, newest first) | — |
| POST | `/api/user-bans` | `CreateUserBanRequest` | `204` + `user:ban:applied` emitted to the victim + (if the two were friends) `friend:removed` emitted to the victim | `400` self-target / validation, `404` target user not found, `409` already banned |
| DELETE | `/api/user-bans/:userId` | — | `204` + `user:ban:removed` emitted to the previously-banned user | `404` no matching ban exists |

---

### GET `/api/user-bans`
List the users the caller has banned, ordered by `createdAt` descending.

**Success** `200` — `UserBan[]`:
```json
[
  { "userId": "uuid", "username": "bob", "createdAt": "ISO" }
]
```

`userId` is the OTHER user (the blocked party); the caller is always the blocker. Mirrors the `Friend.userId` convention.

---

### POST `/api/user-bans`
Block a user. Atomically inserts the `user_bans(blocker=caller, blocked=target)` row, deletes any symmetric `friendships` rows between the two users, and cancels any pending `friend_requests` in either direction — all inside one transaction.

Emits:
- `user:ban:applied` to `user:<targetUserId>` with payload `{ userId: <callerId> }`.
- `friend:removed` to `user:<targetUserId>` with payload `{ userId: <callerId> }` — only if the two users were actually friends. This keeps Round 5's `friend:removed` wiring in charge of the friends-list UI update.

**Request body** (`CreateUserBanRequest`):
```json
{ "userId": "uuid" }
```

**Success** `204`.

**Errors**:
- `400` — self-target: `{ "error": "You cannot ban yourself" }`
- `400` — validation error: `{ "error": "...", "details": [...] }`
- `404` — target user does not exist: `{ "error": "User not found" }`
- `409` — caller has already banned this user: `{ "error": "User is already banned" }`

---

### DELETE `/api/user-bans/:userId`
Unblock a user the caller previously banned. Deletes exactly the `(blocker=caller, blocked=:userId)` row — any mirror ban owned by the other party is untouched (requires that party to unblock themselves).

Emits `user:ban:removed` to `user:<:userId>` with payload `{ userId: <callerId> }`, so the previously-banned user's composer can unfreeze live. No `friend:*` event — friendship is not restored.

**Success** `204`.

**Errors**:
- `404` — no ban row owned by the caller matches this target: `{ "error": "Not banned" }`

---

## Socket Events

Socket.io v4 channel for real-time messaging. Runs on the same HTTP server as Express.

### Transport
- Path: default `/socket.io/`.
- Dev: client connects to `http://localhost:3000`. Prod: same origin (frontend nginx proxies `/socket.io/` to backend with WebSocket upgrade headers).
- Server CORS: `origin: http://localhost:4300`, `credentials: true` (parity with the REST CORS config).

### Handshake
- Client provides `auth: { token: <accessToken> }` in `io(url, options)` — the same JWT access token used for `Authorization: Bearer` on REST calls.
- Server middleware (`io.use`) verifies the token with the same `verifyAccessToken()` helper that backs `requireAuth`. On failure: `next(new Error('Unauthorized'))` — the client surfaces this via `connect_error`.
- On success the server attaches `socket.data.user = { id, email, username }` (same `AuthPayload` shape as HTTP).

### On connect
Subscription state is **maintained server-side** — the client does not send `room:join` / `room:leave` events in Round 3. On each successful `connection`:

1. Server joins the socket to `user:<userId>` (used by REST handlers to fan out to all of a user's tabs).
2. Server joins the socket to `room:<roomId>` for every room the user is currently a member of.
3. Server emits `presence:snapshot` directly to the newly-connected socket (not the `user:<userId>` fan-out room) with the current `online | afk | offline` state for every user in the caller's interest set (friends ∪ DM peers ∪ room co-members). See §`presence:snapshot` below. Also, the newly-connected socket starts with per-socket activity `active`; if this transition changes the user's aggregate state (e.g. they were `offline` with no sockets, now `online`), the server broadcasts `presence:update` to each user in the interest set. Round 7.

REST handlers keep subscriptions in sync for the lifetime of the connection:
- After `POST /api/rooms` (create) and `POST /api/rooms/:id/join` → server calls `io.in('user:<userId>').socketsJoin('room:<roomId>')`.
- After `POST /api/rooms/:id/leave` → server calls `io.in('user:<userId>').socketsLeave('room:<roomId>')`.
- After `POST /api/invitations/:id/accept` → server calls `io.in('user:<accepterUserId>').socketsJoin('room:<roomId>')` **before** emitting the `room:updated` broadcast, so the accepter's tabs receive the same event every other member does.

Clients do **not** need to reconnect or re-subscribe when they create/join/leave rooms during a session.

### Client → Server events

#### `message:send`
- Payload (`SendMessagePayload`):
  ```json
  { "roomId": "uuid", "body": "hello team" }
  ```
- **An ack callback is required** — the server always invokes it.
- Validation:
  - `body` is a string; trimmed length must be 1–3072 characters (requirement §2.5.2 — 3 KB max).
  - `roomId` is a UUID.
  - Caller must be a member of the room.
- Ack (`MessageSendAck`):
  - Success:
    ```json
    { "ok": true, "message": { "id": "uuid", "roomId": "uuid", "userId": "uuid", "username": "alice", "body": "hello team", "createdAt": "ISO" } }
    ```
  - Failure (specific strings — must match verbatim so clients can assert on them):
    - `{ "ok": false, "error": "Body must be between 1 and 3072 characters" }`
    - `{ "ok": false, "error": "Not a room member" }`
    - `{ "ok": false, "error": "Room not found" }`
    - `{ "ok": false, "error": "Invalid payload" }` — malformed `roomId` / non-string `body` / missing fields
    - `{ "ok": false, "error": "Personal messaging is blocked" }` — target room has `type='dm'` and a `user_bans` row exists in either direction between the two participants (Round 6). Only fires for DMs; channel rooms never produce this ack.
- On success the server additionally broadcasts `message:new` (see below) to everyone in `room:<roomId>` **except the sender socket**. The sender renders its own message from the ack, so the broadcast excludes it to avoid duplicates. Other tabs of the same user receive the broadcast normally (different sockets, same user).

#### `presence:active`
- Payload: none (empty event — no arguments).
- Fired by the FE when the tab transitions from `idle` to `active` — first user interaction after an idle window, OR `document.visibilitychange → visible`.
- Server: updates the emitting socket's per-socket state to `active`; recomputes the user's aggregate `online | afk | offline`; emits `presence:update` to the user's interest set only when the aggregate actually changes.
- No ack. Validation is client-driven (transitions only — see §Presence rules).

#### `presence:idle`
- Payload: none (empty event — no arguments).
- Fired by the FE when the tab transitions from `active` to `idle` — 60,000 ms elapses without a qualifying interaction event, OR `document.visibilitychange → hidden` (immediate, no wait).
- Server: updates the emitting socket's per-socket state to `idle`; recomputes the user's aggregate; emits `presence:update` to the interest set only when the aggregate changes.
- No ack.

### Presence rules (Round 7)
- **AFK threshold**: 60,000 ms per tab without a qualifying user-interaction event (requirement §2.2.2). Enforced client-side — the server trusts transitions.
- **Qualifying interaction events** (client side, attached to `document`): `mousedown`, `mousemove`, `wheel`, `scroll`, `keydown`, `pointerdown`, `touchstart`. Plus `visibilitychange` (hidden → immediate `idle`; visible → immediate `active`).
- **Server aggregation**: a user is `online` iff at least one of their connected sockets is `active`; `afk` iff ≥1 socket is connected but all are `idle`; `offline` iff no sockets are connected.
- **Transitions only**: only aggregate-state transitions trigger a `presence:update` broadcast. A socket flipping `active → idle` while another socket of the same user is still `active` is silent on the wire.
- **Interest set**: for a user X, `presence:update` fan-out goes to X's friends ∪ X's DM peers ∪ X's room co-members (every user who shares at least one channel or DM membership with X). X themselves are NOT in their own fan-out — the FE tracks self locally via its activity tracker.
- **Latency**: updates should propagate end-to-end in ≤ 2 s (requirement §3.2). No artificial delays server-side.

### Server → Client events

#### `message:new`
- Payload: `Message` (fully denormalised, including `username`).
  ```json
  { "id": "uuid", "roomId": "uuid", "userId": "uuid", "username": "bob", "body": "hey", "createdAt": "ISO" }
  ```
- Fired to all sockets in `room:<roomId>` **except the sender socket** (`socket.to('room:<roomId>').emit(...)`). Clients are subscribed to every room they belong to, so they must filter by `roomId` when deciding which room's pane to render into.

#### `invitation:new`
- Payload: `Invitation` (fully denormalised — includes `roomName` and `invitedByUsername`).
  ```json
  { "id": "uuid", "roomId": "uuid", "roomName": "engineering-core", "invitedUserId": "uuid", "invitedByUserId": "uuid", "invitedByUsername": "alice", "createdAt": "ISO" }
  ```
- Fired to `user:<invitedUserId>` after `POST /api/rooms/:id/invitations` succeeds. The invitee's tabs render a notification. The inviter does **not** receive a self-broadcast.

#### `invitation:revoked`
- Payload: `InvitationRevokedPayload`.
  ```json
  { "invitationId": "uuid", "roomId": "uuid" }
  ```
- Fired to `user:<invitedUserId>` after `DELETE /api/invitations/:id` succeeds. The invitee's UI drops the notification.
- **Not** fired on `accept` / `reject` — those are invitee-driven, the invitee already knows.

#### `room:updated`
- Payload: full `RoomDetail` (identical shape to `GET /api/rooms/:id`).
- Fired to `room:<roomId>` after:
  - `PATCH /api/rooms/:id` (any field changed).
  - `POST /api/invitations/:id/accept` (new member in `members`, `memberCount` bumped).
- **Not** fired on `POST /api/rooms/:id/join` or `POST /api/rooms/:id/leave` in Round 4 — those events are deferred polish. Existing members reload to see count changes until a later round retrofits member-change broadcasts.

#### `friend:request:new`
- Payload: `FriendRequest` (fully denormalised — includes `fromUsername`, `toUsername`, and optional `message`).
  ```json
  { "id": "uuid", "fromUserId": "uuid", "fromUsername": "alice", "toUserId": "uuid", "toUsername": "bob", "message": "hi", "createdAt": "ISO" }
  ```
- Fired to `user:<toUserId>` after `POST /api/friend-requests` succeeds. The recipient's tabs render a notification. The sender does **not** receive a self-broadcast (they already have the 201 response body).

#### `friend:request:cancelled`
- Payload: `FriendRequestCancelledPayload`.
  ```json
  { "requestId": "uuid" }
  ```
- Fired to `user:<toUserId>` after `DELETE /api/friend-requests/:id` succeeds. The recipient's incoming-requests list drops the row live.
- **Not** fired to the sender — they already own the action.

#### `friend:request:accepted`
- Payload: `FriendRequestAcceptedPayload` — `{ requestId, friend }`.
  ```json
  { "requestId": "uuid", "friend": { "userId": "uuid", "username": "alice", "friendshipCreatedAt": "ISO" } }
  ```
- Fired **separately** to both sides of the original request:
  - To `user:<senderId>`: `friend.userId` is the recipient (from the sender's POV, their new friend is the recipient).
  - To `user:<recipientId>`: `friend.userId` is the sender (from the recipient's POV, their new friend is the sender).
- Each side prepends `payload.friend` to their local friends signal and removes the `requestId` from whichever pending list (incoming for the recipient, outgoing for the sender) held it.

#### `friend:request:rejected`
- Payload: `FriendRequestRejectedPayload`.
  ```json
  { "requestId": "uuid" }
  ```
- Fired to `user:<fromUserId>` after `POST /api/friend-requests/:id/reject`. The sender's outgoing-pending list drops the row live.
- **Not** fired back to the recipient — they just performed the action.

#### `friend:removed`
- Payload: `FriendRemovedPayload`.
  ```json
  { "userId": "uuid" }
  ```
- Fired to `user:<otherUserId>` after `DELETE /api/friends/:userId` succeeds. `payload.userId` is the id of the user who initiated the removal. The recipient drops the matching row from their local friends signal.
- Also fired by `POST /api/user-bans` to the victim when the ban severed an existing friendship (Round 6). Payload shape is unchanged; `payload.userId` is the blocker's id.

#### `dm:created`
- Payload: full `RoomDetail` with `type='dm'` and `dmPeer` populated with the OTHER participant from each recipient's POV. The server constructs two separate payloads (one per side, `dmPeer` flipped) — same per-recipient split pattern as `friend:request:accepted`.
  ```json
  {
    "id": "uuid",
    "type": "dm",
    "name": null,
    "description": null,
    "visibility": "private",
    "ownerId": null,
    "createdAt": "ISO",
    "memberCount": 2,
    "dmPeer": { "userId": "uuid", "username": "bob" },
    "members": [
      { "roomId": "uuid", "userId": "uuid", "username": "alice", "role": "member", "joinedAt": "ISO" },
      { "roomId": "uuid", "userId": "uuid", "username": "bob", "role": "member", "joinedAt": "ISO" }
    ]
  }
  ```
- Fired to both participants' `user:<id>` after `POST /api/dm` **creates** the DM. Idempotent upserts (DM already existed) do NOT re-broadcast — the HTTP caller receives the `200` body and that's it.
- Before emitting, the server joins both users' existing sockets to `room:<dmRoomId>` (via `io.in('user:<id>').socketsJoin('room:<dmRoomId>')`) so the next `message:send` lands correctly without a reconnect. Same pattern as `POST /api/invitations/:id/accept`.

#### `user:ban:applied`
- Payload: `UserBanAppliedPayload`.
  ```json
  { "userId": "uuid" }
  ```
- Fired to `user:<victimId>` after `POST /api/user-bans` succeeds. `payload.userId` is the blocker's id (from the victim's POV). The victim's UI freezes the shared DM composer and renders a lock icon on the DM sidebar row.
- **Not** fired to the blocker — they initiated the action.
- If the ban severed a friendship, a companion `friend:removed` event (same `user:<victimId>` fan-out, same `{ userId: <blockerId> }` payload) is emitted alongside it — `FriendsService` consumes `friend:removed` independently.

#### `user:ban:removed`
- Payload: `UserBanRemovedPayload`.
  ```json
  { "userId": "uuid" }
  ```
- Fired to `user:<previouslyBannedUserId>` after `DELETE /api/user-bans/:userId` succeeds. `payload.userId` is the blocker's id. The victim's UI un-freezes the composer and drops the lock icon.
- **Not** fired to the blocker — they initiated the action.
- Friendship is NOT restored; no `friend:*` event fires. The previously-banned user must re-friend manually.

#### `presence:update`
- Payload: `PresenceUpdatePayload`.
  ```json
  { "userId": "uuid", "state": "online" }
  ```
- `state` is one of `"online" | "afk" | "offline"`.
- Fired to `user:<interestedUserId>` for every user in the CHANGED user's interest set (friends ∪ DM peers ∪ room co-members) whenever that user's aggregate `online | afk | offline` state transitions. Fan-out is per-user via `emitToUser`.
- **Not** fired to the changed user themselves — the FE tracks its own state locally via the activity tracker.
- Recipients apply the update to their local presence map. The UI re-renders the ● / ◐ / ○ dot next to any sidebar row, DM header, or room member rail entry keyed on `userId`.

#### `presence:snapshot`
- Payload: `PresenceSnapshotPayload`.
  ```json
  { "presences": [ { "userId": "uuid", "state": "online" }, { "userId": "uuid", "state": "afk" } ] }
  ```
- Fired to a **single socket** (not the user fan-out `user:<id>`) immediately after it successfully connects and subscribes to its `user:` / `room:` channels. Payload contains every user in the caller's interest set, each with the current aggregate state. Users with no connected sockets are returned as `state: "offline"`.
- Consumer semantics: the FE merges the snapshot into its local presence map — it does NOT clear pre-existing entries for userIds absent from the snapshot. New sockets opened during an already-authenticated session fold the snapshot in without dropping state from other ongoing sockets.
- Per-socket (not per-user) so reopening a tab does not blast every other tab of the same user.

### Error envelope
Connection-level failures (auth, transport) surface via socket.io's built-in `connect_error` event — the client should log and toast. Business-logic failures on `message:send` come through the ack envelope above. There is no generic `error:*` server event in Round 3.

### Token refresh
A long-lived socket keeps its original handshake token until disconnect — it does **not** re-authenticate mid-session. HTTP token refresh during a live session does not affect existing sockets. If stricter session enforcement is needed later, the client would need to reconnect with the rotated token.
