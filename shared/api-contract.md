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
