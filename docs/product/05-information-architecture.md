# Information Architecture

**Status:** Draft · **Owner:** Product / Design · **Last reviewed:** 2026-08-17

This document describes how the product is organised from the user's point of view — the
top-level areas, how a user moves between them, and what each surface is for. It is
business-level; it does not prescribe visual design.

## Top-level areas

1. **Boards** — The default working surface. Kanban Boards where Tasks are administered
   under Issues. The place a user spends most of their time.
2. **Issues** — The catalogue of Issues in the Workspace, native and synchronised, with
   their status and their Tasks.
3. **Workflows** — The visual designer and library of reusable Workflows, and the monitor
   for live Runs.
4. **Task Detail** — The focused, per-Task review workspace: terminal, editor, diff,
   preview, and conversation.
5. **Repositories** — Connected Git repositories and their configuration.
6. **Profiles** — Agent Profiles and Executor Profiles.
7. **Integrations** — Connections to external trackers, chat, and source hosts.
8. **Insights** — Analytics and reporting on throughput and agent activity.
9. **Settings** — Workspace configuration, secrets, members and access (hosted), platform
   options, and the entry point to re-run the **Setup Workflow** (onboarding).

On first use of a Workspace, a guided **Setup Workflow** (onboarding) runs before the areas
above are used in earnest, walking the user through the configuration needed to make the
Workspace Ready (see [F18](../features/F18-onboarding-setup-workflow.md)). It is resumable
and can be re-run at any time from Settings.

## Primary navigation flow

A user typically moves: **Issues → Board (Tasks under an Issue) → Task Detail (review) →
back to Board**. Workflows are designed in the Workflows area and attached to Tasks; their
Runs are watched either in the Workflows monitor or from Task Detail.

## Surface responsibilities

- **Boards** answer "what work is in flight and where does it stand?"
- **Issues** answer "what needs doing, and which Tasks address it?"
- **Workflows** answer "what repeatable process runs, and how is this Run progressing?"
- **Task Detail** answers "what exactly did this agent do, and do I accept it?"
- **Profiles / Repositories / Integrations** answer "what reusable building blocks power the
  work?"
- **Insights** answer "how much are we getting done, and how?"
- **Settings** answer "how is this Workspace configured and secured?"

## Cross-surface consistency

- The Task lifecycle states (Backlog, Ready, Running, Review, Parked, Done, Failed) appear
  consistently on Boards, in Issue detail, and in Insights.
- Live status is reflected in near real time wherever a Task or Run is shown.
- Any Task can be opened into Task Detail from any surface that lists it.
