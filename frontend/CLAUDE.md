# Frontend Conventions

## Folder Structure
```
src/app/
  core/               # Singleton services, guards, interceptors (provided in root)
    auth/
      auth.service.ts       # Login, register, logout, refresh; currentUser signal
      auth.interceptor.ts   # Attach JWT; handle 401 refresh
      auth.guard.ts         # Redirect to /login if not authenticated
      guest.guard.ts        # Redirect to /chat if authenticated
    theme/
      theme.service.ts
      theme-toggle.component.ts
  shared/             # Reusable dumb components (no router, no store dependency)
  auth/               # Auth feature pages (login, register, forgot-password, reset-password)
  shell/              # App shell (top nav + router outlet for authenticated layout)
  sessions/           # Sessions management page
  app.routes.ts       # Root route config
  app.config.ts       # Angular providers (HTTP, router, material, etc.)
```

## Services
- Use `inject()` at the top of constructors or in factory functions
- Expose reactive state via Angular `signal()` (prefer) or `BehaviorSubject`
- One service per domain concept; no god services

## Auth Flow
- **Access token**: persisted in Web Storage (`localStorage` when `keepSignedIn=true`, otherwise `sessionStorage`) so reloads don't require a refresh round-trip; XSS exposure is mitigated via CSP, not by keeping the token out of JS reach
  - Exposed only via `getAccessToken()` for the interceptor
- **Refresh token**: httpOnly cookie — never touched by JS code
- **App init**: `APP_INITIALIZER` calls `authService.refresh()` silently to restore session on page load
- **Interceptor**: attaches Bearer token → on 401 → calls `refresh()` → retries once → on failure: `logout()` + navigate to `/login`
- **Guards**: `authGuard` checks `authService.isAuthenticated` signal; `guestGuard` is the inverse

## Forms
- Always use `ReactiveFormsModule` — `FormGroup`, `FormControl`, `Validators`
- Cross-field validators (e.g. confirmPassword): use `AbstractControl`-level validator on the group
- Show validation errors only after the field is touched or form is submitted
- Disable submit button while form is submitting (`submitting` signal)

## Routing
- Lazy-load feature components where possible using `loadComponent`
- Apply `authGuard` to `/chat`, `/sessions`, and all future authenticated routes
- Apply `guestGuard` to `/login`, `/register`, `/forgot-password`, `/reset-password`
- Store `returnUrl` in router navigation extras when redirecting to login; restore after successful auth

## API Calls
- All HTTP calls go through services — components never call `HttpClient` directly
- Use the shared types from `/shared/types/` for request/response shapes
- API base URL comes from `environment.apiUrl`
