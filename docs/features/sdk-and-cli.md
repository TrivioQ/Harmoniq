# Feature: SDK & CLI

## Overview

The Harmoniq Client SDK (`@harmoniq/client`) provides a zero-dependency JS client for fetching, validating, and reporting health metrics for remote modules. It integrates tightly with the Registry via ETag caching and fallback logic.
The Harmoniq CLI (`@harmoniq/cli`) provides a command-line interface for deploying, promoting, and validating modules from CI/CD pipelines.

## Requirements

| ID     | Requirement                               | Status    |
| ------ | ----------------------------------------- | --------- |
| SDK-01 | Fetch manifests via ETag caching          | Completed |
| SDK-02 | Stale-while-revalidate fallback mechanism | Completed |
| SDK-03 | Module load health reporting              | Completed |
| CLI-01 | CLI authentication (API Key)              | Completed |
| CLI-02 | CI/CD module deployment and validation    | Completed |
| CLI-03 | Promotion between environments            | Completed |

## Architecture Notes

- The SDK utilizes standard `fetch` APIs without any external dependencies to keep the bundle footprint as small as possible.
- The CLI uses `commander` for command parsing and executes REST API calls against the Registry container.

## Breaking Changes

None.

## Change History

### 2026-10-08 — Unimplemented CLI commands fail instead of faking success

**Type:** bug fix
**PR / Branch:** feat/m0-safety-foundations
**Refs:** PRO-04, VAL-01; product-analysis §3.8

#### What changed

- `rollback`, `promote`, `validate`, `login` and `whoami` previously printed success and exited 0 without calling the registry. They now print "not implemented yet. Nothing was changed." and exit 1 until real implementations land (M1.5).
- Default `--registry-url` is `http://localhost:4000` (was the dashboard port).

#### Why

A CI pipeline or incident runbook relying on `harmoniq rollback` would believe a rollback happened when it did not.

#### Testing

`cli.test.ts` asserts each command exits 1 and never logs success.

### 2026-09-13 — Initial Implementation

**Type:** feature
**Refs:** SDK-01, CLI-01

#### What changed

- Initialized `@harmoniq/client` package with `HarmoniqClient` implementation.
- Initialized `@harmoniq/cli` package providing `deploy`, `rollback`, `promote`, and `validate` commands.
- Configured build pipelines utilizing `tsup` for dual ESM/CJS exports.
- Added comprehensive Vitest test coverage for the SDK and CLI command logic.

#### Why

Delivers the core developer tooling to allow developers to publish modules into Harmoniq workspaces and consume them programmatically.

#### Testing

- Both packages achieve 100% test success via `pnpm test`.
- Included mocking via `msw` to eliminate flakiness against live registries.
