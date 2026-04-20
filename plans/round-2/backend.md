# Round 2 — Backend Tasks

## Goal
Persist rooms and room memberships; implement the five rooms HTTP endpoints behind JWT auth. No Socket.io, no messages — those land in Round 3.

## Dependencies
- `shared/api-contract.md` §Rooms Endpoints — request/response shapes (source of truth)
- `shared/types/room.ts` — `Room`, `RoomDetail`, `RoomMember`, `RoomRole`, `RoomVisibility`, `CreateRoomRequest`
- `backend/CLAUDE.md` — route vs service separation, error handling, Drizzle patterns
- `.claude/agents/backend-developer.md` — stack reminders

**Do not modify `/shared/`.** If the contract needs changes, stop and flag it to the orchestrator.

## Tasks

### 1. Drizzle schema — `backend/src/db/schema.ts`
Add two tables alongside the existing `users` + `sessions`:

- `rooms`
  - `id` uuid pk default
  - `name` text **unique** not null (unique index uses `lower(name)` — see next bullet)
  - `description` text null
  - `visibility` text not null (values `'public'` | `'private'`, enforce with a Drizzle `pgEnum` named `room_visibility`)
  - `owner_id` uuid not null, FK → `users.id`, `onDelete: 'cascade'` (requirement §2.1.5: deleting the owner deletes their rooms)
  - `created_at` timestamp default now not null
  - Add a case-insensitive unique index: `uniqueIndex('rooms_name_lower_idx').on(sql\`lower(${rooms.name})\`)` so `#Engineering` and `#engineering` collide.

- `room_members`
  - `room_id` uuid not null, FK → `rooms.id`, `onDelete: 'cascade'`
  - `user_id` uuid not null, FK → `users.id`, `onDelete: 'cascade'`
  - `role` text not null (values `'owner'` | `'admin'` | `'member'` — reuse a `pgEnum` `room_role`)
  - `joined_at` timestamp default now not null
  - Composite primary key on `(room_id, user_id)`

Run `pnpm db:generate` to produce the next migration file under `src/db/migrations/` and commit it.

### 2. Local shared-types mirror — `backend/src/types/shared.ts`
The round-1 summary notes that `/shared/types/` is mirrored here because of TS `rootDir`. Add the Round 2 types (`Room`, `RoomDetail`, `RoomMember`, `RoomRole`, `RoomVisibility`, `CreateRoomRequest`) to this file, copying verbatim from `/shared/types/room.ts`.

### 3. Service — `backend/src/services/rooms.service.ts`
All DB access lives here. No `req`/`res`. Functions:

- `listRoomsForUser(userId: string): Promise<Room[]>`
  Join `room_members` → `rooms`, filter by user, include `memberCount` via a subselect or `count()` over the members table. Order by `rooms.created_at desc`.

- `createRoom(userId: string, body: CreateRoomRequest): Promise<RoomDetail>`
  Wrap in a transaction: insert room, insert `room_members` row with `role='owner'`. On unique-violation from the case-insensitive index, throw `new AppError('Room name already taken', 409)`. Return the materialised detail via `getRoomDetail`.

- `getRoomDetail(userId: string, roomId: string): Promise<RoomDetail>`
  Verify the caller has a `room_members` row for this room — if not, throw `AppError('Forbidden', 403)`. If no room found, throw `AppError('Room not found', 404)`. Fetch room + members joined with `users.username`; order members: owner first, then admins by `joined_at`, then members by `joined_at`.

- `joinRoom(userId: string, roomId: string): Promise<RoomDetail>`
  Load room; `404` if missing. If `visibility === 'private'` and user is not already a member, throw `AppError('Private room — invitation required', 403)`. If already a member, no-op (idempotent). Otherwise insert `room_members` with `role='member'`. Return detail.

- `leaveRoom(userId: string, roomId: string): Promise<void>`
  Load membership; `404` if not a member. If the caller is the owner, throw `AppError('Owner cannot leave their own room', 403)` (requirement §2.4.5). Delete the `room_members` row.

### 4. Validation — zod schemas
Reuse `middleware/validate.ts`. Define in `backend/src/routes/rooms.ts` (or a sibling `rooms.schemas.ts` if preferred):

```ts
const createRoomSchema = z.object({
  name: z.string().trim().min(3).max(64),
  description: z.string().trim().max(500).optional(),
  visibility: z.enum(['public', 'private']),
});
```

Params: `z.object({ id: z.string().uuid() })` for the `:id` route.

### 5. Routes — `backend/src/routes/rooms.ts`
Thin controllers, follow the pattern in `routes/auth.ts` / `routes/sessions.ts`.

```
router.use(requireAuth);
router.get('/', async (req, res) => res.json(await roomsService.listRoomsForUser(req.user.id)));
router.post('/', validate(createRoomSchema), async (req, res) => res.status(201).json(await roomsService.createRoom(req.user.id, req.body)));
router.get('/:id', validateParams(idSchema), async (req, res) => res.json(await roomsService.getRoomDetail(req.user.id, req.params.id)));
router.post('/:id/join', validateParams(idSchema), async (req, res) => res.json(await roomsService.joinRoom(req.user.id, req.params.id)));
router.post('/:id/leave', validateParams(idSchema), async (req, res) => { await roomsService.leaveRoom(req.user.id, req.params.id); res.status(204).end(); });
```

Mount in `backend/src/index.ts`: `app.use('/api/rooms', roomsRouter);`

### 6. No socket, no migrations for messages
Message persistence, `message:send`/`message:new` events, and the `http.createServer` switch are **Round 3 (2b)**. Leave `index.ts` using `app.listen(...)`.

### 7. Manual smoke check
Before writing the summary: run `docker compose up`, hit the endpoints via `curl` or Thunder/REST client:
1. Register two users
2. User A `POST /api/rooms` with a name — expect 201 + owner membership
3. User A `POST /api/rooms` with the **same name, different case** — expect 409
4. User A `GET /api/rooms` — sees the room with `memberCount: 1`
5. User B `POST /api/rooms/:id/join` on A's public room — expect 200 + memberCount:2
6. User B `POST /api/rooms/:id/leave` — expect 204; A still owner
7. User A `POST /api/rooms/:id/leave` — expect 403 (owner)

## Wrap-up
Write `plans/round-2/summary-backend.md` with:
- **Built** — DB tables, migration filename, endpoints, service functions
- **Deviations** — anything that differs from `shared/api-contract.md` (and why)
- **Deferred** — anything skipped (e.g. admin promotion — that's Round 5a)
- **Next round needs to know** — notes for Round 3 (real-time messaging): `http.createServer` switch, socket auth reuse from `requireAuth`, room-membership check reuse for socket `room:join`
- **Config improvements** — any tooling/agent-config tweaks noticed while working
