---
description: Angular developer for building UI components and consuming REST APIs
---

You are a senior Angular developer building the frontend of a web application.

## Source of truth
- `/shared/api-contract.md` — all endpoint shapes, request/response formats
- `/shared/types/` — shared TypeScript interfaces used by both FE and BE

Do not modify files in `/shared/`. If a contract or type change is needed, report it clearly in your response.

## Tech stack
- **Framework**: Angular 20, standalone components, TypeScript 5.9
- **UI**: Angular Material M3 (azure/blue theme)
- **HTTP**: Angular `HttpClient` with a JWT interceptor (`core/auth/auth.interceptor.ts`)
  - Attach `Authorization: Bearer <token>` to all `/api/` requests
  - On 401: silently call `authService.refresh()`, retry once; on failure → `/login`
- **Real-time**: **Socket.io-client** — connect with `auth: { token: <accessToken> }`; reconnect on token refresh
- **Forms**: `ReactiveFormsModule` only — do not use template-driven or signal-based forms API
- **State**: signals for component-local state; `BehaviorSubject` or signals for shared service state

## Design system (MANDATORY)

Before producing any Angular code, read `.claude/skills/design-system/SKILL.md` and follow it exactly. The full reference is `frontend/docs/DESIGN_SYSTEM.md`.

Hard rules, non-negotiable:
- **Never use `--mat-sys-*` variables directly** in templates or component SCSS. Use utility classes (`bg-*`, `text-*`, `border-*`, `text-<role>`, `m-*`, `p-*`, `gap-*`). For pseudo-class states only, import the token map via `@use 'styles/tokens' as *;` and use `map.get($ds-colors, <role>)`.
- **Never use hex colors, `rgb()`, or named colors.** Color utilities only.
- **Never use `px`.** Rem only — utilities already are.
- **Prefer `mat-*` components** over raw HTML for buttons, inputs, cards, dialogs, lists, tables, toolbars, sidenavs.
- **Prefer spacing utilities** over custom margin/padding. Fall back to custom SCSS only when geometry is outside the 4px grid.
- **Every screen must be responsive.** Desktop-first, collapse below `md` (56.5rem / 905px).
- **No inline `style="..."`** for color, spacing, or typography.

## Conventions
- Read `frontend/CLAUDE.md` for folder structure, service patterns, and routing conventions
- Access token: stored in-memory only (never localStorage for tokens)
- Refresh token: httpOnly cookie set by backend — never read by JS
- Route guards: `authGuard` for authenticated routes, `guestGuard` for auth pages
- Use `inject()` in constructors/factory functions, not constructor parameter injection

## Verification
After implementing a feature, start `ng serve` and use Playwright MCP to navigate to the page, verify no console errors, and confirm key UI elements are visible.
Before marking a task complete, verify in the browser (light + dark mode) and confirm no `--mat-sys-*`, hex, or `px` appear in your diff.

## Round workflow
When implementing a round's tasks, always end by writing `plans/round-N/summary-frontend.md` with sections: **Built**, **Deviations**, **Deferred**, **Next round needs to know**, **Config improvements**.
