# Round 3 — Backend Tasks

## Goal
Persist messages; stand up a Socket.io server that auto-subscribes each socket to every room the user belongs to, handles `message:send` with an ack + broadcast, and keeps subscriptions in sync when users create/join/leave rooms through the existing HTTP routes. Also expose `GET /api/rooms/:id/messages` for initial history (hardcoded last 50).

## Dependencies
- `shared/api-contract.md` §Rooms Endpoints + §Socket Events — source of truth (read both the transport block and the per-event bodies; error strings must match verbatim)
- `shared/types/message.ts` — `Message`, `SendMessagePayload`, `MessageSendAck`
- `backend/CLAUDE.md` — route vs service separation, error handling, Drizzle patterns
- `plans/round-2/backend_work_summary.md` — §Next round needs to know lists the three handoffs this round fulfils (`http.createServer`, `verifyAccessToken`, `isRoomMember` reuse)

**Do not modify `/shared/`.** If the contract needs changes, stop and flag it to the orchestrator.

## Tasks

### 1. Install Socket.io
- `pnpm -C backend add socket.io@4`
- No new dev dependencies needed (Socket.io ships its own types).

### 2. Refactor `backend/src/middleware/auth.ts`
Extract the JWT verification step so HTTP and Socket.io share a single source of truth:

```ts
export function verifyAccessToken(token: string): AuthPayload {
  const decoded = jwt.verify(token, config.jwtSecret) as AuthPayload;
  // keep the same shape you populate into req.user
  return decoded;
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  // parse Authorization header → call verifyAccessToken → attach req.user
  // throw AppError(..., 401) on any failure
};
```

- Keep `AuthPayload` exported (already is).
- `requireAuth` now calls `verifyAccessToken`. Behaviour unchanged — run the existing auth tests / smoke steps to confirm no regression.

### 3. Drizzle schema — add `messages` to `backend/src/db/schema.ts`
Columns:
- `id` uuid pk default
- `room_id` uuid not null, FK → `rooms.id`, `onDelete: 'cascade'` (requirement §2.4.6: deleting a room deletes its messages)
- `user_id` uuid not null, FK → `users.id`, `onDelete: 'cascade'` (Round 3 policy; flagged in the orchestrator summary for the account-deletion round to revisit)
- `body` text not null
- `created_at` timestamp default now not null

Index:
- `index('messages_room_created_idx').on(messages.room_id, messages.created_at)` — needed for `ORDER BY created_at` queries on history fetch; Round 5 will rely on it for cursor pagination.

Run `pnpm db:generate` to produce the next migration (expect filename like `0002_*.sql`) and commit it alongside the schema change. The existing migration runner (`node dist/db/migrate.js`) applies it on startup.

### 4. Update `backend/src/types/shared.ts`
Copy `Message`, `SendMessagePayload`, `MessageSendAck` verbatim from `/shared/types/message.ts`. Keep the file's existing structure (auth / user / room mirror already there from Rounds 1–2).

### 5. Service — `backend/src/services/messages.service.ts`
All DB access lives here. No `req`/`res`, no socket objects.

```ts
export async function persistMessage(
  userId: string,
  roomId: string,
  body: string,
): Promise<Message>;

export async function listRecentMessages(
  userId: string,
  roomId: string,
  limit = 50,
): Promise<Message[]>;
```

Behaviour:

- **`persistMessage`** — validates `body.trim().length` is 1–3072 (throw `AppError('Body must be between 1 and 3072 characters', 400)` otherwise — message string must match `/shared/api-contract.md` §Socket Events exactly). Verify membership via `roomsService.isRoomMember(userId, roomId)`; throw `AppError('Not a room member', 403)` if false; throw `AppError('Room not found', 404)` if the room doesn't exist. Insert the row, then fetch it back joined with `users.username` so the returned `Message` is fully denormalised (don't trust the input, use the stored `created_at` and the canonical `id`).

- **`listRecentMessages`** — verify membership (same failures as above). Query: `ORDER BY created_at DESC LIMIT $limit`, then reverse in-code so the returned array is **ascending** (oldest first). Join `users.username` for denormalisation.

### 6. HTTP — add `GET /api/rooms/:id/messages` to `backend/src/routes/rooms.ts`
Extend the existing `rooms` router; do not create a new router file.

```ts
router.get('/:id/messages',
  validateParams(idSchema),
  async (req, res) => res.json(await messagesService.listRecentMessages(req.user.id, req.params.id)),
);
```

Responds with `200 Message[]` on success; `403 { error: "Not a room member" }` / `404 { error: "Room not found" }` via the existing `errorHandler` when the service throws.

### 7. Socket.io — `backend/src/socket/io.ts`
New file. Export an `initSocketIo(httpServer, corsOrigin)` function and a `getIo()` accessor:

```ts
import { Server, type Socket } from 'socket.io';
let ioInstance: Server | null = null;

export function getIo(): Server {
  if (!ioInstance) throw new Error('Socket.io not initialised');
  return ioInstance;
}

export function initSocketIo(httpServer: http.Server, corsOrigin: string): Server {
  const io = new Server(httpServer, {
    cors: { origin: corsOrigin, credentials: true },
  });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (typeof token !== 'string') return next(new Error('Unauthorized'));
      const user = verifyAccessToken(token);
      socket.data.user = user;
      next();
    } catch {
      next(new Error('Unauthorized'));
    }
  });

  io.on('connection', async (socket: Socket) => {
    const userId = socket.data.user.id;
    await socket.join(`user:${userId}`);

    const rooms = await roomsService.listRoomsForUser(userId);
    for (const r of rooms) await socket.join(`room:${r.id}`);

    socket.on('message:send',
      async (payload: SendMessagePayload, ack?: (res: MessageSendAck) => void) => {
        if (typeof ack !== 'function') return;  // ack is mandatory per contract
        try {
          const message = await messagesService.persistMessage(userId, payload.roomId, payload.body);
          ack({ ok: true, message });
          socket.to(`room:${message.roomId}`).emit('message:new', message);
        } catch (err) {
          const errorString = err instanceof AppError ? err.message : 'Internal error';
          ack({ ok: false, error: errorString });
        }
      });
  });

  ioInstance = io;
  return io;
}
```

Notes:
- `socket.to(...)` excludes the sending socket, which is what we want — the sender gets the message via ack; other tabs of the same user get it via the broadcast (same user, different socket).
- Do **not** wire `message:send` error handling through `AppError`'s `errorHandler` middleware — that's Express-specific. Translate to the ack shape in-place.
- Sanitise: call `payload.body.trim()` before passing to `persistMessage` (the service also validates, but trimming is a transport-layer cleanup).
- Defensive: wrap `payload` validation in a small zod schema here too (`z.object({ roomId: z.string().uuid(), body: z.string() })`) and throw `AppError('Invalid payload', 400)` on parse failure, so malformed socket payloads get a friendly error string instead of a stack trace.

### 8. Wire it up — `backend/src/index.ts`
Replace `app.listen(config.port, ...)` with:

```ts
import http from 'node:http';
import { initSocketIo } from './socket/io';

// ...after all middleware + route mounts:
const httpServer = http.createServer(app);
initSocketIo(httpServer, config.corsOrigin);
httpServer.listen(config.port, () => { /* existing log */ });
```

Do **not** touch anything else (CORS middleware, JSON parser, cookie parser, route mounts all stay).

### 9. Keep socket subscriptions in sync with room membership
Edit `backend/src/routes/rooms.ts`. After the three mutating service calls, nudge the user's sockets:

```ts
// after createRoom(...) and joinRoom(...)
getIo().in(`user:${userId}`).socketsJoin(`room:${roomId}`);

// after leaveRoom(...)
getIo().in(`user:${userId}`).socketsLeave(`room:${roomId}`);
```

Guard against startup order: import `getIo` lazily (top-level import is fine — `getIo()` is only invoked at request time, by which point `initSocketIo` has run).

### 10. Smoke check (run before writing summary)
Use `curl` for HTTP and a tiny Node one-liner or `socket.io-client` via `npx` for the socket side:

1. `docker compose up` (or restart backend). Confirm `/socket.io/` responds (e.g. `curl -i http://localhost:3000/socket.io/?EIO=4&transport=polling` should return a Socket.io handshake response, not 404).
2. Register two users A + B, create a public room as A, have B join (reuse Round 2 smoke flow).
3. Connect a socket client as A with `auth.token = <A's access token>`. Confirm it ends up in `room:<id>` via a server-side log in the connection handler (temporarily log `socket.rooms` after the joins — remove before commit).
4. Emit `message:send` from A with a valid body — confirm ack `{ ok: true, message }` with a stable `id` / `createdAt`.
5. Connect a second socket as B. Have A emit another message — B's client receives `message:new` with the same payload; A's client does **not** (received via ack only).
6. Emit `message:send` with a 4000-char body — ack `{ ok: false, error: "Body must be between 1 and 3072 characters" }`.
7. Emit `message:send` with a room id where A is not a member — ack `{ ok: false, error: "Not a room member" }` or `"Room not found"`.
8. `curl GET /api/rooms/<id>/messages` — expect `200` with an ascending-ordered array containing the messages from steps 4–5.
9. Have A create a *new* public room. Without reconnecting, emit `message:send` in that new room — ack ok (confirms `socketsJoin` wired correctly).

Report actual output / ack shapes in the summary rather than "passed".

## Wrap-up
Write `plans/round-3/backend_work_summary.md` with:
- **Built** — files touched, migration filename, service functions, socket wiring
- **Deviations** — anything that differs from the contract or this plan
- **Deferred** — items intentionally skipped (e.g. rate limiting on `message:send`, mid-session token refresh, `invitation:new` / `room:updated` for Round 4, `typing:*` for later)
- **Next round needs to know** — concrete notes for Round 4 (Invitations + Room Settings): where to emit `invitation:new` (to `user:<invitedUserId>` via `getIo().in(...)`), where to emit `room:updated` (to `room:<id>`), and whether the socket-subscription sync pattern from task 9 generalises to invitation-acceptance
- **Config improvements** — any friction noticed while working (docker feedback loop on socket changes, socket.io-client CLI for testing, etc.)
