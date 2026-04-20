# Round 2 — Backend Summary

## Built

### Database
- Added rooms and room_members tables to backend/src/db/schema.ts.
  - rooms: id uuid pk, name text unique not null, description text null, visibility room_visibility not null, owner_id uuid references users.id ON DELETE CASCADE, created_at timestamp default now.
  - Case-insensitive unique index on lower(name): rooms_name_lower_idx.
  - room_members: (room_id, user_id) composite PK, role room_role not null, joined_at timestamp default now, FKs cascade on user/room delete.
- Two pgEnums: room_visibility (public | private) and room_role (owner | admin | member).
- Migration generated: backend/src/db/migrations/0001_worthless_hydra.sql (applied automatically on container start via pnpm db:migrate).

### Shared types
- Mirrored Room, RoomMember, RoomDetail, RoomRole, RoomVisibility, CreateRoomRequest verbatim into backend/src/types/shared.ts (TS rootDir workaround carried from Round 1).

### Service — backend/src/services/rooms.service.ts
- listRoomsForUser(userId) — joins room_members -> rooms, filters by user, memberCount via correlated COUNT(*) subselect, ORDER BY rooms.created_at DESC.
- createRoom(userId, body) — single transaction: insert room + insert owner membership. PG unique-violation 23505 trapped via walking the cause chain and remapped to AppError("Room name already taken", 409).
- getRoomDetail(userId, roomId) — 404 if room missing, 403 if caller is not a member. Members sorted via CASE role WHEN owner 0 WHEN admin 1 ELSE 2 END, joined_at ASC.
- joinRoom(userId, roomId) — 404 if missing; 403 if visibility=private and not already a member; idempotent no-op if already a member; otherwise insert role=member. Always returns fresh RoomDetail.
- leaveRoom(userId, roomId) — 404 if not a member, 403 if caller is the owner, otherwise deletes the room_members row. Returns void.
- Bonus: isRoomMember(userId, roomId): Promise<boolean> — small reusable helper for Round 3 socket room:join authorization.

### Routes — backend/src/routes/rooms.ts
- Single router-level requireAuth applied to all five endpoints.
- Zod schemas: createRoomSchema (name 3–64 trimmed, optional description <=500 trimmed, visibility enum), idSchema (z.string().uuid()).
- Uses validate for bodies and validateParams for :id.
- Mounted at /api/rooms in backend/src/index.ts.
- Status codes: GET->200, POST->201, GET/:id->200, POST/:id/join->200, POST/:id/leave->204.

### Middleware
- No middleware changes — requireAuth, validate, validateParams, errorHandler, AppError all reused as-is from Round 1.

## Smoke test (real curl against docker compose backend)

Two users registered, then:

| # | Action | Observed | Expected | Result |
|---|---|---|---|---|
| 1 | Register A + B | 201 + tokens | 201 | pass |
| 2 | A POST /api/rooms name=Engineering-... | 201, memberCount:1, single owner member | 201 | pass |
| 3 | A POST /api/rooms name=engineering-... (lowercase) | 409 {"error":"Room name already taken"} | 409 | pass |
| 4 | A GET /api/rooms | [{ memberCount:1, visibility:public, ... }] | memberCount=1 | pass |
| 5 | B POST /api/rooms/:id/join on public room | 200, memberCount:2, members=[alice(owner), bob(member)] | 200 | pass |
| 6 | B POST /api/rooms/:id/leave | 204 (empty body) | 204 | pass |
| 7 | A POST /api/rooms/:id/leave (owner) | 403 {"error":"Owner cannot leave their own room"} | 403 | pass |

Extra edge cases verified:
- B POST /api/rooms/:privateId/join -> 403 {"error":"Private room — invitation required"} (em-dash preserved, matches contract exactly).
- B GET /api/rooms/:privateId (not a member) -> 403 {"error":"Forbidden"}.
- GET /api/rooms/00000000-0000-0000-0000-000000000000 -> 404 {"error":"Room not found"}.
- A POST /api/rooms/:id/join on own room (already a member) -> 200, memberCount:1 — idempotent, no new row.

pnpm lint and pnpm build both pass with zero warnings.

## Deviations

None. All endpoints, status codes, error messages, and response bodies match shared/api-contract.md Rooms Endpoints exactly, including the em-dash in "Private room — invitation required" and the exact Forbidden / Room not found / Owner cannot leave their own room / Room name already taken strings.

## Deferred

- Admin promotion / demotion — owner->admin->member transitions. Scheduled for Round 5a.
- Room deletion / rename — Round 5a.
- Room invitations — private-room /invite + accept flow. Round 5b.
- Message persistence + Socket.io — entire real-time layer. Round 3 (aka 2b).
- Backend integration tests — Round 1 also shipped without Jest/Supertest. Deferred until a dedicated testing round; see Config improvements.
- room_members.updated_at — no column yet because nothing is mutable on a membership in Round 2; add when admin promotion lands.

## Next round needs to know (Round 3 / 2b)

1. http.createServer switch. backend/src/index.ts still calls app.listen(config.port, ...). Round 3 must:
   - Replace it with: const httpServer = http.createServer(app); httpServer.listen(config.port, ...).
   - Instantiate new Server(httpServer, { cors: { origin: http://localhost:4300, credentials: true } }) from socket.io.
   - An empty backend/src/socket/ directory already exists from Round 1 scaffolding — drop the io.ts / handlers there.

2. Socket auth — reuse requireAuths JWT decode. Do NOT port the Express middleware verbatim; factor out the JWT-verify step once:
   - backend/src/middleware/auth.ts — requireAuth for HTTP.
   - io.use(async (socket, next) => { const token = socket.handshake.auth?.token; try { socket.data.user = jwt.verify(token, config.jwtSecret); next(); } catch { next(new Error("unauthorized")); } }) for Socket.io.
   Suggested refactor: extract verifyAccessToken(token): AuthPayload into middleware/auth.ts and have both callers use it. AuthPayload is already exported from there.

3. Room-membership check for room:join events. roomsService.isRoomMember(userId, roomId) is ready to call from the socket handler:
   
   Keeps the 403 policy identical between HTTP and WS and avoids duplicating the query.

4. Message persistence. Round 3 will add a messages table (id, room_id -> rooms.id cascade, user_id -> users.id cascade, body, created_at). The lower(name) unique index on rooms does not interact with that table; no schema concerns.

5. Refresh-token rotation during long socket sessions. Not handled yet — sockets hold the original access token. If a long-lived socket outlives 15 min, the client has to reconnect after refresh. Flag for discussion; probably fine for hackathon scope.

## Config improvements

- .claude/settings.json allowlist — repeated curl http://localhost:3000/... and docker compose restart backend calls trigger confirmation prompts. Worth a follow-up pass with the fewer-permission-prompts skill.
- Type duplication in backend/src/types/shared.ts — copy-paste of /shared/types/*.ts is brittle. Two cleaner options: (a) relax tsconfig.json rootDir to the repo root and import from ../../../shared/types; (b) pre-build copy step of /shared/types/*.ts into backend/src/types/shared/. Raise with orchestrator so FE/BE handle it the same way.
- No integration-test scaffolding yet. .claude/agents/backend-developer.md mandates Jest+Supertest for all endpoints but Round 1 and Round 2 both shipped without them. Either carve out a dedicated tooling round or relax the agent description — current state is drifting silently from the stated convention.
- drizzle-kit warnings on generate. Nothing blocking, but worth checking if the next migration produces noise.
