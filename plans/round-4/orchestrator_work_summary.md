# Round 4 Orchestrator — Summary

## Built

### `/shared/types/invitation.ts` (new)
- `Invitation` — `{ id, roomId, roomName, invitedUserId, invitedByUserId, invitedByUsername, createdAt }`
- `CreateInvitationRequest` — `{ username }`
- `InvitationRevokedPayload` — `{ invitationId, roomId }`

### `/shared/types/room.ts` (extended)
- Added `PatchRoomRequest` — `{ name?, description?: string | null, visibility? }`. `description: null` clears; omitting leaves unchanged.

### `/shared/types/index.ts` (updated)
- Added `export * from './invitation';` after the existing `message` export.

### `/shared/api-contract.md` (updated)

**Rooms Endpoints — Rules block**
- Swept the stale "Round 2a / Round 5b" reference (flagged by the Round 3 orchestrator summary). New wording points readers to `§Invitation Endpoints` and records the Q2 = 2b owner/admin ACL for PATCH.

**Rooms Endpoints — Summary table**
- Added `PATCH /api/rooms/:id` row: `PatchRoomRequest` → `200 RoomDetail` + `room:updated` broadcast; `400` empty body / validation, `403` not owner/admin, `404` not found, `409` name taken.

**Rooms Endpoints — PATCH per-endpoint block**
- Documented empty-body 400 (`"At least one field is required"`), rename-to-self no-op (case-only change is not a 409), visibility semantics (no auto-kick on public→private, no catalog rewrite on private→public), and exact 403 string (`"Only room owners and admins can edit room settings"`).

**New top-level `## Invitation Endpoints` section**
- Auth preamble, Rules block (private-only, member-can-invite, unique-per-pair, invitee-only accept/reject, inviter-only revoke, accept idempotency).
- Summary table of all 5 endpoints.
- Per-endpoint blocks with exact error strings preserved verbatim:
  - `"Invitations are only for private rooms"`
  - `"An invitation is already pending for this user"`
  - `"User is already a member of this room"`
  - `"User not found"`
  - `"Invitation not found"`
  - `"Forbidden"` (reused on 403s without a domain-specific message)

**Extended `## Socket Events`**
- REST-sync bullet list now includes: after `POST /api/invitations/:id/accept` → `socketsJoin('room:<id>')` **before** emitting `room:updated`.
- Three new Server → Client event blocks with full payload examples: `invitation:new` (→ `user:<id>`), `invitation:revoked` (→ `user:<id>`), `room:updated` (→ `room:<id>`, payload is full `RoomDetail`).
- Explicit deferred note: `room:updated` is **not** fired on public `POST /:id/join` or `POST /:id/leave` in Round 4.

## Deviations
None from the planning task file. One small, intentional aside:
- Swept the "Round 2a / Round 5b" legacy reference in the Rooms Rules block while editing adjacent content. Round 3 orchestrator summary had flagged this as outstanding; patching it in-place while already in the file was cheap and kept the contract coherent.

## Deferred
- `GET /api/rooms/:id/invitations` — inviter/admin visibility of a room's pending invitations. Nice-to-have for the Manage Room dialog; Round 4 scope deliberately skips it. Revisit with Round 11 (moderation) or a later polish pass.
- `DELETE /api/rooms/:id` — room deletion owned by Round 11 (moderation / destructive actions).
- `room:updated` on public `POST /:id/join` and `POST /:id/leave` — deferred polish so members see live count changes on public rooms. Intentionally excluded from Round 4 to keep the socket-event surface minimal; the pattern already exists and generalises trivially when we want it.
- Admin-level invitation revoke. Round 4 locks revoke to the original inviter. Round 11 can widen the gate by changing a single `invitedByUserId !== userId` check to a role check that includes room admins.
- Auto-kick on visibility transitions. Requirement §2.4.5 does not require it and we are not adding it.

## Next round needs to know

### For Round 5 (Message History + Pagination)
- No shape changes required. `/shared/api-contract.md` §Messages still references Round 5 for the `?before=<messageId>&limit=` extension; that endpoint is the only thing Round 5 needs to evolve.
- Round 5's cursor-paginated endpoint should not change the ascending-oldest-first ordering.
- `room:updated` broadcast now carries a full `RoomDetail`. Round 5's infinite-scroll work does not interact with this, but it's worth knowing so nobody piggybacks "new message appeared" via `room:updated` — that is still strictly `message:new`.

### For Round 11 (Moderation)
- PATCH's ACL gate (`role in ('owner', 'admin')`) is the template to copy for kick/ban/promote/demote. The exact string is already written once in the contract — `"Only room owners and admins can edit room settings"` can act as a pattern reference (each moderation endpoint will have its own string, same ACL).
- Invitation revoke should widen from "inviter only" to "inviter or room admin". Single check point in `invitationsService.revokeInvitation`.
- `room:updated` will also want to fire after bans and role changes; the broadcast channel (`room:<id>`) and payload (`RoomDetail`) are already established, so those are two-line additions in the relevant handlers.

### For general socket consumers
- Two FE services now subscribe to `room:updated` (`ChatContextService` and `RoomsService`). Each owns its slice of state. If a third consumer appears for the same event, it may be time to centralise into a bus — but two is fine.

## Config improvements

- **Stale round references in the contract.** This round fixed the Rooms Rules block. Worth a quick grep for any lingering "Round 2a / Round 5b / ..." strings anywhere else in `/shared/` before the next round — the renumber sweep was not exhaustive.
- **`backend/src/types/shared.ts` mirroring**: fourth round carrying hand-copied types. This is now a steady tax; proposing a follow-up to relax `rootDir` in `backend/tsconfig.json` or add a build-time copy step so the next round stops paying it. Round 2 and Round 3 both raised this.
- **Master-plan language**: the Round 4 bullet in `plans/master-plan.md` says "emit `invitation:new` on create and `room:updated` on patch" but Round 4 also emits `room:updated` after accept. Worth noting in-place that the deliverable broadened during planning; current discrepancy is small and documented in `plans/round-4/orchestrator_tasks.md` Design Decisions.
- **Agent-config socket convention**: Round 3 summary suggested a short paragraph in `.claude/agents/backend-developer.md` and `.claude/agents/frontend-developer.md` about socket conventions (ack on writes, broadcast via `room:<id>` / `user:<id>`, subscribe-in-services-not-components, exact error strings). Still worth doing — each additional round of socket events re-proves the rules by example.
