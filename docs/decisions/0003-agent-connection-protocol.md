# 0003 — Integrate agents via the Agent Client Protocol (ACP)

**Status:** Accepted · **Date:** 2026-08-17 · **Deciders:** Architecture

## Context

GateControl must drive many different AI coding-agent tools (Claude Code, Codex, Gemini CLI,
and others). Integrating each one bespoke would be costly and fragile. A standard has emerged
— the **Agent Client Protocol (ACP)** — that standardises how tools connect to coding agents,
analogous to how the Language Server Protocol standardised editor tooling. It is what kandev
itself uses, and a large and growing set of agents support it.

## Decision

Integrate all agents through **ACP**, a single open standard, as the uniform boundary between
GateControl and agent tools.

## Considered options

- **Bespoke per-agent integrations** — Rejected: high cost, brittle, does not scale to many
  agents.
- **A build-your-own-agent framework** (in-process reasoning loop) — Rejected: the wrong
  layer. GateControl orchestrates *existing external agent tools*; it does not build an
  agent's reasoning loop, so frameworks for that solve a different problem.
- **ACP standard boundary (chosen)** — one interface to many agents; adding an agent is
  configuration, not engineering.

## Consequences

- Positive: broad agent support through one mechanism; orchestration is independent of any
  specific agent tool; new agents are added by configuration.
- Positive: choosing to drive external CLIs (rather than an in-process loop) is what makes
  subscription billing possible — the agent inherits the CLI's authentication
  (see [0005](./0005-subscription-authentication.md)).
- Negative: dependent on the maturity and evolution of the standard; agents differ in the
  capabilities they support (risk R-2), handled per Agent Profile.
