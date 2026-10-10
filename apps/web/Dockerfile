# Harmoniq dashboard (Next.js standalone server). Build from the repository root:
#   docker build -f apps/web/Dockerfile -t harmoniq/web .
FROM node:20-alpine AS base
RUN corepack enable
ENV HUSKY=0 NEXT_TELEMETRY_DISABLED=1
WORKDIR /repo

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@harmoniq/web...

FROM node:20-alpine AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
# Standalone output mirrors the monorepo layout (outputFileTracingRoot = repo root).
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:3000/en/auth/login >/dev/null || exit 1
CMD ["node", "apps/web/server.js"]
