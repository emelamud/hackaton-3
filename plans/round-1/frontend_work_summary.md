# Round 1 Frontend Summary

## Built

- **Docker / nginx**
  - `docker/frontend.Dockerfile` — two-stage (node:20-alpine build, nginx:alpine runtime)
  - `docker/nginx.conf` — SPA fallback + `/api/` proxy to `http://backend:3000/api/`

- **Environments**
  - `frontend/src/environments/environment.ts` — `apiUrl: http://localhost:3000/api` (dev)
  - `frontend/src/environments/environment.prod.ts` — `apiUrl: /api` (relative, nginx proxies)
  - `angular.json` production config wired with `fileReplacements`

- **Core auth (`frontend/src/app/core/auth/`)**
  - `auth.service.ts` — login, register, logout, refresh, forgotPassword, resetPassword; `currentUser` signal; `isAuthenticated` computed; access token in-memory only; `setUserFromToken()` decodes JWT payload to restore user state after silent refresh
  - `auth.interceptor.ts` — functional interceptor; attaches `Authorization: Bearer` to `/api/` calls; on 401 calls refresh once, retries; on failure navigates to `/login`
  - `auth.guard.ts` — functional guard; unauthenticated → `/login?returnUrl=...`
  - `guest.guard.ts` — functional guard; authenticated → `/chat`

- **App config (`app.config.ts`)**
  - `provideHttpClient` with `withInterceptors([authInterceptor])` and `withFetch()`
  - `APP_INITIALIZER` calls `authService.refresh()` on startup to restore session from httpOnly cookie

- **Routing (`app.routes.ts`)**
  - `/` → redirect `/login`
  - `/login`, `/register`, `/forgot-password`, `/reset-password` — guestGuard
  - Shell wrapper route (authGuard) with children: `/chat`, `/sessions`
  - `**` → redirect `/login`
  - All feature routes lazy-loaded via `loadComponent`

- **Auth pages (`frontend/src/app/auth/`)**
  - `login/` — email + password + keepSignedIn; returnUrl support; inline 401 error
  - `register/` — email + username + password + confirmPassword; cross-field `passwordsMatch` group validator; 409 conflict error inline
  - `forgot-password/` — email field; in-place success message on 204
  - `reset-password/` — reads `?token=` query param; newPassword + confirmPassword; 400 token-expired error inline

- **App shell (`frontend/src/app/shell/`)**
  - `shell.component` — `mat-toolbar` top nav; logo left, nav center (Public Rooms, Private Rooms, Contacts), Sessions + profile dropdown (MatMenu) + sign-out icon right; `<router-outlet>` for children; responsive collapse below md/sm
  - `chat-placeholder/` — empty-state component for `/chat` route

- **Sessions page (`frontend/src/app/sessions/`)**
  - `sessions.service.ts` — `getSessions()` / `revokeSession(id)` via HttpClient
  - `sessions.component` — `mat-table`; columns: Browser/OS (parsed UA), IP, Created, Expires, Actions; current session highlighted with badge; revoking current session calls `logout()` then navigates to `/login`; loading/error/empty states; per-row spinner

## Deviations

- **Shell as nested layout**: `/chat` and `/sessions` are children of the Shell route rather than parallel top-level routes. This matches "Shell is the layout for all authenticated pages."
- **User restoration after silent refresh**: `setUserFromToken()` decodes JWT claims to populate `currentUser` because `POST /api/auth/refresh` only returns `accessToken` (not a full user object). If claims are absent the user remains unauthenticated.

## Deferred

- Dark/light mode toggle in the shell nav (ThemeToggleComponent exists but not placed in shell toolbar — deferred to round 2)
- Private Rooms and Contacts nav items are visual placeholders (no routes yet)

## Next round needs to know

- **Shell is a layout wrapper** — add future authenticated routes as additional children of the anonymous shell route in `app.routes.ts`
- **Auth state** — `authService.currentUser()` signal is the single source of truth; `isAuthenticated` is computed from it
- **Token** — `AuthService.getAccessToken()` is the only accessor; never in localStorage
- **Interceptor is functional** — registered via `withInterceptors([authInterceptor])` in `app.config.ts`
- **APP_INITIALIZER** silently calls `refresh()` on every page load; backend down = lands on `/login`
- **Environments** — dev `http://localhost:3000/api`, prod `/api`; file replacement wired in `angular.json`
- **Sessions service pattern** — standalone service in `src/app/sessions/sessions.service.ts`; replicate for future feature HTTP services
