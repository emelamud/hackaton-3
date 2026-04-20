# Build stage
FROM node:20-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /app/backend

# Copy package manifests and install all dependencies
COPY backend/package.json backend/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Copy source and compile TypeScript
COPY backend/ ./
RUN pnpm build

# Runtime stage
FROM node:20-alpine AS runtime

WORKDIR /app

# Copy production node_modules and compiled output
COPY --from=builder /app/backend/node_modules ./node_modules/
COPY --from=builder /app/backend/dist ./dist/

# Copy migration SQL files (needed by drizzle migrator at runtime)
COPY --from=builder /app/backend/src/db/migrations ./dist/db/migrations/

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["/entrypoint.sh"]
