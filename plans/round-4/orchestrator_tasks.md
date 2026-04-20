# Round 4 — Orchestrator Tasks

## Goal
Define the `Invitation` type, the `PatchRoomRequest` shape, the invitation HTTP endpoints, the `PATCH /api/rooms/:id` settings endpoint, and the two new socket events (`invitation:new` / `invitation:revoked` per-user, `room:updated` per-room) so FE and BE can build invitations + room settings.

## Scope
Round 4 from `plans/master-plan.md` — invitations + room settings, with live notifications. No moderation actions (Round 11), no invitation listing UI for inviters / admins (also Round 11), no DMs (Round 6).

## Design decisions (locked during planning)
- **Q1 — who can invite: `1a`**, any current member of the room. Simplest ACL; matches requirement §2.4.9's literal wording.
- **Q2 — who can PATCH settings: `2b`**, owner + admins. Admin promotion only lands in Round 11, so in practice only owners qualify today — but the check is `role in ('owner', 'admin')` now so no Round-11 rewrite is needed.
- **Q3 — can users invite to public rooms: `3a`**, no. Server returns `400` with `"Invitations are only for private rooms"` if the target room is public. Public rooms don't need the invite ceremony.

## Dependencies
- `plans/master-plan.md` §Round 4 bullets
- `requirements.txt` §2.4.9 (invitations), §2.4.2 (room properties), §2.4.7 (role definitions)
- `shared/api-contract.md` — current state (auth + rooms + messages + socket events)
- `shared/types/` — existing exports (`user.ts`, `auth.ts`, `room.ts`, `message.ts`)
- `plans/round-3/orchestrator_work_summary.md` §Next round needs to know — the server-pushed pattern, `socketsJoin` on accept, and the decision to emit full `RoomDetail` in `room:updated`
- `plans/round-3/backend_work_summary.md` §Next round needs to know — concrete call-site patterns (`getIo().in('user:<id>').emit(...)`, `socketsJoin` after accept, `socketsLeave` on kick/revoke)
- `plans/round-3/frontend_work_summary.md` §Next round needs to know — `ChatContextService` as the `room:updated` landing spot, `InvitationsService` sketch, subscribe-in-services-not-components rule

## Tasks

### 1. Create `/shared/types/invitation.ts`
Export:

```ts
export interface Invitation {
  id: string;
  roomId: string;
  roomName: string;          // denormalised — invitee's UI shouldn't need a second fetch
  invitedUserId: string;
  invitedByUserId: string;
  invitedByUsername: string; // denormalised
  createdAt: string;
}

export interface CreateInvitationRequest {
  username: string;          // server resolves to invitedUserId
}

export interface InvitationRevokedPayload {
  invitationId: string;
  roomId: string;
}
```

Notes:
- Denormalising `roomName` and `invitedByUsername` keeps the notification payload self-contained — the top-nav badge can render an invitation without any prerequisite data.
- `InvitationRevokedPayload` carries `roomId` as well as `invitationId` so the FE can cleanly drop the invitation even if it was keyed by room in any ad-hoc cache.

### 2. Extend `/shared/types/room.ts`
Append the patch shape at the bottom of the file (same module — a room mutation request belongs with the `Room` types):

```ts
export interface PatchRoomRequest {
  name?: string;
  description?: string | null;   // explicit null clears; omitted key leaves unchanged
  visibility?: RoomVisibility;
}
```

PATCH semantics: field present → update, field absent → unchanged. `description: null` is how the client clears the description (since the DB column is nullable). At least one field must be present in the body (server returns `400` otherwise).

### 3. Update `/shared/types/index.ts`
Append `export * from './invitation';` after the existing `message` export.

### 4. Extend `/shared/api-contract.md`

#### 4a. Add `PATCH /api/rooms/:id` to the Rooms Endpoints table + per-endpoint section
Append to the summary table:

| Method | Path | Body | Success | Errors |
|--------|------|------|---------|--------|
| PATCH | `/api/rooms/:id` | `PatchRoomRequest` | `200 RoomDetail` + `room:updated` broadcast | `400` validation / empty body, `403` not owner/admin, `404` not found, `409` name taken |

Per-endpoint block:

- **Auth**: caller must be a member of the room **and** have `role in ('owner', 'admin')`. Non-member → `404` (hide room existence). Member with `role = 'member'` → `403 { error: "Only room owners and admins can edit room settings" }`.
- **Body**: at least one of `name` / `description` / `visibility` must be present — entirely empty body → `400 { error: "At least one field is required" }`. Validation otherwise matches create (`name` 3–64 trimmed, unique case-insensitive; `description` 0–500 trimmed, may be `null`; `visibility` `"public"` | `"private"`).
- **Rename conflict**: if the new name matches another room's name case-insensitively → `409 { error: "Room name already taken" }`. Renaming to one's own current name (possibly different casing) is a no-op and must **not** 409.
- **Side effects**: server emits `room:updated` with the full fresh `RoomDetail` to `room:<id>` after a successful persist.
- **Visibility change semantics**: public → private keeps existing members; private → public opens the room to future catalog/joins. No auto-kick, no membership rewrite (requirement §2.4.5 doesn't require it).

#### 4b. Add a new top-level `## Invitation Endpoints` section (after the Rooms Endpoints section, before `## Socket Events`)

Structure the new section exactly like the Rooms Endpoints section — auth preamble, Rules block, Summary table, then per-endpoint blocks.

**Auth preamble**: all invitation endpoints require `Authorization: Bearer <accessToken>`. `401` on missing/invalid token.

**Rules**:
- Invitations are only for **private** rooms (requirement §2.4.9). Invitation creation against a public room returns `400 { error: "Invitations are only for private rooms" }`.
- Any current **member** of a private room may create an invitation (Q1 = 1a).
- An invitation is unique per `(roomId, invitedUserId)`. Creating a second one while a pending one exists → `409 { error: "An invitation is already pending for this user" }`.
- Inviting a user who is already a member → `409 { error: "User is already a member of this room" }`.
- Inviting a non-existent username → `404 { error: "User not found" }`.
- Only the invitee may `accept` or `reject` their invitation.
- Only the original inviter may `revoke` an invitation in Round 4. (Round 11 moderation will extend this to room admins.)
- `accept` is idempotent if the invitee is already a member — the invitation is deleted, no new membership row is inserted, and the response body still contains the current `RoomDetail`. No `409`.

**Summary table**:

| Method | Path | Body | Success | Errors |
|--------|------|------|---------|--------|
| POST | `/api/rooms/:id/invitations` | `CreateInvitationRequest` | `201 Invitation` + `invitation:new` emitted to invitee | `400` public room / validation, `403` not a member, `404` room not found / user not found, `409` duplicate pending / already member |
| GET | `/api/invitations` | — | `200 Invitation[]` (pending invitations where caller is the invitee, newest first) | — |
| POST | `/api/invitations/:id/accept` | — | `200 RoomDetail` + `room:updated` broadcast to room + socket subscribed to `room:<id>` | `403` not the invitee, `404` not found |
| POST | `/api/invitations/:id/reject` | — | `204` | `403` not the invitee, `404` not found |
| DELETE | `/api/invitations/:id` | — | `204` + `invitation:revoked` emitted to invitee | `403` not the inviter, `404` not found |

**Per-endpoint detail blocks** — standard shape: request/response JSON shown, error bodies spelled out. Error strings to preserve verbatim:
- `"Invitations are only for private rooms"`
- `"An invitation is already pending for this user"`
- `"User is already a member of this room"`
- `"User not found"`
- `"Invitation not found"` (404 on accept/reject/revoke)

#### 4c. Extend the `## Socket Events` section
Add two Server → Client events and update the per-connection room-subscription side-effect note. Keep the existing `message:send` / `message:new` blocks unchanged.

**New subsection under `### On connect`** (append to the existing "REST handlers keep subscriptions in sync" bullet list):
- After `POST /api/invitations/:id/accept` — server calls `io.in('user:<accepterUserId>').socketsJoin('room:<roomId>')` **before** emitting `room:updated`, so the accepter's tabs receive the same broadcast all other members do.

**New `### Server → Client events` entries**:

`invitation:new`
- Payload: `Invitation` (full denormalised shape).
- Fired to `user:<invitedUserId>` after `POST /api/rooms/:id/invitations` succeeds.
- The invitee's tabs render a notification. Inviter does **not** receive a self-broadcast.

`invitation:revoked`
- Payload: `InvitationRevokedPayload` (`{ invitationId, roomId }`).
- Fired to `user:<invitedUserId>` after `DELETE /api/invitations/:id` succeeds. The invitee's UI drops the notification.
- Not fired on `accept` / `reject` — those are invitee-driven, the invitee already knows.

`room:updated`
- Payload: full `RoomDetail`.
- Fired to `room:<roomId>` after:
  - `PATCH /api/rooms/:id` (any field changed).
  - `POST /api/invitations/:id/accept` (the new member is in `members`; `memberCount` bumped).
- **Not** fired on public `POST /api/rooms/:id/join` or `POST /api/rooms/:id/leave` in Round 4 — existing members reload to see count changes. Flagged as polish; will be retrofitted when moderation (Round 11) generalises member-change broadcasts.

### 5. No agent description changes
`.claude/agents/backend-developer.md` and `.claude/agents/frontend-developer.md` already cover Socket.io patterns. Nothing to update.

### 6. No master plan update
Round 4 stays as the master plan describes it.

## Wrap-up
Write `plans/round-4/orchestrator_work_summary.md` with:
- **Built** — files touched under `/shared/`, final event + endpoint list
- **Deviations** — any shape changes BE or FE pushed back
- **Deferred** — public `join` / `leave` `room:updated` broadcast, admin-level invitation revoke, `GET /api/rooms/:id/invitations` (inviter-visibility), room deletion
- **Next round needs to know** — for Round 5 (Message History + Pagination): decide whether to piggyback the Round 4 `room:updated` pattern for a future "new member's message-list should reflect they can see history up to their `joinedAt`" decision; and for Round 11 (moderation): extend the revoke / settings ACL to admins, add kick/ban broadcasts that reuse the `socketsLeave` pattern
- **Config improvements** — any socket-layer conventions worth folding back into agent configs after seeing how Round 4 plays out
