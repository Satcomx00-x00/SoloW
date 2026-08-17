# F16 — Platform, Deployment & Multi-Tenancy

**Status:** Draft · **Owner:** Product / Operator · **Maturity:** Core / Edge · **Last reviewed:** 2026-08-17

## Summary

GateControl runs as both a local single-user tool and a hosted multi-user service, from one
product. Local deployment is trivial to start; hosted deployment adds shared access, teams,
and multi-tenancy. Users own their compute and data in both modes, with no required cloud
service and no telemetry.

## Jobs served

- **J10 — Operate with confidence.**

## User stories

- As a Solo Power User, I want to run GateControl on my own machine with minimal setup, so I
  can start immediately.
- As a Team Lead, I want a shared, hosted instance my team can use together, so we
  collaborate.
- As an Operator, I want to control who can access which Workspace, so shared use is safe.

## Functional requirements

### Local deployment
- **FR-1** GateControl runs entirely on one machine for a single user, storing its data and
  Worktrees locally.
- **FR-2** Local deployment requires no external service and sends no telemetry
  (product [NFR-5](../product/03-product-requirements.md), [NFR-14](../product/03-product-requirements.md)).

### Hosted deployment
- **FR-3** GateControl runs as a shared, multi-user service using the same product and
  capabilities as local deployment (product [NFR-13](../product/03-product-requirements.md)).
- **FR-4** Hosted deployment supports multiple users organised into Workspaces, with each
  user able to access only the Workspaces they are granted.
- **FR-5** An Operator can manage members and their access to Workspaces.
- **FR-6** Hosted deployment isolates each Workspace's data, work, and secrets from others.

### Common
- **FR-7** The same features behave identically across deployment modes, differing only in
  configuration.
- **FR-8** GateControl is distributed so a user can obtain and run it without a proprietary
  gatekeeper, consistent with its open-source nature.

## Non-functional requirements

- **NFR-1** No feature is available only in one deployment mode except those that are
  inherently multi-user (members and access control).
- **NFR-2** In hosted deployment, access control is enforced on every action, not only in
  the interface (product [NFR-6](../product/03-product-requirements.md)).
- **NFR-3** Moving from local to hosted does not require re-learning the product.

## States & rules

- A Workspace is the unit of tenancy and access in hosted deployment.
- Secrets and Profiles remain Workspace-scoped in both modes.

## Edge cases & failure handling

- If a user loses access to a Workspace, in-flight work they started continues under the
  Workspace's ownership; the user simply can no longer see or act on it.

## Out of scope

- The specific infrastructure used to host the service (an operational concern).
- The optional desktop shell (a distribution detail, planned as Later).

## Related

- [F17 — Security & Secrets](./F17-security-secrets.md)
- [Architecture — Deployment View](../architecture/07-deployment-view.md)
- [Decision 0002 — Local-first with a path to hosted](../decisions/0002-technology-stack.md)
- [Decision 0008 — SQLite locally, Postgres hosted](../decisions/0008-data-store-strategy.md)
