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
docker-compose.yml
```

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
