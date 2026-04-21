# Round 6 — Orchestrator Work Summary

> **Resume note for the next session.** Phase 1 of `/implement-round 6` landed in the previous session on 2026-04-21 from 16:46:07 → 16:51:24 +0300 (epoch 1776779167 → 1776779484, duration 5m17s). Shared types + api-contract are up-to-date; this file is the Phase 1 deliverable. When resuming, **skip Phase 1 and dispatch Phase 2 directly** — run `backend-developer` and `frontend-developer` in parallel against `plans/round-6/backend_tasks.md` and `plans/round-6/frontend_tasks.md` per the `/implement-round` skill. Carry `T_overall_start = 2026-04-21 16:46:07 +0300` and `T_p1_start` / `T_p1_end` above into the eventual `time_log.md` implementation block so Phase 1's duration is preserved. The previous session ran into a harness issue where the project-level `.claude/agents/backend-developer.md` and `.claude/agents/frontend-developer.md` weren't registered (missing `name:` key in YAML frontmatter, now patched) — after a session restart, `/agents` should list both, and `subagent_type: "backend-developer"` / `"frontend-developer"` resolve correctly.

## Built

**Shared types (`/shared/types/`)**

- `room.ts` — added `RoomType = 'channel' | 'dm'`, added `DmPeer`, made `Room.name` and `Room.ownerId` nullable (`string | null`), added optional `Room.dmPeer?: DmPeer`, added `OpenDmRequest`. Existing `RoomDetail` / `CreateRoomRequest` / `PatchRoomRequest` unchanged in name, but `RoomDetail` now picks up the new nullable + `dmPeer` fields via the `Room` base.
- `user-ban.ts` — NEW file. Exports `UserBan`, `CreateUserBanRequest`, `UserBanAppliedPayload`, `UserBanRemovedPayload`.
- `index.ts` — added `export * from './user-ban';` between `./friend` and `./socket`.
- `socket.ts` — imported `UserBanAppliedPayload`, `UserBanRemovedPayload`; added three new `ServerToClientEvents` entries: `'dm:created': RoomDetail`, `'user:ban:applied': UserBanAppliedPayload`, `'user:ban:removed': UserBanRemovedPayload`.

**API contract (`/shared/api-contract.md`)**

- `## Rooms Endpoints` **Rules** block extended with six new bullets covering: the `type` discriminator, `GET /api/rooms` returning both channels and DMs, nullability of `name` / `ownerId` / presence of `dmPeer`, and the four DM-hostile rejections on the existing endpoints (`PATCH`, `join`, `leave`, `invitations`) with verbatim error strings.
- NEW `## Direct Message Endpoints` section added between `## Friend Endpoints` and `## Socket Events`. Contains Rules preamble, Summary table (single row for `POST /api/dm`), and per-endpoint block with full `RoomDetail` example payload and all error cases (`400` self-target / validation, `403` not friends / banned either direction, `404` user not found). Documents the `201` (first-time create) vs `200` (idempotent re-hit) distinction, and that `dm:created` only fires on first-time create.
- NEW `## User Ban Endpoints` section added between `## Direct Message Endpoints` and `## Socket Events`. Contains Rules preamble (directionality, atomic friendship severance + silent friend-request cleanup, unban does NOT restore friendship), Summary table (3 rows: `GET`, `POST`, `DELETE`), and per-endpoint blocks for each.
- `## Socket Events` → `message:send` ack list extended with one new verbatim failure string: `{ "ok": false, "error": "Personal messaging is blocked" }`, scoped to DMs only.
- `## Socket Events` → `Server → Client` — three new event blocks added: `dm:created` (full `RoomDetail` per-recipient with flipped `dmPeer`, fires only on first-time create, includes the `socketsJoin` note), `user:ban:applied` (to victim with blocker's id, companion `friend:removed` when friendship was severed), `user:ban:removed` (to previously-banned with blocker's id, no friendship restore).
- `friend:removed` event block extended with one bullet noting the `POST /api/user-bans` co-emission path.
- Housekeeping grep for `Round N` references confirms no stale refs. All existing references (Rounds 3, 4, 5, 9, 11) remain accurate. New Round 6 references added at 4 call-sites (Rooms Rules intro, Ban-aware ack string, `friend:removed` annotation, `dm:created` block inherited via "Round 6" in Rules block only).

**Design-decision rationale captured in the contract** (per the planning Q&A, Q1–Q10):
- DM storage lives in `rooms` with a discriminator (Q1) — necessary so `messages.room_id` keeps resolving.
- Idempotent upsert via canonical pair (Q2) — surfaces as the `200` vs `201` distinction in the contract.
- `name`/`ownerId` nullable only for DMs, enforced via CHECK constraints that live in the BE migration (Q3) — the contract carries only the type-level nullability.
- Unified `GET /api/rooms` for both kinds (Q4) — documented in the Rules block.
- Denormalised `dmPeer` on the payload (Q5) — documented throughout; FE consumers read `dmPeer` directly rather than filter-by-members.
- DM create is an upsert, not a create (Q6) — `201`/`200` contract captures it.
- Friendship gates DM CREATE; bans gate DM MESSAGE SEND (Q7) — the two error strings (`"You must be friends to start a direct message"` vs `"Personal messaging is blocked"`) map directly to the two gates.
- Ban has side effects — friendship deleted, pending requests cleaned (Q8) — Rules block under User Ban Endpoints calls out the atomic severance and the silent pending-request cleanup.
- Ban is asymmetric but DM is gated in either direction (Q9) — Rules block under User Ban Endpoints.
- Block UI surface lives in overflow menus + profile-menu dialog (Q10) — out of contract scope, lives in the FE task file only.

## Deviations

None from the planning doc. All ten design decisions landed verbatim in the contract and types.

The only subtle shape choice worth flagging: `dm:created` is documented as firing ONCE per create-event (not per user), but the server builds two separate `RoomDetail` payloads (one per recipient) so each side's `dmPeer` is correctly flipped. The contract's pattern note ("same per-recipient split shape as `friend:request:accepted`") makes this explicit. BE implementers should not hand a single payload to `emitToRoom`; they should `emitToUser` twice with the per-side payload — this is spelled out in the BE task file task 7.

## Deferred

- **Unread badges on DM rows** — Round 12.
- **Presence dots on DM rows / DM header** — Round 7 (row layout reserves the slot already).
- **Attachments in DMs** — Round 8. DMs live in `rooms` and messages in `messages`, so extending the `messages` schema for attachments in Round 8 automatically covers DMs. The access-control check reduces to "caller is a member of the room" — unchanged.
- **Account-delete cascade through DM rooms** — unscheduled (requirement §2.1.5). The `direct_messages.room_id` FK uses `ON DELETE CASCADE` so whenever that round lands the cascade already works.
- **Dedicated `/blocked` route** — a profile-menu dialog is sufficient for hackathon scope (Q10).
- **Edit / delete / reply on DM messages** — Round 10, same pipeline as channel messages.
- **Server-side "who blocked me" list** — deliberately not exposed. FE derives the `incomingBans` set from live `user:ban:applied` / `user:ban:removed` events during the session, and retroactively from the `message:send` ack `"Personal messaging is blocked"`. Accepted hackathon trade-off: a user who logs in after having been banned while offline only learns of the ban on their first send attempt.
- **`friend:request:cancelled` emissions on ban-triggered pending-request cleanup** — the ban transaction drops pending requests silently. Both the sender and recipient notice on next refresh. Hackathon trade-off; documented in BE task file.
- **Integration tests** — carry-over from all prior rounds.

## Next round needs to know

**For Round 7 (presence)**
- The DM sidebar row needs a presence dot keyed on `room.dmPeer.userId`. The three-consumer union for `user:<id>` presence subscriptions becomes:
  `FriendsService.friends().map(f => f.userId) ∪ chatContext.currentRoom().members.map(m => m.userId) ∪ roomsService.roomsSignal().filter(r => r.type === 'dm').map(r => r.dmPeer!.userId)`,
  deduped by userId.
- The DM header's presence dot lives to the left of `@username` — that slot is already reserved by Round 6's `room-view` header update.

**For Round 8 (attachments)**
- DMs are rooms; the `messages.room_id` FK already covers them. No schema branch needed for DM vs channel on the attachments side.
- The attachment access-control check (requirement §2.6.4 "authorized participants of the personal chat") reduces to the standard "caller is a member of the room" check — identical to channel attachments.
- The ban gate on `message:send` does NOT automatically cover a separate attachment-upload endpoint if Round 8 adds one. If a separate upload endpoint lands, it must replicate the DM-ban check to avoid letting a blocked user push files into a frozen DM. Flag this explicitly when planning Round 8.

**For Round 9 (history pagination)**
- `GET /api/rooms/:id/messages?before=<msgId>&limit=` works identically for DMs and channels — `room.type` is irrelevant to paging. No extra case-work in the pagination wiring.

**For Round 11 (moderation / room admin)**
- DM rooms never have admins. When the moderation round ships admin-only controls (Remove Member, Ban, Make Admin, Delete Room, etc.), every control must short-circuit on `room.type === 'dm'` — the existing DM-hostile error strings on `PATCH`, `join`, `leave`, and `invitations` are the template.
- `Room.ownerId === null` for DMs means any "is caller the owner?" check that assumes a non-null `ownerId` will now quietly evaluate to `false` — good news for default-deny, but worth the grep when planning.

**Contract-level**
- `Room.name` and `Room.ownerId` becoming nullable is a **breaking TypeScript shape change** that FE and BE must handle at every read site. The FE and BE task files each call out the expected audit paths (frontend task 1, backend task 4). If a future round sees type errors at an unexpected call-site, the fix is to branch on `room.type === 'channel'` first.

## Config improvements

- **Branded `Channel` vs `Dm` TypeScript discriminated union (scope creep, flag for Round 12+)** — `Room.name: string | null` opens up `undefined.toLowerCase()`-style bugs at every consumer site. A proper discriminated union (`type IRoom = Channel | Dm` where `Channel` narrows `name`/`ownerId` to non-null and forbids `dmPeer`, and `Dm` does the inverse) would let a `isDm(room)` type-guard handle the narrowing in one line instead of N inline `??` fallbacks. Not worth the churn mid-round but a good cleanup for a dedicated "type hygiene" pass.
- **Agent descriptions are drifting re: socket events** — every round since Round 3 has shipped new `ServerToClientEvents` entries, and neither `.claude/agents/backend-developer.md` nor `.claude/agents/frontend-developer.md` mentions the shared contract as the source of truth for event names/payloads. A single line in each — "For socket events, `shared/types/socket.ts` is authoritative — do not invent new event names, and do not hand-roll `io.emit(...)`; use `emitToUser` / `emitToRoom` from `backend/src/socket/io.ts`" — would be a ~10-line improvement that prevents drift in Rounds 7+. Deferred to user approval at end of round.
- **Generic `ConfirmDialogComponent`** — FE side is now accumulating confirm dialogs (Remove Friend, Block User, and future Delete Room / Remove Member / Ban). Extracting a single parametrised component at the next FE pass would deduplicate the three-ish existing dialogs. Flag for Round 11 or a FE-cleanup micro-round.
- **`emitToUser` return type** — currently `void`. Growing it to `{ delivered: boolean }` (or at least emitting strict TS errors when the payload shape doesn't match the event key) would catch mis-matched payloads at compile time. Low-priority; socket event shapes are small and the `ServerToClientEvents` interface already provides generic-parameter enforcement via the helper. Flag for a future typing pass.
