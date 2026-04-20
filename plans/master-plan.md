# Chat App — Master Plan

## Rounds

### Round 1: Foundation — Docker + Auth + App Shell
**Deliverable**: `docker compose up` works. User can register, log in, see the app shell, view and revoke active sessions.

- **[Orchestrator]** Create `/shared/` folder; define User, Session, Auth types; write auth API contract; update agent descriptions and create subproject CLAUDE.md files
- **[BE]** Docker setup (`docker/backend.Dockerfile`, `docker-compose.yml`); Drizzle migrations (users, sessions tables); auth endpoints (register, login, logout, refresh, forgot-password, reset-password, sessions list/revoke); JWT middleware
- **[FE]** Docker setup (`docker/frontend.Dockerfile` + nginx); Sign In / Register / Forgot Password / Reset Password pages; auth service + JWT interceptor + route guards; app shell (top nav); sessions management page

### Round 2: Chat Core — Rooms + Real-time Messaging
**Deliverable**: Users can create/join public rooms, send and receive messages in real time, scroll through history.

- **[Orchestrator]** Room types, Message types, Socket.io event contracts, room API contract
- **[BE]** Socket.io server with JWT auth, room CRUD, message persistence, real-time broadcast, paginated message history
- **[FE]** Three-column chat shell (left sidebar / main chat / right rail), room list, message list with infinite scroll, message composer (text)

### Round 3: DMs + Presence + Friends
**Deliverable**: Users can add friends, chat 1:1, and see online/AFK/offline status.

- **[Orchestrator]** DM types, Presence types, Friend/contact types, DM + friend API contract
- **[BE]** Friend request system, DM logic (two-participant chat), presence tracking via socket events, multi-tab presence aggregation
- **[FE]** Friends list, friend request UI, DM conversations, presence indicators (●/◐/○)

### Round 4: Files + Message Features
**Deliverable**: Users can attach files/images, reply to messages, and edit/delete their own messages.

- **[Orchestrator]** Attachment types, reply/edit metadata types, file API contract
- **[BE]** multer file upload, file serving with access control, message edit/delete endpoints
- **[FE]** File/image attach (button + paste), image preview, reply-to-message UI, edit/delete actions

### Round 5: Moderation + Notifications + Polish
**Deliverable**: Room admins have full moderation tools; unread indicators work; public room catalog works.

- **[Orchestrator]** Admin action types, notification/unread types, ban types, invitation types
- **[BE]** Room ban/unban, remove member, manage admins, invite user, room settings update, unread count tracking, public room catalog + search
- **[FE]** Manage Room dialog (Members/Admins/Banned/Invitations/Settings tabs), unread badges on sidebar, public room catalog with search, admin context menus

### Round 6: Jabber/XMPP Federation (Optional)
**Deliverable**: Users can connect via Jabber client; two-server federation works.

- **[Orchestrator]** Jabber connection types, federation event types
- **[BE]** Jabber library integration, XMPP server, federation docker-compose config, admin dashboard endpoints
- **[FE]** Jabber connection dashboard (admin), federation traffic stats page

---

## Round Summary Convention

After every round, each agent writes `plans/round-N/summary-<role>.md`:
- **Built**: bullet list of what was actually implemented
- **Deviations**: anything that differs from the task description or API contract
- **Deferred**: items skipped or left incomplete
- **Next round needs to know**: decisions that affect Round N+1

Summaries become input context when expanding the next round's detailed task files.
