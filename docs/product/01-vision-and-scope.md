# Vision & Scope

**Status:** Draft · **Owner:** Product · **Last reviewed:** 2026-10-09

## TL;DR

SoloW is a self-hosted control plane for one developer running AI coding harnesses in
parallel on their own machine, under their own review. Work is administered as **Tasks on a
Kanban board, organised under Issues**; a Task can follow a **Workflow** of several Steps; and
every change is reviewed before it ships as a pull request. It adds first-class use of a Claude
subscription plan and durable, resumable runs.

**SoloW 1.0 is for one persona: the solo power user, on their own machine**
([Decision 0031](../decisions/0031-focus-on-the-solo-power-user.md)). Hosting for teams —
several users, invitations, roles, a production database — is **Later**: it comes after 1.0,
and only if real use justifies it. Today an installation has exactly one account.

## The problem

Individual AI coding-harness CLIs are capable at doing work but lack the surrounding
infrastructure to be used seriously at scale. A developer running several of them cannot
easily:

- run several harnesses at once without them colliding on the same files or branches;
- see, understand, and approve what a harness changed before it ships;
- repeat a proven multi-step process (for example: one harness plans, another implements, a
  third reviews) reliably;
- track harness work against the issues it belongs to;
- keep harness work isolated from the rest of their machine while keeping one place to watch
  and steer it.

## The vision

A single, trustworthy control plane where a person points harnesses at issues, watches their
work unfold, reviews the results, and ships them as pull requests — with the confidence and
auditability they would expect from a human colleague, and without surrendering control or
data to a closed cloud.

## Guiding principles

1. **Review-first.** A human understands and approves changes before they are shipped.
   Automation accelerates the work; it never removes the human decision.
2. **Issues organise the work; Kanban administers it.** Every Task exists to advance an
   Issue, and the board makes the state of that work obvious at a glance.
3. **Workflows are visual and repeatable.** A process is designed once as a graph of Steps
   and run consistently.
4. **Own your compute and your data.** Everything runs on the user's own machine with no
   telemetry and no vendor lock-in.
5. **Meet users where their budget is.** Harnesses can run on a personal subscription or on
   metered API keys, chosen per Harness Profile.

## In scope for 1.0

What 1.0 is judged on is the path from an Issue to a reviewed pull request for one person.
Each item below is built; the [Feature Comparison](./06-feature-comparison.md) gives the
detail and its limits.

- Issues: created in SoloW, or imported from GitHub, GitLab or Gitea.
- Kanban administration of Tasks under Issues, a one-field quick task, sub-tasks and
  dependencies.
- Workflows: several Steps, each with its own Harness Profile and review gate.
- Harness orchestration: Claude Code and opencode come ready to use; other harnesses can be
  added by hand ([F04](../features/F04-harness-orchestration.md)).
- Isolated per-Task working copies, and Tasks spanning several repositories.
- Two execution environments: the user's own machine (for trusted agents only) and an
  isolated container.
- A Task page to review the work: transcript, terminal, diff, and the review gate.
- Approval that ships: the branch is pushed and a pull request is opened or updated on
  GitHub, GitLab or Gitea; a repository with no remote keeps a local commit.
- Sign-in for the one Owner account, services reachable from the local machine only by
  default, and encrypted secrets.
- Running it day to day: an Outcomes page, service health and failed or stuck runs on the
  status bar, a history retention window, and backup and restore.

## Later

Moved after 1.0 by [Decision 0031](../decisions/0031-focus-on-the-solo-power-user.md), or not
built yet. Each starts only when real use justifies it ([Roadmap](../ROADMAP.md)):

- **Hosting for teams:** several users, invitations, roles and access control, and a
  production database (Postgres). Only one account can exist per installation today.
- **Remote (SSH) and cloud environments.** They are hidden; they have no driver.
- **Notifications** beyond the in-app notice of a failed or stuck run.
- **Sharing** a Task's record with others ([F13](../features/F13-collaboration-sharing.md)).
- **Analytics** beyond the Outcomes page ([F14](../features/F14-analytics-reporting.md)).
- **Real quota detection.** Today a Task that hits a quota is Parked for a fixed five hours
  ([F06](../features/F06-authentication-billing.md)).
- **More ready-to-use harnesses.**
- **Further integrations** (Jira, Linear, Slack).

## Out of scope

- Building or hosting new foundation models.
- Replacing a full IDE for day-to-day manual coding.
- Acting as a general project-management suite beyond the work SoloW orchestrates.
- Providing a managed commercial cloud as the only way to use the product.

## Competitive positioning

Comparable tools are wider; SoloW 1.0 is deliberately narrower and aims to be more dependable
for one person. Where it differs:

| Dimension | Comparable tools | SoloW 1.0 |
|-----------|--------|-------------|
| Who it is for | Individuals, and teams on a hosted service | One person on their own machine; teams are Later |
| Harness breadth | Twenty or more harnesses supported | Two ready to use (Claude Code, opencode); others added by hand |
| Subscription-based harnesses | Not first-class | First-class: a Claude Pro/Max plan, never silently switched to metered billing |
| Orchestration durability | Hand-built | Durable and resumable runs; the review gate is a recorded state |
| Review to delivery | Varies | Approving pushes the branch and opens or updates the pull request |
| Quota handling | — | A concurrency cap per Harness Profile, and a fixed five-hour Parked wait when a harness reports an exhausted quota. No quota is detected and there is no spending limit |
| Deployment target | Local/desktop-first, some hosted | Local only; hosted multi-user is Later |

See the [Decision Log](../decisions/README.md) for the reasoning behind these choices.

## Success criteria

The product is succeeding when one person can, in one place: create or import an Issue, run
harnesses against its Tasks in parallel on their chosen billing mode, review the proposed
changes, and ship them as pull requests — repeatably, and without changes landing that they did
not approve. The [Roadmap](../ROADMAP.md) measures it by Tasks shipped as pull requests per
week, the share of runs that reach approval within two attempts, and the time from a fresh
install to the first pull request; the Outcomes page reports the first two.
