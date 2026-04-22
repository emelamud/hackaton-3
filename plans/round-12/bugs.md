# Round 12 — Bugs

## Bug #1 — Unread badges do not repopulate after a hard page reload

- Status: Open
- Priority: medium
- Feature: Sidebar unread badges — Feature 1, Scenario 5 (Hydration on reload)
- Repro:
  1. Sign in as carol_r12_1776860231198@example.com with "Keep me signed in" checked (localStorage token).
  2. Verify the #general-1776860231198 sidebar badge shows 13 (or >0).
  3. Do a full page reload (F5, or `page.goto` to the current URL).
  4. Observe the sidebar after the app finishes loading.
- Expected: The #general badge repopulates with the correct unread count (e.g., 13) because `UnreadService.initialize()` fires `GET /api/unread` during the AuthService constructor restore path.
- Actual: All sidebar badges are hidden (mat-badge-hidden). The `GET /api/unread` call does NOT appear in the network log after reload. The API returns the correct data when queried manually (`[{roomId: "393797ba-...", unreadCount: 13}]`). The badge never re-renders until the user signs out and signs back in.
- Notes:
  - Affects both localStorage (Keep me signed in) and sessionStorage (regular login) token storage modes.
  - The login flow works correctly: badges hydrate immediately after a form-based sign-in.
  - The multi-tab socket events (live increment, mark-read) continue to work after reload; only the initial hydration via `GET /api/unread` is missing.
  - The work summary states `initialize()` is wired to the "constructor-restore" path of `AuthService`, but the network evidence shows the HTTP call is not being made during restore. Possible causes: (a) the Angular DI singleton `AuthService` is not reconstructed on reload (SPA behavior), meaning the constructor never re-runs and the in-memory state is lost with no re-seeding, OR (b) a race condition where `reset()` is called after `initialize()` populates the counts. Likely root cause: the Angular app's root-level `AuthService` singleton constructor runs once at bootstrap; on a hard reload, the SPA bootstraps fresh but some code path that was assumed to call `initialize()` is not actually doing so.
  - Observed in Playwright: after `page.goto` / `location.reload()` both with localStorage token (verified valid, non-expired).
  - Not a pre-existing regression — this is the first round introducing `UnreadService`.

---

## Scenario Verification Table

| # | Feature | Scenario | Result | Notes |
|---|---------|----------|--------|-------|
| 1a | Unread badges | Initial hydration on login | PASS | Bob: #general=10 badge visible after login |
| 1b | Unread badges | Badge clears when opening room | PASS | POST /api/rooms/:id/read fired; badge hides immediately |
| 2 | Unread badges | Live increment via message:new | PASS | Carol→#eng: Bob's badge incremented to 3 on both tabs |
| 3 | Unread badges | Multi-tab room:read sync | PASS | Tab 0 opened #general; Tab 1 badge cleared via socket within 1s |
| 4 | Unread badges | Own-message echo suppression | PASS | Bob sent to #general on Tab 0 (active); Tab 1 badge did NOT bump |
| 5 | Unread badges | Hydration on page reload | FAIL | See Bug #1 — badges not repopulated after reload |
| 6 | Unread badges | Rapid room swap debounce | PASS | No POST storm; one POST per distinct room per 500ms window |
| 7 | Unread badges | No NG0200 circular DI error | PASS | Zero NG0200 errors in console across all sessions |
| 8 | Catalog | Initial load at /public-rooms | PASS | 20 rooms, spinner then list, heading visible |
| 9 | Catalog | Top-nav "Public Rooms" link | PASS | Points to /public-rooms (not /chat placeholder) |
| 10 | Catalog | Open vs Join differentiation | PASS | Member rooms show "Open" link; non-member rooms show "Join" button |
| 11 | Catalog | Join flow | PASS | Joined room, sidebar updated, navigated to /chat/:id |
| 12 | Catalog | Search debounce (300ms) | PASS | Only one request fired after 300ms; rapid typing deduped |
| 13 | Catalog | Pagination / Load more | PASS | 20→30 rows appended; Load more button disappears when hasMore=false |
| 14 | Catalog | Empty state with search | PASS | search_off icon + "No rooms match..." message rendered |
| 15 | Catalog | Clear search → default view | PASS | List returns to 20-row default after clearing search box |
| 16 | Catalog | Error state (5xx) | NOT TESTED | Could not force 5xx without network blocking tools |
| 17 | Catalog | DM badges | NOT TESTED | No pre-existing Alice↔Bob DM; skipped to stay within time budget |

---

## Summary

Open: 1 | Fixed (pending verification): 0 | Verified: 0 | Won't fix: 0

One medium-priority bug found. Fifteen of seventeen planned scenarios tested; all tested scenarios pass except Bug #1 (reload hydration). Two scenarios not tested (error state, DM badges) due to testing complexity and time budget. No critical bugs, no NG0200 circular DI regression, no data loss issues. Core features (badge accrual, badge clear, live socket increment, multi-tab sync, own-message suppression, public catalog search/pagination/join) all work correctly.
