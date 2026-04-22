You are implementing Round $ARGUMENTS.

## Preflight
Confirm `backend-developer`, `frontend-developer`, and `frontend-tester` appear in the Agent tool's `subagent_type` list. If any is missing, stop — report which and ask the user to restart the session. Do NOT fall back to `general-purpose`.

Then read `plans/round-N/orchestrator_tasks.md`, `plans/round-N/backend_tasks.md`, and `plans/round-N/frontend_tasks.md`.

## Timing (mandatory — capture at every phase boundary)
Record timestamps at each transition below. Use:
- `date +"%Y-%m-%d %H:%M:%S %z"` for human-readable ISO with offset
- `date +%s` for epoch (for duration math)

Keep these in scratch context as you go:
- `T_overall_start`, `T_overall_end`
- `T_p1_start`, `T_p1_end` (orchestrator phase)
- `T_p2_start`, `T_p2_end` (parallel subagents — wall time)
- `T_ft_start`, `T_ft_end` (frontend tester) — tester self-reports
- `T_p4_start`, `T_p4_end` (consolidated review)
- Per-subagent `T_be_start`, `T_be_end`, `T_fe_start`, `T_fe_end` — subagents self-report (see Phase 2).

Capture `T_overall_start` and `T_p1_start` right now, after the preflight check above has passed and before reading the task files.

## Phase 1 — Orchestrator (you, main agent)
Execute every task in `plans/round-N/orchestrator_tasks.md` yourself:
- Update `/shared/types/*.ts`
- Update `/shared/api-contract.md`
- Update agent descriptions or CLAUDE.md files if the round calls for it
- Anything else in the orchestrator task file

When done, write `plans/round-N/orchestrator_work_summary.md` with sections:
- **Built**, **Deviations**, **Deferred**, **Next round needs to know**, **Config improvements**

Capture `T_p1_end` after writing the summary.

**Then pause.** Report to the user what changed in `/shared/` and ask to proceed to Phase 2. Do not dispatch subagents until the user confirms.

## Phase 2 — Backend + Frontend (parallel subagents)
Capture `T_p2_start` immediately after user approval, right before dispatching.

Dispatch two agents **in the same message** so they run in parallel:

1. **`backend-developer`** — prompt points it at:
   - Its task file: `plans/round-N/backend_tasks.md`
   - `backend/CLAUDE.md` for conventions
   - Updated `/shared/api-contract.md` and `/shared/types/` (do not modify)
   - Instruction to end with `plans/round-N/backend_work_summary.md` (sections: Built / Deviations / Deferred / Next round needs to know / Config improvements)
   - **Timing instruction** (append to the prompt): "At the very start of your work run `date +\"%Y-%m-%d %H:%M:%S %z\"` and save it as `T_start`. At the very end — after the summary is written — run `date` again and save as `T_end`. In the final message you return to me, include a single line at the top: `TIMING: start=<T_start> | end=<T_end>` exactly (no markdown, no other formatting). I will parse this to populate the timelog."

2. **`frontend-developer`** — same pattern with:
   - Task file: `plans/round-N/frontend_tasks.md`
   - `frontend/CLAUDE.md` for conventions
   - `frontend/docs/DESIGN_SYSTEM.md` + design-system skill
   - **Explicit mode**: "You are in **implement mode**. Do not use Playwright MCP. Do not start `ng serve`. Gate before summary with `pnpm build` + typecheck + design-system spot-check."
   - Instruction to end with `plans/round-N/frontend_work_summary.md` — must include the **How to exercise this** section (route + steps + expected state per feature) so the tester can drive from it
   - Same **Timing instruction** as above

When both subagents complete, capture `T_p2_end`. Parse the `TIMING:` line from each subagent's response into `T_be_start` / `T_be_end` / `T_fe_start` / `T_fe_end`. If a subagent forgot to emit the line, fall back to `T_p2_start` / `T_p2_end` for that row and note `(approx)` in the log entry's Notes field.

## Phase 3 — Frontend tester

### 3a. Rebuild + deploy the Docker stack (mandatory)
Phase 2 lands source on disk but doesn't rebuild container images. Run `docker compose up -d --build` in the background to make the deployed app match the code under test, then poll `curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://localhost:4300/` until it returns `200` (cap ~2 minutes). If the rebuild fails or the poll times out, stop and report — do not dispatch the tester against a broken stack. No user confirmation needed; Docker caches unchanged layers, so a no-op rebuild finishes fast.

### 3b. Dispatch the tester
Dispatch **`frontend-tester`** with:
- Round number N
- Pointer to `plans/round-N/frontend_tasks.md` and `plans/round-N/frontend_work_summary.md`
- Instruction to drive the app via Playwright MCP, verify every feature from **How to exercise this**, check console, and write/update `plans/round-N/bugs.md`
- Same **Timing instruction** format — parse its `TIMING:` line into `T_ft_start` / `T_ft_end`

Do not dispatch a fix cycle here. `/fix-bugs N` is a separate command the user runs after reviewing `bugs.md`.

## Phase 4 — Review
Capture `T_p4_start`.

Read all three summary files and report:
- **Built**: consolidated bullet list of what shipped
- **API deviations**: anything the orchestrator may need to patch into `/shared/`
- **Config improvements**: consolidated proposals from all three summaries — present as follow-up changes for the user to accept or reject

Capture `T_p4_end` and `T_overall_end` after the report is written.

Stop after the report — do not auto-apply config changes.

## Phase 5 — Append to `plans/time_log.md`
After Phase 4's report is delivered, append one implementation block to `plans/time_log.md`.

Duration formatting: `XhYmZs`, omit empty leading units (`23m44s`, `2h5m10s`, `47s`).

If `plans/time_log.md` does not exist, create it with `# Time Log` + blank line. If `## Round N` already exists (e.g. from `/plan-round`), append the implementation block under it. If not, append a fresh `## Round N` section with this block inside.

Template (fill in every `<…>`):

```markdown
### Implementation — `/implement-round N`
- Started:  <T_overall_start>
- Finished: <T_overall_end>
- Wall time: <format(T_overall_end - T_overall_start)>

| Phase                   | Agent               | Start             | End               | Duration      | Status |
|-------------------------|---------------------|-------------------|-------------------|---------------|--------|
| Shared types + contract | orchestrator        | <T_p1_start time> | <T_p1_end time>   | <p1 duration> | <✅/⚠️/❌> |
| Backend impl            | backend-developer   | <T_be_start time> | <T_be_end time>   | <be duration> | <status> |
| Frontend impl           | frontend-developer  | <T_fe_start time> | <T_fe_end time>   | <fe duration> | <status> |
| Frontend test           | frontend-tester     | <T_ft_start time> | <T_ft_end time>   | <ft duration> | <status> |
| Wrap-up + review        | orchestrator        | <T_p4_start time> | <T_p4_end time>   | <p4 duration> | <status> |

- Notes: <one or two short lines — tester outcome, bug counts in bugs.md, any deviations the user should know>
```

Notes on the table:
- The "Start" / "End" columns hold ONLY the `HH:MM:SS` part (date is redundant within a single round; full ISO stays on the `Started` / `Finished` lines above the table).
- Status: `✅` success, `⚠️` partial / bounded-retry hit, `❌` failed. For the tester row, `⚠️` if bugs were logged, `✅` if none.
- If a subagent didn't emit `TIMING:`, fall back to the enclosing phase markers and append `(approx)`.

Use `Edit` (append, don't overwrite) so prior rounds' entries stay intact.
