# Security Review — Frontend Fix Tasks

## Goal
Close the security findings surfaced during the round-4 security review of `/frontend`. Security only — do not bundle UX, a11y, or perf work into these tasks.

## Dependencies
- `shared/api-contract.md` — auth/refresh/cookie semantics; treat as source of truth.
- `frontend/CLAUDE.md` §Auth Flow — **access token must be in-memory only**; `APP_INITIALIZER` silently refreshes on reload.
- `plans/round-4/frontend_tasks.md` — prior round context.
- `environment.ts` for the apiUrl used by the interceptor.

**Do not modify `/shared/`.** If the contract needs changes, stop and flag it to the orchestrator.

## Tasks

### 1. [High] Access token stored in `localStorage` / `sessionStorage`
**File(s):** `frontend/src/app/core/auth/auth.service.ts:27-32, 71-74, 147-154`
**Category:** Token Storage
**Problem:** The access JWT is persisted under the storage key `chat.accessToken` (chosen between `localStorage` and `sessionStorage` based on `keepSignedIn`). This directly contradicts `frontend/CLAUDE.md` which states the access token must live only in a private field of `AuthService`. Any XSS — or any compromised third-party asset loaded by the app (e.g., the external Google Fonts CSS links in `src/index.html`) — can read the token via `localStorage.getItem('chat.accessToken')` and impersonate the user for the token's lifetime. The refresh token is already in an httpOnly cookie, so on-reload restoration should use the documented `APP_INITIALIZER` → silent `refresh()` path, not storage.
**Fix:**
- Remove `hydrateFromStorage()` and the constructor call that invokes it.
- Remove `storage.setItem(...)` / `storage.removeItem(...)` from `setAccessToken` and `clearAccessToken`.
- Drop the `keepSignedIn`-driven storage switch entirely on the FE — the flag already influences the refresh-cookie `maxAge` server-side and nothing more is needed client-side.
- Keep the access token strictly in the existing private `#accessToken` (or equivalent) field; rely on `APP_INITIALIZER` + `refresh()` to rehydrate on page reload.

### 2. [High] Open redirect via unvalidated `returnUrl`
**File(s):** `frontend/src/app/auth/login/login.component.ts:59-61`
**Category:** Open Redirect
**Problem:** After a successful login the component passes `returnUrl` from the query string straight into `router.navigateByUrl(returnUrl)`. `navigateByUrl` accepts protocol-relative targets (`//attacker.tld/...`) which Angular's router happily resolves to external hosts. A phishing link like `/login?returnUrl=//attacker.tld/...` will redirect the freshly-authenticated user off-site.
**Fix:** Whitelist paths before navigation:
```ts
const raw = this.route.snapshot.queryParamMap.get('returnUrl') ?? '/chat';
const safe = /^\/(?![/\\])/.test(raw) ? raw : '/chat';
this.router.navigateByUrl(safe);
```
Apply the same guard anywhere else `returnUrl` is consumed (e.g., register/reset flows). Never pass arbitrary query-string values to `navigateByUrl` without validating they begin with a single `/` and not `//` or `/\`.

### 3. [Medium] Client-side JWT decode used for auth state (no signature, no `exp` check)
**File(s):** `frontend/src/app/core/auth/auth.service.ts:162-177`
**Category:** Auth
**Problem:** `decodeUser` `atob`s the middle JWT segment without any verification and the resulting fields drive `currentUser` and `isAuthenticated`. Combined with localStorage persistence (task 1), any attacker with local JS execution can drop a hand-crafted unsigned JWT into storage and gain access to authenticated routes until the first server 401. There is also no `exp` check, so expired tokens still light up protected routes until a network round-trip rejects them.
**Fix:**
- After task 1 removes storage hydration, `isAuthenticated` should reflect whether the boot-time `refresh()` succeeded (i.e., the server handed back a freshly signed access token).
- If a client-side decode is kept for display purposes only (username in the header, etc.), mark it explicitly as untrusted UI data and reject tokens where `payload.exp * 1000 <= Date.now()` before using any fields.
- Never gate guards or guest-guards on data derived from a raw local string.

### 4. [Medium] Interceptor sends `withCredentials` on every `/api/` call and uses a loose URL match
**File(s):** `frontend/src/app/core/auth/auth.interceptor.ts:21-29`
**Category:** CSRF / Config
**Problem:** The interceptor sets `withCredentials: true` on any request whose URL merely **contains** `/api/`. This causes the httpOnly refresh cookie to be attached to every authenticated API call (only `/api/auth/refresh` actually needs it), widens the CSRF-exposure surface if any API endpoint is ever made state-changing via GET or form-POST, and the substring check `req.url.includes('/api/')` can match attacker-controlled cross-origin URLs (`https://evil.com/api/...`), leaking the `Authorization` header to a third party.
**Fix:**
- Remove the default-branch `withCredentials: true`. Only the `/api/auth/refresh` call (already handled explicitly in `auth.service.ts:119`) needs credentials.
- Replace `req.url.includes('/api/')` with a strict prefix check against `environment.apiUrl`:
  ```ts
  const isSameApi = req.url.startsWith(environment.apiUrl + '/') || req.url.startsWith('/api/');
  ```
  Only attach the Authorization header when `isSameApi`.

### 5. [Low] `console.error` leaks token-decode failures in production
**File(s):** `frontend/src/app/core/auth/auth.service.ts:174`
**Category:** Info Disclosure
**Problem:** `console.error('Error decoding token:', e)` runs even in production builds. The logged error object can embed fragments of the malformed token and is visible to any other script sharing the origin and to anyone reviewing devtools on the user's machine.
**Fix:** Remove the `console.error`. If kept for development, gate it with `if (!environment.production)` and silently return `null` otherwise.

### 6. [Low] `console.warn` leaks socket `connect_error` details in production
**File(s):** `frontend/src/app/core/socket/socket.service.ts:56-60`
**Category:** Info Disclosure
**Problem:** `console.warn('[socket] connect_error:', err.message)` prints server-supplied auth-failure messages to the browser console in production.
**Fix:** Remove the log, or gate with `if (!environment.production)`.

### 7. [Low] `/design-system` route is reachable in production
**File(s):** `frontend/src/app/app.routes.ts:68-72`
**Category:** Authorization
**Problem:** The `/design-system` route is registered unconditionally, with no guard and no `environment.production` gate. Unauthenticated visitors can browse an internal component/token inventory that today contains only mock data but is a growing dev surface.
**Fix:** Conditionally register the route:
```ts
...(environment.production ? [] : [{ path: 'design-system', loadComponent: () => import('./design-system/design-system.component').then(m => m.DesignSystemComponent) }]),
```
Alternatively, add `canActivate: [authGuard]` **and** a production-build flag.

### 8. [Low] External stylesheets without SRI + no CSP meta
**File(s):** `frontend/src/index.html:9-10`
**Category:** Config / Dependencies
**Problem:** Two `<link>` tags pull CSS from `https://fonts.googleapis.com/...` without `integrity` / `crossorigin` attributes, so a compromised responder (future DNS incident, MITM on a compromised network) can inject CSS that exfiltrates data via selector-driven requests. `index.html` also has no `Content-Security-Policy` meta tag restricting `script-src` / `style-src` / `connect-src`, which means any XSS foothold (amplified by task 1) has no network-egress constraints.
**Fix:** Pick one:
- Self-host the fonts via the Angular `assets` pipeline (preferred — removes the external dependency outright), **or**
- Add `integrity="sha384-..."` and `crossorigin="anonymous"` to both `<link>` tags.
Additionally add a `Content-Security-Policy` meta tag (or serve the header from backend/nginx — see backend tasks):
```html
<meta http-equiv="Content-Security-Policy"
      content="default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self' ws: wss:; img-src 'self' data:; object-src 'none'; base-uri 'self';">
```

## Wrap-up
Write `plans/reviews/round-4/frontend_fix_summary.md` with:
- **Fixed** — per task: files touched, what changed, verification notes (e.g., "token no longer in localStorage — confirmed via devtools after reload").
- **Deviations** — anywhere the fix diverges from the task description and why.
- **Deferred** — anything you couldn't close and why (with a concrete follow-up).
- **Verification notes** — manual steps exercised (login → reload → session survives via refresh cookie; `/login?returnUrl=//evil.tld` lands at `/chat`; production bundle does not include `/design-system`; interceptor no longer sends refresh cookie on non-auth API calls).
