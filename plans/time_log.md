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
