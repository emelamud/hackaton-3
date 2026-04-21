# Round 6 — Orchestrator Tasks

## Goal
Lock the contract for 1:1 Direct Messages (reusing the Round-3 message pipeline) and user-to-user bans (requirement §2.3.5). Add the `Room.type` discriminator, the `DirectMessage` + `UserBan` types, the new `POST /api/dm` upsert endpoint, the user-ban endpoint surface, and the new socket events (`dm:created`, `user:ban:applied`, `user:ban:removed`) so FE and BE can build DMs end-to-end.

## Scope
Round 6 from `plans/master-plan.md` — DMs + user-to-user ban (promised to this round by every Round 2–5 summary since ban is only observable through DMs).

Out of scope:
- Message edit / delete / reply (Round 10).
- Unread badges on DM rows (Round 12).
- Presence dots on DM rows (Round 7 — row layout must reserve the slot).
- Attachments in DMs (Round 8 — the reuse of the `messages` table means attachments will Just Work there once Round 8 lands).
- Moderation-style admin for DMs — DMs never have admins (requirement §2.5.1); `PATCH /api/rooms/:id`, admin promotion, member removal, and room deletion are all `400` / `403` on DM rooms.

## Design decisions (locked during planning — record as rationale on the contract)

- **Q1 — DM model: reuse the `rooms` table with a `type` discriminator.**
  Add a `room_type` enum column: `'channel' | 'dm'`. Existing rooms backfill to `'channel'` (Round 2 semantics unchanged). DMs are rows with `type='dm'`, two `room_members` entries (both `role='member'`), no owner, no admin. Reason: the master plan explicitly prescribes reusing the message table + socket events, which means DMs must live in `rooms` so `messages.room_id` still resolves. We rename the master-plan's `'public' | 'dm'` to `'channel' | 'dm'` because `'public'` would collide with the existing `visibility` enum value.

- **Q2 — DM uniqueness: separate `direct_messages` lookup table keyed on the canonical unordered pair.**
  `direct_messages(room_id, user_a_id, user_b_id, created_at)` where `user_a_id = LEAST(a, b)` and `user_b_id = GREATEST(a, b)`, `UNIQUE (user_a_id, user_b_id)`. This gives `POST /api/dm` an O(1) upsert path ("row exists → return existing room; absent → create + insert both `room_members`") without a self-join on `room_members`. `room_id` FK with `ON DELETE CASCADE` so DM room deletion (§2.1.5 account-delete path, future round) cascades cleanly.

- **Q3 — DM room naming: `name` and `owner_id` stay on `rooms` but become nullable for DMs.**
  DMs use `name = NULL`, `owner_id = NULL`, `description = NULL`, `visibility = 'private'` (unused but non-null per existing enum). Channels retain the existing NOT NULL constraints enforced via two CHECK constraints: `(type='channel' AND name IS NOT NULL) OR type='dm'` and `(type='channel' AND owner_id IS NOT NULL) OR type='dm'`. The existing `rooms_name_lower_idx` unique index keeps uniqueness across channel names; DMs (name NULL) are always permitted. No migration of existing rows — all current rows get `type='channel'` and already satisfy the new checks.

- **Q4 — `GET /api/rooms` still returns both channels and DMs; FE partitions by `type`.**
  Reason: a second HTTP round-trip for `GET /api/dms` would just duplicate auth + membership enumeration. The sidebar already does one `GET /api/rooms` on login; FE filters by `type` client-side for the channel list vs DM list.

- **Q5 — DM sidebar row identity: `participantUser` denormalised on the `Room` payload for `type='dm'`.**
  For DMs, server adds a `dmPeer: { userId, username }` field to `Room` / `RoomDetail` populated from the OTHER participant (never the caller). Reason: without this the FE has to scan `members` and filter-out-self every render. The existing `members` array still contains both users; `dmPeer` is a denormalised convenience. For channels, `dmPeer` is absent.

- **Q6 — DM creation is an **upsert**, not a **create**.**
  `POST /api/dm { toUserId }` returns `201 RoomDetail` on first creation, `200 RoomDetail` on a subsequent call that hits the existing row. FE treats either status as "open this DM". Mirrors the `POST /api/rooms/:id/join` idempotent-when-already-member pattern from Round 2.

- **Q7 — DM message gating: friendship is NOT required; only "no active ban in either direction".**
  Re-reading requirement §2.3.6 ("users may exchange personal messages only if they are friends and neither side has banned the other"), a strict read would gate DM send on friendship. However, several prior-round summaries assumed friendship-only gating; it creates a worse UX where you DM someone, they remove you as a friend mid-conversation, and your next message fails silently. We lock:
  - `POST /api/dm` requires **friendship** at creation time (the UI entry point is the friend row's Message action anyway). `403 "You must be friends to start a direct message"` on non-friend.
  - `message:send` on an existing DM checks **no active ban** only. Friendship removal freezes no messages (they can still talk); only a ban freezes the conversation. This matches §2.5.1 "personal chats … support the same message and attachment features as room chats" — the DM room persists.
  - If ban is in place: `message:send` acks `{ ok: false, error: "Personal messaging is blocked" }`. History remains visible (requirement §2.3.5 "existing personal message history remains visible but becomes read-only/frozen").

- **Q8 — Ban side effects: ban deletes the friendship atomically and cancels pending requests in either direction.**
  When `POST /api/user-bans { userId }` fires:
  1. Insert `user_bans(blocker_user_id=caller, blocked_user_id=target)` row.
  2. Inside the same transaction: delete both `friendships` rows (if present) and any `friend_requests` in either direction.
  3. Emit `friend:removed` to `user:<target>` (consistent with Round 5 `DELETE /api/friends/:userId`) so the target's friends list drops the row.
  4. Emit `user:ban:applied` to `user:<target>` with `{ userId: caller.id }` so the target's DM with the blocker shows as frozen and the composer disables.
  Unban (`DELETE /api/user-bans/:userId`) is symmetric minus the friendship restore — unbanning does NOT re-create friendship (requirement §2.3.5 "friend relationship … effectively terminated" — termination is permanent).

- **Q9 — Ban is asymmetric (per-direction) but DM-send is gated by **either** direction.**
  The `user_bans` row records who banned whom. `(blocker=A, blocked=B)` means A banned B — B cannot message A. If additionally `(blocker=B, blocked=A)` exists, A also cannot message B. Unbanning is per-row (only the original blocker can remove their own ban). DM-send checks "any row exists in either direction" for the DM to be frozen.

- **Q10 — Block/unblock UI surface: overflow menu on friend row + DM header menu; blocked-list is a profile-menu dialog.**
  Minimum UI: "Block user" in the overflow menu on the friend sidebar row and in the DM header overflow menu; "Unblock" in a "Blocked users" dialog opened from the profile menu in the top nav. No dedicated `/blocked` route — a dialog is sufficient for hackathon scope.

## Dependencies
- `plans/master-plan.md` §Round 6 bullets.
- `requirements.txt` §2.3.5 (user-to-user ban), §2.3.6 (personal messaging rule), §2.5.1 (room vs personal chat model), §4.1 (top nav + side layout).
- `shared/api-contract.md` — current state (auth, rooms, invitations, messages, friends, socket events).
- `shared/types/` — existing exports (`user.ts`, `auth.ts`, `room.ts`, `message.ts`, `invitation.ts`, `friend.ts`, `socket.ts`).
- `plans/round-5/orchestrator_work_summary.md` §Next round needs to know — friendship is the DM gate at creation; user-ban lands with DMs; `user:<id>` fan-out room is already joined on connect (no new subscription state needed for user-scoped events).
- `plans/round-5/backend_work_summary.md` §Next round needs to know — friendship lookup is `SELECT 1 FROM friendships WHERE user_id=$caller AND friend_user_id=$other`; `emitToUser` / `emitToRoom` helpers in `backend/src/socket/io.ts` should be the new default for socket emissions (Round 5 didn't retrofit — Round 6 has 5 fresh emission call-sites, use the helpers).
- `plans/round-5/frontend_work_summary.md` §Next round needs to know — the Friends sidebar row already has a `ml-auto` affordance reserved for a second icon button (the "Message" action); `FriendsService.friends()` is the DM sidebar's input; the root-scoped-service-subscribes-in-constructor pattern (`InvitationsService`, `FriendsService`) generalises directly to a new `DmsService` and `UserBansService`.

## Tasks

### 1. Update `/shared/types/room.ts`
Add the `type` discriminator and the DM peer field. Keep all existing exports backward-compatible.

```ts
export type RoomType = 'channel' | 'dm';

export type RoomVisibility = 'public' | 'private';
export type RoomRole = 'owner' | 'admin' | 'member';

export interface DmPeer {
  userId: string;
  username: string;
}

export interface Room {
  id: string;
  type: RoomType;                // NEW — 'channel' for existing rooms, 'dm' for DMs
  name: string | null;           // nullable now — null for DMs
  description: string | null;
  visibility: RoomVisibility;
  ownerId: string | null;        // nullable now — null for DMs
  createdAt: string;
  memberCount: number;
  dmPeer?: DmPeer;               // present only when type === 'dm' — the OTHER participant
}

export interface RoomMember {
  roomId: string;
  userId: string;
  username: string;
  role: RoomRole;
  joinedAt: string;
}

export type RoomDetail = Room & {
  members: RoomMember[];
};

export interface CreateRoomRequest {
  name: string;
  description?: string;
  visibility: RoomVisibility;
}

export interface PatchRoomRequest {
  name?: string;
  description?: string | null;
  visibility?: RoomVisibility;
}

export interface OpenDmRequest {
  toUserId: string;
}
```

Notes:
- `name` and `ownerId` moving to `string | null` is a BREAKING type change for existing FE/BE consumers. Audit every callsite that reads `room.name` / `room.ownerId` and add the null check or narrow by `type === 'channel'` first. Task 5 below enumerates the expected touchpoints.
- `dmPeer` is optional so channel rooms never carry it. FE rendering logic keys off `type === 'dm' ? room.dmPeer : null`.

### 2. Create `/shared/types/user-ban.ts`
New file.

```ts
export interface UserBan {
  userId: string;            // the banned user (the blocked party, from the caller's POV)
  username: string;
  createdAt: string;
}

export interface CreateUserBanRequest {
  userId: string;            // the user to block
}

export interface UserBanAppliedPayload {
  userId: string;            // the blocker's id (from the victim's POV)
}

export interface UserBanRemovedPayload {
  userId: string;            // the blocker's id (from the victim's POV)
}
```

Rationale:
- `GET /api/user-bans` from the blocker's POV returns `UserBan[]` — each row is a user the caller blocked. `userId` is the OTHER user (the blocked party), matching the `Friend.userId` convention.
- The two socket payloads fire to the VICTIM's `user:<id>` when someone else blocks/unblocks them. `payload.userId` in both cases is the blocker's id — same shape as `FriendRemovedPayload`.

### 3. Update `/shared/types/index.ts`
Append `export * from './user-ban';` after the existing `./friend` export.

### 4. Update `/shared/types/socket.ts`
Add the three new `Server → Client` events to `ServerToClientEvents`:

```ts
import type {
  UserBanAppliedPayload,
  UserBanRemovedPayload,
} from './user-ban';
import type { RoomDetail } from './room';

export interface ServerToClientEvents {
  // ... existing entries ...
  'dm:created': RoomDetail;
  'user:ban:applied': UserBanAppliedPayload;
  'user:ban:removed': UserBanRemovedPayload;
}
```

### 5. Extend `/shared/api-contract.md`

#### 5a. Update the `## Rooms Endpoints` preamble and per-endpoint blocks

**Rules additions** (bulleted under the existing `### Rules` block):
- Rooms now carry a `type: 'channel' | 'dm'` discriminator. All existing endpoints describe `channel` behaviour unless otherwise stated.
- DMs (`type='dm'`) cannot be mutated via `PATCH /api/rooms/:id` — returns `400 { "error": "DM rooms are not editable" }`.
- DMs cannot be joined via `POST /api/rooms/:id/join` — returns `403 { "error": "Direct messages are only reachable via /api/dm" }`.
- DMs cannot be left via `POST /api/rooms/:id/leave` — returns `403 { "error": "DM rooms cannot be left" }`. (Leaving would break the 2-participant invariant; requirement §2.3.5 uses the user-to-user ban surface for severing.)
- `GET /api/rooms` now returns both channels and DMs, ordered by `createdAt` descending. Callers distinguish via `type`.
- `Room.name` and `Room.ownerId` are `string | null`; they are `null` for DMs and non-null for channels. `Room.dmPeer` is populated for DMs only (the other participant's `{ userId, username }`).
- Posting to `POST /api/rooms/:id/invitations` against a DM returns `400 { "error": "DMs cannot have invitations" }`.

#### 5b. Add a new top-level `## Direct Message Endpoints` section (after `## Friend Endpoints`, before `## Socket Events`)

Auth preamble: all DM endpoints require `Authorization: Bearer <accessToken>`; `401` on missing / invalid / expired tokens.

**Rules**:
- A DM is an upsertable 1:1 `rooms` row with `type='dm'` and two members; no owner, no admins.
- Starting a DM requires an existing friendship with the target user (Q7). No friendship → `403 "You must be friends to start a direct message"`.
- Starting a DM with a user who has banned the caller (or who the caller has banned) → `403 "Personal messaging is blocked"`. Same string is used by `message:send` when a ban exists; FE can render the same frozen-composer UX.
- DM is unique per unordered pair of users (Q2). `POST /api/dm` is idempotent: second call returns the existing room.
- Self-DM is rejected: `400 "You cannot open a DM with yourself"`.

**Summary**:

| Method | Path | Body | Success | Errors |
|--------|------|------|---------|--------|
| POST | `/api/dm` | `OpenDmRequest` | `201 RoomDetail` (first-time create) or `200 RoomDetail` (existing) + `dm:created` emitted to BOTH participants | `400` self-target / validation, `403` not friends / banned either way, `404` target user not found |

#### 5c. Add a new top-level `## User Ban Endpoints` section (after `## Direct Message Endpoints`, before `## Socket Events`)

Auth preamble: all user-ban endpoints require `Authorization: Bearer <accessToken>`; `401` on missing / invalid / expired tokens.

**Rules**:
- A user-ban is directional: `(blocker, blocked)` — if A bans B, only A can remove that ban.
- Creating a ban atomically severs any friendship and cancels any pending `friend_requests` between the two users in either direction (Q8).
- Banning a user who has banned you is allowed (creates the mirror row); unbanning only affects rows you own.
- Self-ban is rejected: `400 "You cannot ban yourself"`.
- DM send to / from a banned user is blocked in either direction (Q9); see `message:send` contract under §Socket Events for the ack string.

**Summary**:

| Method | Path | Body | Success | Errors |
|--------|------|------|---------|--------|
| GET | `/api/user-bans` | — | `200 UserBan[]` (caller's blocked list, newest first) | — |
| POST | `/api/user-bans` | `CreateUserBanRequest` | `204` + `user:ban:applied` emitted to victim + `friend:removed` emitted to victim (if they were friends) | `400` self-target / validation, `404` target user not found, `409` already banned |
| DELETE | `/api/user-bans/:userId` | — | `204` + `user:ban:removed` emitted to the previously-banned user | `404` no ban exists |

**Per-endpoint error strings** (exact, verbatim):
- `"You cannot ban yourself"`
- `"User not found"` (reused)
- `"User is already banned"`
- `"Not banned"` (404 on DELETE when the caller has no matching ban row)
- `"You must be friends to start a direct message"` (403 on `POST /api/dm` when the friendship is absent)
- `"Personal messaging is blocked"` (403 on `POST /api/dm` when any ban exists in either direction; also `{ ok: false, error: ... }` in `message:send` ack for DM rooms with a ban)
- `"You cannot open a DM with yourself"`
- `"DM rooms are not editable"` (400 on `PATCH /api/rooms/:id` for a DM)
- `"Direct messages are only reachable via /api/dm"` (403 on `POST /api/rooms/:id/join` for a DM)
- `"DM rooms cannot be left"` (403 on `POST /api/rooms/:id/leave` for a DM)
- `"DMs cannot have invitations"` (400 on `POST /api/rooms/:id/invitations` for a DM)

#### 5d. Extend the `## Socket Events` section

**Server → Client** — add three new event blocks:

`dm:created`
- Payload: full `RoomDetail` (with `type='dm'`, `dmPeer` populated per recipient: each side receives a `RoomDetail` where `dmPeer` is the OTHER user — same split-by-recipient shape as `friend:request:accepted`).
- Fired to both sides' `user:<id>` after `POST /api/dm` succeeds and the DM was actually created (not on idempotent upsert re-hits; second caller gets the HTTP response but no socket broadcast since nothing changed).
- Receivers join `room:<dmRoomId>` via `socketsJoin` before the event fires so they start receiving `message:new` for the DM without reconnecting. Pattern matches `POST /api/invitations/:id/accept` from Round 4.

`user:ban:applied`
- Payload: `UserBanAppliedPayload` (`{ userId }` = the blocker's id).
- Fired to `user:<victimId>` after `POST /api/user-bans` succeeds. Victim's UI: drops the blocker from friends (already handled by the companion `friend:removed` event if they were friends), marks the shared DM room as frozen.
- NOT fired to the blocker — they initiated the action.

`user:ban:removed`
- Payload: `UserBanRemovedPayload` (`{ userId }` = the blocker's id).
- Fired to `user:<previouslyBannedUserId>` after `DELETE /api/user-bans/:userId` succeeds. Victim's UI un-freezes the shared DM. Friendship is NOT restored — user must re-friend manually.
- NOT fired to the blocker.

**Client → Server — `message:send` update**: extend the Failure ack list with one new string:
- `{ "ok": false, "error": "Personal messaging is blocked" }` — fired when the target room has `type='dm'` and a `user_bans` row exists in either direction between the two participants.

No change to `On connect` subscription state — the existing `user:<id>` + `room:<roomId>` joins cover DMs once the user becomes a DM participant.

#### 5e. Housekeeping sweep
While editing `shared/api-contract.md`:
- Grep the file for `Round [0-9]+[a-z]?\b` and confirm no stale round references. Prior rounds' orchestrator summaries flagged this sweep — Round 5 normalised `Round 5a → Round 11` and `Round 5 introduces ?before= → Round 9 introduces`. Round 6 may add its own references ("Round 12 adds unread badges on DM rows …"); keep them minimal and accurate.
- Confirm the existing `## Rooms Endpoints` Rules block still reads correctly after the DM-related rule additions in 5a.

### 6. No agent-description updates
`.claude/agents/backend-developer.md` and `.claude/agents/frontend-developer.md` already cover Drizzle, Socket.io, Material M3, and reactive forms. The new endpoints use the same libraries and patterns. Nothing to update.

### 7. No master-plan update
Round 6 bullet in `plans/master-plan.md` still reads accurately after this round's scope. Do not edit.

## Wrap-up
Write `plans/round-6/orchestrator_work_summary.md` with:
- **Built** — files touched under `/shared/`, final endpoint list, the three new socket events, the breaking `Room.name` / `Room.ownerId` nullability change and the downstream review work.
- **Deviations** — any shape changes BE or FE pushed back during implementation (the `dmPeer` convenience field is most likely to come under pressure — if BE or FE prefers filter-by-members over the denormalised field, document it).
- **Deferred** — unread badges on DM rows (Round 12); presence dots on DM rows (Round 7); account-delete cascade (requirement §2.1.5 is an unscheduled round); attachment support in DMs (automatic once Round 8 lands since DMs are rooms); dedicated `/blocked` route (dialog is sufficient).
- **Next round needs to know** — for Round 7 (presence): DM rows join the three-consumer-set for presence subscription (`FriendsService.friends() + chatContext.currentRoom().members + rooms.filter(type='dm').map(dmPeer)` — dedupe by userId); the DM header's presence dot should reuse the same `user:<id>` presence map. For Round 8 (attachments): DMs are rooms so the `messages` table already carries their attachments once Round 8 extends the schema; the access-control check (requirement §2.6.4 "authorized participants of the personal chat") reduces to the standard "caller is a member of the room" check. For Round 9 (history pagination): the DM `:roomId` is no different from a channel `:roomId` — `GET /api/rooms/:id/messages?before=&limit=` works identically.
- **Config improvements** — whether `Room.name` and `Room.ownerId` nullability warrants a branded `Channel` vs `Dm` TypeScript discriminated union (scope creep — flag for Round 12+); whether the "no agent-description update" pattern is causing drift (every round ships new socket events and no agent config acknowledges them — a brief "consult `shared/types/socket.ts` for the source of truth on event names + payloads" line in both agent descriptions would be a 10-line improvement).
