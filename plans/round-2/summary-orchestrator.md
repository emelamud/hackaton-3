# Round 2 Orchestrator — Summary

## Built

### `/shared/types/room.ts` (new)
- `RoomVisibility = 'public' | 'private'`
- `RoomRole = 'owner' | 'admin' | 'member'`
- `Room { id, name, description: string | null, visibility, ownerId, createdAt, memberCount }`
- `RoomMember { roomId, userId, username, role, joinedAt }`
- `RoomDetail = Room & { members: RoomMember[] }`
- `CreateRoomRequest { name, description?, visibility }`

### `/shared/types/index.ts` (updated)
- Added `export * from './room';` after the existing user / auth exports.

### `/shared/api-contract.md` (updated)
Appended `## Rooms Endpoints` section with:
- Auth preamble (Bearer token, 401 documented once)
- Rules block: unique-name (case-insensitive), length bounds (name 3–64, description 0–500), private rooms `403` on join, member ordering (owner → admins by joinedAt → members by joinedAt)
- Summary table of all 5 endpoints
- Per-endpoint detail sections for `GET /api/rooms`, `POST /api/rooms`, `GET /api/rooms/:id`, `POST /api/rooms/:id/join`, `POST /api/rooms/:id/leave` with request/response/error shapes

### Endpoint list (final)
| Method | Path | Success |
|--------|------|---------|
| GET | `/api/rooms` | `200 Room[]` |
| POST | `/api/rooms` | `201 RoomDetail` |
| GET | `/api/rooms/:id` | `200 RoomDetail` |
| POST | `/api/rooms/:id/join` | `200 RoomDetail` |
| POST | `/api/rooms/:id/leave` | `204` |

## Deviations
None. Contract matches the task file exactly.

## Deferred
- Room deletion (`DELETE /api/rooms/:id`) — owner-only destructive action, belongs with moderation in Round 5a per master plan
- Public catalog (`GET /api/rooms/catalog`) and search — Round 5c
- Invitations for private rooms — Round 5b
- `PATCH /api/rooms/:id` for settings — Round 5b
- DM rooms (`type: 'public' | 'dm'` on `Room`) — Round 3b. Intentionally **not** introduced now to keep `Room` minimal.

## Next round needs to know

### For Round 3 (2b — real-time messaging)
- `Room` already carries `memberCount` from HTTP; if Round 3c (presence) emits `presence:update` events, reuse that channel rather than bumping `memberCount` on the room object.
- There is **no** `room:member-joined` socket event in Round 2a. When Round 3 wires sockets, the FE will need to either re-fetch `RoomDetail` after a join, or we add that event then — decide in Round 3 orchestrator.
- `RoomMember.username` is denormalised into the response to avoid a second user-lookup when rendering the right rail; Socket.io payloads for message events should do the same (include `username`, not just `userId`).
- `RoomDetail` is returned on both `POST /api/rooms` and `POST /api/rooms/:id/join` so the FE can land directly on the room view after either action. Round 3 can safely reuse this shape.

### Type-mirror reminder for BE
- Backend still mirrors `/shared/types/` into `backend/src/types/shared.ts` due to TS `rootDir`. Round 2 adds 6 new names (`Room`, `RoomDetail`, `RoomMember`, `RoomRole`, `RoomVisibility`, `CreateRoomRequest`) — BE must copy them verbatim.

## Config improvements
- **Shared-types import**: the round-1 summary flagged that BE duplicates `/shared/types/` locally. Worth fixing before the contract grows further — either a `tsconfig` path alias with `rootDirs`, or a pre-build copy step. Proposed for the user to consider as a separate cleanup pass, not part of Round 2 scope.
- **Agent workflow docs**: consider adding a "contract-first" note to `.claude/agents/backend-developer.md` and `frontend-developer.md` telling the agent to read the **entire** §Rooms Endpoints section (including the "Rules" preamble) before starting, not just the target endpoint — the case-insensitive-name rule is in the preamble and easy to miss.
