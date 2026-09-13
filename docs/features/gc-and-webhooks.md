# Feature: Garbage Collection & Webhooks

## Overview
This feature introduces background processing and data lifecycle management into the Harmoniq Registry utilizing `pg-boss`. It provides automated Garbage Collection (GC) for stale module versions and health events, and implements a robust, retry-capable webhook delivery system for workspace events like deployments.

## Requirements
| ID | Requirement | Status |
|---|---|---|
| GC-01 | Soft delete module versions older than configured retention | Completed |
| GC-02 | Hard delete soft-deleted records and orphan objects | Completed |
| GC-03 | Purge transient health events | Completed |
| WHK-01 | Secure webhook payload signing via HMAC SHA-256 | Completed |
| WHK-03 | Configurable delivery retries | Completed |
| WHK-06 | Exponential backoff up to a ceiling limit | Completed |
| WHK-07 | Dead-letter queue for exhausted webhook deliveries | Completed |
| WHK-09 | API endpoint to manually re-enqueue dead letters | Completed |
| ALT-05 | Periodic alert evaluation job | Stubbed |
| STG-02 | Staged rollout progression job | Stubbed |
| STG-04 | Automatic rollback job | Stubbed |

## Architecture Notes
- We selected `pg-boss` as the job queue since it uses Postgres natively, removing the operational burden of maintaining a separate Redis cluster just for queues, keeping the initial deployment footprint small.
- `pg-boss` schema is automatically initialized when the Registry boots up if connected to the primary `DATABASE_URL`.
- Webhook delivery utilizes `pg-boss` native delayed retries (via `startAfter`) for exponential backoff instead of failing the job internally, allowing for precise control and dead-letter tracking in our own schema.

## Breaking Changes
None.

## Change History

### 2026-09-13 — Implemented GC and Webhooks
**Type:** feature
**Refs:** GC-01, GC-02, GC-03, WHK-01, WHK-03, WHK-06, WHK-07, WHK-09
#### What changed
- Installed `pg-boss` into `@harmoniq/registry`.
- Created `app-jobs` plugin to initialize `pg-boss` and register background tasks.
- Implemented `gc.softDelete`, `gc.hardDelete`, and `gc.healthEventPurge` CRON jobs to enforce data retention policies.
- Implemented `webhook.deliver` queue worker with HMAC payload signing and exponential backoff.
- Added `POST /api/workspaces/:workspaceSlug/webhooks/dead-letters/:deadLetterId/retry` route to manually re-queue dead letters.
- Hooked webhook dispatch into the existing `deployRoutes`.
- Stubbed alert and staged rollout jobs (`alert.evaluate`, `rollout.advance`, `alert.auto_rollback`).
#### Why
Data lifecycles must be managed to prevent database bloat. Furthermore, robust webhooks are critical for integrating Harmoniq into existing enterprise ecosystems (e.g. notifying Slack/Teams or triggering E2E tests upon deployment).
#### Testing
- Wrote unit tests for GC job functions to verify Prisma query shapes.
- Wrote unit tests using `msw` for `webhook.deliver` to ensure HTTP success logging, 500 error backoff retries, and dead-letter exhaustion logic function flawlessly.
