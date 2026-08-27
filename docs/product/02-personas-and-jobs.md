# Personas & Jobs-to-be-Done

**Status:** Draft · **Owner:** Product · **Last reviewed:** 2026-08-17

Personas describe who SoloW serves. Jobs-to-be-Done describe the outcomes they hire
the product to achieve. Feature specifications trace back to these jobs.

## Personas

### P1 — The Solo Power User
An individual developer running several agents at once on their own machine, often on a
personal Claude subscription. Values speed, low cost, staying in control, and keeping work
on their own hardware.

### P2 — The Team Lead
Leads a small engineering team. Wants to standardise how agents are used, keep a review
gate in front of everything that ships, and see what work is in flight against which
issues. Needs a hosted, shared instance.

### P3 — The Reviewer
Responsible for approving agent-produced changes. Cares most about clear diffs, context on
why a change was made, and the ability to reject or request changes safely.

### P4 — The Operator
Runs the hosted SoloW instance. Cares about deployment, secrets, access control,
resource limits, and reliability.

## Jobs-to-be-Done

Each job is phrased as: *When [situation], I want to [motivation], so I can [outcome].*

- **J1 — Parallelise safely.** When I have several independent pieces of work, I want to
  run multiple agents at once without them corrupting each other's files, so I can move
  faster without cleaning up collisions.

- **J2 — Organise agent work around issues.** When work comes in as issues, I want to
  administer the agent Tasks that address each issue on a board, so I always know what is
  being done and where it stands.

- **J3 — Design a repeatable process.** When a multi-step approach works well, I want to
  capture it as a visual Workflow, so my team can run it the same way every time.

- **J4 — Watch a process unfold.** When a Workflow is running, I want to see progress as a
  live graph, so I can understand and steer it without reading logs.

- **J5 — Review before shipping.** When an agent proposes changes, I want to inspect a
  clear diff and approve, reject, or request changes, so nothing lands that I did not
  understand and accept.

- **J6 — Control cost.** When I run agents, I want to choose whether each one uses my
  subscription or a metered API key, and not be surprised by a bill, so I stay within
  budget.

- **J7 — Offload heavy work.** When a Task is resource-intensive, I want to run it in a
  container or on a remote machine, so my laptop stays usable and the work runs where it
  should.

- **J8 — Resume and recover.** When a long-running process is interrupted, I want it to
  resume rather than start over, so I do not lose work or waste quota.

- **J9 — Collaborate and share.** When a Task is done or noteworthy, I want to share a
  clean record of it, so teammates can learn from or build on it.

- **J10 — Operate with confidence.** When I run SoloW for a team, I want clear
  control over access, secrets, and resource use, so I can trust it in shared use.

## Traceability

Every feature specification lists the jobs it serves. The set of jobs above is the
authoritative source; if a feature serves no job here, either the job is missing or the
feature is out of scope.
