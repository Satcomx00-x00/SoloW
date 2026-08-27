# Vision & Scope

**Status:** Draft · **Owner:** Product · **Last reviewed:** 2026-08-17

## TL;DR

SoloW is a self-hostable control plane for running many AI coding agents in
parallel under human oversight. Users administer work as **Tasks on a Kanban board,
organised under Issues**, design multi-agent processes as **visual Workflows**, and
review every change before it lands. It matches the capability of kandev and adds
first-class use of Claude subscription plans, durable and resumable orchestration, and a
single codebase that runs both locally and as a hosted team service.

## The problem

Individual AI coding-agent CLIs are capable at doing work but lack the surrounding
infrastructure to be used seriously at scale. Teams and power users cannot easily:

- run several agents at once without them colliding on the same files or branches;
- see, understand, and approve what an agent changed before it ships;
- repeat a proven multi-step process (for example: one agent designs, another
  implements, a third reviews) reliably;
- track agent work against the issues it belongs to;
- offload heavy agent work to remote or containerised machines while keeping one place to
  watch and steer it.

## The vision

A single, trustworthy control plane where a person points agents at issues, watches their
work unfold visually, reviews the results, and ships — with the same confidence and
auditability they would expect from a human team, and without surrendering control or
data to a closed cloud.

## Guiding principles

1. **Review-first.** A human understands and approves changes before they are merged.
   Automation accelerates the work; it never removes the human decision.
2. **Issues organise the work; Kanban administers it.** Every Task exists to advance an
   Issue, and the board makes the state of that work obvious at a glance.
3. **Workflows are visual and repeatable.** A process is designed once as a graph, shared,
   and run consistently.
4. **Own your compute and your data.** Everything can run on the user's own machines with
   no telemetry and no vendor lock-in.
5. **Meet users where their budget is.** Agents can run on a personal subscription or on
   metered API keys, chosen per Agent Profile.

## In scope

- Issue tracking (native and synchronised from external trackers).
- Kanban administration of Tasks under Issues.
- Visual Workflow design and monitoring.
- Multi-agent orchestration across many agent CLIs via a standard protocol.
- Isolated per-Task working copies and multi-repository Tasks.
- Multiple execution environments (local, container, remote, cloud).
- An integrated review workspace (terminal, editor, diff, preview).
- Human-in-the-loop review and approval.
- Session and conversation management.
- Integrations with issue trackers, chat, and source hosts.
- Collaboration, sharing, and productivity reporting.
- Local and hosted deployment from one product.

## Out of scope

- Building or hosting new foundation models.
- Replacing a full IDE for day-to-day manual coding.
- Acting as a general project-management suite beyond the work SoloW orchestrates.
- Providing a managed commercial cloud as the only way to use the product.

## Competitive positioning versus kandev

SoloW matches kandev's feature breadth and differentiates on four points:

| Dimension | kandev | SoloW |
|-----------|--------|-------------|
| Subscription-based agents | Not first-class | First-class: run agents on a Claude Pro/Max plan across all executor types via a portable subscription token |
| Orchestration durability | Hand-built | Durable and resumable, with first-class human-in-the-loop gates |
| Deployment target | Local/desktop-first | Local **and** hosted multi-user from one codebase |
| Quota awareness | — | Concurrency caps and a "Parked" state so parallel work never silently exhausts a subscription quota |

See the [Decision Log](../decisions/README.md) for the reasoning behind these choices.

## Success criteria

The product is succeeding when a user can, in one place: create or import an Issue, break
it into Tasks on a board, run agents against those Tasks in parallel on their chosen
billing mode, review the proposed changes, and ship — repeatably, and without changes
landing that a human did not approve.
