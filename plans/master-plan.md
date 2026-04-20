# Chat App — Master Plan

## Rounds

### Round 1: Foundation — Docker + Auth + App Shell ✅
**Deliverable**: `docker compose up` works. User can register, log in, see the app shell, view and revoke active sessions.

- **[Orchestrator]** Create `/shared/` folder; define User, Session, Auth types; write auth API contract; update agent descriptions and create subproject CLAUDE.md files
- **[BE]** Docker setup (`docker/backend.Dockerfile`, `docker-compose.yml`); Drizzle migrations (users, sessions tables); auth endpoints (register, login, logout, refresh, forgot-password, reset-password, sessions list/revoke); JWT middleware
- **[FE]** Docker setup (`docker/frontend.Dockerfile` + nginx); Sign In / Register / Forgot Password / Reset Password pages; auth service + JWT interceptor + route guards; app shell (top nav); sessions management page

---

### Round 2: Rooms — HTTP + Shell ✅
**Deliverable**: User can create a public room, see a list of rooms in a sidebar, and open a room into an empty main pane. No messages yet.

- **[Orchestrator]** Room types (`Room`, `RoomMember`, `CreateRoomRequest`); room HTTP API contract (list, create, get, join, leave)
- **[BE]** Drizzle migration for `rooms` + `room_members`; REST endpoints: `GET /rooms`, `POST /rooms`, `GET /rooms/:id`, `POST /rooms/:id/join`, `POST /rooms/:id/leave`; membership enforcement
- **[FE]** Three-column chat shell (left sidebar / main / right rail); room list in left sidebar (auto-refresh on create); "Create Room" dialog; room detail route `/chat/:roomId` with empty message pane placeholder; room service

---

### Round 3: Real-time Messaging
**Deliverable**: User can send a message in a room and receive messages from other users in real time. No history pagination yet.

- **[Orchestrator]** `Message` type; Socket.io event contract (`message:send`, `message:new`, `room:join`, `room:leave`); message POST contract (if any)
- **[BE]** Wire Express to `http.createServer`; Socket.io server with JWT handshake middleware; `messages` table migration; persist on `message:send`; broadcast `message:new` to room members
- **[FE]** Socket.io-client service with auto-connect on login; join/leave socket rooms on route change; message composer (text + Enter-to-send); live message list rendering new messages

---

### Round 4: Invitations + Room Settings
**Deliverable**: Admins can invite users to private rooms and edit room name/description/visibility; invitees see live notifications.

- **[Orchestrator]** `Invitation` type; invitation + room-settings API contract; socket events `invitation:new` (to invitee) and `room:updated` (to members)
- **[BE]** Invitation create/accept/revoke endpoints; `invitations` table; `PATCH /rooms/:id` for settings; emit `invitation:new` on create and `room:updated` on patch
- **[FE]** Manage Room dialog scaffolding — **Invitations** + **Settings** tabs (other tabs added in later rounds); invite-by-username flow; incoming invitation acceptance UI; live room-header refresh on `room:updated`

---

### Round 5: Friends
**Deliverable**: Users can send, accept, and reject friend requests, and see a friends list in the sidebar.

- **[Orchestrator]** `Friend`, `FriendRequest` types; friend API contract
- **[BE]** `friends` + `friend_requests` tables; send/accept/reject/cancel/remove endpoints; user search endpoint
- **[FE]** Friends panel in left sidebar; "Add Friend" dialog with user search; pending/incoming request list; accept/reject controls

---

### Round 6: Direct Messages
**Deliverable**: From the friends list, users can open a 1:1 DM and exchange messages in real time (reuses Round 3 message infra).

- **[Orchestrator]** Extend room types with `type: 'public' | 'dm'`; `OpenDmRequest` contract
- **[BE]** DM creation endpoint (upsert two-participant dm room); enforce dm-specific membership rules; reuse message table + socket events
- **[FE]** DM list section in sidebar; "Message" action on a friend opens/creates DM; DM header shows other participant

---

### Round 7: Presence
**Deliverable**: Users see online / AFK / offline dots next to friends and DM participants; state is consistent across tabs.

- **[Orchestrator]** `PresenceState` type; presence socket event contract (`presence:update`, `presence:snapshot`)
- **[BE]** In-memory presence map keyed by userId; aggregate across sockets (online if any tab connected); emit on connect/disconnect + idle timeout
- **[FE]** Presence indicators (●/◐/○) on friends list, DM headers, room member rail; subscribe to presence events on connect

---

### Round 8: Attachments
**Deliverable**: Users can attach files/images to messages; recipients see inline image previews.

- **[Orchestrator]** `Attachment` type; file upload API contract; message type extended with `attachments?: Attachment[]`
- **[BE]** `multer` file upload endpoint (size + mime whitelist); file serving with per-message access control; `attachments` table
- **[FE]** Attach button + drag-and-drop + paste handler in composer; inline image preview in messages; fallback file card for non-images

---

### Round 9: Message History + Pagination
**Deliverable**: User can scroll up through full message history with smooth infinite scroll; unread/anchor behavior feels right.

- **[Orchestrator]** Paginated history API contract (`GET /rooms/:id/messages?before=&limit=`); `MessageHistoryResponse` type
- **[BE]** Cursor-paginated history endpoint; order + index optimization on `messages(room_id, created_at)`
- **[FE]** Infinite scroll on the message list (load more on scroll-to-top); preserve scroll anchor when prepending; initial scroll to bottom on room open

---

### Round 10: Message Actions
**Deliverable**: Users can reply to messages, and edit or delete their own messages.

- **[Orchestrator]** Extend `Message` with `editedAt`, `deletedAt`, `replyToId`; reply/edit/delete event + REST contract
- **[BE]** Edit/delete endpoints (author-only); `message:edit`, `message:delete` socket broadcasts; reply metadata resolution
- **[FE]** Message hover toolbar (reply / edit / delete); reply preview in composer; rendered reply quote block above message; edited/deleted indicators

---

### Round 11: Room Moderation
**Deliverable**: Room admins can ban, unban, remove members, and promote/demote admins.

- **[Orchestrator]** `RoomRole` extensions; ban/member-management API contract; admin-action socket events
- **[BE]** Ban/unban/remove/promote/demote endpoints; `room_bans` table; role-based authorization middleware; kick broadcast
- **[FE]** Member context menu (admin-only actions); extend Manage Room dialog (built in Round 4) with **Members**, **Admins**, **Banned** tabs

---

### Round 12: Unread + Public Catalog
**Deliverable**: Unread badges appear on the sidebar; users can browse and search a public room catalog.

- **[Orchestrator]** Unread count types; public catalog API contract (search + pagination)
- **[BE]** Unread tracking (per-user last-read cursor per room); `GET /rooms/catalog?q=&cursor=`; search by name/description
- **[FE]** Unread badges on sidebar room/DM items; clear-on-open behavior; Public Rooms catalog page with search input and join buttons

---

## Round Summary Convention

After every round, each agent writes `plans/round-N/<role>_work_summary.md` (e.g. `backend_work_summary.md`):
- **Built**: bullet list of what was actually implemented
- **Deviations**: anything that differs from the task description or API contract
- **Deferred**: items skipped or left incomplete
- **Next round needs to know**: decisions that affect Round N+1
- **Config improvements**: proposed follow-up changes to settings / tooling / agent configs

Per-round task files live next to the summaries as `plans/round-N/<role>_tasks.md` (`orchestrator_tasks.md`, `backend_tasks.md`, `frontend_tasks.md`).

Summaries become input context when expanding the next round's detailed task files.
