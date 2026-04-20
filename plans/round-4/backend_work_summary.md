# Round 4 -- Backend Summary

## Built

### Database
- `backend/src/db/schema.ts` -- added `invitations` table:
  - `id` uuid pk `defaultRandom()`, `room_id` uuid NOT NULL FK rooms.id ON DELETE CASCADE, `invited_user_id` uuid NOT NULL FK users.id ON DELETE CASCADE, `invited_by_user_id` uuid NOT NULL FK users.id ON DELETE CASCADE, `created_at` timestamp DEFAULT now() NOT NULL.
  - `uniqueIndex('invitations_room_invitee_idx').on(roomId, invitedUserId)` -- one pending invite per (room, invitee).
  - `index('invitations_invited_user_idx').on(invitedUserId)` -- backs `GET /api/invitations`.
  - Exported `InvitationRow` / `NewInvitationRow` inferred types alongside the existing tables.
- Migration generated: `backend/src/db/migrations/0003_add_invitations.sql` (+ `meta/0003_snapshot.json` + `_journal.json` entry). `pnpm db:generate --name add_invitations` produced the readable name this time -- the `--name` flag works. Applied on container start (`entrypoint.sh` runs `node dist/db/migrate.js`); `docker compose logs backend` shows "Migrations complete." `\d invitations` in psql confirms the unique + btree indexes and all three FK constraints with `ON DELETE CASCADE`.

### Shared types (backend/src/types/shared.ts)
Mirrored verbatim from `/shared/types/`:
- `PatchRoomRequest` (new, from `room.ts`).
- `Invitation`, `CreateInvitationRequest`, `InvitationRevokedPayload` (new, from `invitation.ts`).

### Service -- backend/src/services/invitations.service.ts (new)
Reuses the Round 1/3 `isUniqueViolation` cause-chain pattern. Single `loadDenormalisedInvitation(id)` helper joined against `rooms.name` and the inviter's `users.username` -- returns the exact `Invitation` wire shape used for both HTTP responses and `invitation:new` socket payloads.

- `createInvitation(inviterUserId, roomId, body)`:
  1. Load room -> `AppError('Room not found', 404)`.
  2. If `visibility !== 'private'` -> `AppError('Invitations are only for private rooms', 400)`.
  3. `roomsService.isRoomMember(inviter, room)` -> `AppError('Forbidden', 403)`.
  4. Resolve `body.username` -> `AppError('User not found', 404)`.
  5. `isRoomMember(target, room)` -> `AppError('User is already a member of this room', 409)`.
  6. Insert -- on PG 23505 via cause-chain -> `AppError('An invitation is already pending for this user', 409)`.
  7. Return denormalised invitation.
- `listInvitationsForUser(userId)`: SELECT joined with `rooms.name` + inviter's `users.username`, `ORDER BY created_at DESC`.
- `acceptInvitation(userId, invitationId)`:
  1. Load denormalised -> 404 if missing.
  2. Ownership (`invitedUserId !== userId`) -> 403.
  3. Transaction: check existing `room_members` row; if absent, insert `role='member'`; unconditionally delete invitation (idempotent on re-accept path).
  4. Return `{ invitation, room: getRoomDetail(userId, roomId) }` so the route can both respond and broadcast.
- `rejectInvitation(userId, id)`: Load -> 404 / 403. Delete.
- `revokeInvitation(inviterUserId, id)`: Load denormalised first (so route can fan out). 404 on missing, 403 on non-inviter. Delete. Returns the denormalised invitation.

### Service -- backend/src/services/rooms.service.ts (extended)
Added `patchRoom(userId, roomId, body: PatchRoomRequest): Promise<RoomDetail>`:
1. Belt-and-suspenders: uses `Object.prototype.hasOwnProperty.call` on each of `name` / `description` / `visibility`; if none present -> `AppError('At least one field is required', 400)`. This handles the empty-body path without relying on the zod `validate` middleware, which only emits the generic `"Validation failed"` envelope.
2. Load room -> 404 `"Room not found"`.
3. Load caller membership row. If absent -> 404 `"Room not found"` (hides existence). If `role !== 'owner' && role !== 'admin'` -> 403 `"Only room owners and admins can edit room settings"`.
4. Build a partial update object. Rename is SKIPPED if `proposed.toLowerCase() === room.name.toLowerCase()` -- avoids a spurious 409 from the `rooms_name_lower_idx` when the owner is just re-submitting the same name (or fixing casing). Empty patch object -> no SQL update.
5. `db.update(rooms).set(patch).where(eq(rooms.id, roomId))`. On 23505 via cause-chain -> `AppError('Room name already taken', 409)`.
6. Return materialised `getRoomDetail(userId, roomId)`.

### Routes -- backend/src/routes/invitations.ts (new)
Two routers in one file (task-sketch approach -- simpler than nested).
- `invitationsRouter` mounted at `/api/invitations`. `requireAuth`. `GET /`, `POST /:id/accept`, `POST /:id/reject`, `DELETE /:id`.
- `roomInvitationsRouter = Router({ mergeParams: true })` mounted at `/api/rooms/:id/invitations`. `requireAuth`. `POST /` for invitation creation. `mergeParams: true` preserves `req.params.id` from the parent path -- verified live (step 2 of the smoke test returned 201 with the correct `roomId`).

Socket emissions (all via `getIo()` at request time -- same pattern as Round 3):
- After `POST /:id/accept`: `getIo().in(user:<accepterId>).socketsJoin(room:<id>)` FIRST, then `getIo().in(room:<id>).emit('room:updated', detail)`. The subscribe-before-broadcast ordering means the accepter's own tabs receive the event that fires in the same tick.
- After `DELETE /:id`: `getIo().in(user:<invitedUserId>).emit('invitation:revoked', { invitationId, roomId })`.
- After `POST /api/rooms/:id/invitations`: `getIo().in(user:<invitedUserId>).emit('invitation:new', inv)`.
- After `PATCH /api/rooms/:id`: `getIo().in(room:<id>).emit('room:updated', detail)`.

### Routes -- backend/src/routes/rooms.ts (extended)
- Added `patchRoomSchema` -- three optional fields, deliberately without `.refine` so empty-body passes zod and hits the service-layer "At least one field is required" check (see above for rationale).
- `PATCH /:id` handler: `validateParams(idSchema)` then `validate(patchRoomSchema)`, calls `roomsService.patchRoom`, emits `room:updated` to `room:<id>`, returns 200 `RoomDetail`.
- Did NOT add `room:updated` emissions to `POST /:id/join` or `POST /:id/leave` -- explicitly deferred per the contract and the task brief.

### Wiring (backend/src/index.ts)
- Imported `invitationsRouter` and `roomInvitationsRouter` from `./routes/invitations`.
- Mounted `roomInvitationsRouter` at `/api/rooms/:id/invitations` BEFORE `roomsRouter` so Express route resolution doesn't let a future ambiguous roomsRouter handler shadow it. In practice the specific paths (`/`, `/:id`, `/:id/join`, `/:id/leave`, `/:id/messages`) don't collide, but the order is defensive.
- Mounted `invitationsRouter` at `/api/invitations`.
- CORS, JSON parsing, cookie parsing, error handler untouched.

## Smoke test -- observed actual outputs

Driven by `tmp/round4/smoke.js` -- `socket.io-client@4` + `node-fetch@2`, same harness shape as Round 3. Fresh users `alice_r4_<ts>` and `bob_r4_<ts>` each run, so scenarios are idempotent across re-runs.

| # | Scenario | Observed |
|---|----------|----------|
| 1 | B connects socket with valid access token | `connect` fired, no `connect_error`. |
| 2 | A POST /api/rooms/<priv>/invitations `{"username":"<B>"}` | HTTP 201 body `{ id, roomId, roomName: "priv_<ts>", invitedUserId, invitedByUserId, invitedByUsername: "alice_r4_<ts>", createdAt }`. B's socket received exactly 1 `invitation:new` with that same payload (denormalised with `roomName` + `invitedByUsername`). |
| 3 | A repeats the invite | HTTP 409 `{ "error": "An invitation is already pending for this user" }`. |
| 4 | A invites `"ghost_nonexistent_user_9999"` | HTTP 404 `{ "error": "User not found" }`. |
| 5 | A invites B to public room | HTTP 400 `{ "error": "Invitations are only for private rooms" }`. |
| 6 | B GET /api/invitations | HTTP 200, 1-item array with the invitation above (newest-first ordering trivially satisfied with 1 item; joined fields present). |
| 7 | B opens a second socket; A opens its own socket -- all three listen for `room:updated` | All connected cleanly. |
| 8 | B POST /api/invitations/<id>/accept | HTTP 200 `RoomDetail` with `memberCount: 2`, members `["alice_r4_<ts>", "bob_r4_<ts>"]`. All three sockets (B's bSock, B's bSock2, A's aSock) received `room:updated` with the same members list -- confirms the pre-broadcast `socketsJoin` for B and the existing `room:<id>` membership for A both fire. |
| 9 | A PATCH /api/rooms/<priv> `{"name":"renamed_<ts>"}` | HTTP 200, `name: "renamed_<ts>"`. 3 `room:updated` events received (aSock, bSock, bSock2). |
| 10 | Same PATCH again (identical value) | HTTP 200 no-op, no 409 -- confirms rename-to-self skip. |
| 11 | A PATCH /api/rooms/<pub> `{"name":"renamed_<ts>"}` (now taken) | HTTP 409 `{ "error": "Room name already taken" }`. |
| 12 | B PATCH /api/rooms/<priv> `{"name":"b_rename_<ts>"}` | HTTP 403 `{ "error": "Only room owners and admins can edit room settings" }`. |
| 13 | A PATCH /api/rooms/<priv> `{}` | HTTP 400 `{ "error": "At least one field is required" }`. |
| 14 | A creates room C, invites B, then DELETE /api/invitations/<id> | DELETE HTTP 204; B's socket received `invitation:revoked` with exactly `{ invitationId, roomId }` matching room C's id. |
| 15 | A invites B to C, B POST /api/invitations/<id>/reject | HTTP 204; A's socket received 0 events matching `invitation:*` -- confirms reject is silent to the inviter (contract spec). |
| 16 | A creates room D, invites B, B accepts, B replays the accept | First accept 200 with `memberCount: 2`. Replay 404 `{ "error": "Invitation not found" }` -- confirms the row is gone after successful accept. |

`pnpm lint` and `pnpm build` both pass with zero warnings.

All nine required error strings appear verbatim where the contract says, and only where the contract says (grep of the diff confirms):
- `"Invitations are only for private rooms"` -- `invitations.service.ts:75` (createInvitation step 2).
- `"An invitation is already pending for this user"` -- `invitations.service.ts:111` (createInvitation 23505 branch).
- `"User is already a member of this room"` -- `invitations.service.ts:95` (createInvitation step 5).
- `"User not found"` -- `invitations.service.ts:90` (createInvitation step 4). Also exists in `auth.service.ts:194` as a 401 in the refresh-token flow (pre-Round 4, unrelated).
- `"Invitation not found"` -- four sites in `invitations.service.ts` (load helper miss + each load-then-check path).
- `"Only room owners and admins can edit room settings"` -- `rooms.service.ts:258` (patchRoom ACL gate).
- `"At least one field is required"` -- `rooms.service.ts:233` (patchRoom empty-body check).
- `"Room name already taken"` -- `rooms.service.ts:153` (createRoom -- pre-existing) + `rooms.service.ts:296` (patchRoom -- new, reuses the same string verbatim).
- `"Forbidden"` -- reused on 403s that don't need a domain message: createInvitation non-member, acceptInvitation non-invitee, rejectInvitation non-invitee, revokeInvitation non-inviter. Also in `rooms.service.ts:76` (getRoomDetail non-member, pre-existing).

## Deviations

None from `shared/api-contract.md`. Deliberate minor implementation choices called out:

1. Zod `patchRoomSchema` in `routes/rooms.ts` does NOT include the `.refine((obj) => Object.keys(obj).length > 0, { message: 'At least one field is required' })` that the task sketch suggested. Reason: the existing `validate(schema)` middleware wraps ALL zod failures as `AppError('Validation failed', 400, details)` -- that would surface the refine message only inside `details[0].message`, and the HTTP body would read `{ "error": "Validation failed", "details": [...] }`, NOT `{ "error": "At least one field is required" }`. Moving the empty-body check to the service layer (as the task brief itself flagged "belt-and-suspenders here") is actually the only path that produces the contract-exact envelope. The smoke test at step 13 confirms the correct response body.

2. Mounted `roomInvitationsRouter` before `roomsRouter` in `index.ts`. Not required by Express (the paths don't collide since roomsRouter's routes are specific `/`, `/:id`, `/:id/join`, `/:id/leave`, `/:id/messages`), but the ordering is defensive against future `/api/rooms/:id/*` additions to roomsRouter.

## Deferred

- `room:updated` on `POST /api/rooms/:id/join` and `POST /api/rooms/:id/leave` -- explicitly deferred per the contract. Existing members see `memberCount` / `members` drift on the next refetch until a later round retrofits these.
- Admin-level revoke for `DELETE /api/invitations/:id` -- Round 11 moderation extends the allow-list from "inviter only" to "inviter OR room admin". The `role in ('owner', 'admin')` check in `patchRoom` is the pattern to reuse.
- `GET /api/rooms/:id/invitations` for inviter / admin visibility -- deferred; not in this round's contract.
- Room deletion (`DELETE /api/rooms/:id`) -- Round 11+. Current FK cascades already drop pending invitations when a room is eventually deleted, so no extra cleanup needed.
- Auto-kick on visibility change `public -> private` -- not desired. The contract explicitly says "No auto-kick, no membership rewrite."
- Integration tests -- still absent; smoke-tested via a scratch `tmp/round4/smoke.js` harness only. Same flag as Rounds 2 + 3.
- Rate limiting on invitation creation -- nothing stops an inviter from spraying invites to every username. Low priority for hackathon scope; revisit in hardening.
- Inviter-facing notification on reject -- contract says reject is silent in Round 4. Future round can add an `invitation:rejected` event to `user:<inviterId>` if product wants it.

## Next round needs to know

Round 5 (Message History + Pagination):
- The `messages_room_created_idx` compound index on `(room_id, created_at)` already covers `WHERE room_id = $1 AND created_at < $2 ORDER BY created_at DESC LIMIT $3`. No new index needed. Round 3 summary also flagged this; still true post-Round 4.
- `listRecentMessages` already orders DESC + reverses; pagination just needs to add the `createdAt < $cursor` predicate and ignore the reverse when the client asks for ascending vs descending.

Round 11 (Moderation -- kick / ban / promote):
- The ACL gate in `patchRoom` (load `room_members.role`, allow `in ('owner', 'admin')`, else 403) is the reusable pattern for kick / ban / promote. Keep the "hide existence if not a member -> 404" behaviour so unauthenticated probes can't enumerate room IDs.
- The subscription-sync helper calls already used for invitation accept (`socketsJoin` before broadcast) generalise to kick: the kicker route should call `getIo().in(user:<kickedId>).socketsLeave(room:<id>)` after deleting the `room_members` row, and emit `room:member:removed` (or reuse `room:updated`) to the room.

Invitation emission contract surface:
- `invitation:new` -- payload is the full denormalised `Invitation` (matches POST 201 body).
- `invitation:revoked` -- payload is exactly `{ invitationId, roomId }`, not the full invitation. FE should use this only to drop the notification, not rehydrate anything.
- `room:updated` -- fires on both accept (via invitee joining) AND PATCH (settings change). Same `RoomDetail` shape both times. FE can treat these uniformly.

Visibility change semantics (confirmed live):
- `public -> private` leaves existing members intact -- only the `joinRoom` path changes behaviour going forward.
- `private -> public` opens future joins via `POST /:id/join` but does NOT auto-broadcast a public-catalog update (there is no public catalog endpoint yet).

## Config improvements

- Migration naming works (`--name add_invitations` produced `0003_add_invitations.sql`). Keep passing `--name` for every `db:generate` going forward; the Round 3 "bitter_sentinel" auto-name is our canonical bad example.
- Shared CORS origin in `config.ts` -- still the same flag as Round 3. `"http://localhost:4300"` literal is in `index.ts` only, which is fine for single-deploy but will bite on the first env-driven release. Add `corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:4300'` to `config.ts`.
- The smoke-test harness (`tmp/round4/smoke.js`) is still a throwaway. Would be ~50 LOC to promote it to `backend/scripts/smoke-round4.ts` with a proper `pnpm` script -- rounds 3 and 4 have both shipped one of these ad-hoc. Low priority unless it gets to 3 rounds in a row of duplication.
- No backend integration tests -- same flag as every prior round. At this point the agent description's "Write integration tests for all endpoints using Jest and Supertest" is aspirational; the orchestrator may want to formally defer it or carve out a testing round.
- `validate` middleware's `"Validation failed"` wrapper -- as noted in Deviations, this blocks zod-level error strings from surfacing to the HTTP body. Round 4 worked around it by moving empty-body logic to the service. A cleaner long-term fix: the `validate` helper could look for a single top-level refine failure and use its message as the AppError message. Low priority; service-layer checks are the established pattern.
- Permissions / allowlist -- `docker compose logs`, `docker compose up -d --build backend`, `curl`, `node smoke.js` all prompted again. `fewer-permission-prompts` skill run still pending from Round 2.
