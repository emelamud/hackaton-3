# Round 12 — Orchestrator Tasks

## Goal
Lock the contract for two independent features: (a) per-user unread tracking so sidebar room/DM rows show an unread badge that clears when the user opens the chat, and (b) a public room catalog with name/description search and pagination so users can discover rooms they aren't yet members of. Both land on the same round because each is small on its own and they share zero surface with each other.

## Scope
Round 12 from `plans/master-plan.md`:
> Unread badges appear on the sidebar; users can browse and search a public room catalog.

Covers requirements:
- §2.7.1 Unread indicators (near room & contact entries; cleared on chat open) and §4.4 (sidebar unread indicator).
- §2.4.3 Public room catalog (name, description, member count, simple search).
- §2.4.4 Private rooms are NOT listed in the catalog.

Out of scope (deliberate):
- "Jump to first unread" and `?after=<messageId>` forward-pagination on the history endpoint (flagged as deferred by Round 9 — we do NOT need it for sidebar badges; the FE keeps pagination as-is and opens a room at the bottom). If a future round wants jump-to-unread, Round 9's `?before=` cursor shape generalises trivially.
- Per-message read receipts (not in requirements).
- Mentions / highlighted unreads / priority unreads.
- Server-side push of unread counts — the FE derives increments locally from the existing `message:new` broadcast (see D2). The server only pushes `room:read` for multi-tab sync (D6).
- Catalog filters beyond prefix/substring search (no by-tag, by-owner, by-member-count).
- Full-text search (`pg_trgm` / `tsvector`) — simple `ILIKE '%q%'` is sufficient at hackathon scale.

## Design decisions (locked during planning)

**D1. Unread tracking = per-user per-room timestamp cursor.** New `room_read_cursors` table keyed `(user_id, room_id)` with `last_read_at timestamptz`. Unread count = `COUNT(messages WHERE room_id = X AND created_at > last_read_at AND user_id <> caller)` — the caller's own messages never count as unread (they wrote them).

- When the cursor row is absent for a given `(user_id, room_id)` pair, fall back to `room_members.joined_at` as the effective `last_read_at`. Pre-Round-12 members don't need a backfill migration: the `COALESCE(cursor.last_read_at, member.joined_at)` handles it in one query.
- We deliberately do NOT store `last_read_message_id`. A message-id reference can rot when messages are deleted in future rounds; the timestamp alone is enough for the count.
- `markRoomRead` is an UPSERT that sets `last_read_at = GREATEST(existing, now())`. Rapidly repeated calls (e.g. every `message:new` arrival in the active room) are idempotent and monotonic.

**D2. Unread counts are NOT pushed on every `message:new`.** The FE already subscribes to `message:new` on every room it belongs to and increments its local `unreadByRoomId[roomId]` when the incoming `roomId` is NOT the currently-viewed room. This is what every chat client does — no server push overhead per message.

The only thing the server pushes is `room:read` (D6) so the OTHER tabs of the same user clear the badge when one tab marks a room read.

**D3. Initial unread snapshot.** `GET /api/unread` returns an array `{ roomId, unreadCount, lastReadAt }[]` for every room the caller is a member of (channels AND DMs — requirement §2.7.1 says "chat room OR personal dialog"). The FE calls this once per session start (after auth init) and hydrates the `unreadByRoomId` signal. Subsequent updates come from `message:new` (increment) and `room:read` (clear).

**D4. `POST /api/rooms/:id/read` marks the room read up to `now()`.** The endpoint is the canonical mark-read trigger. Response is `MarkRoomReadResponse { roomId, lastReadAt }`. FE calls it (a) when user navigates to `/chat/:roomId`, (b) when a `message:new` arrives for the currently-viewed room. The FE debounces to at-most-once per 500 ms per `roomId` to avoid hammering the endpoint during rapid message bursts; see `frontend_tasks.md` §UnreadService.

Membership gate: caller must be a current member — else `403 "Not a room member"` / `404 "Room not found"` mirroring `GET /api/rooms/:id/messages`. Non-members cannot have a read cursor; the row is not created.

**D5. Unread count clamp.** No upper-bound clamp on the wire (server emits the exact count). UI clamps display to `99+` purely in the template — do not mutate the wire value (future integrations may want the exact count).

**D6. `room:read` socket event** — server emits `{ roomId, lastReadAt }` to `user:<callerId>` after `markRoomRead` succeeds. Fans out to ALL the caller's active sockets (including the initiating one — harmless self-echo, keeps handler symmetric). Other tabs clear their badge to 0; the initiating tab's `unreadByRoomId` is already 0 from the optimistic update.

**D7. Public catalog = public channels only.** `GET /api/rooms/catalog?q=&cursor=&limit=` returns rooms with `type='channel' AND visibility='public'` — private rooms never appear (§2.4.4), DMs never appear. Caller receives entries even for rooms they are already a member of; the response row carries `isMember: boolean` so the FE can render "Open" vs "Join" without a second lookup.

**D8. Catalog cursor semantics match the history endpoint.** Cursor is an opaque room UUID; server resolves it to `(createdAt, id)` and filters `(rooms.createdAt, rooms.id) < (cursor.createdAt, cursor.id)` (newest first). `hasMore` is derived from a `limit+1` fetch. Response carries `nextCursor: string | null` (the id of the last row in the page, to pass back as `?cursor=` on the next request) — NOT derived FE-side; the catalog response emits it explicitly because the rooms list is on a non-chronological landing page where "the next before" is less obvious than on the history pane. Asymmetry with `MessageHistoryResponse` is intentional.

- Invalid `cursor` UUID (not a public room, or belongs to a channel that isn't `visibility=public` anymore, or a non-existent id) → `400 "Invalid cursor"` — same verbatim string Round 9 reserved on the history endpoint. Reusing the string is safe because the FE differentiates by route, not by error text.

**D9. Catalog search parameters.** `q` is optional, trimmed, `0–64` chars. When present and non-empty, filter `name ILIKE '%q%' OR description ILIKE '%q%'`. When empty or absent, return all public channels (newest first). `limit` default 20, min 1, max 50 — lower than history's 100 because each catalog row is heavier (description text). Same `"Validation failed"` envelope on out-of-range.

**D10. Catalog ordering.** `createdAt DESC, id DESC`. Stable ties on `id`. Locking this early so FE pagination logic doesn't churn — the visible "newest rooms first" matches user expectations for a discovery page.

**D11. Catalog does NOT emit a socket event on room create.** The catalog is a pull-based page; joining the catalog room doesn't imply a live subscription. When the user creates a public room via `POST /api/rooms`, other users browsing the catalog would have to refresh manually to see it. This is acceptable at hackathon scale — documented here so the BE agent doesn't invent a `catalog:room:added` event.

**D12. Joining from the catalog reuses the existing `POST /api/rooms/:id/join`.** No new endpoint. The catalog entry's `id` is the room id; the FE posts to `/api/rooms/:id/join` and the existing socket plumbing (`room:updated` rebroadcast, `socketsJoin`) handles the subscription. The 403 "Private room — invitation required" can't fire from the catalog path (catalog entries are public only) but the handler stays defensive.

**D13. `Unread` types live in a new `shared/types/unread.ts` file.** Adding them to `message.ts` or `room.ts` would couple unrelated concerns — `unread` is its own domain. The barrel `index.ts` re-exports the new file.

**D14. `PublicRoomCatalog*` types live in a new `shared/types/catalog.ts` file.** Same rationale: catalog is a read-only discovery surface, separate from the write-oriented `CreateRoomRequest` / `PatchRoomRequest` flows.

## Dependencies
- `plans/master-plan.md` §Round 12 bullet.
- `requirements.txt` §2.7.1 (unread indicators), §4.4 (sidebar badges), §2.4.3 (public catalog + search), §2.4.4 (private rooms invisible to catalog).
- `shared/api-contract.md` — current state; Round 12 appends a new `## Unread Endpoints` section, a new `## Public Room Catalog` section, a new `room:read` row under Socket Events, and adds a summary-table row to the existing `## Rooms Endpoints` table for the `POST /api/rooms/:id/read` shortcut.
- `shared/types/` — new `unread.ts` + `catalog.ts`; `socket.ts` gets a `room:read` key on `ServerToClientEvents`.
- `plans/round-9/orchestrator_work_summary.md` §Next round needs to know — the `"Invalid cursor"` string is shared (D8), `MessageHistoryResponse` shape locked (not touched this round).
- `plans/round-9/frontend_work_summary.md` §Next round needs to know — "Persisted last-read scroll position … Round 12's unread work is the natural place to land it" — deliberately NOT picking this up; see D3 scope note. We only track the count, not the scroll anchor.

## Tasks

### 1. Create `/shared/types/unread.ts`

```ts
export interface UnreadCount {
  roomId: string;
  /** COUNT(messages.created_at > cursor.last_read_at AND user_id <> caller). */
  unreadCount: number;
  /** null when no cursor row exists yet (effective cursor falls back to member.joined_at server-side). */
  lastReadAt: string | null;
}

export interface MarkRoomReadResponse {
  roomId: string;
  /** The timestamp the server actually stored — equal to server now() after the UPSERT. */
  lastReadAt: string;
}

/** Payload for `room:read` socket event. */
export interface RoomReadPayload {
  roomId: string;
  lastReadAt: string;
}
```

### 2. Create `/shared/types/catalog.ts`

```ts
export interface PublicRoomCatalogEntry {
  id: string;
  name: string;                 // channels always have a name (non-null at the DB level)
  description: string | null;
  memberCount: number;
  createdAt: string;
  /** True when the caller is already a `room_members` row for this id. FE renders "Open" vs "Join". */
  isMember: boolean;
}

export interface PublicCatalogResponse {
  rooms: PublicRoomCatalogEntry[];
  hasMore: boolean;
  /** Id of the last row in the page — pass back as `?cursor=` for the next request. null when hasMore=false. */
  nextCursor: string | null;
}
```

Do NOT add a `CreatePublicRoomRequest` or similar — room creation already goes through the existing `POST /api/rooms` flow (D12).

### 3. Update `/shared/types/index.ts`

Add the two new re-exports alongside the existing ones:

```ts
export * from './unread';
export * from './catalog';
```

Keep the existing exports unchanged and their order stable (FE/BE both import from `@shared`).

### 4. Extend `/shared/types/socket.ts` — add `room:read`

Add a new entry to `ServerToClientEvents`:

```ts
import type { RoomReadPayload } from './unread';

export interface ServerToClientEvents {
  // ... existing entries unchanged ...
  'room:read': RoomReadPayload;
}
```

`ClientToServerEvents` is NOT extended. Mark-read is strictly an HTTP action per D4 — keeping it off the socket channel avoids having two code paths that mutate the same cursor.

### 5. Append an `## Unread Endpoints` section to `/shared/api-contract.md`

Insert the new section BEFORE the existing `## Socket Events` section (so all the HTTP endpoint blocks stay contiguous).

Content:

~~~markdown
## Unread Endpoints

All unread endpoints require `Authorization: Bearer <accessToken>` and return `401 { "error": "..." }` on missing / invalid / expired access tokens.

### Rules
- Unread count is per user per room, computed at read time from `messages.created_at > COALESCE(cursor.last_read_at, member.joined_at)` and `messages.user_id <> caller`. The caller's own messages are never counted.
- `POST /api/rooms/:id/read` is the single mutation path — it UPSERTs the cursor to `GREATEST(existing.last_read_at, now())`. Rapid repeated calls are safe and monotonic.
- Cursor rows are stored for channels AND DMs; the same `room_read_cursors(user_id, room_id)` table serves both.
- Leaving a room does NOT delete the cursor; rejoining restarts unread accrual from the stored `last_read_at`. Room delete (future round) cascades the cursor via FK.

### Summary

| Method | Path | Body | Success | Errors |
|--------|------|------|---------|--------|
| GET | `/api/unread` | — | `200 UnreadCount[]` (one entry per member room with `unreadCount > 0` OR a cursor row; entries with 0 may be omitted — FE treats absence as 0) | — |
| POST | `/api/rooms/:id/read` | — | `200 MarkRoomReadResponse` + `room:read` emitted to `user:<callerId>` | `403` not a room member, `404` room not found |

### GET `/api/unread`
List the caller's per-room unread counts. The server MAY omit rooms whose computed count is 0 to keep the payload small; the FE treats absence as 0. (Returning all rooms is also acceptable — this is a perf detail, not a wire contract change.)

**Success** `200` — `UnreadCount[]`:
```json
[
  { "roomId": "uuid", "unreadCount": 7, "lastReadAt": "2026-04-22T10:00:00.000Z" },
  { "roomId": "uuid", "unreadCount": 2, "lastReadAt": null }
]
```

`lastReadAt` is `null` when no cursor row exists yet; the effective cursor is the caller's `room_members.joined_at` for that room.

### POST `/api/rooms/:id/read`
Mark the room read up to server `now()`. UPSERT into `room_read_cursors`; `last_read_at = GREATEST(existing, now())` so out-of-order calls (e.g. from a lagging tab) never rewind the cursor.

**Success** `200` — `MarkRoomReadResponse`:
```json
{ "roomId": "uuid", "lastReadAt": "2026-04-22T12:34:56.789Z" }
```

Also emits `room:read` with the same `{ roomId, lastReadAt }` to `user:<callerId>` — all the caller's live sockets (other tabs / devices) receive it and clear their local badge.

**Errors**:
- `403` — caller is not a current member: `{ "error": "Not a room member" }`.
- `404` — room not found: `{ "error": "Room not found" }`.

Idempotent: calling after a successful mark-read returns the same `lastReadAt` (since `GREATEST(existing, now()) = now()` only if `now()` has advanced; otherwise returns the stored value).
~~~

### 6. Append a `## Public Room Catalog` section to `/shared/api-contract.md`

Insert immediately after the new `## Unread Endpoints` section.

Content:

~~~markdown
## Public Room Catalog

Requires `Authorization: Bearer <accessToken>` and returns `401 { "error": "..." }` on missing / invalid / expired access tokens.

### Rules
- Returns public channels only: `rooms.type='channel' AND rooms.visibility='public'`. Private rooms and DMs are never included (requirement §2.4.4).
- Paginated newest-first by `(createdAt DESC, id DESC)`. Stable tie-break on `id`.
- `q` filters with `name ILIKE '%q%' OR description ILIKE '%q%'` (case-insensitive substring).
- Response carries `isMember` per row so the FE can render "Open" vs "Join" without a second lookup.
- Joining from the catalog reuses the existing `POST /api/rooms/:id/join` — no dedicated catalog-join endpoint.
- The catalog is pull-based — no socket event fires when a public room is created; callers refresh manually.

### Summary

| Method | Path | Query | Success | Errors |
|--------|------|-------|---------|--------|
| GET | `/api/rooms/catalog` | `?q=<0..64>&cursor=<roomId>&limit=<1..50>` | `200 PublicCatalogResponse` | `400` invalid cursor / validation |

### GET `/api/rooms/catalog`
**Query params**:
- `q` — optional, trimmed, 0–64 characters. Empty/absent → no search filter.
- `cursor` — optional UUID. Id of the last row returned by a previous page; server resolves it to `(createdAt, id)` and filters `(rooms.createdAt, rooms.id) < (cursor.createdAt, cursor.id)`.
- `limit` — optional integer, default 20, min 1, max 50.

**Success** `200` — `PublicCatalogResponse`:
```json
{
  "rooms": [
    {
      "id": "uuid",
      "name": "engineering",
      "description": "Backend + frontend discussions",
      "memberCount": 12,
      "createdAt": "ISO",
      "isMember": false
    }
  ],
  "hasMore": true,
  "nextCursor": "uuid"
}
```

Ordering is `createdAt DESC, id DESC` — newest public channels first.

`nextCursor` is the id of the LAST (oldest) row in the returned page when `hasMore=true`, else `null`. Pass it unchanged as `?cursor=` on the next request. Asymmetric with `MessageHistoryResponse` (which does not echo a cursor) — the catalog emits it explicitly because the next-cursor derivation from the row shape is less obvious than on the history pane.

**Errors**:
- `400` — validation error on `q` (too long) / `limit` (out-of-range) / `cursor` (malformed UUID): `{ "error": "Validation failed", "details": [...] }`.
- `400` — `cursor` UUID does not match a public-channel room (unknown id, private, or DM): `{ "error": "Invalid cursor" }`. (Round 9 reserved this verbatim string on the history endpoint; reusing it here is safe — the FE differentiates by route.)
~~~

### 7. Add the `POST /api/rooms/:id/read` row to the existing Rooms Endpoints summary table

In `/shared/api-contract.md`, under `## Rooms Endpoints` → `### Summary` table, insert after the last existing row:

```
| POST | `/api/rooms/:id/read` | — | `200 MarkRoomReadResponse` + `room:read` emitted to caller | `403` not a member, `404` not found |
```

Keep the other table rows unchanged. Also add the catalog row to the same table (conceptually it's a rooms endpoint even though the detail block lives under `## Public Room Catalog`):

```
| GET | `/api/rooms/catalog` | `?q=&cursor=&limit=` | `200 PublicCatalogResponse` | `400` invalid cursor / validation |
```

### 8. Append `room:read` to the `## Socket Events` section in `/shared/api-contract.md`

Find the existing `### Server → Client events` subsection. Add a new block AFTER the existing `#### presence:snapshot` entry (so all server-to-client events stay grouped):

~~~markdown
#### `room:read`
- Payload: `RoomReadPayload`.
  ```json
  { "roomId": "uuid", "lastReadAt": "ISO" }
  ```
- Fired to `user:<callerId>` after `POST /api/rooms/:id/read` succeeds. All the caller's live sockets receive it; the initiating tab's optimistic update makes the echo a no-op, other tabs clear the badge.
- **Not** fired to other users. Unread state is strictly per-user.
~~~

### 9. No agent description changes
Neither `.claude/agents/backend-developer.md` nor `.claude/agents/frontend-developer.md` needs changes. Unread + catalog are not new stack concerns (no new libs, no new patterns).

### 10. No docker-compose / env changes
All Round 12 changes are contract-level + code-level. No new env vars in scope (page-size limits stay hard-coded per Round 9's decision to defer `MESSAGE_PAGE_DEFAULT` / `MESSAGE_PAGE_MAX`; follow the same convention for the catalog's default 20 / max 50).

### 11. No master-plan update
The Round 12 bullet in `plans/master-plan.md` still reads accurately after this round. Do not edit. (The "Round 10" and "Round 11" bullets remain in the plan untouched — they're skipped for scheduling reasons, not removed.)

## Wrap-up
Write `plans/round-12/orchestrator_work_summary.md` with:
- **Built** — files touched under `/shared/`: new `unread.ts`, new `catalog.ts`, `index.ts` barrel updated, `socket.ts` extended with `room:read`, `api-contract.md` with the two new endpoint sections + the summary-table rows + the `room:read` socket block.
- **Deviations** — likely pressure points:
  - (a) Whether to store `last_read_message_id` alongside `last_read_at` (D1: we do NOT — message ids can rot on future delete rounds; timestamp is sufficient).
  - (b) Whether the server should PUSH unread counts on `message:new` (D2: no — FE derives increments locally; server only pushes `room:read` for multi-tab sync).
  - (c) Whether `GET /api/unread` should return every member room or only rooms with `count > 0` (loose: either — FE treats absence as 0; BE should pick whichever is simpler to implement).
  - (d) Whether `nextCursor` appears in the response (D8: yes on the catalog response, NO on the history response — intentional asymmetry; message history's cursor-from-row-shape is obvious, catalog's is not).
  - (e) Whether reusing the `"Invalid cursor"` string across history + catalog is safe (D8: yes — differentiation is by route, not by error text).
- **Deferred** — jump-to-first-unread (needs `?after=` on history, flagged by Round 9 §Deferred; not pulled forward because badges don't require it); mentions / priority unreads; catalog filters beyond substring search; full-text search (`pg_trgm`, `tsvector`); real-time catalog updates; per-message read receipts.
- **Next round needs to know** — if a future round introduces message delete (the deferred Round 10), the unread count query must tolerate `messages.created_at` values that belong to since-deleted rows; since the count is computed live against the `messages` table, a deleted message simply stops being counted — no cursor mutation needed. If a future round adds room delete (deferred Round 11), the `room_read_cursors` rows cascade via FK — document in that round's migration.
- **Config improvements** — `UNREAD_INCLUDE_ZERO` env flag to toggle whether `GET /api/unread` emits rows with count=0 (default: omit for payload size); `CATALOG_PAGE_DEFAULT` / `CATALOG_PAGE_MAX` env vars paralleling the Round-9 config-improvement note; consider a `catalog:room:added` push event if the catalog becomes a high-traffic landing page.
