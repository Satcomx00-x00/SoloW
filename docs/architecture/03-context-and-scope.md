# 3. Context & Scope

**Status:** Draft · **Owner:** Architecture · **Last reviewed:** 2026-08-17

This section defines SoloW's boundary and its neighbours. It corresponds to the
**C4 System Context** level: SoloW as a single system, the people who use it, and the
external systems it talks to.

## The system in its context

SoloW sits between the people who direct agent work and the external tools and
environments that work happens in and against.

**People (actors):**
- **User** — creates Issues and Tasks, runs agents, designs Workflows, reviews changes.
- **Reviewer** — approves, rejects, or requests changes; resolves Gates.
- **Operator** — configures and runs a hosted instance.

**External systems (neighbours):**
- **AI coding agents** — external command-line agent tools that SoloW drives to do the
  work.
- **Git repositories & source hosts** — where code lives and where accepted changes are
  integrated (branches, pull requests).
- **Issue trackers** — external systems Issues are synchronised with (GitHub, Jira, Linear,
  GitLab, Sentry).
- **Chat** — where notifications are delivered (Slack).
- **Execution environments** — the machines and containers agents run in (local host,
  containers, remote hosts, cloud runners).
- **Model providers** — the AI services the agents themselves call, either on a user's
  subscription or via metered API keys.

## Context summary (textual C4 System Context)

> User / Reviewer / Operator
>   ↓ direct and review work
> **SoloW** (the system)
>   ↔ drives → AI coding agents
>   ↔ isolates work in → Git repositories, integrates via → source hosts
>   ↔ synchronises → issue trackers
>   ↔ notifies via → chat
>   ↔ runs agents in → execution environments
>   ↔ agents call → model providers (subscription or API key)

## In scope for SoloW

- Orchestrating agents, isolating their work, and supervising their runs.
- Organising work as Issues and Tasks and administering it on Boards.
- Designing and running visual Workflows with human gates.
- Presenting review and driving the review-first lifecycle.
- Managing Profiles, Integrations, secrets, and deployment.

## Explicitly outside the boundary

- The AI models themselves (owned by model providers).
- The canonical issue data (owned by external trackers).
- The hosting infrastructure of external systems.

## External interface responsibilities

- **Toward agents:** a single standard protocol boundary (see [Decision 0003](../decisions/0003-agent-connection-protocol.md)).
- **Toward source hosts and trackers:** integration connectors, all optional
  (see [F12](../features/F12-integrations.md)).
- **Toward model providers:** credentials are supplied to agents without exposing them to
  agent-run code (see [F17](../features/F17-security-secrets.md)).
