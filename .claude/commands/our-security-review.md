You are running a security-only review of this codebase. **Security only** — no code quality, accessibility, performance, or style findings. Drop them even if tempting.

## Arguments
`$ARGUMENTS` may contain:
- an output folder (e.g. `2026-04-21-auth`) — placed under `plans/reviews/`
- the literal `pending` — limit scope to pending changes on the current branch instead of the full codebase

If the output folder is **not** specified, ask the user for a short slug before doing anything else. Do not invent one. The final path is `plans/reviews/<slug>/`.

## Scope (default: full codebase)
- `/frontend` — Angular app
- `/backend` — Express API
- `/shared` — types + API contract
- Root infra — `docker-compose.yml`, `docker/`, `.env.example`, any root configs

If `pending` was passed, scope is restricted to files changed vs. `master` (`git diff master...HEAD` + uncommitted). Still split FE/BE/infra by path.

## What to look for
OWASP Top 10 and adjacent:
- **Auth** — session/token handling, cookie flags, JWT verification, refresh-token rotation, logout invalidation
- **Authorization** — missing role/ownership checks, IDOR, route-level vs. service-level gates
- **Injection** — SQL (raw queries, string-concat in Drizzle), command injection, NoSQL, XSS (innerHTML, `[innerHTML]`, bypassed `DomSanitizer`), template injection
- **Secrets / crypto** — hardcoded secrets, plaintext passwords, weak hashing (md5/sha1 for passwords, missing salt, missing bcrypt/argon2), weak randomness (`Math.random` for tokens), missing TLS assumptions
- **Input validation** — zod schemas present on every route, trust-boundary checks, size/length limits, type coercion traps
- **CORS / CSRF** — wildcard origins, credentials+wildcard, missing SameSite, state-changing GETs
- **Rate limiting / DoS** — unbounded queries, missing pagination caps, unthrottled auth endpoints, unlimited upload sizes, unbounded socket fan-out
- **Transport / headers** — missing Helmet-class headers, permissive CSP, HSTS in prod config
- **Info disclosure** — stack traces to client, verbose error strings that leak existence, PII in logs
- **Socket.io specifics** — handshake auth, room-join authorization, event payload validation, trust of client-supplied user IDs
- **Dependencies** — obvious outdated/abandoned libs in the security path (don't run `npm audit` — call out only what's visible in package.json)
- **Docker / env** — secrets in compose, world-readable volumes, containers running as root where it matters, committed `.env`

## Execution
1. If folder slug missing, ask and stop until answered.
2. In **parallel**, dispatch:
   - `frontend-developer` subagent → scan `/frontend` (scope-aware) and produce a raw findings list
   - `backend-developer` subagent → scan `/backend` (scope-aware) and produce a raw findings list
3. While those run, the main (orchestrator) agent scans `/shared`, `docker-compose.yml`, `docker/`, `.env.example`, and any cross-cutting config.
4. Collate all findings. Deduplicate cross-cutting issues into the owning role.
5. Write the outputs (see below).

Each subagent must return: list of findings with `{file:line, severity (Critical/High/Medium/Low), category, description, suggested fix}`. Tell them explicitly: security only, no quality/a11y/perf noise.

## Outputs
Write three files into `plans/reviews/<slug>/`. Match the task-file style of `plans/round-N/<role>_tasks.md` (see `plans/round-4/backend_tasks.md` for reference).

### `backend_tasks.md` and `frontend_tasks.md`
Structure:
- `# Security Review — [Role] Fix Tasks`
- `## Goal` — one sentence: close the security findings listed below.
- `## Dependencies` — `/shared/api-contract.md`, `backend|frontend/CLAUDE.md`, any relevant design-system/auth notes. Include the "do not modify /shared/" reminder.
- `## Tasks` — one numbered section per finding (`### 1. [Severity] Short title`). For each:
  - **File(s)**: path:line
  - **Category**: e.g. Authorization, Injection, Crypto
  - **Problem**: concrete description with the offending snippet if short
  - **Fix**: the exact change to make (library, pattern, code shape). Reference existing patterns in the repo when one already solves it.
- `## Wrap-up` — instruction to write `plans/reviews/<slug>/<role>_fix_summary.md` with **Fixed**, **Deviations**, **Deferred**, **Verification notes**.

Order tasks by severity (Critical → Low). Skip the role's file entirely if there are zero findings for that role (note it in the summary instead).

### `security_review_summary.md`
- `# Security Review — <slug>`
- `## Scope` — full codebase vs. pending; list of paths scanned; date (absolute)
- `## Methodology` — parallel FE/BE subagent scan + orchestrator infra sweep; checklist categories covered
- `## Findings` — table: `# | Severity | Category | Location | Owner (FE/BE/Infra) | Task file ref`
- `## Stats` — counts by severity and by category
- `## Out of scope` — anything noticed but deliberately skipped (quality, a11y, perf)
- `## Next steps` — point at the two task files; recommend running `/implement-round`-style execution or manual review

## Rules
- Never include non-security findings. If unsure, drop it.
- Cite real `file:line` references — no hand-waving.
- Do not apply fixes. This command only reports.
- Do not grep `.env` (real secrets) — only `.env.example` and committed configs.
- If a finding spans FE and BE (e.g. a contract-level auth gap), put the fix task in the role that owns the change and cross-reference from the other.

## After writing
Print a short summary: counts by severity per role and the paths of the three (or two) output files. Stop. Do not start fixing.
