# 8. Cross-cutting Concepts

**Status:** Draft · **Owner:** Architecture · **Last reviewed:** 2026-08-17

These concepts apply across the whole system. They are stated here once so individual
features and building blocks can reference them rather than restating them.

## Isolation

Every Task runs in its own working copy per Repository, so concurrent harnesses never share
working files. Isolation is structural and holds across all Executor types.
→ [F08](../features/F08-workspaces-repositories.md)

## Durability & resumption

Progress of Tasks and Workflow Runs is recorded durably. Interruptions resume from the last
completed step; human Gates are first-class waits, not busy loops. Every significant state
change is recorded so history can be reconstructed.
→ [Decision 0004](../decisions/0004-durable-orchestration-engine.md)

## Human-in-the-loop

The review-first principle is a system-wide concern, not a single feature. It appears as
Task Review, Workflow Gates, and harness tool-use approval — all governed by the same rule: a
recorded human decision is required to proceed.
→ [F10](../features/F10-review-approval.md)

## Credential safety & billing integrity

Secrets are stored encrypted and never displayed after entry. Harness-run code never has
access to raw credentials. Subscription-mode harnesses are never run in a way that causes
metered billing. These rules apply everywhere harnesses run.
→ [F06](../features/F06-authentication-billing.md), [F17](../features/F17-security-secrets.md)

## Real-time observability

Live harness activity and state changes are streamed to the user with low latency, so the
board, the review workspace, and the Workflow monitor always reflect current reality.
→ [F09](../features/F09-integrated-workspace.md)

## Uniform harness boundary

All harnesses are driven through one standard protocol, so orchestration behaviour is
independent of which harness tool is used, and adding a harness does not change the system.
→ [Decision 0003](../decisions/0003-agent-connection-protocol.md)

## Tenancy & access

In hosted mode, the Workspace is the tenancy and access boundary; access is enforced on
every action, not only in the interface.
→ [F16](../features/F16-platform-deployment.md)

## Auditability

Reviews, Sessions, Runs, and state changes are recorded so that who did what, when, and with
what outcome can always be reconstructed — the basis for trust and for reporting.
→ [F14](../features/F14-analytics-reporting.md)
