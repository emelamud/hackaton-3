# Round 1 — Backend Tasks

## Goal
Docker setup, database migrations, and full JWT auth API. After this round `docker compose up` starts the backend, migrations run, and all auth endpoints work.

## Dependencies
Read `/shared/api-contract.md` and `/shared/types/` before starting. Do not modify them.

## Tasks

### 1. Docker
- Create `docker/backend.Dockerfile`:
  - Build stage: `node:20-alpine`, install pnpm, copy source, `pnpm install`, `pnpm build`
  - Runtime: copy `dist/`, run migrations on startup, then `node dist/index.js`
- Create root `docker-compose.yml` with services:
  - `postgres`: `postgres:16-alpine`, volume for data, env: POSTGRES_DB/USER/PASSWORD
  - `backend`: build from `docker/backend.Dockerfile`, port 3000, depends on postgres, env from `.env`
  - `frontend`: build from `docker/frontend.Dockerfile`, port 4300, depends on backend

### 2. Drizzle ORM Setup
- Install: `drizzle-orm`, `drizzle-kit`, `@types/pg`
- Create `backend/src/db/schema.ts` with tables:
  - `users`: `id` (uuid pk default), `email` (text unique not null), `username` (text unique not null), `password_hash` (text not null), `created_at` (timestamp default now)
  - `sessions`: `id` (uuid pk default), `user_id` (uuid FK → users.id cascade delete), `refresh_token_hash` (text not null), `user_agent` (text), `ip_address` (text), `created_at` (timestamp default now), `expires_at` (timestamp not null)
- Create `backend/src/db/index.ts` — export drizzle db instance using pool from `pool.ts`
- Create `backend/drizzle.config.ts`
- Add scripts to `package.json`: `"db:generate": "drizzle-kit generate"`, `"db:migrate": "drizzle-kit migrate"`
- Generate and commit first migration

### 3. Auth Service (`backend/src/services/auth.service.ts`)
- `register(body: RegisterRequest)`: hash password with bcrypt (rounds=12), insert user, issue tokens → return `AuthResponse`
- `login(body: LoginRequest)`: find user by email, bcrypt compare, issue tokens → return `AuthResponse`
- `logout(sessionId: string)`: delete session row
- `refresh(refreshToken: string)`: find session by token hash, verify not expired, rotate refresh token → return `RefreshResponse`
- `forgotPassword(email: string)`: if user exists, sign a short-lived reset token (JWT, 1hr), log it (no email service needed — log to console for now)
- `resetPassword(token: string, newPassword: string)`: verify reset token, hash new password, update user
- Token helpers: `issueTokens(userId, sessionData)` → access token (JWT, 15min) + refresh token (random uuid, 30 days, stored as hash in sessions table)

### 4. JWT Middleware (`backend/src/middleware/auth.ts`)
- Verify `Authorization: Bearer <token>` header using `JWT_SECRET`
- On success: attach `req.user = { id, email, username }`
- On fail: call next with 401 AppError

### 5. Auth Routes (`backend/src/routes/auth.ts`)
Implement all 8 endpoints per `/shared/api-contract.md`. Use zod for input validation.
- Refresh token: read from httpOnly cookie `refreshToken`
- Login: set httpOnly cookie `refreshToken` (SameSite=Strict, Secure in prod)
- Logout/refresh failure: clear the cookie

### 6. Sessions Routes (`backend/src/routes/sessions.ts`)
- `GET /api/auth/sessions`: return all sessions for `req.user.id`; mark current session with `isCurrent: true`
- `DELETE /api/auth/sessions/:id`: verify session belongs to user, delete

### 7. Error Handling
- Create `backend/src/errors/AppError.ts`: `class AppError extends Error { statusCode: number }`
- Update `errorHandler.ts` to handle `AppError` → return `{ error: message }` with correct status

### 8. Environment
Update `backend/.env.example`:
```
PORT=3000
DATABASE_URL=postgresql://chat:chat@postgres:5432/chat
JWT_SECRET=change-me
JWT_REFRESH_SECRET=change-me-too
JWT_RESET_SECRET=change-me-three
NODE_ENV=development
UPLOADS_DIR=/app/uploads
```

## Wrap-up
Write `plans/round-1/summary-backend.md` with:
- **Built**: list of endpoints and DB tables created
- **Deviations**: anything that differs from the contract
- **Deferred**: anything skipped
- **Next round needs to know**: Socket.io readiness, DB schema decisions
