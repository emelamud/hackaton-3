# Backend Conventions

## Folder Structure
```
src/
  db/
    schema.ts       # Drizzle ORM table definitions
    migrations/     # Generated SQL migration files (commit these)
    index.ts        # Drizzle db instance (import this everywhere)
    pool.ts         # pg Pool (used by db/index.ts only)
  errors/
    AppError.ts     # Custom error class with statusCode
  middleware/
    auth.ts         # JWT verification → req.user
    errorHandler.ts # Catches AppError, formats JSON response
    validate.ts     # Zod validation helper
  routes/           # Thin controllers: parse, validate, call service, respond
  services/         # Business logic and DB queries (no req/res)
  types/            # Local types not in /shared
  index.ts          # Express app entry point
```

## Drizzle ORM
- Define tables in `src/db/schema.ts` using `drizzle-orm/pg-core`
- `pnpm db:generate` — generate a new migration after schema changes
- `pnpm db:migrate` — apply pending migrations (runs on container startup)
- Always import the db instance: `import { db } from '../db'`
- Use `db.select().from(table).where(...)` style — no raw SQL unless unavoidable

## Route vs Service
- **Routes** (`src/routes/`): `router.post('/path', validate(schema), async (req, res) => { const result = await service.method(req.body); res.json(result); })`
- **Services** (`src/services/`): pure async functions, receive typed args, return typed results, throw `AppError` on domain errors
- Never put DB queries in route handlers; never put req/res in services

## Error Handling
- `AppError(message, statusCode)` — throw from services for known error cases
- `errorHandler` middleware formats: `{ "error": message }` with the correct HTTP status
- Unexpected errors (no statusCode): log stack, return 500 with generic message

## Input Validation
- Define a `zod` schema for every request body and relevant params
- Use a `validate(schema)` middleware wrapper that calls `next(new AppError(..., 400))` on parse failure
- Pass the parsed (typed) data to service methods — never pass raw `req.body`

## Environment Variables
All config lives in `.env` (copied from `.env.example`). Access via `process.env.VAR_NAME` — use a typed `config.ts` module to centralise and validate on startup.
