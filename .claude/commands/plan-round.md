You are planning Round $ARGUMENTS. If no argument was passed, detect the next round: scan `plans/` for the highest existing `round-N/` folder and plan N+1.

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

## After writing
Report a short summary (bullet list of tasks per role) and stop. Do not start implementation — that's `/implement-round`.
