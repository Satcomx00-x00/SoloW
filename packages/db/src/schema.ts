import { randomUUID } from "node:crypto";
import type {
  AgentCapabilities,
  AgentProtocol,
  AuthMode,
  ChangeRequestState,
  ExecutorConfig,
  ExecutorKind,
  IssueSource,
  IssueStatus,
  McpScope,
  RepositorySource,
  ReviewDecision,
  ScmProvider,
  SecretKind,
  SessionState,
  TaskState,
} from "@gatecontrol/contracts";
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * GateControl data model — SQLite dialect (local-first primary store, Decision 0008).
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
    status: text("status").$type<IssueStatus>().notNull().default("open"),
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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    byStatus: index("issue_ws_status").on(t.workspaceId, t.status),
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
 * guarantee is GateControl's headline differentiator, and it must not silently stop holding the
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
     * Per-kind configuration, validated by the discriminated union in `@gatecontrol/contracts`
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
 * from its Integration (issue #15). Reference-only today — GateControl does not open or merge
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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    byState: index("task_ws_state").on(t.workspaceId, t.state),
    byIssue: index("task_issue").on(t.issueId),
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
 * `checkDependencyEdge` in `@gatecontrol/core`, before the insert, so a cycle is refused with
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
  (t) => ({ byTask: index("worktree_task").on(t.taskId) }),
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
 * GateControl is the only thing watching. A run that happens before this table exists is
 * permanently unmeasurable.
 *
 * Three deliberate choices:
 *
 *  - **No monetary column.** Counts and model are facts; price is a moving external opinion.
 *    Cost is derived at query time (`deriveCostUsd` in `@gatecontrol/core`) so a price change
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
  worktree,
  session,
  sessionEvent,
  sessionSummary,
  sessionUsage,
  review,
  secret,
  mcpToken,
  uiPreference,
};
