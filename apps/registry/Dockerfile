# Harmoniq registry. Build from the repository root:
#   docker build -f apps/registry/Dockerfile -t harmoniq/registry .
# The same image runs migrations (see docker/docker-compose.yml, service `migrate`).
FROM node:20-alpine AS base
# Prisma's query engine needs OpenSSL on Alpine.
RUN apk add --no-cache openssl && corepack enable
ENV HUSKY=0
WORKDIR /repo

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@harmoniq/registry...

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build --chown=node:node /repo /repo
USER node
WORKDIR /repo/apps/registry
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:4000/health || exit 1
CMD ["node", "dist/index.js"]
