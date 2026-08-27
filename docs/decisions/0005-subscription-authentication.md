# 0005 — Support Claude subscription billing via a portable token

**Status:** Accepted · **Date:** 2026-08-17 · **Deciders:** Product, Architecture

## Context

Many users already pay for a Claude Pro/Max subscription and want to run agents on it rather
than paying per token through an API key. Because SoloW drives the real agent CLI (see
[0003](./0003-agent-connection-protocol.md)), an agent inherits whatever authentication that
CLI has. A portable subscription token can be provisioned once and supplied to agents in any
Executor. Two hazards must be managed: an API-key credential present in the environment
silently diverts a subscription agent to metered billing, and subscription plans have quota
windows that make unbounded parallel fan-out impossible.

## Decision

Support **two billing modes per Agent Profile**: Subscription and API Key. For Subscription
mode, use a **portable subscription token** provisioned once and supplied across all Executor
types. The orchestrator **removes any conflicting credential** from a subscription agent's
run environment so billing cannot be diverted, applies a **configurable concurrency cap**,
and **Parks** work (preserving it) when a quota window is exhausted, resuming automatically
when the window resets.

## Considered options

- **API keys only** (the usual default posture) — Rejected as the only option: ignores the
  large base of subscription users and their cost concerns.
- **Inherit an interactive login profile only** — Rejected: only works where a human logged
  in interactively; fails for container, remote, and cloud Executors.
- **Portable subscription token + explicit modes (chosen)** — works headless across all
  Executors, with guardrails against accidental metered billing and quota overrun.

## Consequences

- Positive: users run agents on a plan they already pay for, everywhere; a primary
  differentiator from comparable tools.
- Positive: the Parked state and concurrency caps prevent silent quota exhaustion and
  surprise bills (product NFR-10).
- Negative: subscription throughput is capped by quota windows, so wide fan-out still needs
  API-key mode (risk R-1); credential isolation must hold across all Executors (risk R-3).
- Realises [F06](../features/F06-authentication-billing.md) and
  [F17](../features/F17-security-secrets.md).
