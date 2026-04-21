# Project Guidelines

## Running the Project
The entire application must be runnable with a single command:
```
docker compose up
```

All services (frontend, backend, database) must be defined in `docker-compose.yml` at the project root.

## Package Manager
Use `pnpm` for all package management.

## Folder Structure
```
/frontend       # Angular application
/backend        # Express API
/shared         # Shared TypeScript types used by both FE and BE
/docker         # Dockerfiles for each service
/plans          # Roadmap + per-round task & summary files
docker-compose.yml
```

## Plans Folder
`/plans` is the source of truth for scope and history — always read it before starting work.
- `plans/master-plan.md` — the full roadmap: numbered rounds, deliverables, and per-role task bullets. Check which rounds are marked ✅ to know what's already shipped.
- `plans/round-N/` — one folder per round, containing:
  - `orchestrator_tasks.md`, `backend_tasks.md`, `frontend_tasks.md` — detailed task files written before the round starts
  - `<role>_work_summary.md` — written after the round: **Built**, **Deviations**, **Deferred**, **Next round needs to know**, **Config improvements**
- When planning a new round, read prior rounds' `_work_summary.md` files for context on deviations and carry-over items (if they have not already been added to the context).

## Port Conventions
- Frontend (Angular): `4300`
- Backend (Express): `3000`
- PostgreSQL: `5432`

## Environment Variables
- Store all environment-specific config in `.env` files
- Never hardcode secrets or connection strings in source code
- Provide a `.env.example` with all required keys but no real values

## Agent Usage
- For frontend tasks, delegate to the **frontend-developer** subagent
- For backend tasks, delegate to the **backend-developer** subagent
- Run FE and BE tasks in parallel when they are independent
- shared folder (containing contracts and types) should be changed by orcestrator agent, either FE or BE developer **cannot** touch it

## Linting & Formatting
- Follow the ESLint and Prettier configuration files in each subproject
- All code must pass linting before being considered complete

## Ignore List
Ignore (unless told otherwise) thoughts.md and contents of prompts folder 
