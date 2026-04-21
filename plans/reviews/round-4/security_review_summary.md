# Security Review — round-4

## Scope
- **Type:** full codebase (not `pending`-only).
- **Date:** 2026-04-21.
- **Paths scanned:**
  - `/frontend/src/**`, `/frontend/angular.json`, `/frontend/package.json`, `/frontend/public`, `/frontend/src/index.html`
  - `/backend/src/**`, `/backend/drizzle.config.ts`, `/backend/package.json`
  - `/shared/api-contract.md`, `/shared/types/**`
  - `docker-compose.yml`, `docker/backend.Dockerfile`, `docker/frontend.Dockerfile`, `docker/nginx.conf`, `docker/entrypoint.sh`
  - `.gitignore`, `.env.example` files (backend + frontend). Real `.env` files were **not** read.

## Methodology
- Two subagents dispatched in parallel:
  - Frontend security scan over `/frontend`.
  - Backend security scan over `/backend`.
- Orchestrator swept `/shared`, `docker-compose.yml`, `docker/*`, `.env.example`, root `.gitignore`, and confirmed via `git ls-files` that no real `.env` file is tracked (both `.env.example` are the only committed env files).
- One BE subagent finding that claimed a real `.env` was committed was cross-checked and reframed around `.env.example` placeholders + missing startup validation in `config.ts`.
- Findings were deduplicated and assigned to the role that owns the fix. Infra findings are tracked inside `backend_tasks.md` (§17–19) because the backend owns the deploy path.
- Categories covered per-agent checklist: Auth, Authorization, Injection, XSS, Token Storage, Open Redirect, Secrets, Crypto, CORS/CSRF, Rate Limiting/DoS, Transport/Headers, Info Disclosure, Socket Auth, Input Validation, Dependencies, Config.

## Findings

| #  | Severity | Category           | Location                                                   | Owner | Task ref                         |
|----|----------|--------------------|------------------------------------------------------------|-------|----------------------------------|
| 1  | High     | Token Storage      | `frontend/src/app/core/auth/auth.service.ts:27-32,71-74,147-154` | FE    | `frontend_tasks.md §1`           |
| 2  | High     | Open Redirect      | `frontend/src/app/auth/login/login.component.ts:59-61`     | FE    | `frontend_tasks.md §2`           |
| 3  | High     | Secrets            | `backend/.env.example:3-5`, `backend/src/config.ts:10-12`  | BE    | `backend_tasks.md §1`            |
| 4  | High     | Rate Limiting      | `backend/src/index.ts:25` (`express.json()`)               | BE    | `backend_tasks.md §2`            |
| 5  | High     | Rate Limiting      | `backend/src/index.ts:15-45`, auth routes                  | BE    | `backend_tasks.md §3`            |
| 6  | High     | Transport          | `backend/src/index.ts:15-26` (no helmet)                   | BE    | `backend_tasks.md §4`            |
| 7  | High     | Rate Limiting      | `backend/src/socket/io.ts:24-30` + message handler         | BE    | `backend_tasks.md §5`            |
| 8  | High     | Info Disclosure    | `backend/src/services/auth.service.ts:242-248`             | BE    | `backend_tasks.md §6`            |
| 9  | High     | Auth               | `backend/src/services/auth.service.ts:242-271` (reset JWT) | BE    | `backend_tasks.md §7`            |
| 10 | Medium   | Auth               | `frontend/src/app/core/auth/auth.service.ts:162-177`       | FE    | `frontend_tasks.md §3`           |
| 11 | Medium   | CSRF / Config      | `frontend/src/app/core/auth/auth.interceptor.ts:21-29`     | FE    | `frontend_tasks.md §4`           |
| 12 | Medium   | Info Disclosure    | `backend/src/services/auth.service.ts:92-104` (register)   | BE    | `backend_tasks.md §8`            |
| 13 | Medium   | Auth               | `backend/src/services/auth.service.ts:162-164` + middleware| BE    | `backend_tasks.md §9`            |
| 14 | Medium   | Auth               | `backend/src/routes/auth.ts:96-120` (refresh persistence)  | BE    | `backend_tasks.md §10`           |
| 15 | Medium   | Transport          | `backend/src/db/pool.ts:3-5` (no SSL)                      | BE    | `backend_tasks.md §11`           |
| 16 | Medium   | Socket Auth        | `backend/src/socket/io.ts:48-66` (stale room subs)         | BE    | `backend_tasks.md §12`           |
| 17 | Medium   | Secrets            | `docker-compose.yml:5-9,29` (DB creds committed)           | Infra | `backend_tasks.md §17`           |
| 18 | Medium   | Transport          | `docker-compose.yml:11-12` (5432 published)                | Infra | `backend_tasks.md §18`           |
| 19 | Low      | Info Disclosure    | `frontend/src/app/core/auth/auth.service.ts:174`           | FE    | `frontend_tasks.md §5`           |
| 20 | Low      | Info Disclosure    | `frontend/src/app/core/socket/socket.service.ts:56-60`     | FE    | `frontend_tasks.md §6`           |
| 21 | Low      | Authorization      | `frontend/src/app/app.routes.ts:68-72` (`/design-system`)  | FE    | `frontend_tasks.md §7`           |
| 22 | Low      | Config / Dependencies | `frontend/src/index.html:9-10` (fonts, CSP)              | FE    | `frontend_tasks.md §8`           |
| 23 | Low      | Auth               | `backend/src/routes/auth.ts:13-20` (cookie path)           | BE    | `backend_tasks.md §13`           |
| 24 | Low      | Auth / Crypto      | `backend/src/services/auth.service.ts:41-68`, `middleware/auth.ts:29`, `auth.service.ts:253` | BE | `backend_tasks.md §14` |
| 25 | Low      | Transport / Config | `backend/src/index.ts:15-45` (`trust proxy`)               | BE    | `backend_tasks.md §15`           |
| 26 | Low      | Crypto             | `backend/src/services/auth.service.ts:170-185`             | BE    | `backend_tasks.md §16`           |
| 27 | Low      | Config             | `docker/backend.Dockerfile:16-33` (runs as root)           | Infra | `backend_tasks.md §19`           |

## Stats
**By severity:**
- High: 9
- Medium: 9
- Low: 9
- Critical: 0

**By category:**
- Auth: 7
- Rate Limiting / DoS: 4
- Info Disclosure: 4
- Transport: 4
- Config (incl. Config/Dependencies): 3
- Secrets: 2
- Socket Auth: 1
- Token Storage: 1
- Open Redirect: 1
- CSRF / Config: 1
- Authorization: 1
- Crypto: 1
- Auth / Crypto (dual): 1

**By owner:**
- FE: 8
- BE: 16
- Infra (routed via BE): 3

## Out of scope
Noticed but deliberately skipped (per the "security only" rule):
- Angular change-detection strategies, signal vs. observable trade-offs, component splitting, Material theming choices.
- Backend service/route structure cleanliness, test coverage gaps, naming.
- Accessibility of forms and dialogs.
- Performance (DB indexes beyond DoS-relevant scans, Angular bundle size).
- Dev-ergonomics items (migration auto-naming, CORS origin centralisation) — already tracked in round-3/4 summaries.

## Next steps
1. Start with BE §1–9 and FE §1–2 (the High items). These close the worst auth and DoS exposure; several later mediums depend on them (e.g., the session-lookup in §9 enables clean logout semantics, and `trust proxy` in §15 is required before the rate limiter in §3 keys off real client IPs).
2. Run FE §1–4 together — they all touch the same auth/interceptor surface.
3. After fixes land, re-run this review command scoped to `pending` to confirm no regressions before merging.
4. For contract-level items (BE §8 user enumeration, BE §7 reset-token single-use if it wants a new error string), stop and bring the orchestrator in before editing `/shared/api-contract.md`.
5. Both role summaries should be written to `plans/reviews/round-4/<role>_fix_summary.md` using the Wrap-up template in each task file.
