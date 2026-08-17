# Implementation Plan: [FEATURE NAME]

**Feature slug**: `[feature-name]`
**Feature flag**: `ff-[feature-name]` (default: OFF)
**Branch**: `feat/[feature-name]`
**Date**: [DATE]
**Spec**: [link to spec.md]
**RFC PR**: [link — must be merged before implementation PR is opened]

**Note**: This template is filled in by the `/speckit-plan` command. Stack rows
and paths come from the project constitution (`.specify/memory/constitution.md`)
and the installed preset — never invent a technology the project does not use.

---

## Summary

[Extract from feature spec: primary requirement + chosen technical approach in 2–3 sentences.]

---

## Stack Reference

> Fill from the constitution / repo scan output. Delete rows that do not
> apply to this project.

| Layer | Technology | Package / Path |
|---|---|---|
| Runtime / package manager | [e.g. Node + pnpm, Bun] | [monorepo root] |
| Web | Next.js (App Router) | [e.g. `apps/web` or repo root] |
| API surface | [Server Actions / Route Handlers / tRPC / GraphQL] | [path] |
| DB + ORM | [e.g. Postgres + Drizzle / Prisma] | [path] |
| Validation | [e.g. Zod] | [path] |
| Auth | [e.g. BetterAuth / Auth.js / Clerk] | [path] |
| Cache | [e.g. Redis / Next.js cache only] | [path] |
| Background jobs | [e.g. queue / workflow engine / none] | [path] |
| Observability | [error tracking / tracing / metrics tools] | [path] |
| Deploy | [e.g. Vercel / Kubernetes + GitOps] | [path] |
| Secrets | [e.g. platform env vars / secret manager] | [path] |

---

## File Map

> Concrete files this feature adds or touches, using this project's real layout.

```text
[db package]/schema/[feature-name].ts          ← table(s) / model(s)
[shared package]/schemas/[feature-name].ts     ← validation contracts + DTOs + error codes

[api layer]/
├── [feature-name] procedures / actions / handlers
├── dal/[feature-name].ts                      ← server-only reads/writes, cache
└── services/[feature-name].ts                 ← pure business logic, Result<T,E>

[web app]/
├── app/.../[feature-name]/
│   ├── page.tsx                               ← RSC, flag guard
│   ├── loading.tsx                            ← skeleton
│   └── error.tsx                              ← error boundary + capture
└── components/features/[feature-name]/        ← client components

[e2e dir]/[feature-name]/
├── happy.spec.ts
└── isolation.spec.ts                          ← @critical tenant/owner isolation
```

---

## Service Interaction Map

> **Mandatory sweep.** One row per service in the Stack Reference — plus any
> external API — with an explicit verdict. "Not touched" requires a reason;
> a blank row is an incomplete plan, and `verify` will flag interactions in
> code that were never declared here (and vice versa).

| Service | Touched? | Interaction | Changes needed | If this service is down/slow |
|---|---|---|---|---|
| Frontend (web app) | yes/no | [render / mutate / subscribe] | [components, routes] | [degraded UX behavior] |
| API surface | yes/no | [new endpoints / modified] | [routers, actions] | [error contract] |
| Database | yes/no | [read / write / migrate] | [tables, indexes] | [failure behavior] |
| Cache | yes/no | [read / write / invalidate] | [keys, TTLs — must match §8] | [fallback to DB? stampede risk?] |
| Background jobs / workers | yes/no | [enqueue / consume / schedule] | [jobs, workflows] | [retry policy, DLQ, user impact] |
| External APIs (LLM, email, payment, …) | yes/no | [call, per provider] | [client, env vars, secrets] | **timeout / retry / fallback / cost cap — required** |
| Auth / session | yes/no | [role checks, new scopes] | [guards] | [lockout behavior] |
| Realtime (SSE / websockets / push) | yes/no | [emit / subscribe] | [channels, events] | [reconnect / missed-event behavior] |
| Analytics / events | yes/no | [emit] | [event names] | [fire-and-forget — never blocks] |
| File / object storage | yes/no | [upload / serve] | [buckets, limits] | [failure behavior] |

Rules:
- Every "yes" row must be reflected in the numbered sections below (schema,
  API, cache, jobs) and in the Testing Plan — an interaction without a test
  for its failure mode is undeclared risk.
- Every external-API row must name its timeout, retry budget, fallback
  behavior, and marginal cost — "we call OpenAI" is not a plan.
- Delete rows for services this project does not have; never leave a row
  ambiguous.

---

## 1. Data Schema

**Location**: [db package]/schema/[feature-name].ts

| Table / model | Key columns | Indexes | Relations |
|---|---|---|---|
| `[feature_snake]` | `id pk`, `[tenant key — e.g. organizationId / ownerId, per constitution]`, `…`, `createdAt`, `updatedAt` | `([tenant key], createdAt desc)` | [relations] |

**Migration notes**:
- Forward-compatible: [yes — add-only / no — expand-contract required]
- Rollback: flag OFF → behavior unchanged
- Generated migrations only — no handwritten SQL unless the constitution allows it

---

## 2. Validation Contracts

**Location**: [shared package]/schemas/[feature-name].ts

| Schema | Kind | Used by |
|---|---|---|
| `Create[Feature]Input` | input | create |
| `Update[Feature]Input` | input | update |
| `Get[Feature]Input` | input | get |
| `List[Feature]Input` | input | list |
| `[Feature]Dto` | output | all reads |
| `[Feature]ListDto` | output | list |
| `[Feature]ErrorCode` | const literal | API + services |

---

## 3. API Surface

> Server Actions, Route Handlers, or RPC procedures — whichever this project uses.

| Endpoint / action | Type | Input | Output | Min role | Flag guard |
|---|---|---|---|---|---|
| `[feature].get` | query | `Get[Feature]Input` | `[Feature]Dto` | [role] | yes |
| `[feature].list` | query | `List[Feature]Input` | `[Feature]ListDto` | [role] | yes |
| `[feature].create` | mutation | `Create[Feature]Input` | `[Feature]Dto` | [role] | yes |
| `[feature].update` | mutation | `Update[Feature]Input` | `[Feature]Dto` | [role] | yes |
| `[feature].delete` | mutation | `Get[Feature]Input` | void | [role] | yes |

Tenant key comes from the session — never from client input.

---

## 4. DAL

**Location**: [api layer]/dal/[feature-name].ts

| Function | Cache key | Invalidated by |
|---|---|---|
| `get[Feature]ById` | `[feature]:[tenant]:{tenantId}:{id}` TTL [ttl] | update, delete |
| `list[Feature]s` | `[feature]s:[tenant]:{tenantId}` TTL [ttl] | create, update, delete |
| `create[Feature]Record` | — | invalidates list |
| `update[Feature]Record` | — | invalidates one + list |
| `delete[Feature]Record` | — | invalidates one + list |

---

## 5. Services

**Location**: [api layer]/services/[feature-name].ts

| Function | Returns | Purpose |
|---|---|---|
| `buildCreate[Feature]Payload` | `Result<DBPayload>` | validate + transform input |
| `can[Feature]` | `boolean` | pure authorization lookup |
| `validate[Feature]State` | `Result<void>` | state machine guard |

Zero infrastructure imports. `Result<T,E>` — no `throw` on business errors.

---

## 6. Feature Flag

| Property | Value |
|---|---|
| Name | `ff-[feature-name]` (follow the project's registry naming exactly) |
| Registered in | [path to the project's flag registry — the key MUST exist there before merge] |
| Default | OFF |
| Granularity | [global / tenant / user / percentage — must be supported by the project's flag system] |
| Kill switch | [propagation time] |
| Guard locations | Every API entry point + RSC page.tsx |
| Planned removal | [date] |

---

## 7. Authorization Matrix

> Use this project's real role set (from the constitution), not a canned one.

| Action | [role 1] | [role 2] | [role 3] | [role 4] |
|---|---|---|---|---|
| read | ✓ | ✓ | ✓ | ✓ |
| create | ✓ | ✓ | ✓ | — |
| update | ✓ | ✓ | ✓ | — |
| delete | ✓ | ✓ | — | — |

---

## 8. Cache Strategy

| Key | Data | TTL | Invalidated by |
|---|---|---|---|
| `[feature]:[tenant]:{tenantId}:{id}` | Single DTO | [ttl] | update, delete |
| `[feature]s:[tenant]:{tenantId}` | List (first page) | [ttl] | create, update, delete |

**Blast radius**: state explicitly what one write invalidates. A single-item
mutation must not evict a cache shared by all users/tenants.

---

## 9. Background Jobs

| Effect | Tool | ID template (idempotent) | Trigger |
|---|---|---|---|
| [side effect description] | [project's queue/workflow tool] | `[feature]-{id}` | [mutation] |

---

## 10. Observability Plan

> Every row here must be VERIFIABLE after implement — `/speckit-verify` will
> check that these signals are actually emitted, not just planned.

| Signal | Attribute / name | Tool |
|---|---|---|
| Span / timing | `[tenant].id`, `user.id`, endpoint name | [tracing tool] |
| Structured log | tenant id, user id, correlation id, durationMs | [log tool] |
| Analytics event | `[feature].created`, `[feature].updated` | [analytics sink] |
| Error capture | captureException | error.tsx + catch |
| Alert | error_rate / p95 thresholds from spec Rollback Thresholds | [alerting tool] |

---

## 11. Testing Plan

| Type | File | Tool | Critical |
|---|---|---|---|
| Unit (services) | [test dir]/[feature]/services.test.ts | [test runner] | — |
| Integration (DAL) | [test dir]/[feature]/dal.test.ts | [test runner + real DB] | cross-tenant isolation |
| Integration (API) | [test dir]/[feature]/procedures.test.ts | [test runner + real DB] | authorization, idempotency |
| E2E happy path | [e2e dir]/[feature]/happy.spec.ts | [e2e tool] | — |
| E2E @critical | [e2e dir]/[feature]/isolation.spec.ts | [e2e tool] | **blocks merge** |

---

## 12. Security Checklist

- [ ] Tenant key extracted from the server session — never from client input
- [ ] Every DAL query filters by the tenant key in `where`
- [ ] Authorization checked in every mutation (`can[Feature](role, action)` or equivalent)
- [ ] Rate limit on writes: `rl:[feature].[action]:{userId}`
- [ ] Generated migrations only — no handwritten SQL unless constitution allows
- [ ] Secrets via the project's validated env module — no bare `process.env`
- [ ] Sensitive fields absent from DTO schemas, cache values, and log/span attributes

---

## 13. Open Questions

1. [Decision before implementation — e.g. "Soft-delete or hard-delete?"]
2. [Decision before implementation]

*(Delete if none.)*

---

## 14. Complexity Justification

> Fill only if a hard constraint is intentionally violated.

| Violation | Why needed | Simpler alternative rejected because |
|---|---|---|
| [violation] | [reason] | [why the constrained path was insufficient] |
