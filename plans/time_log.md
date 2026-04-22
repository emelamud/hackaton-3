# Time Log

## Round 6

### Planning — `/plan-round 6`
- Started:  <not recorded — timelog instrumentation added mid-session>
- Finished: 2026-04-21 16:42:02 +0300
- Wall time: <not measured>
- Output: `plans/round-6/{orchestrator,backend,frontend}_tasks.md`
- Notes: retroactive entry — locked 10 design decisions for DMs + user-to-user ban; full timing starts with `/implement-round 6`.

### Implementation — `/implement-round 6`
- Started:  2026-04-21 16:46:07 +0300
- Finished: 2026-04-21 18:55:57 +0300
- Wall time: 2h9m50s

| Phase                   | Agent               | Start             | End               | Duration        | Status |
|-------------------------|---------------------|-------------------|-------------------|-----------------|--------|
| Shared types + contract | orchestrator        | 16:46:07          | 16:51:24          | 5m17s           | ✅ |
| Backend impl            | backend-developer   | 18:06:31          | 18:12:52          | 6m21s           | ✅ |
| Frontend impl           | frontend-developer  | 18:05:42 (approx) | 18:44:00 (approx) | 38m18s (approx) | ⚠️ |
| Wrap-up + review        | orchestrator        | 18:44:00 (approx) | 18:55:57          | 11m57s (approx) | ✅ |

- Notes: Run spans two sessions — Phase 1 completed in prior session (16:46:07–16:51:24); Phase 2 dispatched this session at 18:05:42. Phase 2 was interrupted twice in prior attempts (code landed on disk across sessions); third-attempt BE agent resumed clean, verified on-disk state, ran the 27-step smoke harness against `docker compose`, all scenarios passed with exact wire payloads. FE agent was terminated by tool-call rejection ~38 min in, after `plans/round-6/bugs.md` was written; no `TIMING:` line emitted, so FE start/end are approximate from dispatch time + last file-mtime. FE summary reconstructed from on-disk diff during wrap-up. One bounded-retry bug logged to `plans/round-6/bugs.md` (FriendsService signal empty after `location.reload()` — pre-existing Round-5 regression in the `AuthService` hydrate-from-storage path, not Round 6 scope). One API deviation flagged: BE smoke step 19 surfaces `"You must be friends to start a direct message"` rather than `"Personal messaging is blocked"` because `banUser` atomically severs friendship before the post-ban DM-retry hits the friendship gate — both errors are contract-legal under §Direct Message Endpoints.

## Round 7

### Planning — `/plan-round 7`
- Started:  2026-04-22 08:27:37 +0300
- Finished: 2026-04-22 08:36:21 +0300
- Wall time: 8m44s
- Output: `plans/round-7/{orchestrator,backend,frontend}_tasks.md`
- Notes: locked 10 presence design decisions (AFK=60s client-driven; explicit active/idle transitions; server-side aggregate online/afk/offline; interest-set fan-out = friends ∪ DM peers ∪ room co-members; per-socket snapshot on connect; self-presence layered locally). Introduced `ClientToServerEvents` to `shared/types/socket.ts` for the first time — scoped to `presence:active` / `presence:idle` only; `message:send` retrofit deliberately deferred. Added agent-description one-liner re: `shared/types/socket.ts` being authoritative for event shapes (closes the drift flagged in both Round 5 and Round 6 summaries). No open questions — user's four planning questions answered in the orchestrator task file (Q1–Q4).

### Implementation — `/implement-round 7`
- Started:  2026-04-22 08:46:08 +0300
- Finished: 2026-04-22 09:25:48 +0300
- Wall time: 39m40s

| Phase                   | Agent               | Start    | End      | Duration | Status |
|-------------------------|---------------------|----------|----------|----------|--------|
| Shared types + contract | orchestrator        | 08:46:08 | 08:50:53 | 4m45s    | ✅ |
| Backend impl            | backend-developer   | 08:54:38 | 09:05:03 | 10m25s   | ✅ |
| Frontend impl           | frontend-developer  | 08:55:08 | 09:05:12 | 10m4s    | ✅ |
| Frontend test           | frontend-tester     | 09:12:09 | 09:24:35 | 12m26s   | ✅ |
| Wrap-up + review        | orchestrator        | 09:24:59 | 09:25:48 | 49s      | ✅ |

- Notes: Clean round. Zero bugs logged (`plans/round-7/bugs.md`: Open=0, Fixed=0, Verified=0). BE smoke 12/12 with raw payloads captured; FE lint+build+typecheck clean, zero design-system token violations. Between FE dev completion (09:05:12) and tester start (09:12:09) the main orchestrator had to bring the Docker stack up — updated `.claude/commands/implement-round.md` Phase 3 so future rounds offer to `docker compose up -d --build` after user consent instead of just asking and waiting. Only non-ship deviations: BE declined to widen the `Server<CTS, STC>` generic (would drag `message:send` into scope); FE shipped with `bg-outline`/`bg-surface-dim` per `DESIGN_SYSTEM.md §2` rather than the task-file sketch's token names.

## Round 8

### Planning — `/plan-round 8`
- Started:  2026-04-22 10:46:55 +0300
- Finished: 2026-04-22 11:06:54 +0300
- Wall time: 20m0s
- Output: `plans/round-8/{orchestrator,backend,frontend}_tasks.md` (+ `planning_qa.md` for decision rationale)
- Notes: User-supplied planning prompt at `prompts/plan-round-8.md` asked three questions (filesystem storage? how does FE fetch images? HTML sanitization for inline images?). Answered each in `plans/round-8/planning_qa.md` and surfaced seven follow-up decisions; user resolved six (upload-first, cap 5 attachments per message, per-attachment comment in scope per requirements §2.6.3, new-tab full-size viewer, `MessageSendAck.message.attachments?` extension approved, volume choice delegated). Picked named volume `uploads_data` (parity with `postgres_data`). Locked design: upload-first → `message:send { attachmentIds }` → atomic commit in a single transaction. Blob-cache + object-URL lifecycle on FE; no `innerHTML`, no `bypassSecurityTrust*`, no Markdown. 1-hour orphan sweep via `setInterval`. 19-scenario BE smoke harness spec'd covering happy-path, DM ban gate (upload + download), lost-access cleanup, over-cap attachmentIds, wrong-room / wrong-uploader / already-attached, magic-byte sniff, and orphan sweep.

### Implementation — `/implement-round 8`
- Started:  2026-04-22 11:08:15 +0300
- Finished: 2026-04-22 12:21:50 +0300
- Wall time: 1h13m35s

| Phase                   | Agent               | Start    | End      | Duration      | Status |
|-------------------------|---------------------|----------|----------|---------------|--------|
| Shared types + contract | orchestrator        | 11:08:15 | 11:11:37 | 3m22s         | ✅ |
| Backend impl            | backend-developer   | 11:15:25 | 11:32:45 | 17m20s        | ✅ |
| Frontend impl           | frontend-developer  | 11:15:59 | 11:26:52 | 10m53s        | ✅ |
| Frontend test           | frontend-tester     | 11:33:12 | 12:19:50 | 46m38s (approx) | ⚠️ |
| Wrap-up + review        | orchestrator        | 12:20:13 | 12:21:50 | 1m37s         | ✅ |

- Notes: BE shipped clean — 19/19 smoke scenarios produced the expected payloads (raw JSON captured per-scenario in the summary). FE shipped clean — `pnpm lint` / `pnpm build` / `tsc --noEmit` all clean; design-system spot-check zero hits on `#hex`, `var(--mat-sys`, `px`, inline `style=`, `bypassSecurityTrust*`, `innerHTML`. Tester run **incomplete**: 8 / 12 UI scenarios verified (PASS — image upload, file upload, DND, paste, 5-cap + snackbar overflow, remove, per-attachment comment, size-cap failure); 4 unverified (attachment-only send, real-time broadcast to second user, DM ban gate, logout lifecycle, scroll anchoring on async image load) after Playwright MCP held a stale Chrome user-data-dir lock the tester couldn't clear. `bugs.md` logs `Open=0` with a documented coverage-gap section. Tester TIMING line never emitted (killed mid-run); end timestamp recorded at orchestrator kill time (`(approx)` flag). BE wire-layer smoke scenarios #15, #2, #16, #17, #19 cover the server side of every unverified UI case, so the risk surface for the gap is the UI binding, not the contract. Recommended next action: `/fix-bugs 8` or a fresh `frontend-tester` pass to close the UI coverage. Two BE judgement calls to flag for potential contract follow-up: (a) duplicate `attachmentIds` in one send rejected as `"Invalid attachment reference"` — worth noting explicitly in the contract; (b) `Content-Disposition` uses modern-only `filename*=UTF-8''…` with no legacy fallback.

## Round 9

### Planning — `/plan-round 9`
- Started:  2026-04-22 12:34:45 +0300
- Finished: 2026-04-22 12:43:20 +0300
- Wall time: 8m36s
- Output: `plans/round-9/{orchestrator,backend,frontend}_tasks.md`
- Notes: Locked 10 design decisions for paginated history. Cursor = `messageId` (row-value `(created_at, id)` comparison for stable ties); response wrapped in `MessageHistoryResponse { messages, hasMore }` (supersedes Round-3's bare `Message[]` — BC break); default limit 50, max 100; `hasMore` derived from a `limit+1` fetch server-side (no off-by-one). Attachment hydration: one batch query per page (`SELECT … WHERE message_id = ANY(...)`), no N+1. Contract introduces one new error string (`"Invalid cursor"`) covering non-existent, wrong-room, or cross-boundary cursors; malformed-UUID cursors stay on the zod `"Validation failed"` envelope. Only one file under `/shared/` grows (`message.ts`); `api-contract.md` gets the `GET /api/rooms/:id/messages` block rewritten and the superseded Round-3 forward-reference deleted. FE plan covers infinite-scroll-upwards with scroll-anchor preservation: capture `scrollHeight` + `scrollTop` before prepend, restore in `ngAfterViewChecked` using the delta — coexists with Round 8's image `(loaded)` re-anchor because the bottom-pin branch is guarded on `isNearBottom()`. Top-of-list spinner + error+retry + "Start of conversation" sentinel states. No schema / migration / docker changes; existing `messages_room_created_idx(room_id, created_at)` covers the hot query, compound `(room_id, created_at, id)` flagged as a future config improvement only. No open questions.

### Implementation — `/implement-round 9`
- Started:  2026-04-22 12:51:30 +0300
- Finished: 2026-04-22 14:15:13 +0300
- Wall time: 1h23m43s

| Phase                   | Agent               | Start    | End      | Duration | Status |
|-------------------------|---------------------|----------|----------|----------|--------|
| Shared types + contract | orchestrator        | 12:51:30 | 12:53:28 | 1m58s    | ✅ |
| Backend impl            | backend-developer   | 12:55:18 | 13:40:49 | 45m31s   | ✅ |
| Frontend impl           | frontend-developer  | 12:55:42 | 13:01:32 | 5m50s    | ✅ |
| Frontend test           | frontend-tester     | 13:42:22 | 14:13:28 | 31m6s    | ⚠️ |
| Wrap-up + review        | orchestrator        | 14:14:07 | 14:15:13 | 1m6s     | ✅ |

- Notes: BE shipped clean — 15/15 smoke scenarios produced the expected payloads with verbatim JSON captured per-scenario (including the exactly-50 off-by-one regression trap and the 3 invalid-cursor variants). FE shipped clean — `pnpm lint` / `pnpm build` / `tsc --noEmit` clean, design-system spot-check zero hits. Tester run hit a **critical deployment blocker**: the FE Docker container was not rebuilt during Phase 2 (BE dev ran `docker compose up -d --build backend` as its gate, but the FE dev is explicitly told not to run `ng serve` or rebuild, so nothing rebuilt the FE container). Stale Round-8 bundle served against the new Round-9 BE shape caused `TypeError: t[Symbol.iterator] is not a function` on every room open, blocking all 9 UI scenarios. `bugs.md`: Open=2 Fixed=0 Verified=0 — Bug #1 is the FE container deployment blocker (no code change needed; `docker compose up -d --build frontend` resolves it); Bug #2 is a pre-existing Round-1 auth-interceptor race during 401 → refresh → retry on initial room load (surfaced because Round-9's iterator pattern is more sensitive to non-array values; partially masked by #1, needs re-verify after the FE rebuild). Zero API / contract deviations — BE matches the contract 100%. **Workflow improvement for future rounds**: `/implement-round` Phase 2 should rebuild BOTH service images before Phase 3 dispatches the tester; today only the BE is rebuilt as part of its smoke gate.

## Round 12

### Planning — `/plan-round 12`
- Started:  2026-04-22 14:50:44 +0300
- Finished: 2026-04-22 15:01:42 +0300
- Wall time: 10m58s
- Output: `plans/round-12/{orchestrator,backend,frontend}_tasks.md`
- Notes: Rounds 10 (message edit/delete) and 11 (room moderation) deliberately SKIPPED — user asked to leapfrog straight to Round 12. Confirmed no hard dependency: unread counts live-compute against `messages`, so a future R10 delete stops counting naturally; catalog is `rooms`-only. Locked 14 design decisions. Unread = per-user `room_read_cursors(user_id, room_id, last_read_at)` table with `COALESCE(cursor.last_read_at, member.joined_at)` fallback — no backfill migration needed. Mark-read UPSERT uses `GREATEST(existing, EXCLUDED)` for monotonic advancement. Server does NOT push unread on every `message:new` (FE derives locally); only pushes `room:read` for multi-tab sync. Catalog excludes private rooms + DMs; cursor pagination by `(createdAt DESC, id DESC)` with explicit `nextCursor` in the response (asymmetric vs `MessageHistoryResponse` which derives from `messages[0].id` client-side — catalog's row shape makes client derivation less obvious). Reuses Round-9's reserved `"Invalid cursor"` string — differentiation is by route. Search via `ILIKE '%q%'` on name OR description; full-text search deferred. Two new shared files (`unread.ts`, `catalog.ts`) — rationale: unread is its own domain, catalog is read-only discovery, neither fits the existing `room.ts` / `message.ts` shapes. No agent / docker / env / master-plan changes. One notable scope call-out: jump-to-first-unread (and the Round-9-deferred `?after=` history cursor) deliberately NOT pulled forward — the badge UX doesn't require it, and pulling it in would double the backend surface for a nice-to-have. Open question for implement time: whether `emitToUser` is already generic over `ServerToClientEvents` (hopefully yes after Round 7's typed-events work) or needs a cast with a TODO.

### Implementation — `/implement-round 12`
- Started:  2026-04-22 15:03:40 +0300
- Finished: 2026-04-22 16:19:20 +0300
- Wall time: 1h15m40s

| Phase                   | Agent               | Start    | End      | Duration | Status |
|-------------------------|---------------------|----------|----------|----------|--------|
| Shared types + contract | orchestrator        | 15:03:40 | 15:09:06 | 5m26s    | ✅ |
| Backend impl            | backend-developer   | 15:10:42 | 15:19:58 | 9m16s    | ✅ |
| Frontend impl           | frontend-developer  | 15:11:10 | 15:23:14 | 12m4s    | ⚠️ |
| Frontend test           | frontend-tester     | 15:54:37 | 16:18:02 | 23m25s   | ⚠️ |
| Wrap-up + review        | orchestrator        | 16:18:21 | 16:19:20 | 59s      | ✅ |

- Notes: BE shipped clean — 21/21 smoke scenarios contract-correct; the `assertRoomAndMembership` helper lifted cleanly from `messages.service.ts` to `rooms.service.ts` as `assertRoomMembership`; `emitToUser` was already generic over `ServerToClientEvents` (no widening needed). FE shipped with an **NG0200 circular-DI crash**: `AuthService.inject(UnreadService)` vs `UnreadService.inject(AuthService)` at class-init blocked `<app-root>` from rendering. The FE dev's own summary flagged the circular as "handled by Angular root DI" which turned out to be wrong — `inject()` resolves at field-init time regardless of callback boundaries. Two successive frontend-developer fix dispatches between Phase 2 and Phase 3 (first tried a lazy `Injector` on the AuthService side — only fixed cold `/login`; second eliminated `inject(AuthService)` from `UnreadService` entirely and added a push-based `setCurrentUserId()` from `AuthService` — cleanly broke the cycle). Orchestrator-run Playwright smoke confirmed cold-load clean before tester dispatch. Tester result: 15/17 scenarios PASS, 1 open medium bug (Bug R12-#1: unread badges don't repopulate after a hard page reload — `GET /api/unread` does not fire during `AuthService` constructor-restore path despite the FE summary claiming it does; socket-based flows all work post-reload, only cold-restore hydration is broken), 2 untested (catalog 5xx error state; DM badges). Zero NG0200 regressions observed in the tester pass. Zero API/contract deviations. Workflow observation: between Phase 2 end (15:23:36) and Phase 3 start (15:54:37) a 31-min mid-phase fix cycle ran (2 FE dev dispatches + orchestrator Playwright smoke) — not represented as a separate table row to keep the template uniform. Recommended follow-up: `/fix-bugs 12` for Bug R12-#1; add a CLAUDE.md guideline that root-scoped services with bidirectional needs use setter-push over `Injector`-lazy.

## Round 10

### Planning — `/plan-round 10`
- Started:  2026-04-22 16:29:45 +0300
- Finished: 2026-04-22 16:37:55 +0300
- Wall time: 8m10s
- Output: `plans/round-10/{orchestrator,backend,frontend}_tasks.md`
- Notes: Round 10 planned AFTER Round 12 ships (user leapfrogged 10/11 earlier; circling back now). Locked 14 design decisions: HARD delete (Round 12 summary blessed this path — unread query unchanged), `reply_to_id` FK with `ON DELETE SET NULL` so replies survive target deletion, `Message.editedAt` always present (`null` when unedited), `Message.replyTo` uses omit-when-not-a-reply vs present-as-null-when-target-deleted to preserve the "was a reply" signal, PATCH+DELETE on a new `/api/messages/:id` router (not socket — matches Round 12's `POST /api/rooms/:id/read` precedent for author-gated mutations), `message:edit` + `message:delete` broadcast to ALL sockets in `room:<roomId>` including author's own (different from `message:new`'s sender-exclusion pattern because HTTP caller has no socket handle), DM ban gate applies uniformly to both edit and delete (frozen = no mutations), author-only (room-admin delete is Round 11 scope), reply-target validation on `message:send` introduces new ack string `"Invalid reply target"`, batch-hydrate reply previews per page with one extra query (same pattern as attachments hydration), bodyPreview raw `.slice(0, 140)` no server ellipsis, on-disk attachment unlink on delete (carry-over from Round 8 — first round to actually address it). Three shared files grow: `message.ts` (ReplyPreview, EditMessageRequest, MessageDeletedPayload, extended Message + SendMessagePayload), `socket.ts` (two new ServerToClient events), `api-contract.md` (new `## Message Endpoints` section + message:send schema extension + two new socket event blocks + editedAt/replyTo documented on `GET /api/rooms/:id/messages`). No agent / docker / env / master-plan changes; no new library choices. 24-scenario BE smoke spec'd (reply send, edit, delete, author gate, DM ban gate, non-member 404, reply-target-in-other-room validation, attachment unlink + cascade, reply-target-deleted → replyTo: null behavior, unread decrement after delete). FE spec covers hover toolbar, inline edit, delete confirmation dialog, reply chip in composer, reply quote rendering, edited indicator, multi-tab socket sync, and the `replyTarget` state lifted to `RoomViewComponent`. One open note for implement: verify `emitToRoom` is already generic over `ServerToClientEvents` (Round 12 confirmed `emitToUser` is — expectation is yes; if not, widen it, don't cast).
