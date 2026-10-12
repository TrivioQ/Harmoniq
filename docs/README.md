# Harmoniq Documentation

> Open-source Micro Frontend Control Plane — Apache 2.0

## Document Index

| Document                                                         | Description                                                                             |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [requirements.md](./requirements.md)                             | Full product requirements (all functional & non-functional)                             |
| [architecture.md](./architecture.md)                             | Architecture Decision Records (ADRs) — why we made each technical choice                |
| [implementation-plan.md](./implementation-plan.md)               | Phased build plan with task checklists (Phases 0–9)                                     |
| [database-schema.md](./database-schema.md)                       | Complete Prisma/PostgreSQL schema reference with RLS details                            |
| [api-reference.md](./api-reference.md)                           | REST API endpoint documentation (implemented endpoints; [openapi.json](./openapi.json)) |
| [sdk.md](./sdk.md)                                               | `@harmoniq/client` SDK guide                                                            |
| [cli.md](./cli.md)                                               | `@harmoniq/cli` command reference                                                       |
| [self-hosting.md](./self-hosting.md)                             | Deploying and operating a Harmoniq instance                                             |
| [multi-tenancy-gap-analysis.md](./multi-tenancy-gap-analysis.md) | Tenant model and tenant admin review (2026-10-11), input to Phase 9                     |
| [schema/](./schema/)                                             | JSON Schemas for the manifest and `harmoniq.yaml`                                       |
| [features/](./features/)                                         | Per-feature docs with design context, requirements traceability, and change history     |

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

| Prefix    | Area                          | Prefix | Area                                  |
| --------- | ----------------------------- | ------ | ------------------------------------- |
| `MAN`     | Manifest system               | `SSO`  | Single sign-on (OIDC, SAML), SCIM     |
| `VER`     | Versioning & deployment       | `RBAC` | Module-level RBAC (team ownership)    |
| `CAN`     | Canary releases               | `SRI`  | SRI enforcement in the SDK            |
| `MT`      | Multi-tenancy & isolation     | `IMP`  | Import map generation                 |
| `KEY`     | API key management            | `ADP`  | Framework adapters                    |
| `AUD`     | Audit log                     | `OAS`  | OpenAPI export                        |
| `GC`      | Garbage collection            | `SYS`  | SystemJS support                      |
| `WHK`     | Webhook events                | `PLN`  | Plans, quotas                         |
| `PRO`     | Environment promotion         | `DX`   | Developer experience                  |
| `HST`     | Host app scoping              | `APR`  | Change approvals                      |
| `DEP`     | Module dependency declaration | `ORG`  | Organizations                         |
| `VAL`     | Pre-deploy validation gates   | `IaC`  | GitOps / infrastructure as code       |
| `RL`      | Manifest rate limiting        | `INST` | Instance administration               |
| `ALT`     | Alert rules                   | `BYOB` | Bring-your-own-bucket storage         |
| `DIFF`    | Manifest diff                 | `TLC`  | Tenant lifecycle (Phase 9)            |
| `SNAP`    | Manifest snapshots            | `PPL`  | People & invitations (Phase 9)        |
| `ENV-FRZ` | Environment freeze            | `POL`  | Organization policy (Phase 9)         |
| `HLT`     | Module health scoring         | `DOM`  | Verified domains (Phase 9)            |
| `STG`     | Staged rollout                | `USG`  | Usage metering (Phase 9)              |
| `ADR`     | Architecture Decision Record  | `SES`  | Identity & session security (Phase 9) |
|           |                               | `TAD`  | Tenant admin dashboard (Phase 9)      |
