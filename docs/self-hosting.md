# Self-Hosting Harmoniq

Harmoniq is designed to be easily self-hostable within your own infrastructure. The minimal footprint requires only a PostgreSQL database and Node.js environments for the Registry API and Web Dashboard.

## Prerequisites

- **PostgreSQL 15+**: Required for both primary data storage and `pg-boss` background job queues.
- **Node.js 20+** or **Docker**

## Environment Variables

### Registry API (`apps/registry`)

| Variable        | Description                                  |
| --------------- | -------------------------------------------- |
| `DATABASE_URL`  | PostgreSQL connection string                 |
| `JWT_SECRET`    | Secret key used to sign Auth tokens          |
| `PORT`          | Port for the API to listen on (default 3001) |
| `NODE_ENV`      | Should be `production`                       |
| `CACHE_ADAPTER` | `memory` or `redis`                          |
| `REDIS_URL`     | (Optional) Required if `CACHE_ADAPTER=redis` |

### Web Dashboard (`apps/web`)

| Variable                   | Description                                    |
| -------------------------- | ---------------------------------------------- |
| `NEXT_PUBLIC_REGISTRY_URL` | Public URL pointing to your deployed Registry  |
| `NEXTAUTH_URL`             | Public URL pointing to this dashboard          |
| `NEXTAUTH_SECRET`          | Secret for encrypting NextAuth session cookies |

## Docker Compose Setup

The easiest way to get started is using `docker-compose`.

```yaml
version: '3.8'

services:
  db:
    image: postgres:15-alpine
    environment:
      POSTGRES_USER: harmoniq
      POSTGRES_PASSWORD: supersecretpassword
      POSTGRES_DB: harmoniq
    ports:
      - '5432:5432'
    volumes:
      - pgdata:/var/lib/postgresql/data

  registry:
    build:
      context: .
      dockerfile: apps/registry/Dockerfile
    environment:
      DATABASE_URL: postgresql://harmoniq:supersecretpassword@db:5432/harmoniq?schema=public
      JWT_SECRET: generate_a_secure_random_string
      PORT: 3001
      NODE_ENV: production
      CACHE_ADAPTER: memory
    ports:
      - '3001:3001'
    depends_on:
      - db

  web:
    build:
      context: .
      dockerfile: apps/web/Dockerfile
    environment:
      NEXT_PUBLIC_REGISTRY_URL: http://registry:3001
      NEXTAUTH_URL: http://localhost:3000
      NEXTAUTH_SECRET: generate_a_secure_random_string
    ports:
      - '3000:3000'
    depends_on:
      - registry

volumes:
  pgdata:
```

Run `docker-compose up -d` and the system will boot. Background jobs and queue schemas are automatically initialized by the Registry upon startup.
