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

### 2026-10-09 — Local overrides, preview environments, `harmoniq doctor` (M2.6)

**Type:** feature
**PR / Branch:** feat/m2-delivery
**Refs:** VAL-01 (c); product-analysis §5.6

#### What changed

- SDK: opt-in developer overrides (`allowOverrides`; query `?harmoniq-override=name@url`, `localStorage`, option), `overrideActive` event, http(s)-only; `environmentFromQuery` for preview links; `getScriptTag` omits empty integrity.
- Registry: preview environments (`deploy` with `ephemeral: { ttlHours }`, workspace switch `allowEphemeralEnvironments`, host `previewUrlTemplate`, hourly expiry job that also drops caches and published copies); `PATCH` workspace and host app.
- CLI: `deploy --preview-ttl`, `harmoniq doctor`. Action: `preview-ttl-hours` input, `preview-url` output.
- Fix: manifest publishing used `singletonSeconds`, which would drop the second publish of a burst; now `singletonKey` only.

#### Testing

Client (4 new), registry `previews.test.ts` (7). `doctor` run against a live registry with a real bundle: all checks pass, and a missing expose is reported (exit 2). After 3 rapid deploys the CDN copy caught up within ~2s.

### 2026-10-09 — Build plugin and GitHub Action (M2.5)

**Type:** feature
**PR / Branch:** feat/m2-delivery
**Refs:** VAL-01, DEP-01 (exposes); product-analysis §5.3

#### What changed

- New `@harmoniq/build-plugin` (unplugin 3, ESM): `harmoniq.vite|webpack|rspack|rollup|esbuild({...})` computes the remote entry's SRI after `writeBundle`, reads `exposes` from `mf-manifest.json`, and deploys in CI; `harmoniqDeploy()` for custom pipelines.
- New composite action `actions/deploy` (deploy or promote via the CLI, outputs, job summary, CLI exit codes).
- Shared `scripts/tsup/nodeResolve.ts` for bundling workspace packages in Node builds (works around a parent-directory Yarn PnP manifest), now used by the CLI and the build plugin.

#### Testing

`deploy.test.ts` (5): no network outside CI, exact deploy request incl. exposes and commit, failures fail the build, Vite hook. The action's script was run against a live registry with the built CLI: deploy and promote succeed with outputs and summary; a frozen target exits 4.

### 2026-10-09 — SDK correctness: one poll loop, real events, SSR-safe React, no credentials

**Type:** bug fix
**PR / Branch:** feat/m1-core-loop
**Refs:** CAN-09, CAN-10, SRI-01, SRI-02, ADP-01–ADP-04, DX-05; product-analysis §4.10–§4.15

#### What changed

- Reads the schemaVersion 2 manifest (modules array) and rejects other formats.
- `init()` is idempotent: one shared load and a single poll loop, cleared by `destroy()` (previously every call, including every `useRemoteModule`, started another interval).
- Exponential backoff with jitter after failed polls; last manifest kept; `error` event and `getError()`.
- `manifestUpdate` fires only when content changes; `variantAssigned` on first assignment and changes only. Event names exported as `EVENTS` so adapters cannot drift (the React and Vue adapters listened to `manifestUpdated`, which was never emitted).
- React: `useSyncExternalStore`, renders during SSR, `fallback` prop, `useManifest` / `useHarmoniqError`. Vue and Angular adapters rebuilt on the same model.
- `getScriptTag` escapes attribute values.
- Removed: the `apiKey` option (browsers must not hold keys) and `reportModuleLoad` / `reportModuleError`, which posted to an endpoint that does not exist. Health reporting returns with M3.2.

#### Testing

`client.test.ts` (10, fake timers: single loop, backoff schedule, ETag revalidation, events, escaping, no credentials) and `react.test.ts` (4, server rendering). Verified the built SDK against a running registry.

#### Breaking changes

Manifest format v2 only; `apiKey`, `reportModuleLoad`, `reportModuleError` removed; React hook results add `version`.

### 2026-10-09 — Real CLI: deploy, promote, rollback, validate, login, manifest

**Type:** feature
**PR / Branch:** feat/m1-core-loop
**Refs:** PRO-04, VAL-01 (a, b), DEP-05 (output); product-analysis §3.8

#### What changed

- All commands call the registry; the "not implemented" stubs are gone.
- `deploy --release` (`--version` is reserved by the CLI), `--file` computes SRI locally, `--validate`, `--dry-run`, `--commit` from CI env, repeatable `--meta`.
- `rollback` (previous / `--to` / `--version-id`), `promote --from --to`, `validate`, `login` (verifies, saves `~/.harmoniq/config.json` with mode 0600), `whoami`, `manifest get|pull`.
- Settings precedence: flag → env → profile → default. Documented exit codes (0–5).
- Fixed the `bin` entry (pointed at a file the build never produced). `@harmoniq/core` is bundled via `tsup.config.ts`, with a resolver plugin so builds work even when a stray Yarn PnP manifest exists in a parent directory.

#### Testing

`cli.test.ts` (17 tests, msw): request bodies, every exit code, no success output on failure, profile file permissions and precedence. `scripts/e2e-core-loop.sh` runs the built CLI against a live registry (13 checks).

#### Breaking changes

`deploy --version-id` is now `--release`; `--workspace` moved to a global option.

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
