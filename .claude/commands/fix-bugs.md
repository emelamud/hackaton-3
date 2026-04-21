You are running a bug-fix iteration for Round $ARGUMENTS.

## Preflight
Confirm `frontend-developer` and `frontend-tester` appear in Agent's `subagent_type` list. If missing, stop and report.

Read:
- `plans/round-N/frontend_tasks.md`
- `plans/round-N/frontend_work_summary.md`
- `plans/round-N/bugs.md` — must exist. If missing, stop and tell the user to run `/implement-round N` first.

Confirm the frontend is reachable at http://localhost:4300. If not, ask the user to start it — do not start it yourself.

Capture `T_overall_start`.

## Phase 1 — User gate
Read `bugs.md` and report to the user:
- Counts per status
- List of `Open` bugs, grouped by Priority, with IDs + titles

Pause and ask: **"Which open bugs should the FE dev attempt? (IDs, `all`, or `none`)"**

If the user says `none`, skip to Phase 4.

## Phase 2 — Fix
Dispatch **`frontend-developer`** with:
- **Explicit mode**: "You are in **fix mode**. Use Playwright MCP to reproduce and verify."
- Bug IDs the user selected
- Artifacts to read: `plans/round-N/bugs.md`, `plans/round-N/frontend_work_summary.md`, `plans/round-N/frontend_tasks.md`
- Instruction: "**Bounded retries — at most 2 focused fix attempts per bug. Do not try too hard.** If still broken after 2 attempts, leave `Open` with updated Notes and move on. Do not widen scope, do not rewrite surrounding code speculatively. Update `bugs.md` statuses per bug. Edit `frontend_work_summary.md` only if a fix shifts behavior described there."
- **Timing instruction**: "At start run `date +\"%Y-%m-%d %H:%M:%S %z\"` as `T_start`; at end as `T_end`. First line of your final message: `TIMING: start=<T_start> | end=<T_end>` verbatim."

Parse the `TIMING:` line into `T_fd_start` / `T_fd_end`.

## Phase 3 — Re-test
Dispatch **`frontend-tester`** with:
- Round number N
- Pointer to the task file, summary, and current `bugs.md`
- Instruction: verify every `Fixed (pending verification)` bug from this iteration; note regressions on adjacent flows; update statuses in `bugs.md` (pass → `Verified`, still failing → `Open` with updated Notes)
- Same **Timing instruction** format as Phase 2

Parse the `TIMING:` line into `T_ft_start` / `T_ft_end`.

## Phase 4 — Append to `time_log.md`
Capture `T_overall_end`. Append under `## Round N` in `time_log.md` (create `## Round N` if missing):

```markdown
### Fix iteration — `/fix-bugs N` (<ISO datetime>)
- Started:  <T_overall_start>
- Finished: <T_overall_end>
- Wall time: <format(T_overall_end - T_overall_start)>

| Phase    | Agent              | Start             | End               | Duration      | Status |
|----------|--------------------|-------------------|-------------------|---------------|--------|
| Fix      | frontend-developer | <T_fd_start time> | <T_fd_end time>   | <fd duration> | <✅/⚠️/❌> |
| Re-test  | frontend-tester    | <T_ft_start time> | <T_ft_end time>   | <ft duration> | <✅/⚠️>   |

- Notes: <IDs attempted, IDs verified, IDs still open, anything else the user should know>
```

Duration formatting: `XhYmZs`, omit empty leading units. Status: `✅` clean, `⚠️` partial / bounded-retry hit, `❌` failed. If user said `none` in Phase 1, omit both rows and add `user skipped fix phase` to Notes.

Use `Edit` (append), don't overwrite.
