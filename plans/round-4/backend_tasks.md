# Round 4 — Backend Tasks

## Goal
Persist invitations; implement the five invitation endpoints and `PATCH /api/rooms/:id`; emit `invitation:new`, `invitation:revoked`, and `room:updated` through the existing Socket.io fan-out helpers so the FE gets live notifications and live room-state updates without extra HTTP polling.

## Dependencies
- `shared/api-contract.md` §Rooms Endpoints (new `PATCH /api/rooms/:id`), new §Invitation Endpoints, extended §Socket Events — **source of truth**. Read the Rules preambles and the per-endpoint error strings; exact wording matters.
- `shared/types/invitation.ts` — `Invitation`, `CreateInvitationRequest`, `InvitationRevokedPayload`
- `shared/types/room.ts` — now also exports `PatchRoomRequest`
- `backend/CLAUDE.md` — route vs service separation, error handling, Drizzle patterns
- `plans/round-3/backend_work_summary.md` §Next round needs to know — already lists the concrete fan-out patterns (`getIo().in('user:<id>').emit(...)`, `socketsJoin` on accept, `socketsLeave` mirrors)

**Do not modify `/shared/`.** If the contract needs changes, stop and flag it to the orchestrator.

## Tasks

### 1. Drizzle schema — add `invitations` to `backend/src/db/schema.ts`
Columns:
- `id` uuid pk default
- `room_id` uuid not null, FK → `rooms.id`, `onDelete: 'cascade'` (deleting the room drops pending invites)
- `invited_user_id` uuid not null, FK → `users.id`, `onDelete: 'cascade'` (invitee deletes account → drop their invites)
- `invited_by_user_id` uuid not null, FK → `users.id`, `onDelete: 'cascade'` (inviter deletes account → pending invites from them are dropped)
- `created_at` timestamp default now not null

Constraints + indexes:
- `uniqueIndex('invitations_room_invitee_idx').on(invitations.room_id, invitations.invited_user_id)` — enforces one pending invite per `(room, user)`.
- Also add a plain `index('invitations_invited_user_idx').on(invitations.invited_user_id)` — `GET /api/invitations` filters by this column.

Run `pnpm db:generate --name add_invitations` to produce the next migration (expect `0003_*.sql` with a readable suffix — Round 3 summary flagged the auto-name issue). Commit the generated SQL + snapshot.

### 2. Update `backend/src/types/shared.ts`
Mirror the three new names verbatim from `/shared/types/invitation.ts` (`Invitation`, `CreateInvitationRequest`, `InvitationRevokedPayload`) and the extended `PatchRoomRequest` from `/shared/types/room.ts`. Keep the existing mirror section's structure.

### 3. Service — `backend/src/services/invitations.service.ts` (new file)
All DB access lives here. No `req` / `res`, no socket objects. Functions:

```ts
export async function createInvitation(
  inviterUserId: string,
  roomId: string,
  body: CreateInvitationRequest,
): Promise<Invitation>;

export async function listInvitationsForUser(
  invitedUserId: string,
): Promise<Invitation[]>;

export async function acceptInvitation(
  invitedUserId: string,
  invitationId: string,
): Promise<{ invitation: Invitation; room: RoomDetail }>;

export async function rejectInvitation(
  invitedUserId: string,
  invitationId: string,
): Promise<void>;

export async function revokeInvitation(
  inviterUserId: string,
  invitationId: string,
): Promise<Invitation>;   // returns the deleted row so the route can emit invitation:revoked
```

Behaviour details:

- **`createInvitation`**
  1. Load the room (`404 "Room not found"`).
  2. If `visibility !== 'private'` → `AppError('Invitations are only for private rooms', 400)`.
  3. Verify `inviterUserId` is a member (`roomsService.isRoomMember`) → `AppError('Forbidden', 403)` if not.
  4. Resolve `body.username` to a user row → `404 "User not found"` if none.
  5. If that user is already a member → `409 "User is already a member of this room"`.
  6. Insert the invitations row. On PG unique-violation (23505) from `invitations_room_invitee_idx` → `409 "An invitation is already pending for this user"` (walk the `cause` chain exactly like `roomsService.createRoom`).
  7. Return the fully denormalised `Invitation` — re-select joined with `rooms.name` and the inviter's `users.username` so FE has everything.

- **`listInvitationsForUser`**
  SELECT pending invitations where `invited_user_id = $1`, joined with `rooms.name` + inviter's `users.username`. `ORDER BY created_at DESC`.

- **`acceptInvitation`**
  1. Load the invitation (`404 "Invitation not found"`).
  2. `invitation.invited_user_id !== invitedUserId` → `AppError('Forbidden', 403)`.
  3. Wrap in a transaction:
     a. Check if caller is already a member (possible if they joined via some other path). If so, delete the invitation and skip step (b).
     b. Insert `room_members` row with `role='member'`.
     c. Delete the invitation.
  4. Fetch the fresh `RoomDetail` via `roomsService.getRoomDetail(invitedUserId, invitation.roomId)`.
  5. Return `{ invitation, room: detail }` so the route can both respond and broadcast.

- **`rejectInvitation`**
  1. Load (`404`). Ownership check (`403`).
  2. Delete the row.

- **`revokeInvitation`**
  1. Load (`404 "Invitation not found"`).
  2. `invitation.invited_by_user_id !== inviterUserId` → `403 "Forbidden"` (Round 4 restriction; Round 11 will widen to admins).
  3. Delete the row. Return the fully denormalised invitation so the route can fan out to `user:<invitedUserId>`.

### 4. Service — extend `backend/src/services/rooms.service.ts` with `patchRoom`
Add one new function:

```ts
export async function patchRoom(
  userId: string,
  roomId: string,
  body: PatchRoomRequest,
): Promise<RoomDetail>;
```

Behaviour:
1. Check that at least one of `name` / `description` / `visibility` is present. The route layer enforces this via zod too, but belt-and-suspenders here — throw `AppError('At least one field is required', 400)` otherwise.
2. Load room (`404 "Room not found"`).
3. Load caller's membership row. If missing → `AppError('Room not found', 404)` (hide existence). If `role === 'member'` → `AppError('Only room owners and admins can edit room settings', 403)`. `role in ('owner', 'admin')` is the allow-list (Q2 = 2b).
4. Rename is a no-op if `body.name.trim().toLowerCase() === room.name.toLowerCase()` — skip the unique-index check in that case so the owner can fix casing without triggering 409.
5. Update the row. Trap PG 23505 (via the same cause-chain walk) on the `rooms_name_lower_idx` → `AppError('Room name already taken', 409)`.
6. Return the materialised `RoomDetail` via `getRoomDetail(userId, roomId)`.

### 5. Zod schemas
Define alongside existing schemas (reuse `middleware/validate.ts`):

```ts
const createInvitationSchema = z.object({
  username: z.string().trim().min(1),
});

const patchRoomSchema = z
  .object({
    name: z.string().trim().min(3).max(64).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    visibility: z.enum(['public', 'private']).optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, {
    message: 'At least one field is required',
  });
```

Params: the existing `idSchema` (UUID) is reused for `:id` in both `/api/rooms/:id/invitations` and `/api/invitations/:id`.

### 6. Routes — `backend/src/routes/invitations.ts` (new file)
Mount two paths under the same router because `/api/invitations/...` endpoints all start from one router; `/api/rooms/:id/invitations` is a second mount using a nested router or a separate router. Easiest: **two routers**, both defined in this file.

```ts
// /api/invitations/...
invitationsRouter.use(requireAuth);
invitationsRouter.get('/', async (req, res) => res.json(await invitationsService.listInvitationsForUser(req.user.id)));
invitationsRouter.post('/:id/accept', validateParams(idSchema), async (req, res) => {
  const { invitation, room } = await invitationsService.acceptInvitation(req.user.id, req.params.id);
  // subscription sync BEFORE broadcast so the accepter's tabs also receive room:updated
  getIo().in(`user:${req.user.id}`).socketsJoin(`room:${room.id}`);
  getIo().in(`room:${room.id}`).emit('room:updated', room);
  res.json(room);
});
invitationsRouter.post('/:id/reject', validateParams(idSchema), async (req, res) => {
  await invitationsService.rejectInvitation(req.user.id, req.params.id);
  res.status(204).end();
});
invitationsRouter.delete('/:id', validateParams(idSchema), async (req, res) => {
  const inv = await invitationsService.revokeInvitation(req.user.id, req.params.id);
  getIo().in(`user:${inv.invitedUserId}`).emit('invitation:revoked',
    { invitationId: inv.id, roomId: inv.roomId } satisfies InvitationRevokedPayload);
  res.status(204).end();
});

// /api/rooms/:id/invitations
roomInvitationsRouter.use(requireAuth);
roomInvitationsRouter.post('/', validate(createInvitationSchema), validateParams(idSchema), async (req, res) => {
  const inv = await invitationsService.createInvitation(req.user.id, req.params.id, req.body);
  getIo().in(`user:${inv.invitedUserId}`).emit('invitation:new', inv);
  res.status(201).json(inv);
});
```

Wire both into `backend/src/index.ts`:
- `app.use('/api/invitations', invitationsRouter);`
- `app.use('/api/rooms/:id/invitations', roomInvitationsRouter);` — the `:id` parameter needs `mergeParams: true` on the Router for `req.params.id` to survive (Express quirk). Double-check with a targeted test after wiring.

### 7. Extend `backend/src/routes/rooms.ts` with `PATCH /:id`
Follow the existing pattern in that file:

```ts
router.patch('/:id', validate(patchRoomSchema), validateParams(idSchema), async (req, res) => {
  const detail = await roomsService.patchRoom(req.user.id, req.params.id, req.body);
  getIo().in(`room:${detail.id}`).emit('room:updated', detail);
  res.json(detail);
});
```

Do **not** emit `room:updated` on `POST /:id/join` or `POST /:id/leave` — that's explicitly deferred per the contract. Leave those handlers alone.

### 8. Error-string sanity pass
Round-4 contract adds several new error strings. Grep the service + route diff for each literal and confirm it appears exactly once (or in exactly the error paths described). Strings to confirm verbatim:
- `"Invitations are only for private rooms"`
- `"An invitation is already pending for this user"`
- `"User is already a member of this room"`
- `"User not found"`
- `"Invitation not found"`
- `"Only room owners and admins can edit room settings"`
- `"At least one field is required"`
- `"Room name already taken"` (already existed; confirm `patchRoom` reuses it verbatim)
- `"Forbidden"` (reused on 403s that don't need a domain-specific message)

### 9. Smoke check (run before writing summary)
Two registered users A + B. One private room as A, one public room as A. Drive both HTTP and socket sides.

1. B connects a socket and listens for `invitation:new` and `invitation:revoked`.
2. A `POST /api/rooms/<private>/invitations` with `{ "username": "B" }` → `201` body has `roomName`, `invitedByUsername`; B's socket fires `invitation:new`.
3. A repeats the same invite → `409 "An invitation is already pending for this user"`.
4. A invites `"ghost"` (non-existent) → `404 "User not found"`.
5. A tries to invite B to the public room → `400 "Invitations are only for private rooms"`.
6. B `GET /api/invitations` → 1 item.
7. B connects a second socket and also joins `room:<private>` as a listener for `room:updated`.
8. B `POST /api/invitations/<id>/accept` → `200 RoomDetail` with B in `members`; both B's sockets and any of A's sockets receive `room:updated` with the updated `RoomDetail`.
9. A `PATCH /api/rooms/<private>` with `{ "name": "renamed-room" }` → `200 RoomDetail`, everyone in `room:<id>` receives `room:updated`.
10. A `PATCH /api/rooms/<private>` with `{ "name": "renamed-room" }` again (same name) → `200` no-op (not 409 — confirms rename-to-self skip).
11. A `PATCH /api/rooms/<public>` with `{ "name": "renamed-room" }` (already taken by step 9) → `409 "Room name already taken"`.
12. B `PATCH /api/rooms/<private>` with `{ "name": "b-rename" }` → `403 "Only room owners and admins can edit room settings"` (B is a member, not admin/owner).
13. A `PATCH /api/rooms/<private>` with `{}` → `400`.
14. New private room C as A. A invites B. A `DELETE /api/invitations/<id>` → `204`; B's socket receives `invitation:revoked` with `{ invitationId, roomId }`.
15. A invites B to room C again, then B `POST /api/invitations/<id>/reject` → `204`; A does **not** receive any socket event (reject is silent to inviter in Round 4).
16. Edge: A invites B, B accepts; B immediately accepts again (replay from a stale UI) → `404 "Invitation not found"` (already deleted).

Report actual ack / HTTP responses in the summary, not "passed". `pnpm lint` + `pnpm build` must pass.

## Wrap-up
Write `plans/round-4/backend_work_summary.md` with:
- **Built** — files touched, migration filename, service + route additions, socket emission call-sites
- **Deviations** — anything that differs from the contract (should be none if the grep step is honest)
- **Deferred** — `room:updated` on public join/leave, admin-level revoke, `GET /api/rooms/:id/invitations` for inviter/admin visibility, room deletion (Round 11), auto-kick on private-visibility if we ever want that semantic
- **Next round needs to know** — notes for Round 5 (Message History + Pagination): confirm `messages_room_created_idx` is sufficient for `WHERE room_id = $1 AND created_at < $2 ORDER BY created_at DESC LIMIT $3` (Round 3 summary already flagged this); and for Round 11 (moderation): the `role in ('owner', 'admin')` ACL gate used in `patchRoom` is the pattern to reuse for kick/ban/promote
- **Config improvements** — migration naming (pass `--name` worked?), shared CORS origin in config.ts (Round 3 still open), integration tests (still open), anything surfaced while wiring the two-router mount
