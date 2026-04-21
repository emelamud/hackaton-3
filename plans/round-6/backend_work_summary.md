# Round 6 — Backend Work Summary

## Built

**Drizzle schema — `backend/src/db/schema.ts`**
- Added `roomType` pgEnum (`['channel', 'dm']`) and extended `rooms`:
  - `type` column with default `'channel'` so the migration backfills pre-existing rows.
  - `name` and `ownerId` now nullable (DMs store both as NULL).
  - Two CHECK constraints: `rooms_channel_name_required`, `rooms_channel_owner_required`.
  - Existing `rooms_name_lower_idx` unique index unchanged — Postgres treats NULLs as distinct, so DMs don't collide.
- New `directMessages` table: `roomId` PK (FK→`rooms`, cascade), `userAId` / `userBId` (FK→`users`, cascade), canonicalised (`user_a_id < user_b_id`) via the `direct_messages_canonical_order` CHECK. Unique index `direct_messages_pair_idx` on `(userAId, userBId)` backs the upsert. `direct_messages_no_self` CHECK guards against self-DMs at DB level.
- New `userBans` table: composite PK `(blockerUserId, blockedUserId)` doubles as `GET /api/user-bans` lookup index. `user_bans_blocked_user_idx` supports the reverse-direction "who banned me" lookup. `user_bans_no_self` CHECK prevents self-bans.
- Exported `DirectMessageRow` / `NewDirectMessageRow` / `UserBanRow` / `NewUserBanRow` inferred types.

**Migration — `backend/src/db/migrations/0006_add_dms_and_user_bans.sql` + `meta/0006_snapshot.json` + `_journal.json` entry**
- Generated with `pnpm db:generate --name add_dms_and_user_bans`.
- Applied successfully in Docker on backend container start (journal entry idx=6 confirms application; `\d direct_messages` / `\d user_bans` show all FKs, PKs, indexes, and CHECK constraints in place).

**Type imports via `@shared` alias**
- `backend/src/types/shared.ts` is absent (already removed in a prior session). All Round 6 code imports types directly via the `@shared` alias: `Room`, `RoomDetail`, `RoomType`, `DmPeer`, `OpenDmRequest`, `UserBan`, `CreateUserBanRequest`, `UserBanAppliedPayload`, `UserBanRemovedPayload`, `ServerToClientEvents`.

**New service — `backend/src/services/dm.service.ts`**
- `openDirectMessage(callerUserId, targetUserId)`. Gates in strict order: self-check → target exists (404 `"User not found"`) → friendship gate (403 `"You must be friends to start a direct message"`) → ban gate in either direction (403 `"Personal messaging is blocked"`) → canonical pair lookup → upsert inside a single `db.transaction`. 23505 on the pair-unique index is caught by walking the Drizzle error `.cause` chain and re-selecting (idempotent race resolution). Self-check uses AppError with verbatim `"You cannot open a DM with yourself"`.
- Returns `{ room, created }`. `created` drives the route's 201 vs 200 + broadcast-vs-no-broadcast branch.

**New service — `backend/src/services/user-bans.service.ts`**
- `listBans` — joins `user_bans` with `users` on the blocked user; returns `{ userId, username, createdAt }[]` ordered `createdAt DESC`.
- `banUser` — self-check (400 `"You cannot ban yourself"`) → target-exists (404 `"User not found"`) → atomic transaction inserting the ban, deleting symmetric `friendships` rows (capturing `.returning()` count into `severedFriendship`), and silently deleting any pending `friend_requests` in either direction. 23505 on the ban PK → `"User is already banned"` (409). Returns `{ severedFriendship }` so the route can conditionally emit `friend:removed`.
- `unbanUser` — deletes the exact `(blocker=caller, blocked=target)` row; zero-row delete → `"Not banned"` (404).
- `hasBanBetween(userA, userB)` — helper extracted so `messages.service.persistMessage` can call the same symmetric lookup.

**Extended service — `backend/src/services/rooms.service.ts`**
- `listRoomsForUser(userId)`: selects `type` alongside the existing columns; after the main query, batches a second query to resolve `dmPeer` for DM rooms (filters `room_members` to the OTHER user per DM room). Result shape now sets `dmPeer` only on DM rows; channels omit the key entirely.
- `getRoomDetail(userId, roomId)`: accepts the caller id (unchanged signature — it was already there), selects `type`, derives `dmPeer` from `members.find(m => m.userId !== userId)` for DMs.
- `patchRoom`: DM short-circuit (400 `"DM rooms are not editable"`) runs before the membership lookup so non-owner attempts also surface the contract-exact string.
- `joinRoom`: DM short-circuit (403 `"Direct messages are only reachable via /api/dm"`) fires before the membership lookup, so non-members also get the dedicated error (per contract).
- `leaveRoom`: DM short-circuit (403 `"DM rooms cannot be left"`) runs first.
- `createRoom`: unchanged behaviour; explicitly sets `type: 'channel'` on the insert.

**Extended service — `backend/src/services/messages.service.ts`**
- `assertRoomAndMembership` now returns `{ type }`. DM branch consults `userBansService.hasBanBetween(userId, peerId)` after resolving the peer via a `ne(roomMembers.userId, userId)` lookup. Hit → throw `AppError('Personal messaging is blocked', 403)`, surfaced to the client as `{ ok: false, error: "Personal messaging is blocked" }` by the existing socket ack path. Channel rooms skip the check entirely.

**Extended service — `backend/src/services/invitations.service.ts`**
- `createInvitation`: DM short-circuit (400 `"DMs cannot have invitations"`) runs FIRST (before the public-room check) so the error ordering is deterministic.
- `loadDenormalisedInvitation` / `listInvitationsForUser`: `rooms.name` is now nullable in the DB; invitations only exist for channels in practice, but a defensive `?? ''` fallback is kept on `roomName` to satisfy the type narrowing.

**New route — `backend/src/routes/dm.ts`**
- `POST /api/dm` with zod `{ toUserId: uuid }`. On `created===true`:
  1. `getIo().in('user:<caller>').socketsJoin('room:<dmRoomId>')` + same for target, BEFORE broadcasting.
  2. Caller view reused from the service; target view re-resolved via `roomsService.getRoomDetail(targetUserId, room.id)` so `dmPeer` is correctly flipped for B.
  3. `emitToUser(callerId, 'dm:created', callerView)` + `emitToUser(targetId, 'dm:created', targetView)`.
  4. `res.status(201).json(room)`.
- On `created===false`: `res.status(200).json(room)` with no socket traffic.

**New route — `backend/src/routes/user-bans.ts`**
- `GET /api/user-bans` → `listBans`.
- `POST /api/user-bans` (zod `{ userId: uuid }`) → `banUser`; always emits `user:ban:applied` to `user:<targetId>`. If `severedFriendship`, additionally emits `friend:removed` to the same `user:<targetId>`. 204 response.
- `DELETE /api/user-bans/:userId` (zod params) → `unbanUser` → emit `user:ban:removed` to `user:<targetId>`. 204 response.
- All three emit via the typed `emitToUser<E>` helper from `backend/src/socket/io.ts` — no hand-rolled `getIo().in(...).emit(...)`.

**Mount in `backend/src/index.ts`**
- `app.use('/api/dm', dmRouter)` and `app.use('/api/user-bans', userBansRouter)` mounted alongside the existing routers.

## Deviations

- **Step-19 error-string reality vs the task's expected string.** The task file's step 19 said A re-opening a DM with B immediately after B bans A should surface `"Personal messaging is blocked"`. Observed: it returns `"You must be friends to start a direct message"`. This is because `banUser` atomically severs the friendship, so by the time A retries, the friendship gate (which runs BEFORE the ban gate in `openDirectMessage`, per task 3 ordering) fires first. Both are 403s and both correctly prevent DM resurrection; the contract allows either error under the umbrella "DM create is blocked when a ban exists". The gate ordering in the service matches the task file's step-3 spec verbatim, so the service is correct and the task file's step-19 expected string is what drifted. Flagged here so the smoke-output reviewer isn't surprised. No code change made.
- **`roomsService.getRoom` is named `getRoomDetail` on disk.** Task 3 / task 7 referenced `roomsService.getRoom`, but the service's existing helper is `getRoomDetail(userId, roomId)` (pre-existing from earlier rounds). I used the existing name rather than rename the symbol. Functionally equivalent.

## Deferred

- **Silent cleanup of friend-requests on ban** — no `friend:request:cancelled` broadcast fires to either the sender or recipient when a ban drops their pending request. Stale UIs refresh on next fetch. Hackathon-acceptable trade-off, matches what the orchestrator summary / contract called out.
- **Attachment support in DMs** — Round 8. No schema branch needed; `messages.room_id` already points at DM rooms and the member-check is identical. A separate upload endpoint (if added) will need to replicate the DM-ban gate — noted in Next-round.
- **Unread badges on DM rows** — Round 12.
- **Presence on DM rows / DM header** — Round 7. `dmPeer.userId` is the input to the presence lookup.
- **Account-delete cascade through DM rooms** — unscheduled (§2.1.5). All relevant FKs already use `ON DELETE CASCADE` so when that round lands the cascade already works.
- **Integration tests (Jest + Supertest)** — carry-over from all prior rounds; verification is the smoke harness per project convention.
- **Branded `Channel | Dm` discriminated TS union** — `Room.name: string | null` opens `undefined.toLowerCase()`-style footguns at every consumer. A proper union would narrow via `isDm(room)`. Not worth the churn mid-round; flag for a type-hygiene cleanup pass.

## Next round needs to know

**Round 7 (presence)**
- The DM sidebar row and DM header both need a presence dot keyed on `room.dmPeer.userId`. The three-consumer union for user-level presence subscriptions is `FriendsService.friends().map(f => f.userId) ∪ chatContext.currentRoom().members.map(m => m.userId) ∪ roomsService.roomsSignal().filter(r => r.type === 'dm').map(r => r.dmPeer!.userId)`, deduped.
- `dmPeer` is always populated on DM rooms from both `listRoomsForUser` and `getRoomDetail` — no FE fallback logic needed.

**Round 8 (attachments)**
- DMs are rooms; `messages.room_id` already covers them. The access-control check reduces to "caller is a member of the room" — identical to channels.
- The DM ban gate lives in `messages.service.persistMessage` (the message-send path). If Round 8 adds a separate `POST /api/rooms/:id/attachments` endpoint, it **must** replicate the same `hasBanBetween` check for `room.type === 'dm'` — otherwise a blocked user could push files into a frozen DM. `userBansService.hasBanBetween` is already exported for this purpose.

**Round 9 (history pagination)**
- `/api/rooms/:id/messages?before=<msgId>&limit=` will work identically for DMs and channels — `room.type` is irrelevant to paging.

**Round 11 (moderation / room admin)**
- DM rooms never have admins or owners (`ownerId === null`). Every admin-only control (Remove Member, Ban, Make Admin, Delete Room) must short-circuit on `room.type === 'dm'`. The DM-hostile error strings on `PATCH` / `join` / `leave` / `invitations` are the template.

**Contract-level reminders**
- `Room.name: string | null` and `Room.ownerId: string | null` are breaking shape changes. Every consumer that compares `.name` / `.ownerId` against a string must first narrow on `room.type === 'channel'` (or use a discriminated-union helper). `invitations.service.ts` already has the `?? ''` defensive fallback for `roomName` as an example of the pattern; grep before adding new consumers.
- `hasBanBetween(userA, userB)` is the canonical symmetric-ban lookup. Any future feature that gates on "no ban in either direction" should reuse it.

## Config improvements

- **Two CHECK constraints could be one composite.** `rooms_channel_name_required` + `rooms_channel_owner_required` could collapse to `rooms_channel_requires_name_and_owner: (type='channel' AND name IS NOT NULL AND owner_id IS NOT NULL) OR type='dm'`. Kept them separate so a future violation reports which column failed; cost is one extra entry in `pg_constraint`. Low-priority.
- **`dmPeer` is resolved via a second query in `listRoomsForUser`.** A single lateral join (`LEFT JOIN LATERAL (SELECT userId, username FROM room_members JOIN users ... WHERE room_members.userId <> $callerId AND room_members.roomId = rooms.id LIMIT 1) peer ON rooms.type = 'dm'`) would eliminate the N+1-ish extra roundtrip for DM rooms. Realistic DM count per user is bounded by friends count (~low hundreds at hackathon scale) so the second query is fine for now. Flag for a post-hackathon query-tuning pass.
- **`emitToUser` return type is `void`.** It already enforces event/payload type pairing via the generic parameter, so wrong-shaped payloads fail at compile time. Low-priority; no action needed unless a round introduces side-channel "was it delivered" questions.
- **Friend-request cleanup on ban is silent.** If a later round adds a "the other side cancelled their request" notification UX, the ban transaction should co-emit `friend:request:cancelled` to both the sender and recipient of the dropped request. Gated on product decision.
