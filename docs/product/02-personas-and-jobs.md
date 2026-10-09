# Personas & Jobs-to-be-Done

**Status:** Draft · **Owner:** Product · **Last reviewed:** 2026-10-09

Personas describe who SoloW serves. Jobs-to-be-Done describe the outcomes they hire
the product to achieve. Feature specifications trace back to these jobs.

**SoloW 1.0 serves one persona, P1**
([Decision 0031](../decisions/0031-focus-on-the-solo-power-user.md)). Every change is judged by
whether it shortens P1's path from an Issue to a reviewed pull request. The other personas are
kept because the specifications still name them, but each is marked with what applies to it
today. Where a feature specification's user story names the Team Lead, or an Operator of a
hosted instance, it describes a **Later** audience: the feature is built and judged for P1.

## Personas

### P1 — The Solo Power User (the 1.0 persona)
An individual developer running several harnesses at once on their own machine, often on a
personal Claude subscription. Values speed, low cost, staying in control, and keeping work
on their own hardware. P1 is also the only account on the installation, and so is both its
reviewer (P3) and its operator (P4).

### P2 — The Team Lead (Later)
Leads a small engineering team. Wants to standardise how harnesses are used, keep a review
gate in front of everything that ships, and see what work is in flight against which
issues. Needs a hosted, shared instance. **Later:** an installation has exactly one account;
there are no invitations, roles, or shared hosted instance.

### P3 — The Reviewer
Responsible for approving harness-produced changes. Cares most about clear diffs, context on
why a change was made, and the ability to reject or request changes safely. In 1.0 this is
P1 reviewing their own harnesses' work; a separate reviewer account is Later.

### P4 — The Operator
Runs the SoloW installation. Cares about deployment, secrets, resource limits, and
reliability. In 1.0 this is P1 running SoloW on their own machine (backups, upgrades,
running it as a service). Operating a hosted instance for others, with access control, is
Later.

## Jobs-to-be-Done

Each job is phrased as: *When [situation], I want to [motivation], so I can [outcome].*

- **J1 — Parallelise safely.** When I have several independent pieces of work, I want to
  run multiple harnesses at once without them corrupting each other's files, so I can move
  faster without cleaning up collisions.

- **J2 — Organise harness work around issues.** When work comes in as issues, I want to
  administer the harness Tasks that address each issue on a board, so I always know what is
  being done and where it stands.

- **J3 — Design a repeatable process.** When a multi-step approach works well, I want to
  capture it as a visual Workflow, so it runs the same way every time.

- **J4 — Watch a process unfold.** When a Workflow is running, I want to see progress as a
  live graph, so I can understand and steer it without reading logs.

- **J5 — Review before shipping.** When a harness proposes changes, I want to inspect a
  clear diff and approve, reject, or request changes, so nothing lands that I did not
  understand and accept.

- **J6 — Control cost.** When I run harnesses, I want to choose whether each one uses my
  subscription or a metered API key, and not be surprised by a bill, so I stay within
  budget.

- **J7 — Offload heavy work.** When a Task is resource-intensive, I want to run it in a
  container or on a remote machine, so my laptop stays usable and the work runs where it
  should. *In 1.0: an isolated container on the same machine. Remote and cloud machines are
  Later.*

- **J8 — Resume and recover.** When a long-running process is interrupted, I want it to
  resume rather than start over, so I do not lose work or waste quota.

- **J9 — Collaborate and share.** *(Later.)* When a Task is done or noteworthy, I want to
  share a clean record of it, so teammates can learn from or build on it. Nothing serves this
  job in 1.0.

- **J10 — Operate with confidence.** When I run SoloW, I want clear control over secrets,
  resource use, backups and the health of its services, so I can trust it with my work. *The
  team half of this job, control over who can access what in shared use, is Later.*

## Traceability

Every feature specification lists the jobs it serves. The set of jobs above is the
authoritative source; if a feature serves no job here, either the job is missing or the
feature is out of scope.
