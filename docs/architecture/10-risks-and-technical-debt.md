# 10. Risks & Technical Debt

**Status:** Draft · **Owner:** Architecture · **Last reviewed:** 2026-08-17

This section records known risks and areas to watch. It is revisited as the product evolves.

## Risks

- **R-1 Subscription throughput ceiling.** Subscription plans have quota windows, so wide
  parallel fan-out cannot run entirely on a subscription. *Mitigation:* per-profile
  concurrency caps, the Parked state, and an easy path to API-key billing for fan-out
  ([F06](../features/F06-authentication-billing.md)).

- **R-2 Agent protocol maturity.** The standard agent protocol is evolving, and not every
  agent tool supports every capability equally. *Mitigation:* the uniform boundary isolates
  the rest of the system from per-agent differences; capabilities degrade per Profile rather
  than breaking orchestration ([Decision 0003](../decisions/0003-agent-connection-protocol.md)).

- **R-3 Credential-isolation completeness.** The guarantee that agent-run code cannot read
  credentials must hold across every Executor type, including remote and container.
  *Mitigation:* credential isolation is a cross-cutting rule verified per Executor
  ([F17](../features/F17-security-secrets.md)).

- **R-4 Durability guarantees under failure.** Resumption must be correct even for partially
  completed Steps and interrupted Sessions. *Mitigation:* rely on a proven durable
  orchestration engine and record every significant state change
  ([Decision 0004](../decisions/0004-durable-orchestration-engine.md)).

- **R-5 External integration drift.** Trackers, source hosts, and chat services change their
  interfaces over time. *Mitigation:* integrations are optional and degrade gracefully; the
  core product never depends on them ([F12](../features/F12-integrations.md)).

- **R-6 Two-deployment complexity.** Supporting local and hosted from one product adds
  configuration surface. *Mitigation:* one data model with two stores, and identical feature
  behaviour across modes ([Decision 0008](../decisions/0008-data-store-strategy.md)).

## Technical debt (to track)

- The set of external trackers supported at first release versus later is an open decision
  (see [Product Requirements — Open questions](../product/03-product-requirements.md)).
- Whether the optional desktop shell ships at first release is deferred (Later).
- Default concurrency caps for subscription billing need validation against real quota
  behaviour.

## Review cadence

This register and the [Decision Log](../decisions/README.md) are reviewed periodically —
each significant decision roughly one month after acceptance — to compare expected against
actual consequences.
