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
