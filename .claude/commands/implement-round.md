You are implementing Round $ARGUMENTS. Read `plans/round-N/orchestrator.md`, `plans/round-N/backend.md`, and `plans/round-N/frontend.md` first.

## Phase 1 — Orchestrator (you, main agent)
Execute every task in `plans/round-N/orchestrator.md` yourself:
- Update `/shared/types/*.ts`
- Update `/shared/api-contract.md`
- Update agent descriptions or CLAUDE.md files if the round calls for it
- Anything else in the orchestrator task file

When done, write `plans/round-N/summary-orchestrator.md` with sections:
- **Built**, **Deviations**, **Deferred**, **Next round needs to know**, **Config improvements**

**Then pause.** Report to the user what changed in `/shared/` and ask to proceed to Phase 2. Do not dispatch subagents until the user confirms.

## Phase 2 — Backend + Frontend (parallel subagents)
After user approval, dispatch two agents **in the same message** so they run in parallel:

1. **`backend-developer`** — prompt points it at:
   - Its task file: `plans/round-N/backend.md`
   - `backend/CLAUDE.md` for conventions
   - Updated `/shared/api-contract.md` and `/shared/types/` (do not modify)
   - Instruction to end with `plans/round-N/summary-backend.md` (sections: Built / Deviations / Deferred / Next round needs to know / Config improvements)

2. **`frontend-developer`** — same pattern with:
   - Task file: `plans/round-N/frontend.md`
   - `frontend/CLAUDE.md` for conventions
   - `frontend/docs/DESIGN_SYSTEM.md` + design-system skill
   - Instruction to end with `plans/round-N/summary-frontend.md`

## Phase 3 — Review
When both subagents complete, read all three summary files and report:
- **Built**: consolidated bullet list of what shipped
- **API deviations**: anything the orchestrator may need to patch into `/shared/`
- **Config improvements**: consolidated proposals from all three summaries — present as follow-up changes for the user to accept or reject

Stop after the report — do not auto-apply config changes.
