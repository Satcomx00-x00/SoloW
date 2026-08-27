# F06 — Authentication & Billing Modes

**Status:** Draft · **Owner:** Product · **Maturity:** Edge · **Last reviewed:** 2026-08-17

## Summary

SoloW lets each Agent be authenticated and billed in one of two ways, chosen per
Agent Profile: on a personal **Subscription** (a Claude Pro/Max plan) or on a metered
**API Key**. Subscription mode lets users run agents on a plan they already pay for, with no
per-token charges. Because subscription plans have quota windows, SoloW makes agents
quota-aware so parallel work never silently overruns a plan or unexpectedly switches to paid
billing. This is a primary differentiator from kandev.

## Jobs served

- **J6 — Control cost.**

## User stories

- As a Solo Power User, I want my agents to run on my existing Claude subscription, so I do
  not pay per token.
- As a user, I want to be sure that using my subscription never silently turns into a
  metered bill, so I trust the tool with my money.
- As an Operator, I want work to pause cleanly when a subscription quota is spent, rather
  than fail or overspend, so nothing is lost and nothing is surprising.
- As a user, I want to choose metered API-key billing for wide parallel fan-out, so I can
  exceed a subscription's throughput when I need to.

## Functional requirements

- **FR-1** An Agent Profile specifies its Authentication Mode: Subscription or API Key.
- **FR-2** In **Subscription** mode, SoloW runs the Agent using a stored, portable
  subscription credential so the Agent is billed against the user's plan, not per token.
- **FR-3** SoloW guarantees that a Subscription-mode Agent is never run in a way that
  causes metered API billing; any conflicting credential in the environment is removed for
  that Agent's run.
- **FR-4** In **API Key** mode, SoloW runs the Agent using a stored API key credential.
- **FR-5** A user can provide a subscription credential once and reuse it across all
  Subscription-mode Agents and all Executor types (local, container, remote, cloud).
- **FR-6** An Agent Profile in Subscription mode has a configurable concurrency cap; the
  cap defaults to a conservative value suited to subscription quota windows.
- **FR-7** When a Subscription-mode Agent exhausts its quota window, its Task (or Workflow
  Step) moves to **Parked**, preserving all work, and resumes automatically when the quota
  window resets or when the user acts.
- **FR-8** When a subscription or API-key credential is expired or revoked, affected Tasks
  surface a distinct **credential-expired** state — a lock icon and the words "Credential
  expired" on the card, never the raw failure-class string — separate from the quota Parked
  state and from a generic run failure (spec AC-013).
- **FR-8a** A credential-expired Task offers a **Renew** action that opens the Secret form
  pre-filled with the affected credential's name, scrolled and focused so the Owner can act
  in one click rather than hunting for the row by hand.
- **FR-8b** Replacing a credential (there is no separate "renew" endpoint — renewing *is*
  writing the same Secret again) automatically resumes every Task paused on it, in a fresh
  Session, without the Owner retrying each one individually. A Task that cannot resume right
  now (a dependency, the concurrency cap) is left exactly as it was rather than lost.
- **FR-9** SoloW warns a user before they queue more parallel Subscription-mode Tasks
  than the configured cap allows.
- **FR-10** All credentials are stored encrypted and are never displayed after entry
  (see [F17](./F17-security-secrets.md)).

## Non-functional requirements

- **NFR-1** No configuration path results in unintended metered billing for a
  Subscription-mode Agent (see product [NFR-10](../product/03-product-requirements.md)).
- **NFR-2** Credentials are never exposed to the code an Agent runs.
- **NFR-3** Parked work resumes without human intervention when its quota window resets,
  unless the user has intervened.

## States & rules

- Authentication Mode is a property of the Agent Profile and applies to every Session that
  Profile produces.
- The Parked state is a first-class Task and Workflow-Step state (see
  [Domain Model](../product/04-domain-model.md)); it is recoverable, not a failure.
- Subscription concurrency caps are enforced by orchestration alongside global concurrency
  limits.

## Edge cases & failure handling

- If both a subscription credential and an API key are present for a Subscription-mode
  Agent, the subscription credential is used and the API key is excluded from that run.
- If a quota window resets while many Tasks are Parked, they resume in order and within the
  concurrency cap, not all at once.
- If a subscription credential renewal is required, dependent Tasks stay safely paused until
  it is provided, and resume automatically — not manually, one at a time — the moment it is
  (FR-8b).
- Credential-expiry classification comes only from the Agent's own authentication error
  (401/403, "unauthorized", "invalid api key", "token expired", …), never inferred from a
  generic run failure — misclassifying a network error as an expired credential would send
  the Owner to the wrong fix with confidence.

## Out of scope

- The specific commercial terms of any subscription plan (owned by the plan provider).
- How secrets are encrypted and stored, specified in [F17](./F17-security-secrets.md).

## Related

- [F05 — Agent & Executor Profiles](./F05-agent-executor-profiles.md)
- [F07 — Execution Environments](./F07-execution-environments.md)
- [F17 — Security & Secrets](./F17-security-secrets.md)
- [Decision 0005 — Subscription authentication via portable token](../decisions/0005-subscription-authentication.md)
