# Round 6 — Bugs

### Bug #1 — FriendsService signal empty on hard page reload
- Status: Open
- Priority: medium
- Feature: Friends sidebar (pre-existing, flagged by dev in Round-6 summary)
- Repro:
  1. Log in as a user who has at least one friend (e.g. alice_qa friended with bob_qa).
  2. Open a DM with that friend so both Direct Messages and Friends sections should be populated.
  3. Hit `F5` / trigger `location.reload()` on the DM route (`/chat/<dmRoomId>`).
  4. Observe the sidebar after the page re-hydrates.
- Expected: Friends section re-populates from `GET /api/friends` and shows `bob_qa` with the `chat_bubble_outline` Message icon, same as before reload.
- Actual: Only the Friends section is empty — it renders the empty-state "No friends yet. Add someone to start chatting." Meanwhile Rooms (Public Rooms → general-qa), Direct Messages (bob_qa row), DM history, and the right-hand Members rail all re-populate correctly. `GET /api/friends` returns `[{ userId, username: 'bob_qa', friendshipCreatedAt }]` (200 OK), so the data is server-side; only the client `FriendsService.friends()` signal fails to pick it up on reload. No console errors during the reload. Workaround: switch tabs back/forward, or sign out and sign in.
- Notes: Pre-existing, NOT a Round-6 regression per the dev's Round-6 work summary (`plans/round-6/frontend_work_summary.md` §Known issue). Recommended fix (dev-suggested): migrate the three `fetchInitial()` calls in `AuthService.constructor` (`invitations`, `friends`, `user-bans`) into an `APP_INITIALIZER` that `forkJoin`s them and resolves before the first route renders. Verified today against `alice_qa` ⇄ `bob_qa` fixture data.

## Summary
- Open: 1 (medium: 1)
- Fixed (pending verification): 0
- Verified: 0
- Won't fix: 0
