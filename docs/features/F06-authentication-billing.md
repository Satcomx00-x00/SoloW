# F06 — Authentication & Billing Modes

**Status:** Draft · **Owner:** Product · **Maturity:** Edge · **Last reviewed:** 2026-10-09

## Summary

SoloW lets each Harness be authenticated and billed in one of two ways, chosen per
Harness Profile: on a personal **Subscription** (a Claude Pro/Max plan) or on a metered
**API Key**. Subscription mode lets users run harnesses on a plan they already pay for, with no
per-token charges, and SoloW guarantees it never silently switches to paid billing. This is a
primary differentiator from comparable tools.

SoloW does **not** know how much of a plan's quota is left, and it has no budget or spending
limit. What it has is a concurrency cap per Harness Profile, and a **Parked** state that is a
fixed five-hour wait: when a harness stops with words that read as an exhausted quota or a rate
limit, the Task is Parked and the run sleeps five hours before it tries again. Real quota
detection, reading the reset time the provider gives, is planned for after 1.0
([Roadmap](../ROADMAP.md), "After 1.0").

## Jobs served

- **J6 — Control cost.**

## User stories

- As a Solo Power User, I want my harnesses to run on my existing Claude subscription, so I do
  not pay per token.
- As a user, I want to be sure that using my subscription never silently turns into a
  metered bill, so I trust the tool with my money.
- As an Operator, I want work to pause cleanly when a subscription quota is spent, rather
  than fail or overspend, so nothing is lost and nothing is surprising.
- As a user, I want to choose metered API-key billing for wide parallel fan-out, so I can
  exceed a subscription's throughput when I need to.

## Functional requirements

- **FR-1** A Harness Profile specifies its Authentication Mode: Subscription or API Key.
- **FR-2** In **Subscription** mode, SoloW runs the Harness using a stored, portable
  subscription credential so the Harness is billed against the user's plan, not per token.
- **FR-3** SoloW guarantees that a Subscription-mode Harness is never run in a way that
  causes metered API billing; any conflicting credential in the environment is removed for
  that Harness's run.
- **FR-4** In **API Key** mode, SoloW runs the Harness using a stored API key credential.
- **FR-5** A user can provide a subscription credential once and reuse it across all
  Subscription-mode Harnesses and all Executor types offered (local and container; remote and
  cloud are Later, [0031](../decisions/0031-focus-on-the-solo-power-user.md)).
- **FR-6** Every Harness Profile has a configurable concurrency cap, from 1 to 20, defaulting
  to 3. The default is a guess at what a subscription's quota window tolerates, not a
  measurement of it.
- **FR-7** When a Harness ends its run with words that read as an exhausted quota or a rate
  limit ("quota", "usage limit", "rate limit", "limit reached", "too many requests", or a 429),
  its Task (or Workflow Step) moves to **Parked**, preserving all work. The rule reads only the
  harness's own message; it applies in either billing mode, so an API-key harness answered
  with a 429 parks too. The run then sleeps for a **fixed five hours** and runs the Task again
  in the same Worktree, or the user acts first (retry, or move the Task). Nothing reads the
  plan's remaining quota or the reset time the provider reports.
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
- **FR-9** A start that would exceed a Harness Profile's cap is refused with a plain-language
  message, and the Task stays where it was; nothing is queued. Settings shows how many Tasks
  are running against the caps. There is no warning before the attempt (Later).
- **FR-10** All credentials are stored encrypted and are never displayed after entry
  (see [F17](./F17-security-secrets.md)).

## Non-functional requirements

- **NFR-1** No configuration path results in unintended metered billing for a
  Subscription-mode Harness (see product [NFR-10](../product/03-product-requirements.md)).
- **NFR-2** Credentials are never exposed to the code a Harness runs.
- **NFR-3** Parked work resumes without human intervention five hours after it parked, unless
  the user has intervened. If the quota has not reset by then, the harness fails the same way
  and the Task parks for another five hours.

## States & rules

- Authentication Mode is a property of the Harness Profile and applies to every Session that
  Profile produces.
- The Parked state is a first-class Task and Workflow-Step state (see
  [Domain Model](../product/04-domain-model.md)); it is recoverable, not a failure.
- Concurrency caps are per Harness Profile, in either billing mode. There is no global
  limit across Profiles.
- A slot is a live Task reading Running, counted against the Harness Profile the *Task* names.
  Every move into Running takes one under the cap in the same write — a start, a retry, a
  review decision that sends the harness back to work, and a Parked run waking from its quota
  window. A Parked Task holds no slot; on waking with its Profile full it stays Parked, says so
  in its Session, and tries again a minute later, backing off to every ten minutes. A Parked
  run that wakes to find its Task moved while it slept — retried, failed, deleted — stands down
  without writing the Task: whatever moved it owns it now (one run per Task).
- **Known limit:** a Workflow Step that names its own Harness Profile still runs on the Task's
  Profile's slot, not the Step's. A Step boundary reached on the harness's own signal moves the
  Step with the Task already Running, so there is no move into Running at which to claim the
  Step's Profile; capping it there would mean a run waiting mid-pipeline while holding the
  previous Step's slot. Until that is designed, a pipeline whose Steps use other Profiles can
  exceed those Profiles' caps by the number of such pipelines running.

## Edge cases & failure handling

- If both a subscription credential and an API key are present for a Subscription-mode
  Harness, the subscription credential is used and the API key is excluded from that run.
- When many Tasks are Parked, each wakes five hours after it parked, not when a quota resets.
  Waking runs take slots under the concurrency cap like any other start, so they do not all
  run at once; there is no ordering among them beyond who asks first.
- If a parked run is lost (the run engine lost its state) and the Task stays silent for the
  five hours plus ten minutes, the Task is marked as never having resumed, and it shows among
  the runs needing attention, rather than reading Parked for ever.
- A harness that words a quota error in a way the rule does not recognise fails the Task
  instead of parking it. The rule is narrow on purpose: a false Park strands a Task for five
  hours.
- If a subscription credential renewal is required, dependent Tasks stay safely paused until
  it is provided, and resume automatically — not manually, one at a time — the moment it is
  (FR-8b).
- Credential-expiry classification comes only from the Harness's own authentication error
  (401/403, "unauthorized", "invalid api key", "token expired", …), never inferred from a
  generic run failure — misclassifying a network error as an expired credential would send
  the Owner to the wrong fix with confidence.

## Later

Not built, and planned for after 1.0 ([Roadmap](../ROADMAP.md)):

- **Real quota detection** — reading the reset time from the provider's answer and waking then,
  with a visible countdown, instead of the fixed five-hour wait.
- **Budgets and spending limits** — today spend is reported after the fact on the Outcomes page
  ([F14](./F14-analytics-reporting.md)); nothing stops a run when a sum is reached.

## Out of scope

- The specific commercial terms of any subscription plan (owned by the plan provider).
- How secrets are encrypted and stored, specified in [F17](./F17-security-secrets.md).

## Related

- [F05 — Harness & Executor Profiles](./F05-harness-executor-profiles.md)
- [F07 — Execution Environments](./F07-execution-environments.md)
- [F17 — Security & Secrets](./F17-security-secrets.md)
- [Decision 0005 — Subscription authentication via portable token](../decisions/0005-subscription-authentication.md)
