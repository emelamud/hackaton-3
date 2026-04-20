# Round 2 — Orchestrator Tasks

## Goal
Extend the shared contract with rooms types and the rooms HTTP API so FE and BE can build the Round 2a rooms shell (create / list / open an empty room).

## Scope
Round 2 implements sub-round **2a: Rooms — HTTP + Shell** from `plans/master-plan.md`.
No messages, no Socket.io, no history pagination — those are later rounds.

## Dependencies
- `plans/master-plan.md` — Round 2a bullets
- `requirements.txt` §2.4 Chat Rooms (properties, ownership, join/leave rules)
- `shared/api-contract.md` — current state (auth only)
- `shared/types/` — existing exports (`user.ts`, `auth.ts`)

## Tasks

### 1. Create `/shared/types/room.ts`
Export these interfaces/literal-union types:

- `RoomVisibility = 'public' | 'private'`
- `RoomRole = 'owner' | 'admin' | 'member'`
- `Room` — `{ id: string; name: string; description: string | null; visibility: RoomVisibility; ownerId: string; createdAt: string; memberCount: number }`
- `RoomMember` — `{ roomId: string; userId: string; username: string; role: RoomRole; joinedAt: string }`
- `RoomDetail = Room & { members: RoomMember[] }`
- `CreateRoomRequest` — `{ name: string; description?: string; visibility: RoomVisibility }`

Notes for type shape:
- `description` nullable in `Room`; optional in `CreateRoomRequest` (server stores null if omitted)
- `memberCount` returned in list + detail so FE can render `#room (N)` without a second call
- `RoomDetail.members` is the materialised list for the right-rail; endpoint `GET /rooms/:id` returns this
- Do **not** add `type: 'public' | 'dm'` field here — DM support is Round 3b

### 2. Update `/shared/types/index.ts`
Add `export * from './room';` after the existing auth/user exports.

### 3. Extend `/shared/api-contract.md`
Append a `## Rooms Endpoints` section with the five endpoints. All require `Authorization: Bearer <accessToken>`; all return `401` on missing/invalid token (document once at section top, not per endpoint).

| Method | Path | Body | Success | Errors |
|--------|------|------|---------|--------|
| GET | `/api/rooms` | — | `200 Room[]` (rooms the caller is a member of, newest first) | — |
| POST | `/api/rooms` | `CreateRoomRequest` | `201 RoomDetail` (creator auto-joined as `owner`) | `400` validation, `409` name taken |
| GET | `/api/rooms/:id` | — | `200 RoomDetail` | `403` not a member, `404` not found |
| POST | `/api/rooms/:id/join` | — | `200 RoomDetail` (idempotent if already member) | `403` private room (no invite in 2a), `404` not found |
| POST | `/api/rooms/:id/leave` | — | `204` | `403` owner cannot leave, `404` not a member |

Document in prose under the table:
- Room `name` must be unique across the whole system (requirement §2.4.2). Case-insensitive comparison; store original casing.
- Validation constraints: `name` 3–64 chars, `description` 0–500 chars, `visibility` must be one of the literals.
- `POST /rooms/:id/join` on a private room returns `403` for Round 2a. Invitations come in Round 5b.
- Members in `RoomDetail.members` are ordered: owner first, then admins by `joinedAt`, then members by `joinedAt`.

### 4. No agent description changes
`.claude/agents/backend-developer.md` and `.claude/agents/frontend-developer.md` already reference `/shared/` as the source of truth. No edits required for Round 2.

### 5. Master plan update
Leave `plans/master-plan.md` unchanged. Round 2a scope is frozen; 2b/2c remain as-is.

## Wrap-up
Write `plans/round-2/orchestrator_work_summary.md` with:
- **Built** — files touched under `/shared/` and the final endpoint list
- **Deviations** — any shape changes made after BE/FE feedback
- **Deferred** — anything from master plan Round 2 that slipped
- **Next round needs to know** — decisions that affect Round 3 (2b / real-time messaging): e.g. whether the server will broadcast `room:member-joined` on join (Round 3c presence territory) or whether `memberCount` stays HTTP-only
- **Config improvements** — suggested tweaks to agent configs, CLAUDE.md, or the design-system skill that surfaced during the round
