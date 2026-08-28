# F23 — Project Planning

**Status:** Draft · **Owner:** Product · **Maturity:** Core · **Last reviewed:** 2026-08-25

## Summary

SoloW has a board of Tasks — the *execution* layer, where an agent's run advances one
Issue. What it has never had is the layer above: the table a team plans in. Which issues exist,
what state they are in, who holds them, how big they are, which iteration they belong to, which
epic they roll up into, and which pull request will close them.

That table is GitHub Projects, and this feature is that table — for GitHub **and** for GitLab,
which has no equivalent and never will. Field values are the provider's, mirrored here and
synthesised from scoped labels where GitLab has nothing else
([Decision 0018](../decisions/0018-provider-owned-project-fields.md)); the capability registry
from [F21](./F21-integration-providers.md) is what keeps "the same table" from meaning "GitLab
pretending to be GitHub".

Two things this feature is deliberately **not**. It is not a second Issue model: it is a
projection over the Issues [F01](./F01-issue-management.md) already imports. And it is not a
second board: the Kanban stays what [Decision 0006](../decisions/0006-kanban-scoped-to-issues.md)
made it — the runtime of agent work, under an Issue. Planning decides what to do; the board runs
it.

Nothing here is imported by hand. An issue that exists on a connected repository appears in the
table because it exists, not because someone pressed a button.

## Jobs served

- **J2 — Organise agent work around issues.**
- **J3 — Design a repeatable process.**
- **J10 — Operate with confidence.**

## User stories

- As a Team Lead, I want the table my team already plans in, so adopting SoloW does not
  mean keeping a second backlog.
- As a Team Lead, I want it to work on GitLab, so the tool is not chosen by which host we use.
- As a Team Lead, I want a status I change here to be the status my team sees in GitHub or
  GitLab, so nobody has to look in two places.
- As a Solo Power User, I want issues to arrive on their own, so a backlog is not a thing I
  maintain by importing.
- As a Team Lead, I want an epic to show how much of it is done, so I can answer "how far in are
  we" without opening five issues.
- As a Reviewer, I want the pull request that closes an issue on the same row, so I can see what
  is actually in flight.
- As a Team Lead, I want to say plainly what a provider cannot do, rather than discovering it
  when a save fails.

## Functional requirements

- **FR-1** THE SYSTEM SHALL present a Project as a table: one row per item, with columns for
  Title, Status, Assignees, Linked pull requests, Sub-issue progress, Size, Estimate, Iteration,
  Start date, Target date, Repository, and any further field the provider exposes.
- **FR-2** THE SYSTEM SHALL group rows by any single-select field, showing each group's name,
  its item count, and a per-group aggregate of numeric fields.
- **FR-3** THE SYSTEM SHALL let the Owner reorder, resize, show and hide columns, and SHALL
  persist that arrangement per user through [F19](./F19-extension-contributions.md)'s preference
  boundary.
- **FR-4** THE SYSTEM SHALL edit a field value inline, write it to the provider, and render the
  value the provider returns — never the value that was typed.
- **FR-5** WHERE a provider cannot express a field's type, THE SYSTEM SHALL render that field
  read-only and state the reason, and SHALL NOT offer an edit that would fail
  ([Decision 0018](../decisions/0018-provider-owned-project-fields.md)).
- **FR-6** THE SYSTEM SHALL ingest issues from every connected Repository automatically, on a
  cursor, with no manual import step.
- **FR-7** THE SYSTEM SHALL show an epic with its children nested beneath it, collapsed by
  default, with a completion count and percentage rolled up from the children.
- **FR-8** THE SYSTEM SHALL populate assignees, labels, linked pull or merge requests, and issue
  state from the provider, and SHALL present them as read-only mirrors.
- **FR-9** THE SYSTEM SHALL support saved views over one Project — a named tab carrying its own
  filter, grouping, sort, visible columns and layout.
- **FR-10** THE SYSTEM SHALL offer a table layout and a roadmap layout of the same view, the
  roadmap laying items on a timeline by their start and target dates.
- **FR-11** THE SYSTEM SHALL filter by keyword and by field, with a syntax that names fields
  explicitly (`status:"In progress" assignee:@me -label:blocked`).
- **FR-12** THE SYSTEM SHALL let the Owner map a provider's own vocabulary onto a field — which
  scoped-label prefix carries Status, which carries Size — because a convention is a convention.
- **FR-13** WHEN an item's issue is closed on the provider, THE SYSTEM SHALL reflect that on the
  next poll without a person acting.
- **FR-14** THE SYSTEM SHALL link a row to the Issue it projects, so a planning decision leads
  directly to the Tasks that execute it.
- **FR-15** THE SYSTEM SHALL let a person change an imported Issue's title, description, state,
  assignees, labels and milestone **on the provider that owns it**, and SHALL render what the
  provider answers rather than what was entered
  ([Decision 0019](../decisions/0019-editing-an-issue-where-it-lives.md)).
- **FR-16** WHERE a provider declares it cannot hold one of those fields, THE SYSTEM SHALL show
  the value with that provider's own reason instead of a control — the same rule FR-5 applies to
  project fields, for the same reason: a greyed box is a dead end, a sentence is actionable.
- **FR-17** WHEN a change omits a field, THE SYSTEM SHALL leave that field alone. Absent and
  cleared are different instructions, and an editor that sent its whole form would silently
  revert every field it did not display.
- **FR-18** WHERE a provider has nothing shaped like a Project to mirror — GitLab, whose "Projects"
  are its repositories, or a provider that declares no `projects` capability at all — THE SYSTEM
  SHALL let a person create a Project SoloW holds outright, instead of adopting one. This
  reverses [Decision 0018](../decisions/0018-provider-owned-project-fields.md)'s exclusion of
  provider-side creation only in the direction it never covered: nothing is created *on* a
  provider by this, matching the precedent set for local Issues by #15.
- **FR-19** THE SYSTEM SHALL let an Owner register a Repository under a local Project. A local
  Project has no provider board to walk for membership, so this registration decides it directly:
  every Issue the Repository already holds is backfilled in, and every Issue it gains afterward —
  created locally or ingested by #125 — is attached automatically. A Repository MAY be registered
  under more than one local Project.
- **FR-20** THE SYSTEM SHALL let an Owner remove a Repository from a local Project, deleting that
  Repository's items (and any field values on them) from the Project without touching the
  Repository or its Issues themselves.
- **FR-21** A local Project SHALL never be synced to, or created on, any provider, and SHALL carry
  no `project_field` rows — there is no provider board those fields could have been read from.
- **FR-22** THE SYSTEM SHALL let an Owner delete a Project — local or mirrored — removing it from
  SoloW's own database (its saved views, fields, values and items) without deleting its Issues,
  which are kept and become unassigned, and without deleting or otherwise touching anything on the
  provider a mirrored Project came from.
- **FR-23** THE SYSTEM SHALL give a local Project **the same column set a mirrored GitHub Project
  has** — Title, Assignees, Status, Labels, Linked pull requests, Milestone, Repository,
  Reviewers, Parent issue, Sub-issues progress, Created, Updated, Closed, Priority, Size,
  Estimate, Iteration, Start date, Target date — in that order, derived at read time from the
  Issues registered under it and never persisted as `project_field` rows, so FR-21 stays true.
  The single-select columns SHALL be grouped from scoped labels (`status::doing`, `status/todo`;
  GitLab's own convention and SoloW's seeded taxonomy read the same way); the rest SHALL be read
  straight off the Issue.
- **FR-23a** A column SHALL be declared whether or not anything fills it. A table whose columns
  appear and disappear with the provider behind it is a table two people cannot compare, so a
  column with no value renders empty rather than being dropped. WHERE a column cannot be filled
  at all — Reviewers, which belongs to a change request and not to an issue on any provider; and
  Estimate, Iteration, Start date and Target date, which need a provider board a local Project by
  definition does not have — THE SYSTEM SHALL declare it read-only and state that specific
  reason, the same rule FR-5 and FR-16 already apply to a mirrored GitLab Project.
- **FR-24** THE SYSTEM SHALL populate an Issue's assignees and milestone during automatic
  ingestion (#125), not only when the Issue is read one at a time, and SHALL record the provider's
  own last-changed time for an Issue when the provider reports one, rather than only the time of
  the poll that read it.

## Non-functional requirements

- **NFR-1** The table SHALL stay responsive at a thousand items: rows virtualized, and a poll or
  an edit SHALL NOT re-render rows it did not change.
- **NFR-2** A read SHALL be served from the local mirror, never from a provider call per cell.
- **NFR-3** A provider's rate limit SHALL degrade the feature, not break it: polls back off, and
  the table says when it is showing data older than it should be.
- **NFR-4** Every provider call SHALL be authenticated by a stored `Secret` reference
  ([Decision 0014](../decisions/0014-direct-api-source-integrations.md)); no token reaches a
  payload, a log or the client (Principle IV).
- **NFR-5** Provider drivers SHALL be tested against recorded fixtures, never a live API
  (Principle VI).
- **NFR-6** Every row and value SHALL be scoped by `workspaceId` and filtered by it on every read
  (Principle V).
- **NFR-7** A write that fails SHALL leave the table showing the provider's value, with the
  failure stated — an optimistic value that silently stuck would be a table that lies.

## States & rules

- A Project belongs to exactly one Integration, because its fields are that provider's fields.
- An item is an Issue that SoloW has imported. An item with no issue behind it (Projects
  v2's "draft") is out of scope for a first version.
- The mirror is a cache and never the authority: on a conflict the provider's value wins, and the
  local row is corrected on the next poll.
- A field SoloW cannot map is still listed, read-only, named as the provider names it.
  Hiding it would make the table's column set a lie about what the project holds.
- Epic membership comes from the provider's own hierarchy — sub-issues on GitHub, epics or
  parent links on GitLab. SoloW does not invent a hierarchy of its own, and offers no way
  to create a parent a provider cannot store: that edge would be invisible everywhere else the
  team works. The edge is mirrored onto the child Issue as the provider's own parent id, which is
  what lets a parent that has not been imported yet still be recognised when it arrives.
- An epic's progress counts a child as done when the child's issue is **closed on the provider**,
  never when a Status field reads "Done". A status column is a team's convention — renamable,
  reorderable, and left behind by whoever closed the issue on GitHub instead. Closed is a fact.
- A linked pull or merge request on a row is the **provider's** link, mirrored and read-only.
  SoloW does not open, review, approve or merge one from this table — that is issue #71's,
  behind the review gate — and it is not the branch a SoloW Task produced either
  ([Decision 0006](../decisions/0006-kanban-scoped-to-issues.md)'s execution layer, recorded on
  the Task). Two different facts, two different columns: one says what the provider knows, the
  other what an agent did here, and merging them would answer neither question.
- Planning changes nothing about execution: moving a row to "In progress" does not start an
  agent, and a Task reaching Done does not move a row. The two layers are linked, not fused.
- A saved view is a **configuration over the Project's items, never a copy of them**: a name, a
  layout, a filter, a grouping, a sort and a visible column set. Every tab reads the same rows,
  which is why a value edited under `In review` is edited under `Prioritized backlog` too.
- The roadmap is a **second projection, not a second model** — the same items, laid on a timeline
  by their start and target dates. There is no roadmap item and no roadmap date to keep in step.
- A filter is stored as a parsed predicate rather than as the text somebody typed, so the language
  has one implementation and a saved view means the same thing to every reader of it. `@me` and
  `@current` stay symbolic and are resolved as the view is read — a shared `My items` tab is
  "mine" for whoever opens it, and `iteration:@current` still means the current iteration next
  month.
- A view is the team's; the per-user column arrangement (FR-3) rides on top of it. The first is
  what the tab shows everybody, the second is what one person hid on one screen.

## Edge cases & failure handling

- **A provider that cannot express a field** — read-only with the reason, per FR-5. The common
  case is GitLab Free, where iteration and weight are paid features.
- **A scoped-label convention that differs** — configured (FR-12). A team using `Status::Doing`
  is not misconfigured, it is a team.
- **Two people editing one field between polls** — last write wins and the provider's answer is
  rendered. Recorded as a known limit rather than solved
  ([Decision 0018](../decisions/0018-provider-owned-project-fields.md), *Out of scope*).
- **A token that cannot write** — the fields it cannot change render as values with the reason,
  read off the provider's declaration *before* any request. Discovering it at the first failed
  save would teach the operator that saving is unreliable rather than that a scope is missing.
- **Two people editing the same issue between reads** — last write wins, and the value that
  appears afterwards is the provider's own. Unchanged from
  [Decision 0018](../decisions/0018-provider-owned-project-fields.md), where it is recorded as a
  known limit rather than solved.
- **A rate limit** — the poll backs off and the table states its staleness. It does not spin,
  and it does not silently show hours-old data as current.
- **A token without write scope** — detected at connection and stated there, not discovered on
  the first failed edit.
- **A project row from a repository nobody connected** — the ordinary case, and once the reason a
  mirrored project could show nineteen columns and no rows. The row carries its issue, so the scan
  connects the repository from what the provider reports (`getRepository`) and imports the issue,
  rather than skipping the row on every pass for ever behind a count that reads like a race.
  Bounded at `REPOSITORY_CONNECT_CAP` per pass, and every repository connected is named in the
  report — a write into the operator's Workspace that they never see is the one kind they cannot
  undo. A provider that will not hand the repository over leaves the row genuinely waiting.
- **A row whose external id belongs to two repositories** — GitLab's `iid` restarts at 1 per
  project, so a row is resolved against *its own* repository first. Joining on the id alone would
  point a row at another repository's issue, which is worse than the empty table it replaced.
- **An issue deleted on the provider** — the row disappears on the next poll; anything SoloW
  attached to it (Tasks, review history) survives, because that is SoloW's own.
- **An item with no start or target date, under the roadmap** — listed beside the timeline, never
  dropped: "not scheduled" is the answer a roadmap is most often asked for. An item holding one of
  the two dates is drawn as a point on the day it knows, marked as having one date only —
  stretching it to the edge of the chart would invent the date it does not have.
- **A filter naming a column the project no longer has** — the clause matches nothing and the tab
  renders normally. A stored predicate that cannot be parsed at all degrades to no clauses, which
  shows more rows than intended rather than an empty table that looks like an empty project.
- **A project with no date field, under the roadmap** — said plainly, rather than drawn empty.
- **A thousand-item project on first sync** — paged, with the table usable while it fills, and a
  visible count of what has arrived.
- **An epic whose children span repositories** — nested normally. Sub-issue progress counts
  children wherever they live.
- **A child whose parent is not in the project** — rendered at the top level, never dropped. Work
  that cannot be nested is still work, and an issue that vanished because its epic lives in a
  repository nobody added is a table that lies about what is open.
- **A parent id that means two issues** — GitLab's `iid` restarts at 1 per project, so a parent is
  matched inside the child's own repository first, and an ambiguous one is refused rather than
  guessed at. Nesting a row under a stranger's epic is worse than leaving it at the top level.
- **A cycle the provider reports** — refused when read, not only when written: nothing here writes
  an edge, so read is the only place the refusal can happen. The edge that closes the loop is
  dropped, every row still renders exactly once, and a renderer that trusted the hierarchy would
  instead recurse until the stack ended.

## Out of scope

- **Creating or deleting a project on the provider.** SoloW mirrors one that exists.
- **Draft items** — a Projects v2 item with no issue behind it. Every row here is an Issue. They
  are **counted and reported**, never silently dropped: a table shorter than the same project on
  the provider, with nothing to explain the difference, is indistinguishable from a broken import.
  Pull-request rows are counted separately, because telling an operator they have three drafts
  when they have three pull requests is a wrong answer stated confidently.
- **Comments.** Reading and writing an issue's discussion is a client of its own; this table
  plans work, it does not host the conversation about it.
- **Charts and insights.** [F14](./F14-analytics-reporting.md) owns measurement; this is the
  table it would measure.
- **Automations** ("when status becomes X, do Y"). [F03](./F03-workflow-designer.md) owns
  orchestration, and a second rules engine here is the mistake issue #63 already names.
- **Conflict resolution between two editors.** See the decision record.
- **Jira, Linear and everything else.** F21's registry is what makes them possible later; this
  feature ships GitHub and GitLab.

## Related

- [F01 — Issue Management](./F01-issue-management.md)
- [F12 — External Integrations](./F12-integrations.md)
- [F21 — Integration Providers](./F21-integration-providers.md)
- [F19 — Extension Contributions](./F19-extension-contributions.md)
- [F02 — Kanban Task Administration](./F02-kanban-task-administration.md)
- [Decision 0018 — Mirror the provider's own planning fields](../decisions/0018-provider-owned-project-fields.md)
- [Decision 0016 — Register integration providers by capability](../decisions/0016-integration-provider-registry.md)
