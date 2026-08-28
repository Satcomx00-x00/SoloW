import type {
  ScmProvider,
  SessionEventPayload,
  SessionState,
  TaskCompletionOutcome,
  TaskState,
} from "@solow/contracts";
import { parseSessionEventPayload, sessionEventPayloadSchema } from "@solow/contracts";
import {
  type CompactionRange,
  planCompaction,
  type SessionLogEvent,
} from "@solow/core/session-log";
import {
  agentCatalog,
  agentProfile,
  type Db,
  executorProfile,
  integration,
  issue,
  repository,
  secret,
  session,
  sessionEvent,
  sessionSummary,
  sessionUsage,
  task,
  taskDependency,
  taskRepository,
  workspace,
  worktree,
} from "@solow/db";
import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";

/**
 * Orchestrator-side data access. Scoped by workspaceId (the tenant key travels on the
 * launch event, originating from the authenticated session that created it — Principle V).
 * Kept separate from the web DAL, which is `server-only` and request-context bound.
 */

/**
 * One Repository a Task works in, resolved (issue #7): the attachment row that names the branch,
 * the Repository it points at, and the credential for cloning *that* Repository.
 *
 * The credential is per binding rather than per Task because two attachments can come from two
 * different Integrations — a Task spanning a GitHub service and a GitLab library needs each
 * clone authenticated with its own token, and a single `scmClone` on the context could only ever
 * be right for one of them.
 */
export interface TaskRepositoryBinding {
  attachment: typeof taskRepository.$inferSelect;
  repository: typeof repository.$inferSelect;
  /**
   * The Integration the Repository was imported from, with its still-encrypted token (issue #15).
   * Null for a local path or a public URL, which need no credential to clone. Kept encrypted here
   * — this module reads rows, and a plaintext token on a context object would be one more place
   * it could be logged from (Principle IV).
   */
  scmClone: { provider: ScmProvider; secretCiphertext: string } | null;
}

export interface TaskRunContext {
  task: typeof task.$inferSelect;
  /** The Issue the Task belongs to — its description is the agent's brief. */
  issue: typeof issue.$inferSelect;
  agentProfile: typeof agentProfile.$inferSelect;
  /** Which agent this Profile runs, and how — launch command and billing variables (#10). */
  agentCatalog: typeof agentCatalog.$inferSelect;
  /** Where the agent runs, and the per-kind configuration it runs under (issue #73). */
  executorProfile: typeof executorProfile.$inferSelect;
  /** Every Repository the Task works in, in position order. Never empty (issue #7). */
  repositories: TaskRepositoryBinding[];
  secretCiphertext: string | null;
  /**
   * Whether this Workspace has agent widgets on (`ff-agent-widgets`).
   *
   * Read here rather than at the point of use so the run makes one decision about it: the flag
   * governs both halves of the feature — whether the brief teaches the agent to emit a widget,
   * and whether the output stream is scanned for one — and a run where those two disagreed
   * would either teach a language nothing listens to or listen for one nothing was taught.
   */
  widgetsEnabled: boolean;
}

export async function loadTaskRunContext(
  db: Db,
  workspaceId: string,
  taskId: string,
): Promise<TaskRunContext> {
  const [t] = await db
    .select()
    .from(task)
    .where(and(eq(task.workspaceId, workspaceId), eq(task.id, taskId)))
    .limit(1);
  if (!t) throw new Error(`task ${taskId} not found in workspace ${workspaceId}`);

  const [iss] = await db
    .select()
    .from(issue)
    .where(and(eq(issue.workspaceId, workspaceId), eq(issue.id, t.issueId)))
    .limit(1);
  if (!iss) throw new Error(`issue ${t.issueId} not found`);

  const [ap] = await db
    .select()
    .from(agentProfile)
    .where(and(eq(agentProfile.workspaceId, workspaceId), eq(agentProfile.id, t.agentProfileId)))
    .limit(1);
  if (!ap) throw new Error(`agent profile ${t.agentProfileId} not found`);

  const [cat] = await db
    .select()
    .from(agentCatalog)
    .where(and(eq(agentCatalog.workspaceId, workspaceId), eq(agentCatalog.id, ap.agentCatalogId)))
    .limit(1);
  if (!cat) throw new Error(`agent catalog entry ${ap.agentCatalogId} not found`);

  const [ep] = await db
    .select()
    .from(executorProfile)
    .where(
      and(
        eq(executorProfile.workspaceId, workspaceId),
        eq(executorProfile.id, t.executorProfileId),
      ),
    )
    .limit(1);
  if (!ep) throw new Error(`executor profile ${t.executorProfileId} not found`);

  // Ordered by position, so index 0 is the primary attachment and `primaryTaskRepository` and
  // this list agree about which worktree the agent is started in (issue #7).
  const attachments = await db
    .select({ attachment: taskRepository, repository })
    .from(taskRepository)
    .innerJoin(repository, eq(repository.id, taskRepository.repositoryId))
    .where(
      and(
        eq(taskRepository.workspaceId, workspaceId),
        eq(taskRepository.taskId, taskId),
        eq(repository.workspaceId, workspaceId),
      ),
    )
    .orderBy(asc(taskRepository.position));
  // A Task with no attachment cannot be run at all, and every write path creates one with the
  // Task itself. Refused here, by name, rather than letting an index return undefined and the
  // failure surface three steps later as "cannot read property location of undefined".
  if (attachments.length === 0) {
    throw new Error(`task ${taskId} has no repository attached`);
  }

  const repositories: TaskRepositoryBinding[] = [];
  for (const row of attachments) {
    repositories.push({
      attachment: row.attachment,
      repository: row.repository,
      scmClone: await loadScmClone(db, workspaceId, row.repository),
    });
  }

  const [ws] = await db
    .select({ flags: workspace.enabledFlags })
    .from(workspace)
    .where(eq(workspace.id, workspaceId))
    .limit(1);

  const [sec] = await db
    .select({ ciphertext: secret.ciphertext })
    .from(secret)
    .where(and(eq(secret.workspaceId, workspaceId), eq(secret.id, ap.secretId)))
    .limit(1);

  return {
    task: t,
    issue: iss,
    agentProfile: ap,
    agentCatalog: cat,
    executorProfile: ep,
    repositories,
    widgetsEnabled: ws?.flags?.["ff-agent-widgets"] === true,
    secretCiphertext: sec?.ciphertext ?? null,
  };
}

/**
 * The credential for cloning an imported Repository, if it is one.
 *
 * Resolved per run rather than stored on the Repository: the Integration's token can be rotated
 * or revoked between Tasks, and reading it here means the next Task uses the current one instead
 * of a copy taken at import time. A Repository whose Integration has since been disconnected
 * comes back null and clones unauthenticated, which is the honest outcome — there is no token
 * for it any more.
 */
async function loadScmClone(
  db: Db,
  workspaceId: string,
  repo: typeof repository.$inferSelect,
): Promise<{ provider: ScmProvider; secretCiphertext: string } | null> {
  if (repo.source !== "remote_url" || !repo.integrationId) return null;

  const [row] = await db
    .select({ provider: integration.provider, ciphertext: secret.ciphertext })
    .from(integration)
    .innerJoin(secret, eq(secret.id, integration.secretId))
    .where(
      and(
        eq(integration.workspaceId, workspaceId),
        eq(integration.id, repo.integrationId),
        eq(secret.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  return row ? { provider: row.provider, secretCiphertext: row.ciphertext } : null;
}

export async function setTaskState(
  db: Db,
  workspaceId: string,
  taskId: string,
  state: TaskState,
  extra?: { failureReason?: string | null },
): Promise<void> {
  await db
    .update(task)
    .set({
      state,
      ...(extra?.failureReason !== undefined ? { failureReason: extra.failureReason } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(task.workspaceId, workspaceId), eq(task.id, taskId)));
}

/**
 * Record which branch one attachment's work was committed onto (issue #7).
 *
 * Per attachment rather than per Task: approving a multi-Repository Task commits once in each
 * worktree, and a single column on `task` could only ever name one of the branches a reviewer
 * would need to fetch. Scoped by Workspace like every other write here (Principle V).
 */
export async function setTaskRepositoryResultBranch(
  db: Db,
  workspaceId: string,
  attachmentId: string,
  resultBranch: string,
): Promise<void> {
  await db
    .update(taskRepository)
    .set({ resultBranch, updatedAt: new Date().toISOString() })
    .where(and(eq(taskRepository.workspaceId, workspaceId), eq(taskRepository.id, attachmentId)));
}

/**
 * Write down what the agent said about how its run ended (the completion gate).
 *
 * A report, never a decision: this does not move the Task, and it must not. The party that did
 * the work is not the party that signs it off (Principle I) — what this buys is that the board
 * can tell "finished, waiting for you" from "still working" and from "died", which it previously
 * could not, and read it off the Task rather than by scanning every Task's event log.
 *
 * `at` is passed in rather than taken from the clock here, so the durable step that calls this
 * writes the same value on a replay as it did on its first run (Principle III).
 */
export async function recordTaskCompletion(
  db: Db,
  workspaceId: string,
  taskId: string,
  completion: { outcome: TaskCompletionOutcome; summary: string | null; at: string },
): Promise<void> {
  await db
    .update(task)
    .set({
      completedAt: completion.at,
      completedOutcome: completion.outcome,
      completedSummary: completion.summary,
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(task.workspaceId, workspaceId), eq(task.id, taskId)));
}

/**
 * Forget a previous run's declaration, at the moment a new run starts.
 *
 * Without this, a Task sent back for changes would keep the green "finished" control from the
 * round before while its agent is mid-way through the next one — the board would be offering to
 * review work that is being rewritten as you look at it.
 */
export async function clearTaskCompletion(
  db: Db,
  workspaceId: string,
  taskId: string,
): Promise<void> {
  await db
    .update(task)
    .set({
      completedAt: null,
      completedOutcome: null,
      completedSummary: null,
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(task.workspaceId, workspaceId), eq(task.id, taskId)));
}

/**
 * Record that a Task has a working copy on disk, and where (Principle II).
 *
 * Written at the moment the lifecycle learns the path — at provision for a worktree SoloW
 * created, at adoption for one the agent created — because until then there is nothing truthful
 * to record. The table was read in two places and written in none, so every caller asking "does
 * this Task still hold a working copy" got the same answer, `no`, whatever was on disk.
 *
 * Idempotent on `(taskId, path)`, and now by the unique index that pair carries rather than by
 * reading first: a durable step that retries re-adopts the same directory, and a second row for
 * one directory would make "how many worktrees does this Task have" a question with two answers
 * decided by insertion order. The read-then-insert this replaced was a race dressed as a guard.
 */
export async function recordWorktree(
  db: Db,
  workspaceId: string,
  input: { taskId: string; repositoryId: string; path: string; branch: string },
): Promise<void> {
  await db
    .insert(worktree)
    .values({
      workspaceId,
      taskId: input.taskId,
      repositoryId: input.repositoryId,
      path: input.path,
      branch: input.branch,
      status: "active",
    })
    // A re-adopted worktree can legitimately be on a different branch than it was last round, and
    // one marked removed by a cleanup can be adopted again — so the conflict updates rather than
    // doing nothing, which is what `onConflictDoNothing` would have quietly got wrong.
    .onConflictDoUpdate({
      target: [worktree.taskId, worktree.path],
      set: { branch: input.branch, status: "active", updatedAt: new Date().toISOString() },
    });
}

/**
 * Mark a Task's working copies gone, after the directories really have been removed.
 *
 * The row is kept rather than deleted: `status` is what the two readers filter on, and a Task
 * whose worktree was cleaned up is a different fact from a Task that never had one. Deleting
 * would also lose the path, which is the only record of where the work happened.
 */
export async function markWorktreesRemoved(
  db: Db,
  workspaceId: string,
  taskId: string,
  paths: string[],
): Promise<void> {
  if (paths.length === 0) return;
  await db
    .update(worktree)
    .set({ status: "removed", updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(worktree.workspaceId, workspaceId),
        eq(worktree.taskId, taskId),
        inArray(worktree.path, paths),
      ),
    );
}

/**
 * The Task's predecessors that are not yet `done` (issue #6 AC-3).
 *
 * Read here as well as in the web DAL, and deliberately so. `review.decide` refuses a
 * `request_changes` that would start a blocked Task, but that refusal lives at the API boundary,
 * and the transition into `running` is applied *here* — the durable engine is what actually
 * starts the agent (Principle III). A guard on the API only holds while the API is the sole
 * producer of `review.decided`; a guard at the transition holds whatever publishes it.
 */
export async function unsatisfiedDependencyIds(
  db: Db,
  workspaceId: string,
  taskId: string,
): Promise<string[]> {
  const rows = await db
    .select({ blockedByTaskId: taskDependency.blockedByTaskId, state: task.state })
    .from(taskDependency)
    .innerJoin(task, eq(task.id, taskDependency.blockedByTaskId))
    .where(and(eq(taskDependency.workspaceId, workspaceId), eq(taskDependency.taskId, taskId)));
  return rows.filter((row) => row.state !== "done").map((row) => row.blockedByTaskId);
}

/**
 * Everything needed to probe one Agent Profile: what to launch, and the credential to launch it
 * with (2026-08-28).
 *
 * Deliberately not `loadTaskRunContext`: a probe has no Task, no Issue and no Repository, and
 * requiring them would mean an Owner could not check an agent until they had already committed
 * work to it — which is the ordering the probe exists to fix. Every lookup is scoped to the
 * Workspace, so a Profile id from another tenant reads as absent rather than as someone else's
 * agent (Principle V).
 */
export async function loadAgentProbeContext(
  db: Db,
  workspaceId: string,
  agentProfileId: string,
): Promise<{
  agentProfile: typeof agentProfile.$inferSelect;
  agentCatalog: typeof agentCatalog.$inferSelect;
  secretCiphertext: string | null;
} | null> {
  const [ap] = await db
    .select()
    .from(agentProfile)
    .where(and(eq(agentProfile.workspaceId, workspaceId), eq(agentProfile.id, agentProfileId)))
    .limit(1);
  if (!ap) return null;

  const [cat] = await db
    .select()
    .from(agentCatalog)
    .where(and(eq(agentCatalog.workspaceId, workspaceId), eq(agentCatalog.id, ap.agentCatalogId)))
    .limit(1);
  if (!cat) return null;

  const [sec] = await db
    .select({ ciphertext: secret.ciphertext })
    .from(secret)
    .where(and(eq(secret.workspaceId, workspaceId), eq(secret.id, ap.secretId)))
    .limit(1);

  return { agentProfile: ap, agentCatalog: cat, secretCiphertext: sec?.ciphertext ?? null };
}

/**
 * Refresh the catalog row's capability cache from what an agent just advertised (issue #94 AC-2).
 *
 * The cache is a fallback, not the truth — the truth is the handshake, and it only exists while
 * a session is being opened. This write is what makes the Settings pickers non-empty *between*
 * runs: the first launch of an agent teaches the catalog what it offers, and every form after
 * that has a list to suggest from.
 *
 * Written only when the agent said anything (the caller already filters silence out), and
 * written whole rather than merged: the advertised list *replaces* the cache because a model the
 * agent no longer lists is exactly what the stale-pin warning needs to be able to notice.
 */
export async function updateAgentCatalogCapabilities(
  db: Db,
  workspaceId: string,
  agentCatalogId: string,
  capabilities: { models: string[]; modes: string[] },
): Promise<void> {
  await db
    .update(agentCatalog)
    .set({ capabilities, updatedAt: new Date().toISOString() })
    .where(and(eq(agentCatalog.workspaceId, workspaceId), eq(agentCatalog.id, agentCatalogId)));
}

export async function setSessionState(
  db: Db,
  workspaceId: string,
  sessionId: string,
  state: SessionState,
  extra?: { diffRef?: string; endedAt?: string },
): Promise<void> {
  await db
    .update(session)
    .set({
      state,
      ...(extra?.diffRef !== undefined ? { diffRef: extra.diffRef } : {}),
      ...(extra?.endedAt !== undefined ? { endedAt: extra.endedAt } : {}),
    })
    .where(and(eq(session.workspaceId, workspaceId), eq(session.id, sessionId)));
}

/**
 * Append-only agent event log (TASK-018 replay). Every streamed event is persisted before a
 * client can ask for it again, so a reconnecting SPA replays exactly what it missed instead of
 * losing terminal history. `seq` is unique per Session, so a retried durable step that re-emits
 * the same event is a no-op rather than a duplicate.
 *
 * The payload is validated against the contract union before the insert (issue #2, AC-1) and the
 * `kind` column is *derived* from it rather than passed alongside, so the column and the payload
 * cannot drift apart — a row that says `tool_call` in one place and `stdout` in the other is not
 * representable. A payload the union does not admit throws here rather than becoming another
 * opaque blob a reader has to guess at.
 */
/**
 * Whether a write failed because the row it points at is gone.
 *
 * The case this exists for: a Task is deleted (or its Issue force-deleted) while its agent is
 * still streaming. `cascadeDeleteTasks` takes the `session` row with the Task, and every event
 * the live run appends afterwards hits `session_event.session_id`'s foreign key — one stack
 * trace per chunk of agent output, for a run whose transcript no longer has anywhere to live.
 *
 * Both dialects are named because the same condition means the same thing in each and this is
 * the only place that has to know their codes: SQLite reports `SQLITE_CONSTRAINT_FOREIGNKEY`,
 * Postgres `23503`.
 */
export function isMissingParentRow(cause: unknown): boolean {
  const code = (cause as { code?: unknown } | null)?.code;
  return code === "SQLITE_CONSTRAINT_FOREIGNKEY" || code === "23503";
}

export async function appendSessionEvent(
  db: Db,
  workspaceId: string,
  input: { sessionId: string; seq: number; payload: SessionEventPayload },
): Promise<void> {
  const payload = sessionEventPayloadSchema.parse(input.payload);
  await db
    .insert(sessionEvent)
    .values({
      workspaceId,
      sessionId: input.sessionId,
      seq: input.seq,
      kind: payload.kind,
      payload,
    })
    .onConflictDoNothing();
}

/**
 * The newest state transition recorded for a Session, or null when it has recorded none.
 *
 * One caller, and one reason: the lifecycle's `recordTransition` takes its `seq` from max+1, so
 * the `(session_id, seq)` unique index cannot turn a retried write into a no-op — a second
 * attempt just lands at a new seq. A retried Inngest step body would therefore append the same
 * transition twice, which a reviewer reads as the Task having moved twice (Principle III is
 * about the run surviving a restart, not about the record growing a duplicate each time one
 * happens). Only the newest one is needed: an identical transition further back is a real
 * revisit, and the departure between them is itself a recorded transition.
 */
export async function latestStateTransition(
  db: Db,
  workspaceId: string,
  sessionId: string,
): Promise<Extract<SessionEventPayload, { kind: "state" }> | null> {
  const [row] = await db
    .select({ kind: sessionEvent.kind, payload: sessionEvent.payload })
    .from(sessionEvent)
    .where(
      and(
        eq(sessionEvent.workspaceId, workspaceId),
        eq(sessionEvent.sessionId, sessionId),
        eq(sessionEvent.kind, "state"),
      ),
    )
    .orderBy(desc(sessionEvent.seq))
    .limit(1);
  if (!row) return null;
  const payload = parseSessionEventPayload(row.kind, row.payload);
  return payload.kind === "state" ? payload : null;
}

/**
 * A Session's whole log, typed, oldest first — what compaction reads.
 *
 * Rows written before the payload union existed are mapped on the way out by
 * `parseSessionEventPayload`, so a Session recorded by an earlier run hashes and compacts like
 * any other instead of being unreadable (see that function for the mapping and its one
 * judgement call).
 */
export async function listSessionLog(
  db: Db,
  workspaceId: string,
  sessionId: string,
): Promise<SessionLogEvent[]> {
  const rows = await db
    .select({ seq: sessionEvent.seq, kind: sessionEvent.kind, payload: sessionEvent.payload })
    .from(sessionEvent)
    .where(and(eq(sessionEvent.workspaceId, workspaceId), eq(sessionEvent.sessionId, sessionId)))
    .orderBy(asc(sessionEvent.seq));
  return rows.map((r) => ({ seq: r.seq, payload: parseSessionEventPayload(r.kind, r.payload) }));
}

/** Every summary recorded for a Session, oldest range first. */
export async function listSessionSummaries(
  db: Db,
  workspaceId: string,
  sessionId: string,
): Promise<(typeof sessionSummary.$inferSelect)[]> {
  return db
    .select()
    .from(sessionSummary)
    .where(
      and(eq(sessionSummary.workspaceId, workspaceId), eq(sessionSummary.sessionId, sessionId)),
    )
    .orderBy(asc(sessionSummary.fromSeq));
}

/**
 * Compact a Session at a turn boundary (issue #2, AC-3).
 *
 * Inserts summaries and nothing else. `onConflictDoNothing` on `(session_id, from_seq)` makes a
 * durable step that replays after an orchestrator restart a no-op rather than a duplicate
 * (Principle III), and there is deliberately no delete or update of `session_event` anywhere on
 * this path — replay reproduces the full history whether or not this ever ran (AC-2).
 */
export async function compactSession(
  db: Db,
  workspaceId: string,
  sessionId: string,
  opts: { threshold?: number; tail?: number } = {},
): Promise<CompactionRange[]> {
  const events = await listSessionLog(db, workspaceId, sessionId);
  const existing = await listSessionSummaries(db, workspaceId, sessionId);
  const planned = planCompaction(events, existing, opts);
  for (const range of planned) {
    await db
      .insert(sessionSummary)
      .values({
        workspaceId,
        sessionId,
        fromSeq: range.fromSeq,
        toSeq: range.toSeq,
        eventCount: range.eventCount,
        text: range.text,
      })
      .onConflictDoNothing();
  }
  return planned;
}

/**
 * Record one turn's token usage (issue #14).
 *
 * Keyed on `(sessionId, seq)` like the event log and inserted with `onConflictDoNothing`, so a
 * durable step that replays after an orchestrator restart re-records the same turn as a no-op
 * rather than double-counting it (Principle III).
 *
 * Counts and model only. Nothing derived from the prompt or the completion is stored here.
 */
export async function recordSessionUsage(
  db: Db,
  workspaceId: string,
  input: {
    sessionId: string;
    taskId: string;
    agentProfileId: string;
    /** The assistant turn. Repeats for the same turn are ignored — see the schema comment. */
    messageId: string;
    seq: number;
    model: string | null;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reported: boolean;
  },
): Promise<void> {
  await db
    .insert(sessionUsage)
    .values({
      workspaceId,
      sessionId: input.sessionId,
      taskId: input.taskId,
      agentProfileId: input.agentProfileId,
      messageId: input.messageId,
      seq: input.seq,
      model: input.model,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheReadTokens: input.cacheReadTokens,
      cacheWriteTokens: input.cacheWriteTokens,
      reported: input.reported,
    })
    .onConflictDoNothing();
}

/**
 * The next usage `seq` for a Session — an ordering hint, read from the database because a
 * Session spans review rounds and each round re-enters the durable step with a fresh closure.
 *
 * Identity lives on `messageId`, not here: a repeated or replayed turn is rejected by the
 * unique index regardless of what sequence number it arrives with.
 */
export async function nextSessionUsageSeq(
  db: Db,
  workspaceId: string,
  sessionId: string,
): Promise<number> {
  const [row] = await db
    .select({ seq: sessionUsage.seq })
    .from(sessionUsage)
    .where(and(eq(sessionUsage.workspaceId, workspaceId), eq(sessionUsage.sessionId, sessionId)))
    .orderBy(desc(sessionUsage.seq))
    .limit(1);
  return row ? row.seq + 1 : 0;
}

/** Every usage row for a Session, oldest turn first. */
export async function listSessionUsage(
  db: Db,
  workspaceId: string,
  sessionId: string,
): Promise<(typeof sessionUsage.$inferSelect)[]> {
  return db
    .select()
    .from(sessionUsage)
    .where(and(eq(sessionUsage.workspaceId, workspaceId), eq(sessionUsage.sessionId, sessionId)))
    .orderBy(sessionUsage.seq);
}

/** The next free `seq` for a Session (resumes correctly after an orchestrator restart). */
export async function nextSessionEventSeq(
  db: Db,
  workspaceId: string,
  sessionId: string,
): Promise<number> {
  const [row] = await db
    .select({ seq: sessionEvent.seq })
    .from(sessionEvent)
    .where(and(eq(sessionEvent.workspaceId, workspaceId), eq(sessionEvent.sessionId, sessionId)))
    .orderBy(desc(sessionEvent.seq))
    .limit(1);
  return row ? row.seq + 1 : 0;
}

export interface ReplayEvent {
  sessionId: string;
  seq: number;
  payload: SessionEventPayload;
}

/**
 * Events for a Task's Sessions with `seq` above `sinceSeq`, oldest first. Workspace-scoped:
 * the caller's ticket names the Workspace, and a Task from another one yields nothing.
 *
 * Payloads come back typed, rows written before the union existed included — which is what lets
 * the replay projection be a total `switch` instead of the field-probing it used to be.
 */
export async function listTaskEventsSince(
  db: Db,
  workspaceId: string,
  taskId: string,
  sinceSeq: number,
): Promise<ReplayEvent[]> {
  const sessions = await db
    .select({ id: session.id })
    .from(session)
    .where(and(eq(session.workspaceId, workspaceId), eq(session.taskId, taskId)));
  if (sessions.length === 0) return [];

  const rows = await db
    .select({
      sessionId: sessionEvent.sessionId,
      seq: sessionEvent.seq,
      kind: sessionEvent.kind,
      payload: sessionEvent.payload,
    })
    .from(sessionEvent)
    .where(
      and(
        eq(sessionEvent.workspaceId, workspaceId),
        inArray(
          sessionEvent.sessionId,
          sessions.map((s) => s.id),
        ),
        gt(sessionEvent.seq, sinceSeq),
      ),
    )
    .orderBy(asc(sessionEvent.seq));

  return rows.map((r) => ({
    sessionId: r.sessionId,
    seq: r.seq,
    payload: parseSessionEventPayload(r.kind, r.payload),
  }));
}
