# Security Review — Backend Fix Tasks

## Goal
Close the security findings surfaced during the round-4 security review of `/backend` and the cross-cutting infra bits that the backend owns (docker-compose, Dockerfile). Security only — do not bundle refactors, perf, or test-coverage work into these tasks.

## Dependencies
- `shared/api-contract.md` — auth/refresh/cookie/session semantics; treat as source of truth when deciding what a fix may and may not change.
- `backend/CLAUDE.md` — route vs. service separation, `AppError` + `errorHandler`, zod validation, config.ts as the single env-var entrypoint.
- `plans/round-4/backend_tasks.md` + `plans/round-4/backend_work_summary.md` for prior-round context.
- Do **not** modify `/shared/`. If a fix requires a contract change (e.g., cookie `path`, error-string rewording), stop and flag it to the orchestrator first.

## Tasks (ordered by severity)

### 1. [High] Weak / placeholder JWT secrets + no startup validation
**File(s):** `backend/.env.example:3-5`, `backend/src/config.ts:10-12`
**Category:** Secrets
**Problem:** `.env.example` ships placeholder values `change-me`, `change-me-too`, `change-me-three` for the three JWT secrets. `config.ts` only verifies presence (`require_env`) — it accepts any non-empty string, including the placeholders. If an operator forgets to rotate them before a first deploy (or inherits these into a CI secret store), anyone with access to the repo can forge access tokens, refresh tokens, and password-reset tokens.
**Fix:**
1. Keep `.env.example` as-is (documentation only), **but** add startup validation in `config.ts`:
   ```ts
   const PLACEHOLDERS = new Set(['change-me', 'change-me-too', 'change-me-three', 'secret', 'changeme']);
   function requireStrongSecret(name: string): string {
     const val = require_env(name);
     if (val.length < 32 || PLACEHOLDERS.has(val)) {
       throw new Error(`${name} must be at least 32 chars and not a placeholder`);
     }
     return val;
   }
   ```
   Use it for `JWT_SECRET`, `JWT_REFRESH_SECRET`, `JWT_RESET_SECRET`.
2. In `production` (`NODE_ENV === 'production'`) additionally require the three secrets to be distinct from each other.
3. Document (in `.env.example` comments) to generate each with `openssl rand -base64 48`.

### 2. [High] `express.json()` has no body-size limit
**File(s):** `backend/src/index.ts:25`
**Category:** Rate Limiting / DoS
**Problem:** `app.use(express.json())` accepts the default 100KB but the real risk is documented differently across versions; worse, even 100KB allows 1000 concurrent uploads to allocate ~100MB. There is no explicit cap, so operators cannot rely on it. An attacker can POST very large JSON bodies to unauthenticated endpoints (`/api/auth/login`, `/api/auth/register`, `/api/auth/reset-password`) and exhaust memory/CPU during parsing.
**Fix:** Set an explicit, conservative limit — the largest legitimate payload is the chat message at 3072 chars, auth bodies are tiny:
```ts
app.use(express.json({ limit: '16kb' }));
```
Pick whatever number comfortably fits every real payload plus a margin (e.g., 32kb). No route in the round-4 contract requires more.

### 3. [High] No rate limiting on auth endpoints (or anywhere else)
**File(s):** `backend/src/index.ts:15-45`, `backend/src/routes/auth.ts` (entire file)
**Category:** Rate Limiting / DoS
**Problem:** None of `/api/auth/login`, `/api/auth/register`, `/api/auth/forgot-password`, `/api/auth/reset-password`, `/api/auth/refresh` has any throttling. Combined with user-enumeration signals (task 8) and unbounded reset-token brute-force potential, this enables credential stuffing, password spraying, and enumeration at scale. bcrypt with 12 rounds is the only throttle and it is CPU-bound on the server, not the attacker.
**Fix:**
1. Add `express-rate-limit` (already small, well-maintained).
2. Define two limiters in `backend/src/middleware/rateLimit.ts`:
   ```ts
   export const authLimiter = rateLimit({ windowMs: 15 * 60_000, max: 10, standardHeaders: true, legacyHeaders: false });
   export const apiLimiter = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false });
   ```
3. Mount `apiLimiter` globally after `express.json()`, and layer `authLimiter` on top of the five auth routes above.
4. Per-route buckets for `/api/rooms/:id/messages` (listing) can reuse `apiLimiter`; no separate bucket required in round 4.
5. Requires `app.set('trust proxy', ...)` from task 15 so the limiter keys off the real client IP.

### 4. [High] No security headers (`helmet` absent)
**File(s):** `backend/src/index.ts:15-26`
**Category:** Transport
**Problem:** Responses lack `X-Content-Type-Options`, `X-Frame-Options`, `Strict-Transport-Security`, a baseline `Content-Security-Policy`, `Referrer-Policy`, and CORP/COEP. The API can be framed/sniffed and HSTS is never sent in production.
**Fix:**
```ts
import helmet from 'helmet';
app.use(helmet({
  contentSecurityPolicy: config.nodeEnv === 'production' ? undefined : false,
  crossOriginResourcePolicy: { policy: 'same-site' },
  hsts: config.nodeEnv === 'production' ? { maxAge: 31_536_000, includeSubDomains: true } : false,
}));
```
Place it before the routes, after CORS. Cross-reference FE task 8 — the CSP story is completed either here (header) or via `<meta>` on the frontend, pick one (prefer here).

### 5. [High] Socket.io has no payload-size cap and no emit rate limit
**File(s):** `backend/src/socket/io.ts:24-30`, `backend/src/socket/handlers/message.ts` (the `message:send` handler)
**Category:** Rate Limiting / DoS
**Problem:** The `Server` constructor does not pass `maxHttpBufferSize`, so the default 1 MB applies — four orders of magnitude above the 3072-char message cap. There is also no per-socket emit limit, so a single authenticated socket can drive message emissions as fast as the event loop allows (each emit triggers a DB insert + broadcast).
**Fix:**
1. Cap the buffer:
   ```ts
   new Server(httpServer, { cors: {...}, maxHttpBufferSize: 16 * 1024 });
   ```
2. Add a lightweight token-bucket / sliding-window limiter around `message:send`:
   ```ts
   const buckets = new WeakMap<Socket, { tokens: number; ts: number }>();
   function allow(socket: Socket): boolean {
     const now = Date.now();
     const b = buckets.get(socket) ?? { tokens: 10, ts: now };
     b.tokens = Math.min(10, b.tokens + (now - b.ts) / 1000 * 5); // 5/sec refill, burst 10
     b.ts = now;
     if (b.tokens < 1) return false;
     b.tokens -= 1;
     buckets.set(socket, b);
     return true;
   }
   ```
   On reject, ack with `{ ok: false, error: 'Rate limit exceeded' }` (new literal — confirm with orchestrator before adding to contract).

### 6. [High] Password-reset token logged to stdout
**File(s):** `backend/src/services/auth.service.ts:242-248`
**Category:** Info Disclosure
**Problem:** `console.log('[PASSWORD RESET] Token for ${user.email}: ${resetToken}')` writes a bearer credential — usable by anyone for the next hour to change that account's password — into the application log. Any log sink (aggregator, terminal scrollback, CI artifacts, support ticket exports) now holds a full account-takeover primitive.
**Fix:**
- Remove the `console.log` entirely. Even in development, never log secrets.
- If a developer-facing dev-only path is still needed while email delivery is unimplemented, write to a file under `.dev-artifacts/password-resets.log` that is gitignored, gated by `config.nodeEnv !== 'production'`, and include only the token — never `user.email`.
- The contract already returns `204` regardless of whether the email exists (no enumeration), so no endpoint response changes.

### 7. [High] Password-reset tokens are stateless JWTs, not single-use
**File(s):** `backend/src/services/auth.service.ts:242-271` (issue path), same file `resetPassword` (consume path)
**Category:** Auth
**Problem:** Reset tokens are JWTs signed with `JWT_RESET_SECRET` and a 1-hour TTL. There is no server-side tracking of whether a token has been used, so a captured token (from the log leak in task 6, or from email forwarding, history sync, etc.) can be replayed repeatedly during its TTL — even after the legitimate user has already reset their password once.
**Fix:**
Pick one of:
1. **Token-version approach (smaller change):** Add `password_reset_token_version: integer` on `users`. Embed the current version in the reset JWT payload. On `resetPassword`: compare versions; on success bump the column. Any prior issued token fails verification.
2. **Dedicated table approach (cleaner):** Create `password_reset_tokens (id uuid pk, user_id uuid fk, jti uuid unique, used_at timestamp null, expires_at timestamp)`. Embed `jti` in the JWT; on consume, `UPDATE ... SET used_at = now() WHERE jti = $1 AND used_at IS NULL RETURNING id`; treat zero rows as 400 "Reset token is invalid or has expired".
Either way, also keep the existing "invalidate all sessions on successful reset" behavior.

### 8. [Medium] User enumeration via distinct register conflict errors
**File(s):** `backend/src/services/auth.service.ts:92-104`
**Category:** Info Disclosure
**Problem:** `/api/auth/register` returns `409 "Email already in use"` vs. `409 "Username already taken"` vs. success on 201. An unauthenticated attacker can enumerate both email addresses and usernames of existing users. Combined with no rate limiting (task 3) this is a fast, cheap oracle.
**Fix:**
- Preferred: the contract today exposes both strings; treat this as a contract-level question and flag to the orchestrator. If the contract collapses both into one message (e.g., `"Registration failed — try different credentials"`), update `shared/api-contract.md` + `.../auth.service.ts` together.
- Minimum (without contract change): apply `authLimiter` (task 3) and consider blocking rapid same-IP register attempts after N distinct attempts.
- If registration is ever gated behind invite/captcha, the oracle shrinks further.

### 9. [Medium] Logout does not invalidate the access JWT
**File(s):** `backend/src/services/auth.service.ts:162-164`, `backend/src/middleware/auth.ts:29` (verify path)
**Category:** Auth
**Problem:** `logout` deletes the refresh-session row but the access token remains valid until its natural `exp` (15 min). `verifyAccessToken` only checks signature + expiry — it never cross-references the `sessions` row — so a stolen/cached access token continues to work after logout.
**Fix:** In `requireAuth`, after verifying the JWT, look up `sessions.id = req.user.sessionId` and require the row to exist and be unexpired; otherwise throw `AppError('Unauthorized', 401)`. The `sessionId` is already embedded in the payload per round-2/3 summaries.

### 10. [Medium] Refresh endpoint silently upgrades non-persistent sessions to 30 days
**File(s):** `backend/src/routes/auth.ts:96-120`, `backend/src/routes/auth.ts:13-20` (`setRefreshCookie`)
**Category:** Auth
**Problem:** A login with `keepSignedIn: false` issues a session cookie (no `maxAge`). On the next call to `/api/auth/refresh`, the handler calls `setRefreshCookie(res, newToken, true)` unconditionally — converting the cookie into a 30-day persistent one. This defeats the user's explicit choice on a shared device.
**Fix:**
- Persist the `persistent` flag on the `sessions` row when issuing tokens.
- In the refresh handler, pass that flag back into `setRefreshCookie` so the cookie retains its original nature.
- Alternatively, detect persistence from `req.cookies[REFRESH_COOKIE]` source metadata if the DB change is heavy — but the DB column is cleaner and supports the task-9 session lookup.

### 11. [Medium] DB Pool connects without TLS in production
**File(s):** `backend/src/db/pool.ts:3-5`
**Category:** Transport
**Problem:** `new Pool({ connectionString })` with no `ssl` option never enables TLS. If the Postgres host is ever on a different network than the backend, credentials and every message body / password hash travel in plaintext. `sslmode=require` in the URL alone does not cause node-postgres to validate the server cert.
**Fix:**
```ts
import { config } from '../config';
export const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.nodeEnv === 'production' ? { rejectUnauthorized: true } : false,
});
```
If a CA bundle is needed, load it via a new `DATABASE_CA_PATH` env var. Fail startup in production if `DATABASE_URL` implies TLS but the CA is missing.

### 12. [Medium] Stale socket room subscriptions after membership changes
**File(s):** `backend/src/socket/io.ts:48-66` (connection-time join), and all REST paths that mutate `room_members`
**Category:** Socket Auth / Authorization
**Problem:** On connection the socket is auto-joined to every `room:<id>` the user currently belongs to. If membership changes *during* the socket's lifetime (leave/kick/admin action), other active sockets/tabs continue to receive `message:new` and `room:updated` broadcasts until they disconnect. Today only `POST /api/rooms/:id/leave` calls `socketsLeave`. Any future admin kick path or room-deletion path that forgets the mirror will leak.
**Fix:**
- Add a small helper in `backend/src/socket/io.ts`:
  ```ts
  export function leaveAllSockets(userId: string, roomId: string) {
    getIo().in(`user:${userId}`).socketsLeave(`room:${roomId}`);
  }
  ```
- Require every membership-removal service to call it (leave today; kick/ban/delete in later rounds — flag for round-11 plan).
- Defense-in-depth: in the `message:new` broadcast path, before emitting a room-scoped event, the service already checks membership on send for the sender; add a periodic reconciler or rely on the invariant that every `leave` path calls `leaveAllSockets`. Document the invariant in `backend/CLAUDE.md`.

### 13. [Low] Refresh cookie has no `path` attribute
**File(s):** `backend/src/routes/auth.ts:13-20` (`setRefreshCookie` / `clearRefreshCookie`)
**Category:** Auth
**Problem:** The refresh cookie is scoped to `/`, so the browser attaches it to every same-origin request (`/api/rooms`, `/api/invitations`, `/socket.io/`), not only to the auth endpoints that need it.
**Fix:** Add `path: '/api/auth'` to both `res.cookie(...)` and `res.clearCookie(...)` calls so the cookie is only sent to `/api/auth/*` routes. Verify the FE interceptor (see FE task 4) still triggers `withCredentials: true` on `/api/auth/refresh` specifically.

### 14. [Low] JWT algorithm not pinned on sign or verify
**File(s):** `backend/src/services/auth.service.ts:41-68` (sign paths), `backend/src/middleware/auth.ts:29` (verify), `backend/src/services/auth.service.ts:253` (reset verify)
**Category:** Auth / Crypto
**Problem:** None of the `jwt.sign(...)` / `jwt.verify(...)` calls pass an explicit `algorithm` / `algorithms` option. `jsonwebtoken` defaults to HS256 for sign, but `verify` will accept whatever algorithm the token's header claims is valid. This is the classic vector for algorithm-confusion attacks if the secret is ever reused as a public key, or for silent misconfiguration later.
**Fix:** Pass options consistently:
- Sign: `jwt.sign(payload, secret, { expiresIn, algorithm: 'HS256' })`
- Verify: `jwt.verify(token, secret, { algorithms: ['HS256'] })`
Add a small wrapper in `backend/src/services/auth.service.ts` (or new `jwt.ts`) to centralise so future additions can't drift.

### 15. [Low] `trust proxy` not configured
**File(s):** `backend/src/index.ts:15-45`
**Category:** Transport / Config
**Problem:** `app.set('trust proxy', ...)` is never called. `req.ip` captured into `sessions.ip_address` (`routes/auth.ts:44, 68, 109`) is the reverse-proxy's IP in every real deployment, and the rate limiter from task 3 would key off the proxy instead of the client.
**Fix:**
```ts
if (config.nodeEnv === 'production') app.set('trust proxy', 1);
```
Revisit the value when the deployment topology is final (e.g., multiple proxies → integer > 1).

### 16. [Low] Refresh-token lookup is not time-constant end-to-end
**File(s):** `backend/src/services/auth.service.ts:170-185`
**Category:** Crypto
**Problem:** Refresh tokens are compared by querying `eq(sessions.refreshTokenHash, hashToken(refreshToken))`. The DB compares hash bytes exactly and the index probe is fast, but the whole flow is not time-constant. UUIDv4 refresh tokens have ~122 bits of entropy so practical exploitation is infeasible — treat this as defense-in-depth.
**Fix (optional):** Split the refresh cookie into `sessionId.secret`, look up the row by `sessionId`, then `crypto.timingSafeEqual(Buffer.from(hashToken(secret)), Buffer.from(row.refreshTokenHash))`. Either accept the current risk and add a comment explaining the rationale in `auth.service.ts`, or implement the split.

---

## Infra findings (BE owns the deploy config)

### 17. [Medium] Database credentials hard-coded in `docker-compose.yml` (committed)
**File(s):** `docker-compose.yml:5-9, 29`
**Category:** Secrets / Config
**Problem:** `POSTGRES_USER: chat`, `POSTGRES_PASSWORD: chat`, and the same credential baked into `DATABASE_URL: postgresql://chat:chat@...` are all in the committed compose file. Anyone with read access to the repo knows the dev DB credentials. In a hackathon these are low value, but copy-paste into staging/prod deployments is the recurring failure mode.
**Fix:**
- Replace literal values with environment substitution:
  ```yaml
  environment:
    POSTGRES_DB: ${POSTGRES_DB:-chat}
    POSTGRES_USER: ${POSTGRES_USER:-chat}
    POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}
  ```
  And in the backend service: `DATABASE_URL: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}`
- Document in root `.env.example` (create if missing) that `POSTGRES_PASSWORD` must be set; compose will refuse to start otherwise.
- Add a README callout that production deployments must supply secrets via a secret manager, not the compose file.

### 18. [Medium] Postgres port 5432 is published to the host
**File(s):** `docker-compose.yml:11-12`
**Category:** Transport / Config
**Problem:** `ports: - "5432:5432"` binds the Postgres container to `0.0.0.0:5432` on the host. On a laptop this is only LAN-reachable, but if the docker host is ever on a shared network (coworking, coffee shop, cloud VM with a default SG), the DB is exposed outside the container network. The backend does not need host-published ports to talk to postgres — it uses the compose network.
**Fix:**
- Drop the `ports:` stanza for the `postgres` service, **or**
- Bind to loopback only: `ports: - "127.0.0.1:5432:5432"` if local DB-client access is desired.

### 19. [Low] Backend container runs as root
**File(s):** `docker/backend.Dockerfile:16-33`
**Category:** Config
**Problem:** The runtime image has no `USER` directive so the `node` process runs as root. A compromise of the node process (e.g., via an npm supply-chain issue) has full root access inside the container and can trivially write to any mounted volume.
**Fix:** The `node:20-alpine` base image already ships a `node` user. After the `COPY` steps and before `ENTRYPOINT`:
```dockerfile
RUN chown -R node:node /app /entrypoint.sh
USER node
```
Verify the uploads dir (`/app/uploads`, if used) is also owned by `node` when the volume is mounted.

---

## Wrap-up
Write `plans/reviews/round-4/backend_fix_summary.md` with:
- **Fixed** — per task: files touched, libs added (`helmet`, `express-rate-limit`), new env validation lines, migration (if any for task 7). Mention migration filename once generated.
- **Deviations** — anywhere the fix diverges from the task description and why (especially on task 8 if the contract could not be changed in this pass).
- **Deferred** — e.g. task 16 (time-constant compare) if treated as accept-risk; task 8 contract-level rewrite if orchestrator punted it.
- **Verification notes** — concrete evidence: `curl -v http://localhost:3000/api/auth/login -d '...' | grep -i strict-transport-security`, rate-limit 429 after N attempts, `netstat` / `docker compose port postgres 5432` showing loopback-only bind, container running as `node` (`docker compose exec backend id`), reset token no longer in logs.
