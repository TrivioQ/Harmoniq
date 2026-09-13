# Harmoniq Documentation

> Open-source Micro Frontend Control Plane — Apache 2.0

## Document Index

| Document                                           | Description                                                                         |
| -------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [requirements.md](./requirements.md)               | Full product requirements (all functional & non-functional)                         |
| [architecture.md](./architecture.md)               | Architecture Decision Records (ADRs) — why we made each technical choice            |
| [implementation-plan.md](./implementation-plan.md) | Phased build plan with task checklists                                              |
| [database-schema.md](./database-schema.md)         | Complete Prisma/PostgreSQL schema reference with RLS details                        |
| [api-reference.md](./api-reference.md)             | REST API endpoint documentation                                                     |
| [features/](./features/)                           | Per-feature docs with design context, requirements traceability, and change history |

## Quick Navigation

### For new contributors

1. Read [requirements.md](./requirements.md) to understand what we're building
2. Read [architecture.md](./architecture.md) to understand key technical decisions
3. Read [AGENTS.md](../.agents/AGENTS.md) for contribution and documentation rules

### For implementers

1. Check [implementation-plan.md](./implementation-plan.md) for the current phase and open tasks
2. Reference [database-schema.md](./database-schema.md) when touching data models
3. Reference [api-reference.md](./api-reference.md) when implementing or consuming endpoints

### Requirement ID Format

Requirements are referenced throughout the codebase and feature docs as `<AREA>-<NUMBER>`:

| Prefix | Area                         |
| ------ | ---------------------------- |
| `MAN`  | Manifest system              |
| `VER`  | Versioning & deployment      |
| `CAN`  | Canary releases              |
| `MT`   | Multi-tenancy                |
| `KEY`  | API key management           |
| `AUD`  | Audit log                    |
| `GC`   | Garbage collection           |
| `WHK`  | Webhook events               |
| `ADR`  | Architecture Decision Record |
