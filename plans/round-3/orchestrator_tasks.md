# Round 3 — Orchestrator Tasks

## Goal
Define the `Message` type, the Socket.io event contract (handshake, auto-subscription model, `message:send` ack, `message:new` broadcast), and the small HTTP endpoint that returns recent history, so FE and BE can build real-time messaging.

## Scope
Round 3 from `plans/master-plan.md` — real-time messaging only. No history pagination (Round 5), no edit / delete / reply / attachments (Rounds 9–10), no presence (Round 8), no DMs (Round 7).

## Design decisions (locked during planning)
- **Q1: send via socket emit with ack**, no HTTP POST. One write channel.
- **Q2: auto-subscribe to all joined rooms on connect.** No `room:join` / `room:leave` socket events in Round 3. Active-room signalling is deferred to Round 12 (unread tracking).
- **Q3: hardcoded `?limit=50`** for `GET /api/rooms/:id/messages` — cursor pagination comes in Round 5.

## Dependencies
- `plans/master-plan.md` §Round 3 bullets
- `requirements.txt` §2.5 Messaging (3 KB max body, UTF-8, multiline), §2.1.5 (account-deletion semantics)
- `shared/api-contract.md` — current state (auth + rooms)
- `shared/types/` — existing exports (`user.ts`, `auth.ts`, `room.ts`)
- `plans/round-2/backend_work_summary.md` — flagged the `http.createServer` switch, `verifyAccessToken` extraction, `isRoomMember` reuse
- `plans/round-2/frontend_work_summary.md` — flagged `ChatContextService` as socket-lifecycle hook; **this is superseded** by Q2 (no per-room lifecycle on the client)

## Tasks

### 1. Create `/shared/types/message.ts`
Export:

```ts
export interface Message {
  id: string;
  roomId: string;
  userId: string;     // author id (still in DB even after account delete — see BE task 3)
  username: string;   // denormalised so clients can render without a user lookup
  body: string;
  createdAt: string;
}

export interface SendMessagePayload {
  roomId: string;
  body: string;
}

export type MessageSendAck =
  | { ok: true; message: Message }
  | { ok: false; error: string };
```

Notes:
- Keep `Message` minimal. Future fields (`editedAt`, `deletedAt`, `replyToId`, `attachments`) are added in Rounds 9–10 behind `?:` optional markers — do not introduce them now.
- `userId` stays non-nullable for Round 3. Round-level decision: when a user deletes their account we will cascade-delete their messages. The account-deletion round can revisit if we want to preserve history with a `(deleted)` placeholder instead. Document that in the contract so both sides know.

### 2. Update `/shared/types/index.ts`
Append `export * from './message';` after the existing `room` export.

### 3. Extend `/shared/api-contract.md`

#### 3a. Add `GET /api/rooms/:id/messages` to the existing `## Rooms Endpoints` section
Append to the summary table and add a per-endpoint section.

| Method | Path | Body | Success | Errors |
|--------|------|------|---------|--------|
| GET | `/api/rooms/:id/messages` | — | `200 Message[]` (oldest first, up to 50 most-recent) | `403` not a member, `404` not found |

Document in prose:
- Returns at most 50 messages — the 50 most-recent, ordered by `createdAt` **ascending** (oldest first, newest last) so the client can append directly to its scrollable list.
- No cursor / `before` query param in Round 3. Round 5 introduces `?before=<messageId>&limit=` and keeps the same response shape.
- Auth + membership rules identical to `GET /api/rooms/:id`: 401 missing token, 403 non-member, 404 unknown id.

#### 3b. Add a new top-level `## Socket Events` section (after the Rooms Endpoints section)
Structure the new section like this:

**Transport**
- Socket.io v4 on the same HTTP server as Express. Path: default `/socket.io/`.
- Dev: client connects to `http://localhost:3000`. Prod: same origin (frontend nginx proxies `/socket.io/` to backend with WebSocket upgrade).
- CORS origin on the Socket.io server: `http://localhost:4300` with `credentials: true` (for parity with the REST CORS).

**Handshake**
- Client provides `auth: { token: <accessToken> }` in `io(url, options)`.
- Server `io.use()` verifies the token with the same `verifyAccessToken()` helper used by `requireAuth` (see BE task 2). On failure: `next(new Error('Unauthorized'))`.
- On successful handshake, server attaches `socket.data.user = { id, email, username }`.

**On connect**
- Server joins the socket to `user:<userId>` (used by REST handlers to fan out to all of a user's tabs).
- Server joins the socket to `room:<roomId>` for every room the user is currently a member of.
- No explicit `room:join` / `room:leave` events from the client in Round 3. Subscription state is maintained server-side:
  - After `POST /api/rooms` (create) and `POST /api/rooms/:id/join` — server calls `io.in('user:<userId>').socketsJoin('room:<roomId>')`.
  - After `POST /api/rooms/:id/leave` — server calls `io.in('user:<userId>').socketsLeave('room:<roomId>')`.

**Client → Server events**

`message:send`
- Payload: `SendMessagePayload` (`{ roomId, body }`).
- Acknowledgement is **required** — client must pass an ack callback.
- Validation: `body` is a non-empty string, trimmed length 1–3072 chars (requirement §2.5.2). `roomId` is a UUID. Caller must be a member of the room (reuse `isRoomMember`).
- Server persists the message, then acks with `MessageSendAck`:
  - Success: `{ ok: true, message: Message }`.
  - Failure: `{ ok: false, error: <human-readable reason> }`. Specific error strings to preserve verbatim:
    - `"Body must be between 1 and 3072 characters"`
    - `"Not a room member"`
    - `"Room not found"`
- After a successful persist, server broadcasts `message:new` (see below) to everyone in `room:<roomId>` **except the sender socket** (`socket.to('room:<roomId>').emit(...)`). The sender renders its own message from the ack, so it is excluded from the broadcast to avoid duplicates. Other tabs of the same user receive the broadcast normally.

**Server → Client events**

`message:new`
- Payload: `Message` (the full denormalised message including `username`).
- Fired to all sockets in `room:<roomId>` except the sender socket. Clients should filter by active room id when rendering (they are subscribed to every room they belong to).

**Error envelope**
- Connection-level errors surface via socket.io's built-in `connect_error` — the client should log and show a toast. There is no generic `error:*` event in Round 3.

### 4. No agent description changes
`.claude/agents/backend-developer.md` already names Socket.io + JWT handshake; `.claude/agents/frontend-developer.md` already names socket.io-client. Nothing to update.

### 5. No master plan update
Round 3 stays as the master plan describes it. Future rounds unchanged.

## Wrap-up
Write `plans/round-3/orchestrator_work_summary.md` with:
- **Built** — files touched under `/shared/`, final event + endpoint list
- **Deviations** — any shape changes BE or FE pushed back
- **Deferred** — explicit list of message-shape fields **not** added (see task 1 note on `editedAt` / `replyToId` / etc.) and the multi-tab token-refresh question
- **Next round needs to know** — for Round 4 (Invitations + Room Settings): whether `invitation:new` and `room:updated` events should follow the same "server pushes, no client-side room-join" pattern established here
- **Config improvements** — socket-layer conventions worth adding to agent configs (e.g. "ack is mandatory on writes", "prefer room-keyed broadcasts with sender exclusion")
