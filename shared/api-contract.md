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
- `POST /api/rooms/:id/join` on a private room returns `403` for Round 2a. Invitations come in Round 5b.
- Members in `RoomDetail.members` are ordered: owner first, then admins by `joinedAt` ascending, then regular members by `joinedAt` ascending.

### Summary

| Method | Path | Body | Success | Errors |
|--------|------|------|---------|--------|
| GET | `/api/rooms` | — | `200 Room[]` (caller's memberships, newest first) | — |
| POST | `/api/rooms` | `CreateRoomRequest` | `201 RoomDetail` (creator auto-joined as `owner`) | `400` validation, `409` name taken |
| GET | `/api/rooms/:id` | — | `200 RoomDetail` | `403` not a member, `404` not found |
| POST | `/api/rooms/:id/join` | — | `200 RoomDetail` (idempotent if already member) | `403` private room, `404` not found |
| POST | `/api/rooms/:id/leave` | — | `204` | `403` owner cannot leave, `404` not a member |
| GET | `/api/rooms/:id/messages` | — | `200 Message[]` (oldest first, up to 50 most-recent) | `403` not a member, `404` not found |

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
Leave a room. The owner cannot leave their own room (requirement §2.4.5) — they must delete it instead (room deletion is Round 5a).

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

No cursor / `before` parameter in Round 3. Round 5 introduces `?before=<messageId>&limit=` and keeps the same response shape.

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

REST handlers keep subscriptions in sync for the lifetime of the connection:
- After `POST /api/rooms` (create) and `POST /api/rooms/:id/join` → server calls `io.in('user:<userId>').socketsJoin('room:<roomId>')`.
- After `POST /api/rooms/:id/leave` → server calls `io.in('user:<userId>').socketsLeave('room:<roomId>')`.

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
- On success the server additionally broadcasts `message:new` (see below) to everyone in `room:<roomId>` **except the sender socket**. The sender renders its own message from the ack, so the broadcast excludes it to avoid duplicates. Other tabs of the same user receive the broadcast normally (different sockets, same user).

### Server → Client events

#### `message:new`
- Payload: `Message` (fully denormalised, including `username`).
  ```json
  { "id": "uuid", "roomId": "uuid", "userId": "uuid", "username": "bob", "body": "hey", "createdAt": "ISO" }
  ```
- Fired to all sockets in `room:<roomId>` **except the sender socket** (`socket.to('room:<roomId>').emit(...)`). Clients are subscribed to every room they belong to, so they must filter by `roomId` when deciding which room's pane to render into.

### Error envelope
Connection-level failures (auth, transport) surface via socket.io's built-in `connect_error` event — the client should log and toast. Business-logic failures on `message:send` come through the ack envelope above. There is no generic `error:*` server event in Round 3.

### Token refresh
A long-lived socket keeps its original handshake token until disconnect — it does **not** re-authenticate mid-session. HTTP token refresh during a live session does not affect existing sockets. If stricter session enforcement is needed later, the client would need to reconnect with the rotated token.
