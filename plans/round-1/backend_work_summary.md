# Round 1 Backend — Summary

## Built

### DB Tables
- `users` — `id` (uuid pk), `email` (text unique not null), `username` (text unique not null), `password_hash` (text not null), `created_at` (timestamp default now)
- `sessions` — `id` (uuid pk), `user_id` (uuid FK → users.id cascade delete), `refresh_token_hash` (text not null), `user_agent` (text), `ip_address` (text), `created_at` (timestamp default now), `expires_at` (timestamp not null)

### Endpoints
- `POST /api/auth/register` — bcrypt hash, insert user, issue JWT + refresh token cookie, return AuthResponse
- `POST /api/auth/login` — verify password, issue JWT + refresh token cookie, supports keepSignedIn
- `POST /api/auth/logout` — requires auth, deletes session, clears cookie
- `POST /api/auth/refresh` — reads httpOnly refreshToken cookie, rotates token, returns new access token
- `POST /api/auth/forgot-password` — always 204, logs reset token to console if user exists
- `POST /api/auth/reset-password` — verifies JWT reset token, updates password hash, invalidates all sessions
- `GET /api/auth/sessions` — requires auth, returns all sessions with isCurrent flag
- `DELETE /api/auth/sessions/:id` — requires auth, enforces ownership (403 if wrong user, 404 if missing)

### Infrastructure
- `docker-compose.yml` at project root — services: postgres (16-alpine), backend (port 3000), frontend (port 4300)
- `docker/backend.Dockerfile` — two-stage build; runtime uses compiled JS + programmatic drizzle migrator
- `docker/entrypoint.sh` — runs `node dist/db/migrate.js` then `node dist/index.js`
- `backend/src/db/migrate.ts` — programmatic Drizzle migrator (compiled to dist/db/migrate.js)
- First migration generated: `src/db/migrations/0000_closed_shriek.sql`

### Core Files
- `backend/src/db/schema.ts` — Drizzle schema
- `backend/src/db/index.ts` — db instance
- `backend/drizzle.config.ts` — drizzle-kit config
- `backend/src/config.ts` — typed env config with startup validation
- `backend/src/errors/AppError.ts` — AppError(message, statusCode, details?)
- `backend/src/middleware/errorHandler.ts` — handles AppError + generic 500
- `backend/src/middleware/validate.ts` — Zod v4 schema validation middleware
- `backend/src/middleware/auth.ts` — JWT Bearer verification, populates req.user
- `backend/src/services/auth.service.ts` — all auth business logic
- `backend/src/routes/auth.ts` — auth route handlers
- `backend/src/routes/sessions.ts` — sessions route handlers
- `backend/src/types/shared.ts` — local mirror of /shared/types interfaces

## Deviations

- **Shared types not imported directly**: TypeScript rootDir constraint prevents importing outside src/. A local mirror `src/types/shared.ts` replicates the shared interfaces. Must be kept in sync when /shared/types/ changes.
- **Refresh cookie on /refresh always persistent**: The original session's keepSignedIn value is not stored in the sessions table, so on rotation the new cookie always gets the 30-day maxAge. Fix in Round 2 by adding a `persistent` boolean column to sessions.
- **JWT_REFRESH_SECRET declared but unused**: Refresh tokens are random UUIDs stored as SHA-256 hashes, not JWTs. The env var is declared for future use.
- **Zod v4 API**: Installed zod@4.3.6 which uses `result.error.issues` instead of `result.error.errors`. Validate middleware uses the v4 API.

## Deferred

- Integration tests (Jest + Supertest) — no Jest setup in Round 1
- Email service for forgot-password — reset token logged to console only
- Rate limiting on auth endpoints
- UPLOADS_DIR directory creation on startup

## Next Round Needs to Know

### Socket.io Readiness
- The Express app uses `app.listen()` directly. To add Socket.io in Round 2, change to `http.createServer(app)` + `new Server(server)` + `server.listen()`.
- `requireAuth` exports `AuthPayload` — reuse this type in `io.use()` for socket authentication.
- JWT access token should be sent as `auth.token` in the Socket.io handshake and verified with `config.jwtSecret`.

### DB Schema Notes
- `sessions.expires_at` uses `timestamp` without timezone. Consider `timestamptz` for correctness.
- Add `sessions.persistent boolean default false` in Round 2 to preserve keepSignedIn state across token rotations.
- `users` table has no `avatar_url` or `status` column — add when implementing user profiles.
- Sessions are not cleaned up automatically — add a cron job or TTL-based cleanup in a later round.
