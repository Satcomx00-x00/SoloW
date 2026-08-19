import { randomUUID } from "node:crypto";
import type {
  AgentKind,
  AuthMode,
  ExecutorKind,
  IssueStatus,
  RepositorySource,
  ReviewDecision,
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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    byStatus: index("issue_ws_status").on(t.workspaceId, t.status),
    byCreated: index("issue_ws_created").on(t.workspaceId, t.createdAt),
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
    kind: text("kind").$type<ExecutorKind>().notNull().default("local"),
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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({ byWs: index("repository_ws").on(t.workspaceId) }),
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
  issue,
  agentProfile,
  executorProfile,
  repository,
  task,
  worktree,
  session,
  sessionEvent,
  review,
  secret,
};
