import { randomUUID } from "node:crypto";
import type {
  AgentCapabilities,
  AgentPermissionMode,
  AgentProtocol,
  AuthMode,
  ChangeRequestState,
  ExecutorConfig,
  ExecutorKind,
  IssueMilestone,
  IssueSource,
  IssueStatus,
  LinkedChangeRequest,
  McpScope,
  ProjectFieldOption,
  ProjectFieldType,
  ProjectFilter,
  ProjectIteration,
  ProjectUser,
  ProjectViewLayout,
  RepositorySource,
  ReviewDecision,
  ScmProvider,
  SecretKind,
  SessionState,
  TaskCompletionOutcome,
  TaskState,
  WorkflowAdvanceOn,
  WorkflowStepAutomation,
  WorkflowStepGate,
} from "@solow/contracts";
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * SoloW data model — SQLite dialect (local-first primary store, Decision 0008).
 *
 * NOTE (Decision 0008 / risk R-6): "one data model, two stores" is implemented for
 * SQLite here. Drizzle uses separate dialect builders (sqliteTable vs pgTable), so the
 * Postgres mirror is a follow-up that reuses these column specs. Tracked as a Phase-2
 * hosted-path task; it does not affect the local v1 loop.
 *
 * Every table carries a non-null `workspaceId` (tenant key, constitution Principle V).
 */

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => randomUUID());

const createdAt = () =>
  text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);
const updatedAt = () =>
  text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);

export const workspace = sqliteTable("workspace", {
  id: id(),
  name: text("name").notNull(),
  /** The BetterAuth user who owns this Workspace (`auth_user.id`). */
  ownerUserId: text("owner_user_id").notNull(),
  /**
   * Per-Workspace feature-flag overrides, `{ "ff-core-program": true }` (task TASK-001).
   * The registry default stays OFF, so a Workspace with no entry here has the feature off and
   * clearing the column is the kill switch.
   */
  enabledFlags: text("enabled_flags", { mode: "json" }).$type<Record<string, boolean>>(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * SCM integrations (issue #15, spec F12). One connected GitHub or GitLab account per row; the
 * PAT lives in `secret` (Principle IV) and is only ever reached through `secretId`.
 */
export const integration = sqliteTable(
  "integration",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    provider: text("provider").$type<ScmProvider>().notNull(),
    secretId: text("secret_id").notNull(),
    /** GitHub Enterprise Server / self-managed GitLab host; null for the public SaaS API. */
    baseUrl: text("base_url"),
    writeBackEnabled: integer("write_back_enabled", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({ byWs: index("integration_ws").on(t.workspaceId) }),
);

export const issue = sqliteTable(
  "issue",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    title: text("title").notNull(),
    description: text("description"),
    /**
     * A person's deliberate status, overriding the one derived from this Issue's Tasks (spec
     * F01 FR-7). Null — the normal case — means "follow the Tasks", which is what
     * `deriveIssueStatus` answers.
     *
     * This replaces a `status` column that was written once at creation and then never updated:
     * with the status derived on read, a stored copy of it was a second source of truth that
     * spent its life wrong. What is stored now is only the part nothing else can know, namely
     * that a person disagreed with the Tasks — recorded with who and when, because an override
     * outliving the reason for it is how a board starts lying.
     */
    statusOverride: text("status_override").$type<IssueStatus>(),
    statusOverrideAt: text("status_override_at"),
    /** `auth_user.id` of whoever set the override, or the dev-owner stand-in. */
    statusOverrideBy: text("status_override_by"),
    /**
     * Every Issue is imported now (issue #15) — `source`/`integrationId`/`externalId` are set
     * together by the import DAL. `"local"` is the value existing pre-#15 rows carry; nothing
     * creates a new one.
     */
    source: text("source").$type<IssueSource>().notNull().default("local"),
    integrationId: text("integration_id").references(() => integration.id),
    repositoryId: text("repository_id").references(() => repository.id),
    externalId: text("external_id"),
    externalNumber: integer("external_number"),
    externalUrl: text("external_url"),
    syncedAt: text("synced_at"),
    /**
     * Free-text labels (issue #15 reversal, 2026-08-20). A JSON array rather than a
     * label/issue_label join table: at this scale (a handful of short strings per Issue, never
     * queried by label) a normalized many-to-many buys referential integrity nobody needs and
     * costs a join on every list read. Set directly for a local Issue; mirrored from the
     * provider's own label names for an imported one (the picker fetches real labels via
     * `repository.listLabels`, but nothing here enforces they still exist on the provider).
     */
    labels: text("labels", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    /**
     * Pull or merge requests the provider itself links to this Issue (spec F23 FR-8, issue #128).
     *
     * A JSON column for the same reason `labels` is one: a handful of entries per Issue, replaced
     * wholesale by every poll and never queried by, where a join table would buy referential
     * integrity over rows SoloW does not own and cost a join on every list read.
     *
     * Deliberately **not** the `change_request` table below. That one mirrors a repository's
     * change requests and knows nothing about which of them closes which issue; this is the
     * provider's own answer to that question, and it belongs to the issue it answers for.
     *
     * Deliberately **not** the branch a Task produced either (issue #104): provider-linked and
     * agent-produced are two different facts, and one column holding both would answer neither.
     */
    linkedChangeRequests: text("linked_change_requests", { mode: "json" })
      .$type<LinkedChangeRequest[]>()
      .notNull()
      .default(sql`'[]'`),
    /**
     * Who the provider has this Issue assigned to, mirrored (spec F23 FR-8, user request
     * 2026-08-28). A JSON column for the same reason `labels`/`linkedChangeRequests` are: a
     * handful of people per Issue, replaced wholesale by every poll, never queried by.
     *
     * This existed as data the whole time — every driver's issue-read already parsed it off the
     * provider's response — but nothing here had a column to put it in, so #125's automatic sync
     * read it and threw it away on every single pass.
     */
    assignees: text("assignees", { mode: "json" })
      .$type<ProjectUser[]>()
      .notNull()
      .default(sql`'[]'`),
    /**
     * The milestone the provider has this Issue under, mirrored (spec F23 FR-8, user request
     * 2026-08-28). Null for an Issue on no milestone, and for one imported before this column
     * existed — the same "null is not a fact yet" rule `externalState` already states for
     * exactly this reason.
     */
    milestone: text("milestone", { mode: "json" }).$type<IssueMilestone | null>(),
    /**
     * Open or closed **on the provider** (spec F23 FR-13, issue #127 AC-3).
     *
     * Separate from `statusOverride` and from the status derived from Tasks, and it has to be:
     * those are SoloW's answer to "how is this going", and this is the provider's answer to
     * "is it finished". An epic's progress is counted from this one, because a Status field is a
     * team's convention — renamable, reorderable, and left behind by whoever closed the issue on
     * GitHub instead — where closed is a fact.
     *
     * Null for a local Issue and for one imported before the column existed. Null is *not* open:
     * a mirror that guessed would report work as unfinished, or finished, on no evidence.
     */
    externalState: text("external_state").$type<"open" | "closed">(),
    /**
     * The parent issue's `externalId`, as the provider reported it (issue #127).
     *
     * A column on the child rather than an edge table, because every hierarchy this mirrors is
     * single-parent — a GitHub sub-issue has one parent, a GitLab work item has one — so the edge
     * *is* a property of the child. An edge table would let the mirror hold a shape no provider
     * can express, and would then need a uniqueness constraint whose only job was to forbid it.
     *
     * The **provider's** id, not a local `issue.id`, and not a foreign key: the parent may not be
     * imported yet, may live in a repository this Workspace never added, or may never arrive. A
     * foreign key would force the edge to be dropped or the parent to be invented, and both lose
     * information the provider gave us. Resolving it to a row is a read-time question, answered by
     * `buildProjectHierarchy` — which is also where a parent that resolves to nothing becomes a
     * top-level row rather than a dropped one.
     *
     * Nothing but the sync writes this. SoloW does not offer to create a parent the provider
     * cannot store (F23, States & rules — the hierarchy is the provider's).
     */
    externalParentId: text("external_parent_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    byStatus: index("issue_ws_status").on(t.workspaceId, t.statusOverride),
    byCreated: index("issue_ws_created").on(t.workspaceId, t.createdAt),
    /**
     * Idempotent import (issue #15 AC-2 / DoD), scoped per **Repository**, not per Integration.
     * GitHub's issue `id` is globally unique, but GitLab's `iid` is scoped *per project* and
     * restarts at 1 — so two Repositories linked to the same Integration (one GitLab account,
     * several projects) would collide on `(integrationId, externalId)` alone: project A's issue
     * #1 and project B's issue #1 both map to the same key, and the second import would
     * silently no-op onto the first's row instead of creating its own (caught in adversarial
     * review before merge). `externalId` only has to be unique within the Repository it came
     * from, which `(repositoryId, externalId)` states directly. SQLite treats each NULL as
     * distinct, so any number of `source: "local"` rows (both columns null) coexist without
     * tripping this index.
     */
    byExternal: uniqueIndex("issue_repository_external").on(t.repositoryId, t.externalId),
    /**
     * "Which issues report this one as their parent" — the question a project table asks once per
     * render, over the Workspace it is scoped to (Principle V). Without it that is a scan of every
     * Issue the Workspace has ever imported.
     */
    byParent: index("issue_ws_parent").on(t.workspaceId, t.externalParentId),
  }),
);

/**
 * Agent catalog (issue #10, spec F05). Agent identity as data: adding a supported agent is a
 * seed row plus an Agent Profile pointing at it, not a change to `agent_profile.agentKind` and
 * every place that used to switch on it.
 *
 * Workspace-scoped like every other tenant-owned table (Principle V) — a self-hoster who wires
 * up a custom agent CLI does it for their own Workspace.
 *
 * `subscriptionEnvVar` / `meteredEnvVar` are why this is a table and not a JSON blob: the
 * billing strip (`resolveAgentRunEnv`) used to hardcode Claude Code's two variable names. That
 * guarantee is SoloW's headline differentiator, and it must not silently stop holding the
 * moment a second agent's row is added — so which variables to strip is read off this row, not
 * assumed.
 */
export const agentCatalog = sqliteTable(
  "agent_catalog",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    key: text("key").notNull(),
    displayName: text("display_name").notNull(),
    protocol: text("protocol").$type<AgentProtocol>().notNull(),
    command: text("command").notNull(),
    argsTemplate: text("args_template", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    installHint: text("install_hint"),
    subscriptionEnvVar: text("subscription_env_var").notNull(),
    meteredEnvVar: text("metered_env_var").notNull(),
    /** A cache of the agent's last advertised models/modes — see `AgentCapabilities`. */
    capabilities: text("capabilities", { mode: "json" })
      .$type<AgentCapabilities>()
      .notNull()
      .default(sql`'{"models":[],"modes":[]}'`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    byWs: index("agent_catalog_ws").on(t.workspaceId),
    byKey: uniqueIndex("agent_catalog_ws_key").on(t.workspaceId, t.key),
  }),
);

export const agentProfile = sqliteTable(
  "agent_profile",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    name: text("name").notNull(),
    agentCatalogId: text("agent_catalog_id")
      .notNull()
      .references(() => agentCatalog.id),
    authMode: text("auth_mode").$type<AuthMode>().notNull(),
    secretId: text("secret_id").notNull(),
    concurrencyCap: integer("concurrency_cap").notNull().default(3),
    /**
     * How much the agent may do without asking (spec F05). Defaults to the value every Profile
     * effectively ran as before the column existed, so an existing row's behaviour is unchanged
     * by the migration that added it.
     */
    permissionMode: text("permission_mode")
      .$type<AgentPermissionMode>()
      .notNull()
      .default("acceptEdits"),
    /**
     * Which model and mode this Profile launches its agent with (issue #94).
     *
     * Nullable, and null is the ordinary value: it means "whatever the agent chooses". A default
     * written here would be a model id that rots the first time a provider retires one, and a
     * stale pin fails at launch rather than at the moment somebody could have fixed it.
     */
    model: text("model"),
    modeId: text("mode_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({ byWs: index("agent_profile_ws").on(t.workspaceId) }),
);

export const executorProfile = sqliteTable(
  "executor_profile",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    name: text("name").notNull(),
    /**
     * Denormalised copy of `config.kind`, derived by the DAL on every write so the kind is
     * queryable. The configuration is the source of truth; nothing sets this independently.
     */
    kind: text("kind").$type<ExecutorKind>().notNull().default("local"),
    /**
     * Per-kind configuration, validated by the discriminated union in `@solow/contracts`
     * (issue #73). One JSON column rather than a column — or a table — per kind is what makes a
     * new Executor kind a driver plus a union member instead of a migration (AC-5).
     *
     * The SQL default exists so the column can be added to a populated table; every write goes
     * through the DAL and states a configuration explicitly.
     */
    config: text("config", { mode: "json" })
      .$type<ExecutorConfig>()
      .notNull()
      .default(sql`'{"kind":"local","env":{}}'`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({ byWs: index("executor_profile_ws").on(t.workspaceId) }),
);

export const repository = sqliteTable(
  "repository",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    name: text("name").notNull(),
    source: text("source").$type<RepositorySource>().notNull(),
    location: text("location").notNull(),
    /** Set together, once linked to an Integration (issue #15) — null for a purely local repo. */
    integrationId: text("integration_id").references(() => integration.id),
    /** The provider's own identifier — "owner/repo" for GitHub, "namespace/path" for GitLab. */
    externalFullName: text("external_full_name"),
    /**
     * The watermark an automatic issue sync resumes from (issue #125).
     *
     * The provider's own "updated after" filter, not a page number: pages shift under a sync as
     * issues are edited, and re-reading a repository's whole history every few minutes is what
     * exhausts a rate limit. Null means never synced, which is a full first read.
     */
    issuesSyncedAt: text("issues_synced_at"),
    /**
     * When this repository's data stopped being current, and why.
     *
     * Set when a poll backs off — a rate limit, an unreachable host — and cleared by the next
     * poll that succeeds. It exists so a table can say it is showing stale data rather than
     * present hours-old rows as current, which is the failure F23 NFR-3 names.
     */
    syncStaleSince: text("sync_stale_since"),
    syncStaleReason: text("sync_stale_reason"),
    /**
     * Repository-relative globs for files copied into each new worktree (issue #52) — a `.env`
     * the agent needs to run the test suite, not a general "copy what git ignores".
     *
     * Stored as a list rather than a single joined string so a pattern containing a separator
     * cannot silently become two, and so the maximum length is a property of the list.
     */
    setupFilePatterns: text("setup_file_patterns", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({ byWs: index("repository_ws").on(t.workspaceId) }),
);

/** A Repository's branches, as last synced from its Integration (issue #15). */
export const repositoryBranch = sqliteTable(
  "repository_branch",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repository.id),
    name: text("name").notNull(),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    headSha: text("head_sha").notNull(),
    headCommittedAt: text("head_committed_at"),
    syncedAt: text("synced_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    byRepo: index("repository_branch_repo").on(t.repositoryId),
    byName: uniqueIndex("repository_branch_repo_name").on(t.repositoryId, t.name),
  }),
);

/**
 * A Repository's change requests (GitHub pull requests / GitLab merge requests), as last synced
 * from its Integration (issue #15). Reference-only today — SoloW does not open or merge
 * these; that is issue #71, gated on #7.
 */
export const changeRequest = sqliteTable(
  "change_request",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repository.id),
    integrationId: text("integration_id")
      .notNull()
      .references(() => integration.id),
    externalId: text("external_id").notNull(),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    state: text("state").$type<ChangeRequestState>().notNull(),
    url: text("url").notNull(),
    headRef: text("head_ref").notNull(),
    baseRef: text("base_ref").notNull(),
    authorLogin: text("author_login"),
    syncedAt: text("synced_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    byRepo: index("change_request_repo").on(t.repositoryId),
    // Same reasoning as `issue`'s `issue_repository_external`: GitLab's merge-request `iid` is
    // scoped per project, so this must be scoped per Repository, not per Integration.
    byExternal: uniqueIndex("change_request_repository_external").on(t.repositoryId, t.externalId),
  }),
);

export const task = sqliteTable(
  "task",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    issueId: text("issue_id")
      .notNull()
      .references(() => issue.id),
    title: text("title").notNull(),
    state: text("state").$type<TaskState>().notNull().default("backlog"),
    agentProfileId: text("agent_profile_id")
      .notNull()
      .references(() => agentProfile.id),
    executorProfileId: text("executor_profile_id")
      .notNull()
      .references(() => executorProfile.id),
    failureReason: text("failure_reason"),
    /**
     * What the agent said about how its run ended, and when it said it (spec F22 / the
     * completion gate).
     *
     * Columns rather than a read of the session log, because the board asks this question once
     * per card on every render: "has this Task finished?" is a property of the Task, and
     * answering it by scanning each Task's events would put a subquery per tile on the one
     * screen that has to stay fast.
     *
     * Null means the agent has not declared anything — which is *not* the same as failing.
     * Nothing here moves the Task: the declaration is a report, and the person decides
     * (Principle I). `completedOutcome` is the agent's own word from `task_complete`, so a run
     * that finished having changed nothing is distinguishable from one that produced work.
     */
    completedAt: text("completed_at"),
    completedOutcome: text("completed_outcome").$type<TaskCompletionOutcome>(),
    /** What the agent wants read before the diff is opened. Shown on the card and in the header. */
    completedSummary: text("completed_summary"),
    /**
     * The Workflow this Task follows, and where it has got to (issue #5). All four are nullable
     * and every Task that exists today has them null, which is exactly "this Task follows no
     * Workflow" — `task.agent_profile_id` remains the agent for a Task that has none.
     *
     * The cursor is a Step *id* rather than an ordinal on purpose: an ordinal is invalidated by
     * the next Step inserted above it, so a restart would resume a Task at whatever now sits at
     * position 2 rather than at the Step it was actually running (Principle III, AC-5).
     */
    workflowId: text("workflow_id").references(() => workflow.id),
    workflowStepId: text("workflow_step_id").references(() => workflowStep.id),
    /** The `workflow.version` in force when this Task was attached, so a mid-run edit is detectable. */
    workflowVersion: integer("workflow_version"),
    /**
     * The previous Step's summary, carried into the next Step's brief (AC-2). A column rather
     * than a variable in the run loop because a handoff that lives only in the loop is lost by
     * the very restart Principle III exists to survive.
     */
    workflowHandoff: text("workflow_handoff"),
    /**
     * What the *current* Step has reported, not yet promoted into `workflow_handoff`.
     *
     * Two columns rather than one because a Step reports it has finished before it is allowed to
     * move: an `agent-signal` Step behind a `human` gate hands over its summary, waits for the
     * decision, and is then replayed by whatever noticed the decision — a caller that no longer
     * has the agent's words. Writing the summary into `workflow_handoff` immediately would
     * instead corrupt the brief of the Step still running, which is built from the *previous*
     * Step's handoff.
     */
    workflowPendingHandoff: text("workflow_pending_handoff"),
    /**
     * The `review` row this Task has already spent on a gate (Principle I, AC-4).
     *
     * An approval releases one gate. Without recording which one was used, the question the gate
     * asks degrades from "has this change been approved" to "has anyone ever looked at this
     * Task", and the first approval in a pipeline silently authorises every Step after it.
     *
     * Deliberately not a foreign key to `review`: this is a record of something that happened,
     * and it must keep its meaning even if the row it names is one day archived away.
     */
    workflowDecisionId: text("workflow_decision_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    byState: index("task_ws_state").on(t.workspaceId, t.state),
    byIssue: index("task_issue").on(t.issueId),
    /** Serves the "is this Workflow still in use" check that refuses a delete. */
    byWorkflow: index("task_workflow").on(t.workspaceId, t.workflowId),
    /**
     * Serves the narrower "is a Task parked on this Step" check that refuses a Step delete.
     * `task_workflow` cannot: a prefix of `(workspace_id, workflow_id)` says nothing about the
     * cursor, so without this every Step edit scans the Workspace's whole `task` table.
     */
    byWorkflowStep: index("task_workflow_step").on(t.workspaceId, t.workflowStepId),
  }),
);

/**
 * A Workflow — a repeatable pipeline of Steps, each run by its own Agent Profile (issue #5,
 * spec F03). The example the issue is written around is one row here with three Steps:
 * one agent plans, another implements, a third reviews.
 *
 * `version` is bumped by every Step write and recorded on a Task when it attaches, so editing a
 * definition underneath a running Task is *detectable* rather than silently applied. It is not
 * copy-on-write versioning — a snapshot table with no producer would be a table nothing writes —
 * but it is the half of it that cannot be added retroactively once Tasks are already attached.
 */
export const workflow = sqliteTable(
  "workflow",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    name: text("name").notNull(),
    description: text("description"),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    byWs: index("workflow_ws").on(t.workspaceId),
    /**
     * A Workflow is chosen by name in a Select, and two rows sharing one name make that choice a
     * coin flip — the same reasoning as `agent_catalog_ws_key`.
     */
    byName: uniqueIndex("workflow_ws_name").on(t.workspaceId, t.name),
  }),
);

/**
 * One Step of a Workflow.
 *
 * `agent_profile_id` is a foreign key to the Agent Profile catalog (issue #10) rather than a
 * second way of naming an agent. That is what AC-3 actually asks for: a Task using different
 * agents across Steps is this column differing between two rows, not a parallel agent registry
 * that would have to be kept in step with the first.
 *
 * `rank` is a lexicographic string, not an integer position — see `rankBetween` in
 * `@solow/core` for why. Inserting a Step in the middle writes exactly one row and leaves
 * every other row's `rank` and `updated_at` untouched.
 */
export const workflowStep = sqliteTable(
  "workflow_step",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflow.id),
    rank: text("rank").notNull(),
    name: text("name").notNull(),
    agentProfileId: text("agent_profile_id")
      .notNull()
      .references(() => agentProfile.id),
    promptTemplate: text("prompt_template").notNull().default(""),
    gate: text("gate").$type<WorkflowStepGate>().notNull().default("human"),
    advanceOn: text("advance_on").$type<WorkflowAdvanceOn>().notNull().default("review"),
    /**
     * The automation fired when a Task enters this Step (issue #63). Reserved before anything
     * fires it, because issue #5's third constraint is that automations are a Step property
     * rather than a second rules engine — and adding the column after Tasks are attached is a
     * migration on a populated table plus that argument reopened.
     */
    onEnter: text("on_enter", { mode: "json" }).$type<WorkflowStepAutomation>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    byWs: index("workflow_step_ws").on(t.workspaceId),
    /** Unique, because uniqueness is what makes the order total rather than insertion-dependent. */
    byOrder: uniqueIndex("workflow_step_order").on(t.workflowId, t.rank),
  }),
);

/**
 * Which Repositories a Task works in, and on which branch (issue #7). One row per attachment;
 * this replaced `task.repository_id` / `task.base_ref` / `task.result_branch`.
 *
 * Keyed on `(task, repository, branch)` rather than on `(task, repository)`. That is the whole
 * point of the change: one Task producing two branches of one Repository — several change
 * requests out of one unit of work — is then a second row rather than a second migration, and it
 * costs nothing to state now while every Task still attaches exactly one Repository.
 *
 * `checkout_branch` is NOT NULL for that key to mean anything. SQLite treats every NULL as
 * distinct, so a nullable branch column would make the unique index enforce nothing at all: two
 * rows for the same `(task, repository)` would both be accepted and "which worktree is this
 * Task's" would be decided by insertion order. The value is either the Owner's or the
 * deterministic name `taskCheckoutBranch` derives, so it is always known at insert time.
 *
 * `result_branch` is a separate column from `checkout_branch` even though the two are equal
 * today — the branch the work was committed onto is the branch it was checked out on. They stop
 * being equal the moment the work is pushed somewhere else (#57/#100), and `base_ref` living
 * here rather than on the Task is what lets a diff base become per-repository, mutable state
 * (#84). Both are the cheap-now half of work that is expensive later.
 */
export const taskRepository = sqliteTable(
  "task_repository",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    taskId: text("task_id")
      .notNull()
      .references(() => task.id),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repository.id),
    /** Where the worktree starts from. Null means HEAD, exactly as `task.base_ref` did. */
    baseRef: text("base_ref"),
    checkoutBranch: text("checkout_branch").notNull(),
    /** Set on approval, once the change has actually been committed onto a branch. */
    resultBranch: text("result_branch"),
    position: integer("position").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    byTask: index("task_repository_task").on(t.taskId),
    /** The tenant-scoped read the board does once for every card (Principle V). */
    byWs: index("task_repository_ws").on(t.workspaceId),
    byBranch: uniqueIndex("task_repository_task_repo_branch").on(
      t.taskId,
      t.repositoryId,
      t.checkoutBranch,
    ),
    /** So "which attachment is primary" has exactly one answer, forever — see `primaryTaskRepository`. */
    byPosition: uniqueIndex("task_repository_task_position").on(t.taskId, t.position),
  }),
);

/**
 * Task dependency edges (issue #6). One row per `blocked_by` relationship: `taskId` cannot start
 * until `blockedByTaskId` is done.
 *
 * There is no constraint here that keeps the graph acyclic, and there cannot be — reachability
 * is not something SQLite can express. The invariant is enforced at write time by
 * `checkDependencyEdge` in `@solow/core`, before the insert, so a cycle is refused with
 * the offending path instead of being discovered later as a Task that silently never starts.
 *
 * `createdAt` only, no `updatedAt`: an edge is declared or withdrawn, never amended — the same
 * shape choice `sessionUsage` makes with its bare `at`.
 */
export const taskDependency = sqliteTable(
  "task_dependency",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    taskId: text("task_id")
      .notNull()
      .references(() => task.id),
    blockedByTaskId: text("blocked_by_task_id")
      .notNull()
      .references(() => task.id),
    createdAt: createdAt(),
  },
  (t) => ({
    /** Re-declaring an existing dependency is a no-op, not a second row that must be removed twice. */
    byEdge: uniqueIndex("task_dependency_edge").on(t.taskId, t.blockedByTaskId),
    byBlockedBy: index("task_dependency_blocked_by").on(t.blockedByTaskId),
    /** The DFS loads the tenant subgraph and nothing else (Principle V). */
    byWs: index("task_dependency_ws").on(t.workspaceId),
  }),
);

/**
 * A planning project — mirrored from a provider, or held **locally** (spec F23, Decision 0018,
 * user request 2026-08-27).
 *
 * The mirrored case is what 0018 is about: a project is a GitHub Project or a GitLab
 * group-plus-labels, and belongs to exactly one Integration because its fields are that
 * provider's fields. But 0018's own words are "GitLab has no GitHub Projects" — and for a
 * provider with nothing to adopt at all (Gitea has no `projects` capability; a GitLab instance
 * a token cannot see a group-level project on is the same shape of nothing), the mirrored case
 * left an Owner with no Project, ever. That is the gap this reopens, on the same terms issue
 * #15 already used to reopen local Issue creation: **SoloW still creates nothing on any
 * provider.** A local Project is a container SoloW owns outright, and the Repositories
 * registered under it (`projectRepository`) are how its Issues are decided — every Issue in a
 * member Repository is a member of the Project, kept that way as new Issues arrive
 * (`attachIssueToLocalProjects`), the same automatic-ingestion promise #125 makes for Issues
 * themselves.
 *
 * `integrationId`/`providerProjectId` are therefore nullable, together: both null is a local
 * Project, both set is a mirrored one. There is no third state, which is why nothing here
 * validates the pair beyond the type — the DAL is the one layer that ever constructs a row, and
 * every path it offers writes one or the other whole.
 */
export const project = sqliteTable(
  "project",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    /** Null for a local Project — see the table's own comment. */
    integrationId: text("integration_id").references(() => integration.id),
    /** The provider's own id. Opaque, and the key — the title is a label people rename. Null for a local Project. */
    providerProjectId: text("provider_project_id"),
    title: text("title").notNull(),
    /**
     * When the mirror last agreed with the provider. Null until the first sync completes — and,
     * for a local Project, set once at creation rather than left null forever: there is no
     * provider to disagree with, so "never synced" would read as a fault this Project can never
     * clear, on the one kind of Project for which that is simply not true.
     */
    syncedAt: text("synced_at"),
    /**
     * Where a paged sync got to, so a restart resumes rather than starting over.
     *
     * On the project rather than on the item, because the thing being resumed is the *walk*: an
     * item-level marker would say which rows exist and not where the provider's pagination had
     * reached, which is the only question a resume has to answer. Always null for a local
     * Project — there is no provider walk to resume.
     */
    syncCursor: text("sync_cursor"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    byWs: index("project_ws").on(t.workspaceId),
    /**
     * One row per provider project: a second would make "which mirror is current" ambiguous.
     * Silent on a local Project — SQLite treats every NULL in a unique index as distinct from
     * every other, so `(null, null)` never collides with itself, which is exactly "not this
     * constraint's business" rather than "coincidentally allowed".
     */
    byProvider: uniqueIndex("project_integration_provider").on(
      t.integrationId,
      t.providerProjectId,
    ),
  }),
);

/**
 * A Repository registered under a local Project (spec F23, user request 2026-08-27).
 *
 * This is what makes a local Project's membership a *decision* rather than a sync: a mirrored
 * Project's rows come from walking a provider's own board, and a local Project has no board to
 * walk, so an Owner states which Repositories' Issues belong to it instead. Every Issue in a
 * registered Repository becomes a `project_item` here — on registration (the backfill) and on
 * arrival (`attachIssueToLocalProjects`, called from Issue creation and from #125's automatic
 * ingestion) — so the Project stays populated the same "nothing is imported by hand" way F23
 * already promises, without a provider board behind it to promise it *from*.
 *
 * Meaningless on a mirrored Project, which is why nothing here references one by name: the DAL
 * refuses to attach a Repository to a Project that has an `integrationId`, because a mirrored
 * Project's membership is the provider's answer, not this table's.
 */
export const projectRepository = sqliteTable(
  "project_repository",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repository.id),
    createdAt: createdAt(),
  },
  (t) => ({
    byWs: index("project_repository_ws").on(t.workspaceId),
    /** One membership per pair — attaching twice is a no-op the unique index refuses, not a duplicate. */
    byPair: uniqueIndex("project_repository_pair").on(t.projectId, t.repositoryId),
    /** The reverse lookup: which local Projects does this Repository feed. Ingestion's own read. */
    byRepository: index("project_repository_repository").on(t.repositoryId),
  }),
);

/**
 * One column of a project, as the provider describes it.
 *
 * `readOnly` and its reason are the provider's answer to "can you hold this", recorded at sync
 * (Decision 0018). A GitLab Free instance stores its number fields here read-only with "weights
 * need a paid tier" attached, and the table renders a value with a sentence rather than an input
 * whose save would fail.
 */
export const projectField = sqliteTable(
  "project_field",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id),
    providerFieldId: text("provider_field_id").notNull(),
    name: text("name").notNull(),
    type: text("type").$type<ProjectFieldType>().notNull(),
    /** Single-select options, as the provider names and colours them. */
    options: text("options", { mode: "json" })
      .$type<ProjectFieldOption[]>()
      .notNull()
      .default(sql`'[]'`),
    /** Iterations, for an iteration field. Empty for every other type. */
    iterations: text("iterations", { mode: "json" })
      .$type<ProjectIteration[]>()
      .notNull()
      .default(sql`'[]'`),
    position: integer("position").notNull().default(0),
    readOnly: integer("read_only", { mode: "boolean" }).notNull().default(false),
    readOnlyReason: text("read_only_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    byProject: index("project_field_project").on(t.projectId, t.position),
    /** Keyed on the provider's id, so renaming a field updates it rather than doubling it. */
    byProviderField: uniqueIndex("project_field_provider").on(t.projectId, t.providerFieldId),
  }),
);

/**
 * One row of the table: an Issue, in a project.
 *
 * `issueId` is the join to everything SoloW already owns — the row's Tasks, its review
 * history, its worktrees. That join is the whole reason this is a projection over Issues rather
 * than a second Issue model (F23, Summary).
 */
export const projectItem = sqliteTable(
  "project_item",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id),
    issueId: text("issue_id")
      .notNull()
      .references(() => issue.id),
    providerItemId: text("provider_item_id").notNull(),
    position: integer("position").notNull().default(0),
    /** Archived on the provider. Kept, because a row that vanishes takes its history with it. */
    archivedAt: text("archived_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    byProject: index("project_item_project").on(t.projectId, t.position),
    /** The reverse lookup: which projects hold this Issue. */
    byIssue: index("project_item_issue").on(t.issueId),
    byProviderItem: uniqueIndex("project_item_provider").on(t.projectId, t.providerItemId),
  }),
);

/**
 * One cell.
 *
 * `value` is JSON rather than a column per type, because a typed column set means a migration
 * every time a provider grows a field type — and the value is parsed against its *field's* type
 * on read (`parseProjectFieldValue`), so a value whose shape no longer matches degrades to an
 * empty cell rather than to a row that will not render. The same rule `ui_preference` follows,
 * for the same reason.
 */
export const projectValue = sqliteTable(
  "project_value",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    itemId: text("item_id")
      .notNull()
      .references(() => projectItem.id),
    fieldId: text("field_id")
      .notNull()
      .references(() => projectField.id),
    value: text("value", { mode: "json" }).$type<unknown>(),
    syncedAt: createdAt(),
  },
  (t) => ({
    /** One value per cell. The pair is the identity, which makes a write an upsert. */
    byCell: uniqueIndex("project_value_cell").on(t.itemId, t.fieldId),
    byField: index("project_value_field").on(t.fieldId),
  }),
);

/**
 * One saved view over a project — a tab (spec F23 FR-9, issue #129).
 *
 * A configuration, never a copy of the rows: there is no item column here and there never will
 * be one. Every tab reads the same `project_item`s, which is what makes a value edited under one
 * tab an edit under all of them.
 *
 * The filter is stored as the parsed predicate rather than as the text someone typed, so the
 * language has exactly one implementation (`@solow/core`'s parser) and a reader that is
 * not the table — a count, an export, an MCP tool — cannot disagree with it about what a saved
 * view means.
 */
export const projectView = sqliteTable(
  "project_view",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id),
    name: text("name").notNull(),
    /** Tab order, ascending — the order the team put them in, not an alphabetisation. */
    position: integer("position").notNull().default(0),
    layout: text("layout").$type<ProjectViewLayout>().notNull().default("table"),
    filter: text("filter", { mode: "json" })
      .$type<ProjectFilter>()
      .notNull()
      .default(sql`'{"terms":[]}'`),
    /** A single-select field id. Null renders one flat list, as the table already means. */
    groupByFieldId: text("group_by_field_id"),
    /** A field id or `@title`; the direction rides beside it. Null leaves the mirror's order. */
    sortField: text("sort_field"),
    sortDirection: text("sort_direction").$type<"asc" | "desc">(),
    /**
     * Which columns this view shows. **Null is every column** — not the same as an empty list:
     * a view saved before a sync added a field should show that field, and a view whose author
     * hid all of them should show none. One of those two views would be a lie if the column set
     * defaulted to `[]`.
     */
    visibleFieldIds: text("visible_field_ids", { mode: "json" }).$type<string[]>(),
    /**
     * Leave rows the provider has closed out of this view.
     *
     * Defaults to false so every view saved before this column existed keeps showing everything:
     * hiding rows from somebody's saved tab is not a migration, it is a change to what their tab
     * means.
     */
    hideClosed: integer("hide_closed", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    /** The tab strip, in order. Every read of this table is "the views of one project". */
    byProject: index("project_view_project").on(t.projectId, t.position),
    byWs: index("project_view_ws").on(t.workspaceId),
  }),
);

export const worktree = sqliteTable(
  "worktree",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    taskId: text("task_id")
      .notNull()
      .references(() => task.id),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repository.id),
    path: text("path").notNull(),
    branch: text("branch").notNull(),
    status: text("status").$type<"active" | "removed">().notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    byTask: index("worktree_task").on(t.taskId),
    /**
     * A Task's worktree at a given path is one row.
     *
     * Unique because the pair *is* the identity: a directory belongs to one Task, and a second
     * row for it would make "how many working copies does this Task hold" a question with two
     * answers decided by insertion order. It also turns the write into an upsert — the DAL read
     * first for idempotence before this index existed, which is a race dressed as a guard.
     */
    byPath: uniqueIndex("worktree_task_path").on(t.taskId, t.path),
  }),
);

export const session = sqliteTable(
  "session",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    taskId: text("task_id")
      .notNull()
      .references(() => task.id),
    state: text("state").$type<SessionState>().notNull().default("active"),
    diffRef: text("diff_ref"),
    startedAt: createdAt(),
    endedAt: text("ended_at"),
  },
  (t) => ({ byTask: index("session_task_started").on(t.taskId, t.startedAt) }),
);

export const sessionEvent = sqliteTable(
  "session_event",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    sessionId: text("session_id")
      .notNull()
      .references(() => session.id),
    seq: integer("seq").notNull(),
    kind: text("kind").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
    at: createdAt(),
  },
  (t) => ({ bySeq: uniqueIndex("session_event_seq").on(t.sessionId, t.seq) }),
);

/**
 * A summary standing in for a closed range of a Session's event log (issue #2, AC-2/AC-3).
 *
 * A separate table rather than a summary *event*, for a concrete reason: `seq` inside a live run
 * is an in-memory counter held for the life of the durable step, so a compactor inserting into
 * the same sequence would collide with the agent still writing to it. Keeping summaries out of
 * `session_event` also keeps that table exactly what it claims to be — what the agent produced,
 * with nothing derived mixed in.
 *
 * Compaction can only ever insert here. There is no code path that deletes or updates a
 * `session_event` row, which is what makes "replay stays lossless" a structural property rather
 * than a discipline: a summary is an index into history, never a replacement for it, and the
 * review gate keeps its evidence (Principle I).
 *
 * `(session_id, from_seq)` is the idempotency key, the same way `session_event_seq` and
 * `session_usage_turn` are theirs: a durable step that re-runs after an orchestrator restart
 * re-inserts the same range as a no-op rather than a duplicate (Principle III).
 */
export const sessionSummary = sqliteTable(
  "session_summary",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    sessionId: text("session_id")
      .notNull()
      .references(() => session.id),
    /** Inclusive on both ends. */
    fromSeq: integer("from_seq").notNull(),
    toSeq: integer("to_seq").notNull(),
    /** How many events the range actually held — not `toSeq - fromSeq`, which counts gaps. */
    eventCount: integer("event_count").notNull(),
    text: text("text").notNull(),
    at: createdAt(),
  },
  (t) => ({
    byRange: uniqueIndex("session_summary_range").on(t.sessionId, t.fromSeq),
    bySession: index("session_summary_session").on(t.workspaceId, t.sessionId, t.fromSeq),
  }),
);

/**
 * Per-turn token usage (issue #14).
 *
 * Written at the moment a turn completes, because this is the one record in the product that
 * cannot be reconstructed later: the agent reports usage once, in its own event stream, and
 * SoloW is the only thing watching. A run that happens before this table exists is
 * permanently unmeasurable.
 *
 * Three deliberate choices:
 *
 *  - **No monetary column.** Counts and model are facts; price is a moving external opinion.
 *    Cost is derived at query time (`deriveCostUsd` in `@solow/core`) so a price change
 *    never rewrites what was recorded.
 *  - **`reported` marks coverage.** A turn whose agent said nothing about usage is still
 *    inserted, with `reported: false` and zero counts, so a gap in coverage is visible instead
 *    of being indistinguishable from a turn that genuinely cost nothing.
 *  - **No content, ever.** Prompts and completions are not usage data (Principle IV).
 */
export const sessionUsage = sqliteTable(
  "session_usage",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    sessionId: text("session_id")
      .notNull()
      .references(() => session.id),
    taskId: text("task_id")
      .notNull()
      .references(() => task.id),
    /**
     * The Agent Profile the turn ran under — the attribution key for "what did this profile
     * cost". Issue #14 names an agent-catalog reference; the catalog is issue #10 and does not
     * exist yet, and the profile reaches it once it does.
     */
    agentProfileId: text("agent_profile_id")
      .notNull()
      .references(() => agentProfile.id),
    /**
     * Identifies the assistant turn, and is what makes a row unique within a Session.
     *
     * The agent CLI emits one stream event per content block of a turn and repeats the whole
     * turn's usage on each, so a row per event would multiply a turn's counts by its block
     * count. Keying on the turn instead makes that impossible by construction — and makes a
     * durable step's replay a no-op for free, which a sequence number could not (Principle III).
     */
    messageId: text("message_id").notNull(),
    /** Ordering within the Session. Not unique — the turn id carries identity. */
    seq: integer("seq").notNull(),
    /** Whatever the agent called the model. Null when it did not say. */
    model: text("model"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    /** False when the agent reported no usage for this turn — a visible coverage gap. */
    reported: integer("reported", { mode: "boolean" }).notNull().default(true),
    at: createdAt(),
  },
  (t) => ({
    byTurn: uniqueIndex("session_usage_turn").on(t.sessionId, t.messageId),
    bySeq: index("session_usage_seq").on(t.sessionId, t.seq),
    byWorkspace: index("session_usage_ws_at").on(t.workspaceId, t.at),
  }),
);

export const review = sqliteTable(
  "review",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    sessionId: text("session_id")
      .notNull()
      .references(() => session.id),
    decision: text("decision").$type<ReviewDecision>().notNull(),
    feedback: text("feedback"),
    actorUserId: text("actor_user_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({ bySession: index("review_session").on(t.sessionId) }),
);

export const secret = sqliteTable(
  "secret",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    name: text("name").notNull(),
    kind: text("kind").$type<SecretKind>().notNull(),
    /** AES-256-GCM ciphertext; never selected into a DTO/log (Principle IV). */
    ciphertext: text("ciphertext").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({ byName: uniqueIndex("secret_ws_name").on(t.workspaceId, t.name) }),
);

/**
 * External MCP access tokens (issue #16, spec F12).
 *
 * Deliberately *not* a `secret` row: a Secret is encrypted so it can be decrypted and handed to
 * something else, whereas nothing ever needs a token's plaintext back. Storing it reversibly
 * would create a recoverable credential for no purpose, so this table keeps only a one-way
 * `tokenHash` — a lost token is reissued, never looked up (Principle IV).
 *
 * SHA-256 rather than a password KDF on purpose: the value is 256 bits of `randomBytes`, not a
 * user-chosen password, so it has no dictionary to attack and a slow KDF would only add latency
 * to every MCP call.
 */
export const mcpToken = sqliteTable(
  "mcp_token",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    label: text("label").notNull(),
    scope: text("scope").$type<McpScope>().notNull().default("read"),
    /** SHA-256 of the token value, hex. The value itself is never stored. */
    tokenHash: text("token_hash").notNull(),
    /** First characters of the value, in the clear, so the UI can tell two tokens apart. */
    prefix: text("prefix").notNull(),
    lastUsedAt: text("last_used_at"),
    /** Set on revoke; the row is kept so a revoked token stays auditable (AC-5). */
    revokedAt: text("revoked_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    byWs: index("mcp_token_ws").on(t.workspaceId),
    /**
     * Lookup key on every MCP request, and unique because the hash *is* the identity: a
     * collision would mean one presented value authenticating as two tokens.
     */
    byHash: uniqueIndex("mcp_token_hash").on(t.tokenHash),
  }),
);

/**
 * Per-user interface preferences (issue #3, AC-3) — today the arrangement of a contributed
 * surface, tomorrow whatever else belongs to a person rather than to a browser.
 *
 * One table with a namespaced `key` rather than a column (or a table) per preference: these are
 * opaque to the server, which stores and returns them and never branches on their contents, so a
 * schema change per preference would buy nothing. The value is parsed against its contract on
 * read, and a value that no longer parses degrades to the default — a preference written by an
 * older build must never be able to stop the shell rendering.
 *
 * Keyed by Workspace *and* user: an arrangement belongs to one person inside one tenant
 * (Principle V), and the same account in two Workspaces is entitled to two arrangements.
 */
export const uiPreference = sqliteTable(
  "ui_preference",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    /** `auth_user.id`, or the local stand-in owner when running on the dev-owner path. */
    userId: text("user_id").notNull(),
    key: text("key").notNull(),
    value: text("value", { mode: "json" }).$type<unknown>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    /**
     * Unique because the triple *is* the identity: a second row for the same key would make
     * "the user's arrangement" a question with two answers, decided by insertion order. It is
     * also what lets a write be an upsert rather than a read-then-branch.
     */
    byOwnerKey: uniqueIndex("ui_preference_owner_key").on(t.workspaceId, t.userId, t.key),
  }),
);

/**
 * Which provider login the signed-in user is, per Integration (spec F23 FR-11, `assignee:@me`).
 *
 * The planning table filters `My items` against the assignee logins the provider mirrored onto
 * each row. A SoloW account name is not one of those, so without this table `@me` compares
 * two unrelated names and matches only by coincidence — which is a `My items` tab that is empty
 * for almost everybody and, for the one person whose names happen to agree, silently right.
 *
 * **Stated, not derived from the token, and that is the design.** The PAT belongs to the
 * *Workspace*, not to the person reading: whoever connected the Integration issued it, and every
 * member reads through it. So the provider's "who am I" endpoint answers *who issued this token*
 * — deriving `@me` from it would show the token owner's items to everyone else, under a tab
 * named after them. A wrong answer nobody can see is worse than no answer, so the mapping is one
 * each user makes for themselves. (Deriving it as a *pre-filled suggestion* for the person who
 * connected the Integration is the sensible next step, and needs a `viewer` capability on the
 * driver registry — `authenticate()` today answers `{ ok }` and throws the login away.)
 *
 * `integrationId` is deliberately **not** a foreign key, following `integration.secretId` above:
 * disconnecting an Integration must not be refused because someone once recorded their login for
 * it. A row whose Integration is gone is unreachable — every read here joins through
 * `integration`, which is also what keeps a reconnected Integration from inheriting a stale
 * login belonging to a connection that no longer exists.
 */
export const providerIdentity = sqliteTable(
  "provider_identity",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    integrationId: text("integration_id").notNull(),
    /** `auth_user.id`, or the local stand-in owner when running on the dev-owner path. */
    userId: text("user_id").notNull(),
    /** The login exactly as the provider writes it; compared case-insensitively on read. */
    login: text("login").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    /**
     * Unique because the triple *is* the identity: a second row would make "who am I on this
     * connection" a question with two answers decided by insertion order, and `@me` would then
     * resolve differently depending on which one a query happened to read first. It is also what
     * lets a correction be an upsert rather than a read-then-branch.
     */
    byOwner: uniqueIndex("provider_identity_owner").on(t.workspaceId, t.integrationId, t.userId),
    byWs: index("provider_identity_ws").on(t.workspaceId),
  }),
);

/**
 * The domain tables. BetterAuth's tables live in `auth-schema.ts` and are joined onto this in
 * `tables.ts` — kept in separate files because drizzle-kit reads each schema file standalone.
 */
export const schema = {
  workspace,
  integration,
  issue,
  agentCatalog,
  agentProfile,
  executorProfile,
  repository,
  repositoryBranch,
  changeRequest,
  task,
  taskRepository,
  taskDependency,
  project,
  projectField,
  projectItem,
  projectValue,
  projectView,
  workflow,
  workflowStep,
  worktree,
  session,
  sessionEvent,
  sessionSummary,
  sessionUsage,
  review,
  secret,
  mcpToken,
  uiPreference,
  providerIdentity,
};
