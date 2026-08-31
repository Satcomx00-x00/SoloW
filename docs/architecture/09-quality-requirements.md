# 9. Quality Requirements

**Status:** Draft · **Owner:** Architecture · **Last reviewed:** 2026-08-17

This section states the quality attributes SoloW is judged by and how each is assessed.
It complements the product-wide non-functional requirements in
[Product Requirements](../product/03-product-requirements.md).

## Quality tree (priorities)

1. **Reliability** — highest priority; the system must not lose work or corrupt it.
2. **Security & privacy** — credentials and data must be safe; nothing leaks or leaves
   without intent.
3. **Cost trustworthiness** — billing mode is honoured exactly.
4. **Usability** — state is understandable at a glance; review is easy and safe.
5. **Portability** — one product, local and hosted.
6. **Performance & scale** — responsive under many concurrent Tasks.

## Quality scenarios

Each scenario names a stimulus and the response that constitutes success.

- **Q-Reliability-1** *When the Orchestration Component restarts mid-Run,* every in-flight
  Run resumes from its last completed Step rather than restarting.
- **Q-Reliability-2** *When one Task's Agent fails,* no other Task's working copy or progress
  is affected.
- **Q-Security-1** *When an Agent runs arbitrary code,* it cannot read any stored credential.
- **Q-Security-2** *When any log, notification, report, or export is produced,* it contains no
  readable secret.
- **Q-Cost-1** *When a Subscription-mode Agent runs,* no configuration causes metered
  billing; quota exhaustion parks work rather than switching billing.
- **Q-Usability-1** *When a user looks at a Board or Workflow monitor,* they can tell the
  state of any Task or Run without reading raw logs.
- **Q-Portability-1** *When the product is deployed hosted instead of local,* every feature
  behaves identically except those inherently multi-user.
- **Q-Performance-1** *When many Tasks run in parallel,* the Board and live views update in
  near real time.
- **Q-Performance-2** *When a sync polls a repository nothing has changed in,* it transfers no
  issue bodies and spends no provider rate-limit budget — the provider's own `304` is what says
  so, never an assumption about how long an answer stays good
  ([0020](../decisions/0020-provider-revalidation-not-expiry.md)).
- **Q-Performance-3** *When a screen the user has already visited is returned to,* it repaints
  from what the client is holding rather than reloading it. Correctness does not depend on the
  window: a write invalidates what it affects, and a live change arrives on the stream.

## How quality is judged

- Reliability and cost scenarios are the acceptance bar for the orchestration and billing
  building blocks.
- Security scenarios are non-negotiable constraints (C-4, C-5) verified before release.
- Usability and performance scenarios guide design and are validated against the primary
  success metric (reviewed-and-accepted Task completion rate).
