# Round 6 — Backend Tasks

## Goal
Persist DMs and user-to-user bans; ship the `POST /api/dm` upsert endpoint and the three user-ban HTTP endpoints; gate `message:send` on DM rooms against active bans; retrofit the existing rooms/invitations endpoints so DMs can't be edited, joined, left, or invited; wire three new socket emissions (`dm:created`, `user:ban:applied`, `user:ban:removed`) through the existing typed `emitToUser` helper.

## Dependencies
- `shared/api-contract.md` §Rooms Endpoints (updated Rules block), §Direct Message Endpoints, §User Ban Endpoints, extended §Socket Events — **source of truth**. Read the Rules preambles; the error strings must match verbatim.
- `shared/types/room.ts` — updated shape: `type: 'channel' | 'dm'`, nullable `name` / `ownerId`, optional `dmPeer`.
- `shared/types/user-ban.ts` — new types: `UserBan`, `CreateUserBanRequest`, `UserBanAppliedPayload`, `UserBanRemovedPayload`.
- `shared/types/socket.ts` — new events: `dm:created`, `user:ban:applied`, `user:ban:removed`.
- `backend/CLAUDE.md` — `@shared` path alias is now configured; import from `@shared` directly. `src/socket/` has typed emit helpers `emitToUser` and `emitToRoom` — use them for every new call-site, don't hand-roll `getIo().in('user:<id>').emit(...)`.
- `plans/round-5/backend_work_summary.md` §Next round needs to know — friendship lookup is `SELECT 1 FROM friendships WHERE user_id=$caller AND friend_user_id=$other LIMIT 1`; `emitToUser` is the new call-site pattern.
- `backend/src/socket/io.ts` — `emitToUser<E>` and `emitToRoom<E>` signatures are typed against `ServerToClientEvents`; adding new events to the shared interface automatically makes the helpers know about them.

**Do not modify `/shared/`.** If the contract needs changes, stop and flag it to the orchestrator.

## Tasks

### 1. Drizzle schema — extend `rooms` + add two new tables in `backend/src/db/schema.ts`

#### Modify `rooms`
- Add `roomType` pgEnum: `pgEnum('room_type', ['channel', 'dm'])`.
- Add column `type: roomType('type').notNull().default('channel')` — default lets the migration backfill existing rows in one SQL statement.
- Make `name` nullable: `text('name')` (drop the `.notNull()`, keep `.unique()`).
- Make `ownerId` nullable: remove `.notNull()`; keep the FK + `onDelete: 'cascade'`.
- Add two CHECK constraints (via `check` from `drizzle-orm/pg-core`):
  - `rooms_channel_name_required`: `((type = 'channel' AND name IS NOT NULL) OR type = 'dm')`.
  - `rooms_channel_owner_required`: `((type = 'channel' AND owner_id IS NOT NULL) OR type = 'dm')`.
- Keep the existing `rooms_name_lower_idx` unique index — Postgres treats NULLs as distinct by default, so DMs (name NULL) don't collide.

#### New table `direct_messages`
- `room_id` uuid PK, FK → `rooms.id`, `onDelete: 'cascade'`.
- `user_a_id` uuid not null, FK → `users.id`, `onDelete: 'cascade'` — stored as `LEAST(caller, target)`.
- `user_b_id` uuid not null, FK → `users.id`, `onDelete: 'cascade'` — stored as `GREATEST(caller, target)`.
- `created_at` timestamp default now not null.
- `uniqueIndex('direct_messages_pair_idx').on(user_a_id, user_b_id)` — the primary lookup index for the upsert. Since the columns themselves are already canonicalised, no functional `LEAST/GREATEST` index needed.
- CHECK constraint `direct_messages_no_self`: `user_a_id <> user_b_id`.
- CHECK constraint `direct_messages_canonical_order`: `user_a_id < user_b_id` — enforces that the insert side actually passed canonicalised values.

Export `DirectMessageRow` / `NewDirectMessageRow` inferred types.

#### New table `user_bans`
- `blocker_user_id` uuid not null, FK → `users.id`, `onDelete: 'cascade'`.
- `blocked_user_id` uuid not null, FK → `users.id`, `onDelete: 'cascade'`.
- `created_at` timestamp default now not null.
- Composite PK `(blocker_user_id, blocked_user_id)` — doubles as the lookup index for `GET /api/user-bans`.
- `index('user_bans_blocked_user_idx').on(blocked_user_id)` — backs the "is this caller banned by anyone" / DM message-send check in the reverse direction.
- CHECK constraint `user_bans_no_self`: `blocker_user_id <> blocked_user_id`.

Export `UserBanRow` / `NewUserBanRow` inferred types.

Run `pnpm db:generate --name add_dms_and_user_bans`. Expected filename: `0006_add_dms_and_user_bans.sql` (`0005_add_friends.sql` was Round 5). Review the generated SQL before committing — specifically:
- `ALTER TABLE rooms ALTER COLUMN name DROP NOT NULL;` + `ALTER COLUMN owner_id DROP NOT NULL;`
- `CREATE TYPE room_type AS ENUM ('channel', 'dm');`
- `ALTER TABLE rooms ADD COLUMN type room_type DEFAULT 'channel' NOT NULL;` (default backfills existing rows in one statement)
- Two `ALTER TABLE rooms ADD CONSTRAINT ... CHECK (...)` for name/owner requirements.
- Two `CREATE TABLE` for `direct_messages` and `user_bans` + their indices + CHECK constraints.

### 2. Backend no longer mirrors `/shared/` types
Per `backend/CLAUDE.md`, the `@shared` path alias is configured — import the new types directly:

```ts
import type {
  Room, RoomDetail, RoomType, DmPeer, OpenDmRequest,
  UserBan, CreateUserBanRequest, UserBanAppliedPayload, UserBanRemovedPayload,
  ServerToClientEvents,
} from '@shared';
```

If `backend/src/types/shared.ts` still exists, delete the Round-5 friend block's `Friend` / `FriendRequest` re-exports too while you're here (or at least stop adding to it) and import from `@shared` throughout the round's new code. Removing the file entirely is a carry-over cleanup that Round 5 flagged — do it if nothing outside the Round-6 diff still references it; otherwise leave it in place and only use `@shared` for new imports.

### 3. Service — `backend/src/services/dm.service.ts` (new file)

```ts
export async function openDirectMessage(
  callerUserId: string,
  targetUserId: string,
): Promise<{ room: RoomDetail; created: boolean }>;
```

Behaviour:

1. **Self-check**: `targetUserId === callerUserId` → `AppError('You cannot open a DM with yourself', 400)`.
2. **Target user exists**: `SELECT id, username FROM users WHERE id=$targetUserId` — 404 `"User not found"` if absent.
3. **Friendship gate**: `SELECT 1 FROM friendships WHERE user_id=$caller AND friend_user_id=$target LIMIT 1` — absent → `AppError('You must be friends to start a direct message', 403)`.
4. **Ban gate**: `SELECT 1 FROM user_bans WHERE (blocker_user_id=$caller AND blocked_user_id=$target) OR (blocker_user_id=$target AND blocked_user_id=$caller) LIMIT 1` — any hit → `AppError('Personal messaging is blocked', 403)`.
5. **Canonical pair**: `userA = min(callerId, targetId)` / `userB = max(callerId, targetId)` (string comparison is fine — uuids sort lexicographically).
6. **Upsert path**:
   - `SELECT room_id FROM direct_messages WHERE user_a_id=$userA AND user_b_id=$userB`.
   - Hit → load `RoomDetail` for that `room_id` via `roomsService.getRoom(callerUserId, roomId)` (reuse existing helper which resolves members + denormalises `dmPeer`), return `{ room, created: false }`.
   - Miss → transaction:
     1. `INSERT INTO rooms (type, name, description, visibility, owner_id) VALUES ('dm', NULL, NULL, 'private', NULL) RETURNING id, created_at`.
     2. `INSERT INTO direct_messages (room_id, user_a_id, user_b_id) VALUES (...)`.
     3. `INSERT INTO room_members` twice, both with `role='member'`.
     4. Commit. Reload `RoomDetail` via `roomsService.getRoom`.
     5. Return `{ room, created: true }`.
7. **Caller's POV for `dmPeer`**: the returned `RoomDetail`'s `dmPeer` must be the OTHER user (targetUserId + target's username), never the caller. `roomsService.getRoom` needs to be parametrised by caller id so it can compute `dmPeer` correctly — see task 4.

Transaction scope note: use a single `db.transaction(async (tx) => {...})` for the insert block. The 23505 case (race where two concurrent `POST /api/dm` requests both miss the SELECT and try to INSERT) is caught by the `direct_messages_pair_idx` unique constraint; on 23505, re-run step 6's SELECT inside the catch block and return `{ room, created: false }` — this is the textbook "upsert" path.

### 4. Service — `backend/src/services/rooms.service.ts` (extend)

The existing `roomsService.getRoom` / `listRoomsForUser` / whatever helper builds `RoomDetail` needs to:
- Include `type` from the `rooms` row.
- Include `dmPeer` when `type='dm'`: for the CALLER's POV, `dmPeer = { userId, username }` of the OTHER `room_members` row (filter by `userId <> callerUserId`).
- Leave `dmPeer` undefined for channels.
- Ensure `name` / `ownerId` can flow through as `null` in the response — update the typescript return type to match the updated `/shared/types/room.ts`.

Every existing consumer in `backend/src/routes/rooms.ts` and `backend/src/routes/invitations.ts` must pass through the `callerUserId` so `dmPeer` is computed correctly. The `POST /api/rooms` creator-auto-joined-as-owner path stays unchanged (channels); DMs don't use it.

### 5. Routes — `backend/src/routes/rooms.ts` (extend)

Retrofit the three existing DM-hostile endpoints with a type-check that short-circuits before the normal logic:

- **`PATCH /api/rooms/:id`** — if the target room's `type='dm'`, short-circuit to `AppError('DM rooms are not editable', 400)`. Put the check inside `roomsService.patchRoom` (keep the route thin).
- **`POST /api/rooms/:id/join`** — if `type='dm'`, `AppError('Direct messages are only reachable via /api/dm', 403)`. Put the check inside `roomsService.joinRoom`.
- **`POST /api/rooms/:id/leave`** — if `type='dm'`, `AppError('DM rooms cannot be left', 403)`. Put the check inside `roomsService.leaveRoom`.

**`GET /api/rooms`** / **`GET /api/rooms/:id`** need no special-casing — they already read all rooms the caller is a member of, which naturally includes DMs. Just make sure `type` + `dmPeer` flow through the response.

### 6. Routes — `backend/src/routes/invitations.ts` (extend)

In `POST /api/rooms/:id/invitations` (service `invitationsService.create` or equivalent), if the target room's `type='dm'`, throw `AppError('DMs cannot have invitations', 400)` **before** the public-room check. Place this new check first so the error ordering is deterministic.

### 7. Routes — `backend/src/routes/dm.ts` (new file)

```ts
const dmRouter = Router();
dmRouter.use(requireAuth);

const openDmSchema = z.object({
  toUserId: z.string().uuid(),
});

dmRouter.post('/', validate(openDmSchema), async (req, res) => {
  const { room, created } = await dmService.openDirectMessage(
    req.user!.id,
    req.body.toUserId,
  );

  if (created) {
    // Subscribe both users' existing sockets to the new `room:<id>`
    // before broadcasting, so the first `message:new` lands correctly.
    getIo().in(`user:${req.user!.id}`).socketsJoin(`room:${room.id}`);
    getIo().in(`user:${req.body.toUserId}`).socketsJoin(`room:${room.id}`);

    // Each side receives a RoomDetail whose `dmPeer` is the OTHER participant.
    // Build two payloads with the peer flipped.
    const callerView = room;                                // dmPeer already = target
    const targetView = await roomsService.getRoom(req.body.toUserId, room.id);
    emitToUser(req.user!.id, 'dm:created', callerView);
    emitToUser(req.body.toUserId, 'dm:created', targetView);
  }

  res.status(created ? 201 : 200).json(room);
});

export { dmRouter };
```

Wire in `backend/src/index.ts`: `app.use('/api/dm', dmRouter);`.

### 8. Routes — `backend/src/routes/user-bans.ts` (new file)

```ts
const userBansRouter = Router();
userBansRouter.use(requireAuth);

const createUserBanSchema = z.object({
  userId: z.string().uuid(),
});
const userIdSchema = z.object({ userId: z.string().uuid() });

userBansRouter.get('/', async (req, res) =>
  res.json(await userBansService.listBans(req.user!.id)),
);

userBansRouter.post('/', validate(createUserBanSchema), async (req, res) => {
  await userBansService.banUser(req.user!.id, req.body.userId);
  emitToUser(req.body.userId, 'user:ban:applied', { userId: req.user!.id });
  // If the ban severed a friendship, the service also returned that fact
  // — in that case emit friend:removed to keep Round 5's UI wiring happy.
  // See service signature below; emissions stay in the route.
  res.status(204).end();
});

userBansRouter.delete('/:userId', validateParams(userIdSchema), async (req, res) => {
  await userBansService.unbanUser(req.user!.id, req.params.userId);
  emitToUser(req.params.userId, 'user:ban:removed', { userId: req.user!.id });
  res.status(204).end();
});

export { userBansRouter };
```

Wire in `backend/src/index.ts`: `app.use('/api/user-bans', userBansRouter);`.

### 9. Service — `backend/src/services/user-bans.service.ts` (new file)

```ts
export async function listBans(callerUserId: string): Promise<UserBan[]>;

export async function banUser(
  callerUserId: string,
  targetUserId: string,
): Promise<{ severedFriendship: boolean }>;

export async function unbanUser(
  callerUserId: string,
  targetUserId: string,
): Promise<void>;
```

Behaviour:

- **`listBans`**: `SELECT ... FROM user_bans INNER JOIN users ON users.id = user_bans.blocked_user_id WHERE user_bans.blocker_user_id = $caller ORDER BY user_bans.created_at DESC`. Return `{ userId, username, createdAt }[]`.

- **`banUser`**:
  1. `targetUserId === callerUserId` → `AppError('You cannot ban yourself', 400)`.
  2. Target user exists? → 404 `"User not found"` if not.
  3. Inside a transaction:
     a. `INSERT INTO user_bans (blocker_user_id, blocked_user_id) VALUES ($caller, $target)`. On 23505 (cause-chain) → `AppError('User is already banned', 409)`.
     b. `DELETE FROM friendships WHERE (user_id=$caller AND friend_user_id=$target) OR (user_id=$target AND friend_user_id=$caller) RETURNING user_id` — capture the count; `severedFriendship = rows.length > 0`.
     c. `DELETE FROM friend_requests WHERE (from_user_id=$caller AND to_user_id=$target) OR (from_user_id=$target AND to_user_id=$caller)` — drop any pending requests in either direction silently.
  4. Return `{ severedFriendship }`.
  5. The route layer emits `friend:removed` to `user:<targetUserId>` if `severedFriendship === true`, **in addition to** the `user:ban:applied` emission. The two events are independent — FE's `FriendsService` consumes `friend:removed` to drop the friend row, `UserBansService` (new, task 10a FE) consumes `user:ban:applied` to freeze the DM.

  **Race note on friend-request cancel**: a pending request cleanup happens silently — no `friend:request:cancelled` broadcast is emitted to either side. The sender will notice their outgoing-pending UI goes stale on next refresh; the recipient notices theirs on next incoming fetch. For hackathon scope the silent drop is acceptable. Document this in the summary.

- **`unbanUser`**:
  1. `DELETE FROM user_bans WHERE blocker_user_id=$caller AND blocked_user_id=$target RETURNING blocker_user_id`. Zero rows → `AppError('Not banned', 404)`.

**Emit updates from the route** — add the conditional `friend:removed` emission:

```ts
userBansRouter.post('/', validate(createUserBanSchema), async (req, res) => {
  const { severedFriendship } = await userBansService.banUser(req.user!.id, req.body.userId);
  emitToUser(req.body.userId, 'user:ban:applied', { userId: req.user!.id });
  if (severedFriendship) {
    emitToUser(req.body.userId, 'friend:removed', { userId: req.user!.id });
  }
  res.status(204).end();
});
```

### 10. Message-send gating — `backend/src/services/messages.service.ts` / `backend/src/socket/io.ts`

Extend `messagesService.persistMessage` (or whatever function backs `message:send`) to refuse DM messages when a ban exists:

1. After loading the room + verifying membership, check `room.type`:
   - `type='channel'` → existing code path, no change.
   - `type='dm'` → query `user_bans` for the canonical pair (either direction). Any hit → `AppError('Personal messaging is blocked', 403)`.
2. The socket handler in `socket/io.ts` converts the `AppError` to the ack envelope `{ ok: false, error: "Personal messaging is blocked" }` as it already does for other `AppError`s.

Do NOT add this gate to channel rooms — `user_bans` is only observable on DMs per Q7/Q9.

### 11. Error-string sanity pass
Grep the service + route diff for each new literal and confirm it appears exactly once (or in exactly the error paths described):
- `"You cannot ban yourself"`
- `"User is already banned"`
- `"Not banned"`
- `"You must be friends to start a direct message"`
- `"Personal messaging is blocked"` (two call-sites: `dmService.openDirectMessage` + `messagesService.persistMessage` DM branch)
- `"You cannot open a DM with yourself"`
- `"DM rooms are not editable"`
- `"Direct messages are only reachable via /api/dm"`
- `"DM rooms cannot be left"`
- `"DMs cannot have invitations"`
- `"User not found"` — reused verbatim in both `dmService.openDirectMessage` and `userBansService.banUser`.

### 12. Smoke check (run before writing summary)

Four registered users A, B, C, D. Scratch harness at `tmp/round6/smoke.js` (same shape as round-5's). Steps (20+ scenarios — capture actual outputs verbatim):

**Setup**
1. Register A, B, C, D; log each in; open sockets for each with valid tokens. A friends B, C; B friends A, C; D is friends with nobody.

**DM create (happy path)**
2. A `POST /api/dm { toUserId: B.id }` → `201 RoomDetail` with `type='dm'`, `name=null`, `ownerId=null`, `dmPeer={userId: B.id, username: 'bob_r6_<ts>'}`, `members` length 2. B's socket receives `dm:created` with `dmPeer={userId: A.id, ...}`. A's socket ALSO receives `dm:created` (other tabs case — if harness uses separate sockets per user, A's one socket receives it).
3. A `POST /api/dm { toUserId: B.id }` again → `200 RoomDetail` (same `id` as step 2). No new `dm:created` broadcast (assert 0 events landed).

**DM create (rejection paths)**
4. A `POST /api/dm { toUserId: A.id }` → `400 "You cannot open a DM with yourself"`.
5. A `POST /api/dm { toUserId: <random-uuid-not-in-users> }` → `404 "User not found"`.
6. A `POST /api/dm { toUserId: D.id }` → `403 "You must be friends to start a direct message"`.

**DM messaging (reuses message:send)**
7. A opens socket emits `message:send { roomId: <dmRoom.id>, body: "hi bob" }` → ack `{ ok: true, message: {...} }`. B's socket receives `message:new` with the same payload. A's second-tab socket (if harness spawns one) also receives `message:new`.
8. B `GET /api/rooms/<dmRoom.id>/messages` → returns the message with `body: "hi bob"`.

**DM retrofit error surfaces**
9. A `PATCH /api/rooms/<dmRoom.id> { name: "foo" }` → `400 "DM rooms are not editable"`.
10. C `POST /api/rooms/<dmRoom.id>/join` → `403 "Direct messages are only reachable via /api/dm"` (the endpoint short-circuits BEFORE checking membership, so this fires for non-members too).
11. A `POST /api/rooms/<dmRoom.id>/leave` → `403 "DM rooms cannot be left"`.
12. B `POST /api/rooms/<dmRoom.id>/invitations { username: "<C>" }` → `400 "DMs cannot have invitations"`.

**`GET /api/rooms` returns DMs + channels**
13. A creates a channel room X. `A GET /api/rooms` → 200 containing both the channel X (type='channel') and the DM (type='dm', dmPeer = B).

**User-ban happy path**
14. B `POST /api/user-bans { userId: A.id }` → `204`. A's socket receives TWO events:
    - `user:ban:applied` with `{ userId: B.id }`.
    - `friend:removed` with `{ userId: B.id }` (because they were friends).
15. B `GET /api/friends` → `200 []` (A no longer in B's friends list). A `GET /api/friends` → B also gone.
16. B `GET /api/user-bans` → `200 [{ userId: A.id, username: 'alice_r6_<ts>', createdAt: ... }]`.

**DM-send gate when banned**
17. A `message:send { roomId: <dmRoom.id>, body: "still there?" }` → ack `{ ok: false, error: "Personal messaging is blocked" }`. B's socket does NOT receive a `message:new`.
18. B `message:send { roomId: <dmRoom.id>, body: "you're blocked" }` → same `{ ok: false, error: "Personal messaging is blocked" }` ack. Confirms gate applies in both directions regardless of which side initiated the ban.

**DM-create gate when banned**
19. A `POST /api/dm { toUserId: B.id }` → `403 "Personal messaging is blocked"`. Confirm even already-friends-just-got-banned can't resurrect a DM upsert.

**Ban rejection paths**
20. B `POST /api/user-bans { userId: B.id }` → `400 "You cannot ban yourself"`.
21. B `POST /api/user-bans { userId: A.id }` again → `409 "User is already banned"`.
22. B `POST /api/user-bans { userId: <random-uuid> }` → `404 "User not found"`.

**Unban + DM unfreezes**
23. B `DELETE /api/user-bans/<A.id>` → `204`. A's socket receives `user:ban:removed` with `{ userId: B.id }`.
24. A `message:send { roomId: <dmRoom.id>, body: "ok we good?" }` → ack `{ ok: true, message: {...} }`. B's socket receives `message:new`.
25. B `DELETE /api/user-bans/<A.id>` again → `404 "Not banned"`.
26. A `GET /api/friends` still empty (unban does NOT restore friendship — confirms Q8).

**Pending-request cleanup during ban**
27. A friends B again (send + accept). Then: A sends a friend request to C. Before C actions it, B bans C. After: A `GET /api/friend-requests/outgoing` → 200 without the A→C request (the ban cleaned it up silently). C `GET /api/friend-requests/incoming` → 200 without the A→C request.
    Actually — B banning C only touches the (B,C) pair's pending requests, NOT A's outgoing request to C. Revise this step:
    → A sends request to B. B bans A. After: A `GET /api/friend-requests/outgoing` → 200 without the A→B row.

Report actual HTTP bodies + socket payloads in the summary, not "passed". `pnpm lint` + `pnpm build` must pass with zero warnings.

## Wrap-up
Write `plans/round-6/backend_work_summary.md` with:
- **Built** — files touched, migration filename, service + route additions, all new socket emission call-sites (via `emitToUser`), message-send gating branch in the DM path.
- **Deviations** — any shape changes from the contract (should be none if the grep step is honest). The most likely one is the `dmPeer` computation path — if deriving it in `roomsService.getRoom` turned out wrong, document the alternative.
- **Deferred** — silent cleanup of friend-requests on ban (sender/recipient get no socket notification — acceptable hackathon trade-off); attachment support in DMs (Round 8); unread badges on DM rows (Round 12); presence on DM rows (Round 7); account-delete cascade through DM rooms (unscheduled, but the CASCADE FKs already handle it when the round lands); integration tests (carry-over from all prior rounds).
- **Next round needs to know** — for Round 7 (presence): the DM sidebar row needs the peer's presence; `dmPeer.userId` is the input. For Round 8 (attachments): DMs are rooms so `messages.room_id` already works; the access-control check is `is caller a member of the room` (unchanged); the ban check for message-send already runs for DMs and does NOT need to be replicated in the attachment-upload path unless Round 8 adds a separate attachment-create endpoint — note this explicitly. For Round 9 (pagination): `/api/rooms/:id/messages?before=&limit=` works identically for DMs and channels.
- **Config improvements** — migration naming; whether the two new CHECK constraints (`rooms_channel_name_required`, `rooms_channel_owner_required`) could have been a single composite check; whether the `dmPeer` denormalisation is worth the joined-query cost or should move to a lateral join; whether `emitToUser` should grow a return type so the route layer can statically assert the call-site's payload shape.
