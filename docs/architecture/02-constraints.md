# 2. Constraints

**Status:** Draft · **Owner:** Architecture · **Last reviewed:** 2026-08-17

Constraints are fixed conditions the architecture must respect. They are not choices; they
bound the solution space.

## Product constraints

- **C-1 Review-first.** No agent change is integrated without a recorded human approval.
- **C-2 Own compute and data.** The system must run entirely on the user's machines with no
  required external service and no telemetry.
- **C-3 Two deployment modes.** The same product must run locally (single user) and hosted
  (multi-user), differing only in configuration.
- **C-4 Billing integrity.** A Subscription-mode agent must never be run in a way that causes
  metered billing.
- **C-5 Credential isolation.** Agent-run code must never have access to raw credentials.

## Technical constraints

- **C-6 Standard agent protocol.** Agents are integrated through a single open standard
  (the Agent Client Protocol) rather than bespoke per-agent integrations
  (see [Decision 0003](../decisions/0003-agent-connection-protocol.md)).
- **C-7 Long-lived agent processes.** Agents are external, long-running command-line
  processes that must be held open and supervised — which cannot be done inside a
  request/response-only surface (see [Decision 0002](../decisions/0002-technology-stack.md)).
- **C-8 Isolation via working copies.** Parallel agent work is isolated using per-Task Git
  working copies.

## Organisational constraints

- **C-9 Open source.** The product is open source with no vendor lock-in.
- **C-10 Docs-as-Code.** Documentation is versioned with the product and reviewed alongside
  it (see [Conventions](../CONVENTIONS.md)).

## Consequences

These constraints directly drive the solution strategy: a separation between the interactive
application and a long-lived orchestration component (C-7), structural isolation per Task
(C-8), a standard protocol boundary for agents (C-6), and a portable, credential-safe
approach to billing modes (C-4, C-5). See [Solution Strategy](./04-solution-strategy.md).
