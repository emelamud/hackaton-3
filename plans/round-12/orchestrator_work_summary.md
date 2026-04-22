# Round 12 — Orchestrator Work Summary

## Built

**Shared types (`/shared/types/`)**

- `unread.ts` — **new file**. Three exports:
  - `UnreadCount { roomId: string; unreadCount: number; lastReadAt: string | null }` — `lastReadAt` is `null` when no cursor row exists yet (server falls back to `member.joined_at` for the effective cursor).
  - `MarkRoomReadResponse { roomId: string; lastReadAt: string }` — echoed from `POST /api/rooms/:id/read`.
  - `RoomReadPayload { roomId: string; lastReadAt: string }` — payload for the new `room:read` socket event.
- `catalog.ts` — **new file**. Two exports:
  - `PublicRoomCatalogEntry { id, name: string, description: string | null, memberCount, createdAt, isMember: boolean }` — `name` is typed as non-nullable (channels always carry a name at the DB level; catalog never returns DMs).
  - `PublicCatalogResponse { rooms: PublicRoomCatalogEntry[], hasMore: boolean, nextCursor: string | null }` — `nextCursor` is explicitly echoed (asymmetric with `MessageHistoryResponse` per D8).
- `index.ts` — **edited**. Added `export * from './unread'` and `export * from './catalog'` alongside the existing re-exports. Kept the ordering (presence before unread/catalog, socket last).
- `socket.ts` — **edited**. Added `import type { RoomReadPayload } from './unread'` and a new `'room:read': RoomReadPayload` entry to `ServerToClientEvents`. `ClientToServerEvents` untouched — mark-read stays HTTP-only per D4.

**API contract (`/shared/api-contract.md`)**

- `## Rooms Endpoints` summary table — **edited**. Added two rows immediately after the existing `PATCH /api/rooms/:id` row:
  - `POST | /api/rooms/:id/read | — | 200 MarkRoomReadResponse + room:read emitted to caller | 403 not a member, 404 not found`
  - `GET | /api/rooms/catalog | ?q=&cursor=&limit= | 200 PublicCatalogResponse | 400 invalid cursor / validation`
- `## Unread Endpoints` — **new section**, inserted before `## Socket Events` so all HTTP endpoint blocks stay contiguous. Covers:
  - Rules (per-user per-room timestamp cursor, caller's own messages excluded, UPSERT monotonic via `GREATEST`, shared table serves channels + DMs, cursor survives leave/rejoin, cascades on room delete).
  - Summary table with `GET /api/unread` and `POST /api/rooms/:id/read` rows.
  - Full endpoint blocks for both with request/response shapes, idempotency notes, and error envelopes.
- `## Public Room Catalog` — **new section**, immediately after Unread Endpoints. Covers:
  - Rules (public channels only, newest-first `(createdAt DESC, id DESC)`, ILIKE substring, `isMember` computed server-side, join via existing `POST /api/rooms/:id/join`, pull-based — no live push).
  - Summary table with the single `GET /api/rooms/catalog` row.
  - Full endpoint block with query-param table, response example, cursor echo semantics, and the reuse of `"Invalid cursor"` string inherited from Round 9.
- `#### room:read` block — **added** under `## Socket Events` → `### Server → Client events`, placed AFTER the existing `#### presence:snapshot` block so all server-to-client events remain grouped.

**No other shared surface touched.** Agent descriptions (`backend-developer.md`, `frontend-developer.md`), CLAUDE.md files, `master-plan.md`, `docker-compose.yml`, schema / migrations, env files — all untouched. Round 12 is purely a contract + new-code change; no new stack concerns, no deployment changes, no agent-config changes.

**Verification**
- `pnpm build` in `backend/` — clean (`> tsc` with no errors, no warnings). Confirms the new `RoomReadPayload` import in `socket.ts` resolves through `./unread` and the two new type files compile without cross-module issues.
- `pnpm build` in `frontend/` — clean. Angular production build succeeds; the new shared re-exports don't break the existing `@shared` imports anywhere in the FE tree.
- `grep -c '^## '` on `api-contract.md` — 13 top-level sections, structure intact, no duplicate headers.

## Deviations

1. **`PublicRoomCatalogEntry.name` typed as non-nullable** (not `string | null` as the `Room.name` shared type is). Rationale: DMs carry `name=null`, but the catalog only returns `rooms.type='channel'` and channels always have a name (enforced by DB check constraint `rooms_channel_name_required`). Keeping the FE type narrow avoids a redundant null-check on every row render. If a future round relaxes the channel-name constraint this deviation becomes unsafe; flag to revisit then.

2. **Summary-table rows for the new endpoints went into the existing `## Rooms Endpoints` table**, even though the detail blocks live in separate `## Unread Endpoints` / `## Public Room Catalog` sections. Rationale: the table already serves as the quick-scan reference for anything under `/api/rooms/*` — keeping all `/api/rooms/*` rows together makes grep-for-my-path trivial. The cross-reference cost is one extra scroll-to-find when reading the doc linearly.

3. **`RoomReadPayload` lives in `unread.ts` alongside `UnreadCount` / `MarkRoomReadResponse`**, not in `socket.ts`. Rationale: `MarkRoomReadResponse` and `RoomReadPayload` are structurally identical (same two fields) and conceptually describe the same event envelope from two angles (HTTP response vs socket push). Co-locating them in `unread.ts` keeps the domain coherent; `socket.ts` imports `RoomReadPayload` the same way it imports `PresenceUpdatePayload` from `./presence`.

4. **Index-barrel ordering**: added `unread` + `catalog` re-exports between `presence` and `socket` (not at the tail). Rationale: the existing convention groups domain types first and cross-cutting socket types last; following it avoids a spurious pattern break. Zero runtime impact.

5. **No `ClientToServerEvents` addition.** Mark-read could have been a socket event instead of an HTTP POST (reducing round-trip count for rapid auto-marks). Decision: keep it HTTP-only per D4. Two code paths on the same cursor table invite race conditions; the HTTP path is strictly more debuggable and the 500ms FE debounce already caps request volume. Flagged to reconsider if traffic patterns change.

6. **Inserted `## Unread Endpoints` and `## Public Room Catalog` between `## User Ban Endpoints` and `## Socket Events`**, preserving the existing "all HTTP endpoints above, all socket docs below" split. No existing section was reordered; editors of the doc see the two new sections land exactly where they'd expect.

## Deferred

- **`?after=<messageId>` forward-pagination on `GET /api/rooms/:id/messages`** — Round 9 flagged this as "Round 12 will need it for jump-to-unread / load-newer-from-last-read flows". Deliberately NOT pulled forward; the badge UX does not require it and pulling it in would double BE surface for a nice-to-have. The Round 9 scaffolding (row-value cursor, `MessageHistoryResponse` wire shape) still generalises trivially when a future round picks this up.
- **Jump-to-first-unread UI** — blocked on `?after=` above. When revisited, the BE would need a `firstUnreadMessageId` derivation (`SELECT MIN(id) FROM messages WHERE room_id=$1 AND created_at > $lastReadAt AND user_id <> $callerId`) plus a route change in the FE room-open flow.
- **Mentions / priority unreads / `@user`-scoped badges** — not in requirements; no hooks left in the Round-12 types that would complicate a future extension.
- **Full-text search on the catalog** (`pg_trgm`, `tsvector`, GIN index on `rooms.name`) — the ILIKE `%q%` path is adequate at hackathon scale; flagged as config improvement territory.
- **`catalog:room:added` socket push** — the catalog is pull-based by D11. If it becomes a high-traffic landing page, a newly-created-room broadcast would keep the discovery list live; fine to defer.
- **Per-message read receipts** — not in requirements (§2.7.1 only mentions unread indicators at the room/DM level, cleared on open). No type hooks added.
- **Backfill migration for pre-existing members** — unnecessary; the `COALESCE(cursor.last_read_at, member.joined_at)` fallback handles pre-Round-12 users transparently. Flagged here only so the BE agent doesn't second-guess task 2's "no backfill" note.

## Next round needs to know

**For a future message edit / delete round (the deferred Round 10)**
- Unread count is live-computed against the `messages` table, so a hard-delete row simply stops being counted — no cursor mutation needed.
- If the delete path is soft (set `deletedAt`, keep row) and FE should render a tombstone, the unread count query must filter `WHERE deleted_at IS NULL`. Flag in that round's task file; the cursor schema does NOT need changes.
- The deferred Round-8 on-disk-unlink concern (remove files when a message is deleted) still applies — unchanged by Round 12.

**For a future room moderation / delete round (the deferred Round 11)**
- `room_read_cursors(user_id, room_id)` has `ON DELETE CASCADE` FKs to both `users` and `rooms`. Room delete cleans up every member's cursor row implicitly; no follow-up DML needed.
- Ban / kick flows do not touch the cursor table — leaving a room does NOT delete the cursor (per `## Unread Endpoints` §Rules), so if a banned user is re-invited they pick up unread accrual from the stored `last_read_at`. Intentional; matches the "rejoining restarts from last-read" wording.

**For a future jump-to-unread round**
- Extend `listMessageHistory` with `after?: string` (mirror of `before?`); flip the row-value comparator to `>`; keep `ORDER BY created_at ASC, id ASC`; `hasMore` semantics become "newer pages exist".
- Cursor resolution reuses the same tuple-load pattern (`SELECT created_at, id FROM messages WHERE id = $1 AND room_id = $2`).
- The `"Invalid cursor"` string is now shared across `GET /api/rooms/:id/messages` AND `GET /api/rooms/catalog`. Any future cursor-carrying endpoint should either reuse the string verbatim OR pick a distinct one — do not overload `"Invalid cursor"` with new semantics that a single FE branch couldn't disambiguate by route.

**Contract locks established in Round 12**
- `UnreadCount.lastReadAt` is `string | null` on the wire. `null` explicitly signals "no cursor row yet" (effective cursor = member.joined_at server-side). Don't change this to `string` with a sentinel value in a future round — the null carries meaning.
- `PublicCatalogResponse.nextCursor` is `string | null`. `null` specifically means `hasMore=false`; pass back unchanged. Don't introduce a `prevCursor` without deciding whether the catalog supports a "go back" affordance.
- `PublicRoomCatalogEntry.name` is non-nullable. Narrower than `Room.name` by design; see Deviation 1.
- `room:read` fans out to `user:<callerId>` only. Other users NEVER receive unread state; don't overload the event for cross-user notification.

## Config improvements

- **`UNREAD_INCLUDE_ZERO` env flag** — gate whether `GET /api/unread` emits rows with `unreadCount=0`. Default: omit (smaller payload, FE treats absence as 0). Would help smoke-test assertions that want to see the full room set.
- **`CATALOG_PAGE_DEFAULT=20` / `CATALOG_PAGE_MAX=50` env vars** — parallel to the Round-9 `MESSAGE_PAGE_*` config-improvement note. Cheap to add; lets prod ops tune without redeploying.
- **`pg_trgm` + GIN index on `rooms.name` and `rooms.description`** — would make ILIKE substring search fast under load. Deferred: sequential scan over `WHERE type='channel' AND visibility='public'` is fine for the hackathon's room count.
- **`catalog:room:added` socket push** — transforms the catalog from pull-based to live-updating. Worth revisiting if the catalog becomes a high-traffic landing page.
- **Promote the shared `"Invalid cursor"` string to a named constant** (`shared/types/errors.ts` or similar) — currently it's a magic string duplicated across the history endpoint and the catalog endpoint. Low-effort DX win, no runtime change.
- **`Server-Timing: unread-query;dur=<ms>` on `GET /api/unread`** — the correlated subquery is the likely hot spot on rooms with 10k+ messages per §3.2; surfacing the timing inline helps capacity planning without a full tracing stack.
- **Consider a composite index on `messages(room_id, user_id, created_at)`** — the unread-count subquery has predicates on all three. Not needed at hackathon scale; flagged for when write volume grows.
