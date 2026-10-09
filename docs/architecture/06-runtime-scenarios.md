# 6. Runtime View

**Status:** Draft · **Owner:** Architecture · **Last reviewed:** 2026-08-17

This section shows how the building blocks collaborate for the most important journeys. Each
scenario is described as a sequence of responsibilities, not implementation.

## Scenario 1 — Run a Task and review its changes

1. A user creates a Task under an Issue and marks it Ready (Interactive Application, F02).
2. The user launches the Task; the Orchestration Component checks concurrency and billing
   rules, provisions a Worktree, and starts a Harness Session through the standard protocol
   (F04, F06, F08).
3. The Harness works; its activity streams live to the review workspace (F09).
4. The Harness proposes changes; the Task enters Review and the changes are presented as a
   Diff (F10).
5. The user approves; the changes are integrated (optionally as a pull request), the Task
   moves to Done, and the Worktree is cleaned up (F08, F12).

## Scenario 2 — Run a multi-harness Workflow with a human Gate

1. A Task executes a Workflow; the Workflow engine begins the Run and records its progress
   durably (F03, Decision 0004).
2. A Harness Step runs; on completion the engine advances to the next Step.
3. The Run reaches a Gate; it pauses and requests a human decision, notifying the reviewer
   (F10, F15).
4. The reviewer approves at the Gate; the engine resumes and continues downstream Steps.
5. The Run completes; its final state is recorded and shown on the graph (F03).

## Scenario 3 — Resume after interruption

1. A Run is in progress when the Orchestration Component restarts.
2. On restart, the Workflow engine reads the durably recorded progress and resumes each Run
   from its last completed Step, not from the beginning (product NFR-1, Decision 0004).
3. In-flight Tasks likewise resume or fail cleanly without corrupting other Tasks' Worktrees
   (product NFR-2).

## Scenario 4 — Subscription quota exhausted

1. A Harness stops mid-run with words that read as an exhausted quota or a rate limit (F06).
   SoloW does not track the quota itself; it reads only the harness's message.
2. The billing & credential guard moves the Task (or Workflow Step) to Parked, preserving all
   work.
3. Five hours later (a fixed wait, not the provider's reset time) the run wakes, takes a slot
   under the concurrency cap, and runs again in the same Worktree; the user is not billed
   metered charges and loses no work. If the quota has not reset, it parks again.

## Scenario 5 — Synchronise an Issue and create a Task

1. An Issue is synchronised from an external tracker (F01, F12).
2. The user breaks it into Tasks on a Board (F02).
3. Each Task follows Scenario 1 or Scenario 2.
4. On acceptance, changes flow to the source host and the Issue's status updates (F10, F12).

## What these scenarios demonstrate

- The Interactive Application directs; the Orchestration Component does the durable work.
- Isolation, billing safety, and human review are enforced at the points where they matter.
- Interruptions resume rather than restart, which is the reason for the durable engine.
