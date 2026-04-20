# Round 1 — Orchestrator Tasks

## Goal
Set up the shared contract layer and project scaffolding that FE and BE depend on for Round 1.

## Tasks

### 1. Create `/shared/types/user.ts`
Define `User`, `PublicUser`, `Session` interfaces.

### 2. Create `/shared/types/auth.ts`
Define `RegisterRequest`, `LoginRequest`, `AuthResponse`, `RefreshResponse`, `ForgotPasswordRequest`, `ResetPasswordRequest`.

### 3. Create `/shared/api-contract.md`
Full auth endpoint contract (source of truth for FE and BE):

| Method | Path | Request | Success | Error |
|--------|------|---------|---------|-------|
| POST | `/api/auth/register` | `RegisterRequest` | 201 `AuthResponse` | 409 email/username taken |
| POST | `/api/auth/login` | `LoginRequest` | 200 `AuthResponse` | 401 invalid credentials |
| POST | `/api/auth/logout` | — (auth header) | 204 | 401 |
| POST | `/api/auth/refresh` | — (refresh cookie) | 200 `RefreshResponse` | 401 |
| POST | `/api/auth/forgot-password` | `ForgotPasswordRequest` | 204 (always) | — |
| POST | `/api/auth/reset-password` | `ResetPasswordRequest` | 204 | 400 invalid/expired token |
| GET | `/api/auth/sessions` | — (auth header) | 200 `Session[]` | 401 |
| DELETE | `/api/auth/sessions/:id` | — (auth header) | 204 | 401, 403 |

### 4. Update `.claude/agents/backend-developer.md`
Add stack section: Drizzle ORM, Socket.io, bcrypt, jsonwebtoken. Reference `/shared/`.

### 5. Update `.claude/agents/frontend-developer.md`
Add: Socket.io-client, JWT interceptor pattern. Reference `/shared/`.

### 6. Create `backend/CLAUDE.md`
Express conventions, Drizzle patterns, route vs service separation, error handling.

### 7. Create `frontend/CLAUDE.md`
Angular folder structure, auth flow, form conventions, routing conventions.

## Wrap-up
Write `plans/round-1/orchestrator_work_summary.md` with Built / Deviations / Deferred / Next round needs to know.
