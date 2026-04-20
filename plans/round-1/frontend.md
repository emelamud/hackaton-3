# Round 1 — Frontend Tasks

## Goal
Docker setup, auth pages, and app shell. After this round `docker compose up` serves the Angular app; users can register, log in, and view/revoke sessions.

## Dependencies
Read `/shared/api-contract.md` and `/shared/types/` before starting. Read `frontend/docs/DESIGN_SYSTEM.md` and `.claude/skills/design-system/SKILL.md`. Do not modify shared files.

## Tasks

### 1. Docker
- Create `docker/frontend.Dockerfile`:
  - Build stage: `node:20-alpine`, install pnpm, `pnpm install`, `pnpm build`
  - Runtime: `nginx:alpine`, copy `dist/browser/` to `/usr/share/nginx/html`
- Create `docker/nginx.conf`:
  - Serve Angular SPA (try_files fallback to index.html)
  - Proxy `/api/` → `http://backend:3000/api/`
  - Listen on port 80 (docker-compose maps to 4300 externally)

### 2. Environment & API Config
- Create `frontend/src/environments/environment.ts` and `environment.prod.ts` with `apiUrl`
- In prod build, `apiUrl` should be relative (`/api`) so nginx proxies it

### 3. Core Auth Module (`frontend/src/app/core/auth/`)
**`auth.service.ts`**:
- Methods: `login()`, `register()`, `logout()`, `refresh()`, `forgotPassword()`, `resetPassword()`
- State: `currentUser` signal (`User | null`), `isAuthenticated` computed signal
- Access token: stored in a private property (in-memory only)
- On login: store access token in memory; backend sets `refreshToken` httpOnly cookie
- On app init: call `refresh()` silently to restore session (APP_INITIALIZER)
- Expose `getAccessToken()` for the interceptor

**`auth.interceptor.ts`**:
- Attach `Authorization: Bearer <token>` to all requests to `/api/`
- On 401 response: call `authService.refresh()`, retry original request once
- On refresh failure: call `authService.logout()`, navigate to `/login`

**`auth.guard.ts`** — functional guard: if not authenticated → `/login`

**`guest.guard.ts`** — functional guard: if authenticated → `/chat`

### 4. App Routing (`frontend/src/app/app.routes.ts`)
```
/               → redirect to /login
/login          → LoginComponent (guestGuard)
/register       → RegisterComponent (guestGuard)
/forgot-password → ForgotPasswordComponent (guestGuard)
/reset-password  → ResetPasswordComponent (guestGuard)
/chat           → ShellComponent (authGuard) [placeholder content for now]
/sessions       → SessionsComponent (authGuard)
** → redirect to /login
```

### 5. Auth Pages (`frontend/src/app/auth/`)
All pages: use `ReactiveFormsModule`, `MatFormField`, `MatInput`, `MatButton`. Match wireframes from requirements. Show inline error messages (email invalid, passwords don't match, etc.).

**`login/login.component.ts`**:
- Fields: email, password, keepSignedIn (checkbox)
- On submit: call `authService.login()`, navigate to `/chat`
- Link to `/register` and `/forgot-password`
- Show server error (invalid credentials) inline

**`register/register.component.ts`**:
- Fields: email, username, password, confirmPassword
- Validator: confirmPassword must match password
- On submit: call `authService.register()`, navigate to `/chat`
- Show server errors (email/username taken) inline

**`forgot-password/forgot-password.component.ts`**:
- Field: email
- On submit: call `authService.forgotPassword()`, show success message

**`reset-password/reset-password.component.ts`**:
- Read `token` from query param
- Fields: newPassword, confirmPassword
- On submit: call `authService.resetPassword(token, password)`, navigate to `/login`

### 6. App Shell (`frontend/src/app/shell/shell.component.ts`)
Top navigation bar (full width):
- Left: logo "ChatApp"
- Center nav links: Public Rooms, Private Rooms, Contacts
- Right: Sessions link, Profile dropdown (username + avatar placeholder), Sign out button
- Router outlet below nav for page content

Use `MatToolbar`, `MatMenu` for profile dropdown. Shell is the layout for all authenticated pages.

### 7. Sessions Page (`frontend/src/app/sessions/sessions.component.ts`)
- On init: `GET /api/auth/sessions`
- Display as `MatTable`: columns — Browser/OS (from userAgent), IP address, Created, Expires, Actions
- Current session row: highlighted with "(current)" label
- Revoke button: `DELETE /api/auth/sessions/:id`, remove row on success
- Revoking current session: call `authService.logout()` then navigate to `/login`

### 8. Polish
- Loading states on all form submit buttons (`[disabled]` + spinner)
- Global error snackbar for unexpected errors (`MatSnackBar`)
- Redirect unauthenticated deep links back after login (store `returnUrl` in router state)

## Wrap-up
Write `plans/round-1/summary-frontend.md` with:
- **Built**: list of pages/components implemented
- **Deviations**: anything that differs from the task or contract
- **Deferred**: items skipped
- **Next round needs to know**: shell layout decisions, service patterns established
