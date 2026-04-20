# ── Build stage ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS build

RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /app/frontend

COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY frontend/ ./
COPY shared/ /app/shared/
RUN pnpm build

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM nginx:alpine

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/frontend/dist/frontend/browser /usr/share/nginx/html

EXPOSE 80
