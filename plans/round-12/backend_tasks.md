# Round 12 — Backend Tasks

## Goal
Ship two independent BE surfaces:
1. **Unread tracking** — a new `room_read_cursors` table, `GET /api/unread`, `POST /api/rooms/:id/read`, and a `room:read` socket broadcast for multi-tab sync.
2. **Public room catalog** — `GET /api/rooms/catalog?q=&cursor=&limit=` returning `PublicCatalogResponse` with `isMember` per row, newest-first, cursor pagination.

Both are read-light; no existing endpoint changes shape.

## Dependencies
- `/shared/api-contract.md` — the Round-12 orchestrator appends `## Unread Endpoints`, `## Public Room Catalog`, a `room:read` entry under `## Socket Events`, and two summary-table rows. Conform to those blocks verbatim.
- `/shared/types/unread.ts` — new `UnreadCount`, `MarkRoomReadResponse`, `RoomReadPayload`.
- `/shared/types/catalog.ts` — new `PublicRoomCatalogEntry`, `PublicCatalogResponse`.
- `/shared/types/socket.ts` — `ServerToClientEvents` now includes `'room:read': RoomReadPayload`.
- **Do not modify `/shared/`.** If a contract / type change is needed, report to the orchestrator.
- `backend/CLAUDE.md` — route vs service separation, Drizzle conventions, error handling (`AppError`).
- `backend/src/db/schema.ts` — existing `rooms`, `roomMembers`, `messages` tables; add a new `roomReadCursors` table.
- `backend/src/services/rooms.service.ts` — existing `isRoomMember(userId, roomId)` helper; reuse as the membership gate.
- `backend/src/routes/rooms.ts` — existing router mounted at `/api/rooms`; new `/catalog` and `/:id/read` endpoints land here. `validateQuery` already exists (Round 9) — reuse it.
- `backend/src/socket/io.ts` — existing `emitToUser(userId, event, payload)` helper; use it for the `room:read` broadcast.

## Tasks

### 1. Schema — add `roomReadCursors` table in `backend/src/db/schema.ts`

Append a new `pgTable` declaration alongside the existing ones (after `attachments` or `userBans` — order doesn't matter for runtime, pick whichever keeps the file readable):

```ts
export const roomReadCursors = pgTable(
  'room_read_cursors',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    lastReadAt: timestamp('last_read_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.roomId] }),
  }),
);

export type RoomReadCursorRow = typeof roomReadCursors.$inferSelect;
export type NewRoomReadCursorRow = typeof roomReadCursors.$inferInsert;
```

Notes:
- `(user_id, room_id)` composite PK. Doubles as the UPSERT conflict target and covers the `GET /api/unread` lookup by `user_id`.
- `last_read_at` uses `withTimezone: true` to match the newer columns (`attachments.createdAt`, etc.). Older tables use naked `timestamp` — that's an inconsistency we're not fixing this round.
- No `last_read_message_id` per orchestrator D1.
- No FK on `messages` — the cursor is a timestamp, not a message reference.

### 2. Migration — `pnpm db:generate`

Run `pnpm db:generate` in `backend/` to emit `0008_<random>.sql` under `backend/src/db/migrations/`. Inspect the output for:
- `CREATE TABLE "room_read_cursors"` with the three columns and composite PK.
- FK cascades to `users` and `rooms`.
- No extra implicit indexes (the PK covers the hot path).

Commit the generated SQL + `meta/_journal.json` as-is. Do not hand-edit.

The migration runs automatically on container startup (`Running database migrations...` line in the backend log) — no separate `pnpm db:migrate` invocation needed for the smoke harness.

### 3. Service — create `backend/src/services/unread.service.ts`

New file. Two exports:

```ts
export async function listUnread(userId: string): Promise<UnreadCount[]> { ... }
export async function markRoomRead(userId: string, roomId: string): Promise<MarkRoomReadResponse> { ... }
```

#### 3a. `listUnread(userId)`

One query, left-join the cursor onto the caller's memberships and count messages in a correlated subquery:

```sql
SELECT
  rm.room_id AS "roomId",
  COALESCE(rrc.last_read_at, rm.joined_at) AS "effectiveCursor",
  rrc.last_read_at AS "lastReadAt",
  (
    SELECT COUNT(*)::int FROM messages m
    WHERE m.room_id = rm.room_id
      AND m.created_at > COALESCE(rrc.last_read_at, rm.joined_at)
      AND m.user_id <> $1
  ) AS "unreadCount"
FROM room_members rm
LEFT JOIN room_read_cursors rrc
  ON rrc.user_id = rm.user_id AND rrc.room_id = rm.room_id
WHERE rm.user_id = $1
```

Use Drizzle's `sql` template for the correlated subquery — the simplest path is:

```ts
const unreadCountExpr = sql<number>`(
  SELECT COUNT(*)::int FROM ${messages} m
  WHERE m.room_id = ${roomMembers.roomId}
    AND m.created_at > COALESCE(${roomReadCursors.lastReadAt}, ${roomMembers.joinedAt})
    AND m.user_id <> ${userId}
)`;

const rows = await db
  .select({
    roomId: roomMembers.roomId,
    lastReadAt: roomReadCursors.lastReadAt,
    unreadCount: unreadCountExpr,
  })
  .from(roomMembers)
  .leftJoin(
    roomReadCursors,
    and(
      eq(roomReadCursors.userId, roomMembers.userId),
      eq(roomReadCursors.roomId, roomMembers.roomId),
    ),
  )
  .where(eq(roomMembers.userId, userId));
```

Post-process:
- Filter out `unreadCount === 0` rows (saves wire bytes per orchestrator D3; FE treats absence as 0).
- Map to `UnreadCount[]`: `{ roomId, unreadCount: Number(r.unreadCount), lastReadAt: r.lastReadAt?.toISOString() ?? null }`.

#### 3b. `markRoomRead(userId, roomId)`

Two-stage:

1. Membership gate — reuse `assertRoomAndMembership` from `messages.service.ts`? No: that helper throws `'Not a room member'` / `'Room not found'` with the same strings the contract requires. Since it's scoped to the messages service, either:
   - (a) extract it to `rooms.service.ts` as an exported `assertRoomMembership(userId, roomId)` helper and reuse from both services, OR
   - (b) duplicate the 10-line helper inline.
   
   Prefer (a) — the helper is going to be reused by every future per-room mutation endpoint. Move it, re-export via `rooms.service.ts`, update `messages.service.ts` to import it. Keep the return shape (`{ type: 'channel' | 'dm' }`) so the messages service's DM-ban branch keeps working.

2. UPSERT:
   ```ts
   const [row] = await db
     .insert(roomReadCursors)
     .values({ userId, roomId, lastReadAt: new Date() })
     .onConflictDoUpdate({
       target: [roomReadCursors.userId, roomReadCursors.roomId],
       set: {
         lastReadAt: sql`GREATEST(${roomReadCursors.lastReadAt}, EXCLUDED.last_read_at)`,
       },
     })
     .returning({ lastReadAt: roomReadCursors.lastReadAt });
   ```
   The `GREATEST` clause guarantees monotonic advancement even under out-of-order calls from laggy tabs (orchestrator D1).

Return `{ roomId, lastReadAt: row.lastReadAt.toISOString() }`.

### 4. Service — create `backend/src/services/catalog.service.ts`

New file. One export:

```ts
export async function listPublicCatalog(
  userId: string,
  params: { q?: string; cursor?: string; limit: number },
): Promise<PublicCatalogResponse> { ... }
```

Implementation outline:

1. Resolve cursor (when present):
   ```ts
   let cursor: { createdAt: Date; id: string } | undefined;
   if (params.cursor) {
     const [row] = await db
       .select({ createdAt: rooms.createdAt, id: rooms.id })
       .from(rooms)
       .where(
         and(
           eq(rooms.id, params.cursor),
           eq(rooms.type, 'channel'),
           eq(rooms.visibility, 'public'),
         ),
       )
       .limit(1);
     if (!row) throw new AppError('Invalid cursor', 400);
     cursor = row;
   }
   ```
   `"Invalid cursor"` matches the Round-9 reserved string (orchestrator D8).

2. Build the page query:
   ```ts
   const memberCountExpr = sql<number>`(
     SELECT COUNT(*)::int FROM ${roomMembers} rm WHERE rm.room_id = ${rooms.id}
   )`;
   const isMemberExpr = sql<boolean>`EXISTS (
     SELECT 1 FROM ${roomMembers} rm
     WHERE rm.room_id = ${rooms.id} AND rm.user_id = ${userId}
   )`;

   const qTrimmed = params.q?.trim();
   const searchPredicate =
     qTrimmed && qTrimmed.length > 0
       ? sql`(${rooms.name} ILIKE ${'%' + qTrimmed + '%'} OR ${rooms.description} ILIKE ${'%' + qTrimmed + '%'})`
       : undefined;

   const rowsPlusProbe = await db
     .select({
       id: rooms.id,
       name: rooms.name,
       description: rooms.description,
       createdAt: rooms.createdAt,
       memberCount: memberCountExpr,
       isMember: isMemberExpr,
     })
     .from(rooms)
     .where(
       and(
         eq(rooms.type, 'channel'),
         eq(rooms.visibility, 'public'),
         searchPredicate,
         cursor
           ? sql`(${rooms.createdAt}, ${rooms.id}) < (${cursor.createdAt}, ${cursor.id})`
           : undefined,
       ),
     )
     .orderBy(desc(rooms.createdAt), desc(rooms.id))
     .limit(params.limit + 1);
   ```
   Same `limit + 1` probe pattern as Round 9's history endpoint — detect `hasMore` without a second count query.

3. Trim + shape:
   ```ts
   const hasMore = rowsPlusProbe.length > params.limit;
   const page = hasMore ? rowsPlusProbe.slice(0, params.limit) : rowsPlusProbe;
   const nextCursor = hasMore ? page[page.length - 1].id : null;

   return {
     rooms: page.map((r) => ({
       id: r.id,
       name: r.name!,             // channel name is non-null at the DB level (schema check constraint)
       description: r.description,
       memberCount: Number(r.memberCount),
       createdAt: r.createdAt.toISOString(),
       isMember: Boolean(r.isMember),
     })),
     hasMore,
     nextCursor,
   };
   ```

Notes:
- The ILIKE `%q%` predicate is deliberate (substring, not prefix). Requirement §2.4.3 says "simple search"; substring is the least-surprising default.
- When `q` is the empty string (after trim), do NOT add the predicate — return all public channels. The zod schema should coerce missing/empty to `undefined` (see task 5b).
- No index on `rooms(lower(name))` is needed for the catalog — the existing `rooms_name_lower_idx` is a UNIQUE index that helps exact-match lookups but not ILIKE; at hackathon scale a sequential scan over public rooms is fine. Flagged as a config improvement.

### 5. Routes — extend `backend/src/routes/rooms.ts`

`requireAuth` already wraps the router. Keep the existing handlers unchanged; add the new ones.

#### 5a. `POST /api/rooms/:id/read`

```ts
import * as unreadService from '../services/unread.service';
import { emitToUser } from '../socket/io';

// Inside roomsRouter …
roomsRouter.post(
  '/:id/read',
  validateParams(idSchema),
  async (req, res, next) => {
    try {
      const result = await unreadService.markRoomRead(req.user!.id, req.params.id);
      emitToUser(req.user!.id, 'room:read', result);
      res.status(200).json(result);
    } catch (err) { next(err); }
  },
);
```

Order in the file: place after the existing `POST /:id/leave` handler and before `PATCH /:id` so all `/:id/...` endpoints stay grouped.

#### 5b. `GET /api/rooms/catalog`

This handler MUST be registered BEFORE `GET /:id` — otherwise Express matches `/catalog` as `:id` and the handler never fires.

```ts
import * as catalogService from '../services/catalog.service';

const catalogQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .max(64)
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

roomsRouter.get(
  '/catalog',
  validateQuery(catalogQuerySchema),
  async (req, res, next) => {
    try {
      const params = req.query as unknown as z.infer<typeof catalogQuerySchema>;
      const result = await catalogService.listPublicCatalog(req.user!.id, params);
      res.status(200).json(result);
    } catch (err) { next(err); }
  },
);
```

**Route order is load-bearing** — put the `/catalog` block BEFORE any `/:id` handler (or use a UUID regex on the `:id` constraint, but moving the route is simpler).

### 6. New route file — `backend/src/routes/unread.ts`

Create a new router for `GET /api/unread` (not a `/api/rooms/...` endpoint — it spans all rooms, so a dedicated router is cleaner).

```ts
import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import * as unreadService from '../services/unread.service';

export const unreadRouter = Router();
unreadRouter.use(requireAuth);

unreadRouter.get('/', async (req, res, next) => {
  try {
    const result = await unreadService.listUnread(req.user!.id);
    res.status(200).json(result);
  } catch (err) { next(err); }
});
```

Mount it in `backend/src/index.ts` alongside the existing routers:

```ts
app.use('/api/unread', unreadRouter);
```

### 7. Socket emitter — verify / use `emitToUser`

Check `backend/src/socket/io.ts` — the existing `emitToUser(userId, event, payload)` should already emit typed events via `ServerToClientEvents`. With the Round-12 orchestrator change to `shared/types/socket.ts` (adding `'room:read': RoomReadPayload`), the TypeScript compiler should accept `emitToUser(userId, 'room:read', payload)` automatically.

If `emitToUser` is NOT currently generic over the event map, DO NOT widen it in Round 12 — ad-hoc cast to `any` inline with a `// TODO: widen emitToUser to be generic over ServerToClientEvents` note and flag it under Config improvements. Scope creep otherwise.

### 8. Service helper move — lift `assertRoomAndMembership` from `messages.service.ts` to `rooms.service.ts`

Export it from `rooms.service.ts` as `assertRoomMembership(userId, roomId): Promise<{ type: 'channel' | 'dm' }>`. Keep the error strings exactly: `'Room not found'` (404), `'Not a room member'` (403). Update `messages.service.ts`'s `listMessageHistory` and `persistMessage` to call the moved helper. Update `unread.service.ts` to use it.

If you prefer to keep the helper inline in `messages.service.ts` and duplicate in `unread.service.ts`, that's also acceptable — but flag it as a deviation in the summary. The shared-export path is cleaner.

### 9. Smoke harness — `tmp/round-12/smoke.js`

Drive the full Round-12 contract end-to-end. Same pattern as Round 7/8/9 (`node-fetch` + `socket.io-client`). Produce a structured JSON log keyed per scenario.

**Setup** (one-shot at start):
- Register three users: `alice`, `bob`, `carol`.
- alice creates 3 public channels: `#general`, `#eng`, `#random`. Descriptions vary (e.g. `#eng` has "Backend and frontend discussions"; `#general` has null description).
- alice creates 1 private channel: `#ops`.
- bob + carol join `#general` and `#eng`. Only bob joins `#random`.
- bob + carol are not friends; skip DM scenarios (DM unread is structurally identical to channel unread — one-liner sanity test at the end is enough).
- alice sends 30 messages in `#eng` (pace at 210 ms — same rate-limit respect as Round 9). 10 messages in `#general`. 0 in `#random`.
- bob connects a socket and subscribes to `room:read` / `message:new` for multi-tab assertions.

**Scenarios** (record verbatim payloads):

1. **Initial unread snapshot for bob** — `GET /api/unread` as bob. Assert: `200`, body is an array, `#eng` row has `unreadCount=30` and `lastReadAt=null`, `#general` row has `unreadCount=10` and `lastReadAt=null`, `#random` row is absent (count=0 rows may be omitted) OR `unreadCount=0`. alice's own messages must NOT count for alice (so alice's `GET /api/unread` returns all rows with count 0 → empty array or rows with 0).

2. **Initial unread for alice** — `GET /api/unread` as alice. Assert: every entry has `unreadCount=0` (she sent the messages). Body may be empty array or rows with 0.

3. **Mark `#eng` read as bob** — `POST /api/rooms/<engId>/read`. Assert: `200`, `{ roomId: <engId>, lastReadAt: "<ISO>" }`. `lastReadAt` is within 2 s of now.

4. **Subsequent unread snapshot for bob** — `GET /api/unread` as bob. Assert: `#eng` unread count is 0 (or absent), `#general` still 10.

5. **`room:read` socket event fires for bob** — assert bob's subscribed socket received one `room:read` event during scenario 3 with payload `{ roomId: <engId>, lastReadAt: <same ISO as the HTTP 200 body> }`. (Open the socket BEFORE scenario 3.)

6. **New messages bump unread for bob** — alice sends 5 messages to `#eng` after bob's mark-read. Wait a bit for persistence. `GET /api/unread` as bob. Assert: `#eng` unread count is exactly 5.

7. **Mark-read is monotonic** — bob POSTs `/api/rooms/<engId>/read` (now). Capture `lastReadAt_1`. Pause 50 ms. POST again. Capture `lastReadAt_2`. Assert `lastReadAt_2 >= lastReadAt_1` (equal is fine — same millisecond). Neither call reverses the cursor.

8. **Mark-read on non-member** — carol POSTs `/api/rooms/<randomId>/read` where `#random` only has alice+bob. Assert: `403 { "error": "Not a room member" }` (carol is a member of `#general` and `#eng`, NOT `#random`).

9. **Mark-read on unknown room** — bob POSTs `/api/rooms/<random uuid>/read`. Assert: `404 { "error": "Room not found" }`.

10. **Catalog — no query, no cursor** — carol `GET /api/rooms/catalog`. Assert: `200`, `rooms` array contains `#general`, `#eng`, `#random` (all public channels) but NOT `#ops` (private). `isMember=true` for `#general` and `#eng` (carol joined), `false` for `#random`. Ordering newest-first by `createdAt`. `hasMore=false`, `nextCursor=null` (only 3 rows, limit default 20).

11. **Catalog — limit=2** — carol `GET /api/rooms/catalog?limit=2`. Assert: `rooms.length=2`, `hasMore=true`, `nextCursor=<id of the last row>`.

12. **Catalog — cursor pagination** — carol `GET /api/rooms/catalog?limit=2&cursor=<nextCursor from scenario 11>`. Assert: `rooms.length=1` (the oldest public channel), `hasMore=false`, `nextCursor=null`. No id overlap with scenario 11.

13. **Catalog — search by name** — carol `GET /api/rooms/catalog?q=eng`. Assert: only `#eng` in `rooms`. `isMember=true`. Other rooms filtered out.

14. **Catalog — search by description** — carol `GET /api/rooms/catalog?q=frontend`. Assert: only `#eng` (description contains "frontend"); other rooms absent.

15. **Catalog — invalid cursor (non-existent UUID)** — `GET /api/rooms/catalog?cursor=<random uuid>`. Assert: `400 { "error": "Invalid cursor" }`.

16. **Catalog — invalid cursor (private room id)** — `GET /api/rooms/catalog?cursor=<opsId>`. Assert: `400 { "error": "Invalid cursor" }` — private rooms must not be valid cursors (leaks existence otherwise).

17. **Catalog — limit out of range** — `?limit=0` and `?limit=100`. Assert both `400 "Validation failed"`.

18. **Catalog — q too long** — `?q=<65 chars>`. Assert `400 "Validation failed"`.

19. **Catalog — unauthenticated** — no Bearer. Assert `401`.

20. **Catalog — join flow** — carol POSTs `/api/rooms/<randomId>/join` (the one she's not a member of). Assert `200`. Re-fetch `/api/rooms/catalog`. Assert `#random` row now has `isMember=true`.

21. **DM unread sanity** — friend bob + carol, open a DM via `POST /api/dm` as carol → bob. Bob sends 2 messages. `GET /api/unread` as carol. Assert the DM room id is present with `unreadCount=2`. POST `/api/rooms/<dmId>/read` as carol. Re-fetch — `unreadCount=0`.

**Verification gate**:
- `pnpm build` in `backend/` — clean (0 errors).
- `pnpm lint` in `backend/` — clean.
- `docker compose up -d --build backend` — rebuild + restart cleanly; migration log shows `Applying migrations from ...` including the new `0008_*.sql`.
- All 21 scenarios produce the expected payloads.

### 10. Do not introduce new dependencies

No `pg_trgm` extension, no `tsvector`. Drizzle + zod + existing middleware cover everything. If you need row-value comparison at the Drizzle layer, it's the same pattern Round 9 locked in (`sql\`(${a}, ${b}) < (${c}, ${d})\``).

## Wrap-up
Write `plans/round-12/backend_work_summary.md` with:

- **Built** — the `roomReadCursors` table + migration, the two new services (`unread.service.ts`, `catalog.service.ts`), the three new endpoints (`GET /api/unread`, `POST /api/rooms/:id/read`, `GET /api/rooms/catalog`), the `room:read` socket emit, the smoke harness output, and confirmation that the route-order trap (`/catalog` before `/:id`) was handled.
- **Deviations** — likely pressure points:
  - (a) Whether `assertRoomAndMembership` got lifted to `rooms.service.ts` (cleaner, preferred per task 8) or duplicated (acceptable). Note which path landed.
  - (b) Whether `GET /api/unread` emits count=0 rows (orchestrator D3 loose — either acceptable). Note which.
  - (c) Whether the `GREATEST(existing, EXCLUDED)` UPSERT worked under the project's Drizzle version (`onConflictDoUpdate` + raw `sql` in the `set` clause). Alternative: a raw `INSERT ... ON CONFLICT` via `db.execute(sql\`...\`)`.
  - (d) Whether `emitToUser('room:read', ...)` compiled without widening (task 7). If you had to cast, document.
- **Deferred** — `catalog:room:added` socket push (orchestrator §Config improvements — pull-based catalog is accepted); `pg_trgm` / full-text search; unread-on-`message:new` server push (orchestrator D2 — FE derives locally); jump-to-first-unread endpoints (orchestrator §Out of scope); backfilling `room_read_cursors` rows on migrate (unnecessary — `COALESCE(last_read_at, joined_at)` covers pre-existing members).
- **Next round needs to know**
  - If Round 10 (message delete) ships later: the unread count is live-computed against the `messages` table, so deletes naturally stop counting; no cursor mutation needed.
  - If Round 11 (room delete) ships later: `room_read_cursors` has `ON DELETE CASCADE` FKs to both `users` and `rooms`, so the cleanup is implicit. Document in the Round-11 migration PR.
  - If a future round wants jump-to-unread, Round 9's `listMessageHistory` generalises with an `after?: string` sibling — flip the comparator. Unread cursor provides the `after` timestamp (convert to message id with one `SELECT MIN(id) FROM messages WHERE room_id=$1 AND created_at > $lastReadAt`).
  - The `"Invalid cursor"` string is now shared between `GET /api/rooms/:id/messages` and `GET /api/rooms/catalog` (per orchestrator D8). Any future cursor-carrying endpoint should either reuse the string OR pick a distinct verbatim string — do not overload.
- **Config improvements** — `CATALOG_PAGE_DEFAULT=20` / `CATALOG_PAGE_MAX=50` env vars paralleling the Round-9 `MESSAGE_PAGE_*` note; `UNREAD_INCLUDE_ZERO` env flag; `pg_trgm` GIN index on `rooms.name` for faster substring search if catalog traffic spikes; widen `emitToUser` to be generic over `ServerToClientEvents` (if you had to cast in task 7); `Server-Timing` header on `/api/unread` (the correlated subquery is the likely hot spot on large rooms).
