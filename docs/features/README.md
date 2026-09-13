# docs/features

This directory contains **one Markdown file per product feature**. Each file serves as the single source of truth for that feature: its requirements, architecture notes, and full change history.

## Why feature docs instead of date-stamped changelogs?

| Date-stamped `docs/changelog/`        | Feature-based `docs/features/`                          |
| ------------------------------------- | ------------------------------------------------------- |
| "What changed on 2026-09-13?"         | "What is enterprise governance and how has it evolved?" |
| Context scattered across many files   | Single file per feature — easy to read and update       |
| AI agents must piece together history | One file gives complete context                         |
| Grows indefinitely                    | Files grow in-place; history is inside each file        |

**Release versioning and semver** are handled by [Changesets](../.changeset/) — that is separate from this directory.

## Structure of each feature file

```
# Feature: <Name>
> Requirement IDs, Status, Phase

## Overview          — what problem it solves, who it's for
## Requirements      — table of requirement IDs with status
## Architecture Notes — design decisions, data model, API contracts
## Breaking Changes  — YES/NO + migration path
## Change History    — dated sections, newest first
  ### YYYY-MM-DD — <short description>
  **Type / PR / Refs**
  #### What changed
  #### Why
  #### Testing
```

## When to create a new feature file

- A **new top-level capability** is being designed or implemented → create `docs/features/<slug>.md`
- Use `_template.md` as the starting point

## When to update an existing feature file

- Iterating on, fixing, or extending an existing feature → append a new dated section to **Change History** (newest at the top)

## Files

| File | Feature | Description | PRs / Status |
|---------|-------------|--------------|
| [Enterprise Governance](./enterprise-governance.md) | Org-level controls, SSO mappings, audit logs, approval policies | Active |
| [Registry Core](./registry-core.md) | Manifest generation, deploy routes, caching, and auth middleware | Active |
| [Web Dashboard](./web-dashboard.md) | Next.js Dashboard UI and OAuth flow | Active |
| [SDK and CLI](./sdk-and-cli.md) | `@harmoniq/client` SDK and `@harmoniq/cli` developer tooling | Active |
| [Garbage Collection & Webhooks](./gc-and-webhooks.md) | Background jobs, data retention, and event webhooks via `pg-boss` | Active |
| [Hardening, Observability & Docs](./hardening-observability-docs.md) | Security, OTel metrics, performance, and documentation | Active |
| [Instance Admin & BYOB Storage](./instance-admin-and-byob-storage.md) | Global system settings and tenant-provided storage (S3/GCS) | Planned |
| [`_template.md`](./_template.md) | Template — copy to start a new feature doc | — |
