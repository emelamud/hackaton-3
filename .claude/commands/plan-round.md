You are planning Round $ARGUMENTS. If no argument was passed, detect the next round: scan `plans/` for the highest existing `round-N/` folder and plan N+1.

## Timing (mandatory)
Before reading anything else, run:
```
date +"%Y-%m-%d %H:%M:%S %z"
```
Record the output as `T_start`. Also record its epoch form via a second Bash call: `date +%s` → `T_start_epoch`. You'll use both at the end of the command. Do NOT skip this step — the timelog is required.

## Precondition check
Before reading inputs, run `git status --porcelain` and `git log -1 --pretty=%s`. If the working tree has uncommitted changes or the last commit does not appear to cover round N-1, ask the user whether to proceed and wait for confirmation before continuing.

## Inputs to read first
1. `requirements.txt` — full chat app spec
2. `plans/master-plan.md` — find the target round's high-level bullets and deliverable
3. For each role (orchestrator, backend, frontend), read `plans/round-{N-1}/{role}_work_summary.md` if it exists — these are the compacted context from the previous round
4. `.claude/agents/backend-developer.md`, `.claude/agents/frontend-developer.md` — stack assumptions
5. `shared/api-contract.md`, `shared/types/` — current contract state

## What to produce
Write three task files in `plans/round-N/`:
- `orchestrator_tasks.md`
- `backend_tasks.md`
- `frontend_tasks.md`

Each file follows the structure used in `plans/round-1/orchestrator_tasks.md`:

- `# Round N — [Role] Tasks`
- `## Goal` — one-sentence deliverable
- `## Dependencies` — references to `/shared/` files, CLAUDE.md files, design system; for BE and FE include the "do not modify /shared/" reminder
- `## Tasks` — numbered sections (`### 1. Task name`) with bullet sub-details (file paths, specific libs, patterns from agent descriptions)
- `## Wrap-up` — instruction to write `plans/round-N/{role}_work_summary.md` with sections: **Built**, **Deviations**, **Deferred**, **Next round needs to know**, **Config improvements**

## Rules for task content
- Orchestrator owns `/shared/` (types + api-contract.md) and any cross-cutting doc changes
- BE and FE read `/shared/` but never modify it
- Match library choices already in agent descriptions (Drizzle, Socket.io, Material M3, ReactiveFormsModule, etc.)
- Reuse existing patterns — reference files that already exist rather than proposing new abstractions
- If the previous round's "Next round needs to know" section flags a decision, honor or address it

## Before writing
Ask clarifying questions if anything is ambiguous (scope cuts, library choice for a new feature, etc.). Otherwise proceed without questions.

## After writing — append to `time_log.md`
1. Run `date +"%Y-%m-%d %H:%M:%S %z"` → record as `T_end`. Run `date +%s` → `T_end_epoch`.
2. Compute `duration_seconds = T_end_epoch - T_start_epoch`. Format as `XhYmZs` (omit empty leading units — e.g. `23m44s`, `2h5m10s`, `47s`).
3. If `time_log.md` does not exist at the project root, create it with a single `# Time Log` header line followed by a blank line.
4. Look for an existing `## Round N` section in `time_log.md`. If absent, append one. Under it, append a `### Planning — /plan-round N` block using this exact template:

```markdown
### Planning — `/plan-round N`
- Started:  <T_start>
- Finished: <T_end>
- Wall time: <formatted duration>
- Output: `plans/round-N/{orchestrator,backend,frontend}_tasks.md`
- Notes: <one short line — e.g. "locked N design decisions; scope cuts: X, Y" or "straightforward; no open questions">
```

Use `Edit` (append to end of file) rather than `Write` so prior rounds' entries are preserved.

## After writing — user-facing summary
Report a short summary (bullet list of tasks per role) and stop. Do not start implementation — that's `/implement-round`.
