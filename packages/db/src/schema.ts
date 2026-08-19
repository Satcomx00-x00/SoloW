import { randomUUID } from "node:crypto";
import type {
  AgentKind,
  AuthMode,
  ChangeRequestState,
  ExecutorConfig,
  ExecutorKind,
  IssueSource,
  IssueStatus,
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

export const agentProfile = sqliteTable(
  "agent_profile",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    name: text("name").notNull(),
    agentKind: text("agent_kind").$type<AgentKind>().notNull().default("claude_code"),
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
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repository.id),
    baseRef: text("base_ref"),
    resultBranch: text("result_branch"),
    failureReason: text("failure_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    byState: index("task_ws_state").on(t.workspaceId, t.state),
    byIssue: index("task_issue").on(t.issueId),
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
 * The domain tables. BetterAuth's tables live in `auth-schema.ts` and are joined onto this in
 * `tables.ts` — kept in separate files because drizzle-kit reads each schema file standalone.
 */
export const schema = {
  workspace,
  integration,
  issue,
  agentProfile,
  executorProfile,
  repository,
  repositoryBranch,
  changeRequest,
  task,
  worktree,
  session,
  sessionEvent,
  sessionUsage,
  review,
  secret,
};
