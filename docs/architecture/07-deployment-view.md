# 7. Deployment View

**Status:** Draft · **Owner:** Architecture / Operator · **Last reviewed:** 2026-08-17

GateControl runs in two deployment modes from one product. This section describes both at a
business-readable level. See [F16](../features/F16-platform-deployment.md) for the
requirements and [Decision 0008](../decisions/0008-data-store-strategy.md) for the data
store choice.

## Local deployment (single user)

- The Interactive Application, the Orchestration Component, and the State Store all run on
  one machine.
- The State Store is a lightweight embedded store; work and working copies are kept locally.
- Agents run in local, container, or remote Executors as configured.
- Nothing is required from any external service, and no telemetry is sent.

> **Local shape:** one machine hosts the application, the orchestrator, and the embedded
> store; agents run in the chosen Executors; the user works entirely on their own hardware.

## Hosted deployment (multi-user)

- The Interactive Application and the Orchestration Component run as a shared service;
  multiple users connect to it.
- The State Store is a shared database supporting many users and Workspaces.
- Work is isolated per Workspace, which is the tenancy and access boundary.
- Agents run in container, remote, or cloud Executors; Executors can scale independently of
  the application.

> **Hosted shape:** a shared application and orchestrator back a shared database; many users
> across many Workspaces connect; Executors run agents on separate compute.

## What stays the same across modes

- The features, the domain model, the review-first lifecycle, and the user experience are
  identical.
- Profiles, Integrations, and secrets remain Workspace-scoped.
- The only differences are configuration: which store is used, whether multiple users and
  access control are present, and where Executors run.

## Operator responsibilities in hosted mode

- Managing members and their access to Workspaces (F16).
- Providing and rotating secrets safely (F17).
- Ensuring Executors are available and appropriately scaled (F07).
- Keeping the shared database and orchestrator healthy (product NFR-1, NFR-2).
