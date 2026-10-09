# 0008 — One data model, two stores (embedded local, shared hosted)

**Status:** Accepted · **Date:** 2026-08-17 · **Deciders:** Architecture

## Context

SoloW must run both as a local single-user tool and as a hosted multi-user service
(see [0002](./0002-technology-stack.md)). Local use favours a zero-setup embedded store;
hosted use requires a shared database that supports many users and Workspaces. Maintaining
two separate data models would risk divergence and double the work.

## Decision

Use **one conceptual data model** backed by **two interchangeable stores**: a lightweight
**embedded store** for local deployment and a **shared database** for hosted deployment. The
store is selected by configuration; the model, and therefore all features, are identical
across both.

## Considered options

- **Embedded store only** — Rejected: cannot support hosted multi-user use.
- **Shared database only** — Rejected: too heavy for a zero-setup local experience.
- **Two models, one per mode** — Rejected: divergence risk and duplicated effort.
- **One model, two stores (chosen)** — identical behaviour across modes with the right store
  for each.

## Consequences

- Positive: identical features and domain model in both deployment modes (product NFR-13);
  trivial local start; scalable hosted operation.
- Negative: the data-access layer must support both stores cleanly; more configuration
  surface (risk R-6).
- Realises [F16](../features/F16-platform-deployment.md) and the
  [deployment view](../architecture/07-deployment-view.md).

## Review (2026-10-09)

The one-month review ([Conventions](../CONVENTIONS.md#maintenance)), held late, against the code
at version 0.21.0.

**Verdict: holds as a design constraint; only one of the two stores exists.** SQLite is the only
store wired (`packages/db/drizzle.config.ts`); `createDb()` refuses
`SOLOW_DB_DRIVER=postgres` ("not wired in v1"). Hosting, and
with it the shared store, is Later under [0031](./0031-focus-on-the-solo-power-user.md). The
schema has kept to one model scoped by Workspace, so the decision is still cheap to honour.
