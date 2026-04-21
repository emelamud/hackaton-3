# Round 5 — Backend Tasks

## Goal
Persist friendships + friend requests; ship a user-search endpoint with relationship resolution; implement the friendship + friend-request HTTP endpoints; emit `friend:request:new`, `friend:request:cancelled`, `friend:request:accepted` (to both sides), `friend:request:rejected`, and `friend:removed` through the existing Socket.io fan-out helpers so the FE gets live notifications without polling.

## Dependencies
- `shared/api-contract.md` §User Search Endpoint, §Friend Endpoints, extended §Socket Events — **source of truth**. Read the Rules preambles and the per-endpoint error strings; exact wording matters.
- `shared/types/friend.ts` — `Friend`, `FriendRequest`, `CreateFriendRequestBody`, `FriendRequest{Cancelled,Accepted,Rejected}Payload`, `FriendRemovedPayload`, `UserSearchResult`, `UserSearchRelationship`.
- `backend/CLAUDE.md` — route vs service separation, error handling, Drizzle patterns.
- `plans/round-4/backend_work_summary.md` §Next round needs to know — concrete call-site patterns (`getIo().in('user:<id>').emit(...)`), migration naming (`--name` flag works), the cause-chain 23505 trap used in `roomsService.createRoom`.

**Do not modify `/shared/`.** If the contract needs changes, stop and flag it to the orchestrator.

## Tasks

### 1. Drizzle schema — add `friendships` + `friend_requests` to `backend/src/db/schema.ts`

#### `friendships` table
Symmetric two-row design (Q1 = 1b):
- `user_id` uuid not null, FK → `users.id`, `onDelete: 'cascade'`
- `friend_user_id` uuid not null, FK → `users.id`, `onDelete: 'cascade'`
- `created_at` timestamp default now not null
- **Composite primary key** on `(user_id, friend_user_id)` — also serves as the lookup index for `GET /api/friends`.
- Add a `check` constraint `user_id <> friend_user_id` (no self-friendship rows).

Export `FriendshipRow` / `NewFriendshipRow` inferred types alongside the existing tables.

#### `friend_requests` table
- `id` uuid pk default
- `from_user_id` uuid not null, FK → `users.id`, `onDelete: 'cascade'`
- `to_user_id` uuid not null, FK → `users.id`, `onDelete: 'cascade'`
- `message` text (nullable), no length constraint at DB level — zod enforces 500 in the route layer.
- `created_at` timestamp default now not null

Indexes:
- `uniqueIndex('friend_requests_pair_idx').on(least(fromUserId, toUserId), greatest(fromUserId, toUserId))` — enforces the unordered-pair uniqueness (Q2). Drizzle doesn't expose `LEAST`/`GREATEST` natively; build it via `sql\`LEAST(${table.fromUserId}, ${table.toUserId})\`` in `uniqueIndex(...).on(sql\`...\`, sql\`...\`)` (Drizzle supports raw SQL in index expressions via the `index().on()` + `sql\`\`` form — verify against the current drizzle-orm version before committing).
- Plain `index('friend_requests_to_user_idx').on(toUserId)` — backs `GET /api/friend-requests/incoming`.
- Plain `index('friend_requests_from_user_idx').on(fromUserId)` — backs `GET /api/friend-requests/outgoing`.

Run `pnpm db:generate --name add_friends` → expect `0004_add_friends.sql` + `meta/0004_snapshot.json` + `_journal.json` entry. Review the generated SQL before committing: specifically confirm the functional unique index is `CREATE UNIQUE INDEX ... ON friend_requests (LEAST(from_user_id, to_user_id), GREATEST(from_user_id, to_user_id))`. If drizzle-kit can't express it, fall back to a hand-written follow-up migration `0005_friend_requests_pair_unique.sql` containing the raw SQL.

### 2. Update `backend/src/types/shared.ts`
Mirror from `/shared/types/friend.ts` (verbatim — same copy-in-place tax as prior rounds; orchestrator's Config Improvements flag tracks this):
- `Friend`, `FriendRequest`, `CreateFriendRequestBody`
- `FriendRequestCancelledPayload`, `FriendRequestAcceptedPayload`, `FriendRequestRejectedPayload`
- `FriendRemovedPayload`
- `UserSearchResult`, `UserSearchRelationship`

Keep the existing mirror section's structure — one `// ----- round N -----` block per round.

### 3. Service — `backend/src/services/friends.service.ts` (new file)
All DB access lives here. No `req` / `res`, no socket objects. Functions:

```ts
export async function listFriends(userId: string): Promise<Friend[]>;

export async function removeFriend(
  userId: string,
  otherUserId: string,
): Promise<void>;

export async function createFriendRequest(
  fromUserId: string,
  body: CreateFriendRequestBody,
): Promise<FriendRequest>;

export async function listIncomingFriendRequests(userId: string): Promise<FriendRequest[]>;

export async function listOutgoingFriendRequests(userId: string): Promise<FriendRequest[]>;

export async function acceptFriendRequest(
  recipientUserId: string,
  requestId: string,
): Promise<{ request: FriendRequest; friendForRecipient: Friend; friendForSender: Friend }>;

export async function rejectFriendRequest(
  recipientUserId: string,
  requestId: string,
): Promise<FriendRequest>; // returned so the route can emit friend:request:rejected to sender

export async function cancelFriendRequest(
  senderUserId: string,
  requestId: string,
): Promise<FriendRequest>; // returned so the route can emit friend:request:cancelled to recipient
```

Behaviour details:

- **`listFriends`**
  SELECT from `friendships` where `user_id = $1`, joined with `users` on `friend_user_id = users.id` to resolve `username`. `ORDER BY friendships.created_at DESC`. Shape each row to `{ userId, username, friendshipCreatedAt }` — `userId` is the other user.

- **`removeFriend`**
  1. Inside a transaction, `DELETE FROM friendships WHERE (user_id = $1 AND friend_user_id = $2) OR (user_id = $2 AND friend_user_id = $1)`. Capture the row count.
  2. If 0 rows deleted → `AppError('Not a friend', 404)`.
  3. Otherwise commit. Return void.
  4. No DB-level guarantee that exactly 2 rows are deleted — a successful 2-row delete is the normal path, but a self-healing "clean up a stray single row" is also acceptable. Log a warning if `deletedCount === 1` so an inconsistency is surfaced.

- **`createFriendRequest`**
  1. Load the target user by case-insensitive username match (`username ILIKE $1` with exact trim; reuse the comparison logic in `getUserByUsername` if one exists, else write it inline here). Not found → `AppError('User not found', 404)`.
  2. `target.id === fromUserId` → `AppError('You cannot send a friend request to yourself', 400)`.
  3. Query `friendships` for the unordered pair — if a row exists → `AppError('You are already friends with this user', 409)`.
  4. Insert the `friend_requests` row with `fromUserId`, `toUserId = target.id`, `message` (null if absent or empty-after-trim).
  5. On PG 23505 via cause-chain (uniqueness violation on `friend_requests_pair_idx`) → `AppError('A pending friend request already exists between you and this user', 409)` — this catches both the "resend from same direction" and "counter-request from the other side" cases uniformly.
  6. Return the denormalised `FriendRequest` — re-select joined with both `from_user` and `to_user` to resolve `fromUsername` / `toUsername`.

- **`listIncomingFriendRequests`** / **`listOutgoingFriendRequests`**
  Two near-identical queries. Filter by `to_user_id` / `from_user_id` respectively, join with `users` for both `fromUsername` and `toUsername`, `ORDER BY created_at DESC`.

- **`acceptFriendRequest`**
  1. Load the request (`404 "Friend request not found"`).
  2. If `request.to_user_id !== recipientUserId` → `AppError('Forbidden', 403)`.
  3. Inside a transaction:
     a. Insert two `friendships` rows — `(from, to)` and `(to, from)`. If a PG 23505 occurs (shouldn't — would mean they're already friends, which should have been blocked at request creation, but defensive), swallow and continue: the invariant we care about is "after this call, they are friends".
     b. Delete the request row.
  4. Re-select `users` for both sides' usernames + the invariant `friendshipCreatedAt` value used in step (a).
  5. Return `{ request, friendForRecipient, friendForSender }`:
     - `friendForRecipient.userId` = the sender (from the recipient's POV, the sender is now their friend).
     - `friendForSender.userId` = the recipient.
     - Each has the matching `username` and the same `friendshipCreatedAt` timestamp.

- **`rejectFriendRequest`**
  1. Load (`404`). Ownership check: `request.to_user_id !== recipientUserId` → `403 "Forbidden"`.
  2. Delete the row.
  3. Return the denormalised request so the route can emit `friend:request:rejected` to the sender.

- **`cancelFriendRequest`**
  1. Load (`404`). Ownership check: `request.from_user_id !== senderUserId` → `403 "Forbidden"`.
  2. Delete the row.
  3. Return the denormalised request so the route can emit `friend:request:cancelled` to the recipient.

### 4. Service — `backend/src/services/users.service.ts` (extend or create)
If a users service already exists (auth.service.ts holds most user queries), add a new function there or lift a separate `users.service.ts`. Whatever is more natural in the current layout — see `backend/src/services/` for the current pattern.

```ts
export async function searchUsers(
  callerUserId: string,
  q: string,
): Promise<UserSearchResult[]>;
```

Behaviour:
1. Trim `q`. If `q.length < 2` → `AppError('Search query must be at least 2 characters', 400)`.
2. Single query: `SELECT u.id, u.username FROM users u WHERE u.id <> $1 AND u.username ILIKE $2 || '%' ORDER BY (CASE WHEN lower(u.username) = lower($2) THEN 0 ELSE 1 END), lower(u.username) ASC LIMIT 20`.
3. In a follow-up query (or CTE if it's cleaner), compute `relationship` per row. Two batched lookups:
   - `friendships`: `WHERE user_id = $caller AND friend_user_id IN (...ids)` — any hit → `'friend'`.
   - `friend_requests`: `WHERE (from_user_id = $caller AND to_user_id IN (...)) OR (to_user_id = $caller AND from_user_id IN (...))` — hit where caller is `from` → `'outgoing_pending'`; hit where caller is `to` → `'incoming_pending'`.
4. Merge into `UserSearchResult[]` — `self` is never emitted (caller already excluded). Default is `'none'`.

Single query with two LEFT JOIN subqueries is also acceptable and probably faster — engineer's call.

### 5. Zod schemas
Alongside existing schemas (reuse `middleware/validate.ts`):

```ts
const createFriendRequestSchema = z.object({
  toUsername: z.string().trim().min(1).max(64),
  message: z.string().trim().max(500).optional(),
});

const userSearchQuerySchema = z.object({
  q: z.string().trim().min(2).max(64),
});
```

Params: reuse the existing `idSchema` (UUID) for `:id` in `/api/friend-requests/:id/*` and the new `:userId` in `/api/friends/:userId`. Rename `idSchema` if you want a param-agnostic name; otherwise just reuse.

Note: the `min(2)` zod refine on `q` produces the generic `"Validation failed"` envelope. To surface the exact `"Search query must be at least 2 characters"` string, do the check in the service layer (same pattern as Round 4's `patchRoom` "At least one field is required" — see `plans/round-4/backend_work_summary.md` Deviations #1 for the rationale).

### 6. Routes — `backend/src/routes/friends.ts` (new file)
Mount paths:
- `/api/friends` → friendshipsRouter (GET list, DELETE by userId)
- `/api/friend-requests` → friendRequestsRouter (create, accept/reject/cancel, list incoming/outgoing)
- `/api/users/search` → users router (same file is fine; separate file if users.service.ts ends up with more endpoints)

```ts
// /api/friends
friendshipsRouter.use(requireAuth);
friendshipsRouter.get('/', async (req, res) => res.json(await friendsService.listFriends(req.user.id)));
friendshipsRouter.delete('/:userId', validateParams(userIdSchema), async (req, res) => {
  await friendsService.removeFriend(req.user.id, req.params.userId);
  getIo().in(`user:${req.params.userId}`).emit('friend:removed', { userId: req.user.id } satisfies FriendRemovedPayload);
  res.status(204).end();
});

// /api/friend-requests
friendRequestsRouter.use(requireAuth);
friendRequestsRouter.get('/incoming', async (req, res) => res.json(await friendsService.listIncomingFriendRequests(req.user.id)));
friendRequestsRouter.get('/outgoing', async (req, res) => res.json(await friendsService.listOutgoingFriendRequests(req.user.id)));
friendRequestsRouter.post('/', validate(createFriendRequestSchema), async (req, res) => {
  const request = await friendsService.createFriendRequest(req.user.id, req.body);
  getIo().in(`user:${request.toUserId}`).emit('friend:request:new', request);
  res.status(201).json(request);
});
friendRequestsRouter.post('/:id/accept', validateParams(idSchema), async (req, res) => {
  const { request, friendForRecipient, friendForSender } = await friendsService.acceptFriendRequest(req.user.id, req.params.id);
  // each side gets the OTHER user in `friend`
  getIo().in(`user:${request.fromUserId}`).emit('friend:request:accepted',
    { requestId: request.id, friend: friendForSender } satisfies FriendRequestAcceptedPayload);
  getIo().in(`user:${request.toUserId}`).emit('friend:request:accepted',
    { requestId: request.id, friend: friendForRecipient } satisfies FriendRequestAcceptedPayload);
  res.json(friendForRecipient);
});
friendRequestsRouter.post('/:id/reject', validateParams(idSchema), async (req, res) => {
  const request = await friendsService.rejectFriendRequest(req.user.id, req.params.id);
  getIo().in(`user:${request.fromUserId}`).emit('friend:request:rejected',
    { requestId: request.id } satisfies FriendRequestRejectedPayload);
  res.status(204).end();
});
friendRequestsRouter.delete('/:id', validateParams(idSchema), async (req, res) => {
  const request = await friendsService.cancelFriendRequest(req.user.id, req.params.id);
  getIo().in(`user:${request.toUserId}`).emit('friend:request:cancelled',
    { requestId: request.id } satisfies FriendRequestCancelledPayload);
  res.status(204).end();
});

// /api/users/search
usersRouter.use(requireAuth);
usersRouter.get('/search', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  res.json(await usersService.searchUsers(req.user.id, q));
});
```

Wire all three routers into `backend/src/index.ts`:
- `app.use('/api/friends', friendshipsRouter);`
- `app.use('/api/friend-requests', friendRequestsRouter);`
- `app.use('/api/users', usersRouter);`

Do NOT collide with existing `/api/rooms/:id/invitations` — the new paths are disjoint.

### 7. Error-string sanity pass
Round-5 contract adds several new error strings. Grep the service + route diff for each literal and confirm it appears exactly once (or in exactly the error paths described):
- `"You cannot send a friend request to yourself"`
- `"You are already friends with this user"`
- `"A pending friend request already exists between you and this user"`
- `"Friend request not found"` (404 on accept/reject/cancel)
- `"Not a friend"` (404 on DELETE /api/friends/:userId)
- `"Search query must be at least 2 characters"`
- `"User not found"` (already existed in Round 4 invitations code — reuse verbatim in `createFriendRequest`)
- `"Forbidden"` (reused on all 403s)

### 8. Smoke check (run before writing summary)
Three registered users A, B, C. Drive HTTP + sockets as with Round 4. Use a scratch harness `tmp/round5/smoke.js` — same shape as `tmp/round4/smoke.js`.

1. All three connect sockets with valid tokens. A listens for `friend:request:rejected` and `friend:removed`. B listens for `friend:request:new`, `friend:request:cancelled`, `friend:request:accepted`. C listens for `friend:request:new`.
2. A `GET /api/users/search?q=b` → 200 `[{ id: B.id, username: 'bob_r5_<ts>', relationship: 'none' }, ...]`. Confirm self-exclusion (A not in results).
3. A `POST /api/friend-requests` `{ "toUsername": "<A>" }` → 400 `"You cannot send a friend request to yourself"`.
4. A `POST /api/friend-requests` `{ "toUsername": "ghost" }` → 404 `"User not found"`.
5. A `POST /api/friend-requests` `{ "toUsername": "<B>", "message": "hey bob" }` → 201 FriendRequest with `fromUsername`, `toUsername`, `message: "hey bob"`. B's socket fires `friend:request:new` with same payload.
6. A repeats → 409 `"A pending friend request already exists between you and this user"`.
7. B attempts reverse-direction `POST /api/friend-requests` `{ "toUsername": "<A>" }` → 409 (same string) — confirms unordered-pair uniqueness.
8. A `GET /api/users/search?q=b` again → 200 row for B has `relationship: 'outgoing_pending'`.
9. B `GET /api/users/search?q=a` → 200 row for A has `relationship: 'incoming_pending'`.
10. B `GET /api/friend-requests/incoming` → 200 with 1 item. A `GET /api/friend-requests/outgoing` → 200 with 1 item.
11. B `POST /api/friend-requests/<id>/accept` → 200 `Friend` with `userId: A.id, username: "alice_r5_<ts>"`. A's socket receives `friend:request:accepted` with `friend.userId === B.id`; B's socket also receives `friend:request:accepted` with `friend.userId === A.id`. Both sides verified.
12. A `GET /api/friends` → 200 `[{ userId: B.id, username, friendshipCreatedAt }]`. B `GET /api/friends` → same from B's POV.
13. A `GET /api/users/search?q=b` → 200 row for B now has `relationship: 'friend'`.
14. A `POST /api/friend-requests` `{ "toUsername": "<B>" }` → 409 `"You are already friends with this user"`.
15. A `POST /api/friend-requests` `{ "toUsername": "<C>" }` → 201. C's socket receives `friend:request:new`.
16. A `DELETE /api/friend-requests/<id>` → 204. C's socket receives `friend:request:cancelled` with matching `requestId`.
17. A invites C again. C `POST /api/friend-requests/<id>/reject` → 204. A's socket receives `friend:request:rejected` with matching `requestId`. No event to C.
18. A `DELETE /api/friends/<B.id>` → 204. B's socket receives `friend:removed` with `{ userId: A.id }`. A `GET /api/friends` → 200 `[]`. B `GET /api/friends` → 200 `[]` (both rows deleted).
19. A `DELETE /api/friends/<B.id>` again → 404 `"Not a friend"`.
20. Edge: permissions — A creates a request to B; C attempts `POST /api/friend-requests/<id>/accept` → 403 `"Forbidden"`. B (correct recipient) then `POST /api/friend-requests/<id>/reject` → 204.
21. `GET /api/users/search?q=a` → 200. `GET /api/users/search?q=` → 400 `"Search query must be at least 2 characters"`. `GET /api/users/search?q=<70 chars>` → 400 (zod envelope, not the min-length string).

Report actual ack / HTTP response bodies + socket payloads in the summary, not "passed". `pnpm lint` + `pnpm build` must pass.

## Wrap-up
Write `plans/round-5/backend_work_summary.md` with:
- **Built** — files touched, migration filename, service + route additions, socket emission call-sites
- **Deviations** — anything that differs from the contract (should be none if the grep step is honest)
- **Deferred** — user-to-user ban (Round 6 with DMs), friend-request expiry, outgoing-request notification badge (FE-only decision), friend requests initiated from a room member list (orchestrator-level deferral), integration tests (carry-over flag from all prior rounds)
- **Next round needs to know** — for Round 6 (DMs): the `friendships` row is the gate for `POST /api/dm` upsert — verify both rows still exist on every DM send, or just one canonical lookup `WHERE user_id = $caller AND friend_user_id = $other`. Round 6 also adds the user-to-user ban, which will add a second gate and need a new `user_bans` table keyed by `(blocker_user_id, blocked_user_id)` with `onDelete cascade` mirrored on both user FKs. For Round 7 (presence): presence needs to know the caller's friends + DM participants to know who to snapshot — the `listFriends` query is the primary input.
- **Config improvements** — migration naming (`--name` flag once again); functional unique index support in drizzle-kit (if the hand-written fallback was necessary, note it); whether `rootDir` relaxation on `backend/tsconfig.json` has been attempted yet (Rounds 2, 3, 4 all flagged the `backend/src/types/shared.ts` copy-in-place tax); integration tests (still open from Round 1); whether to promote `getIo().in('user:<id>').emit(...)` into a typed helper now that three rounds use it.
