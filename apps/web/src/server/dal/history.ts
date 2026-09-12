import "server-only";
import {
  type HistoryEntryDto,
  type HistoryListDto,
  type HistoryResumability,
  ok,
  type Result,
  type TaskDto,
} from "@solow/contracts";
import { primaryTaskRepository, retentionExpiresAt, TASK_RETENTION_MS } from "@solow/core";
import { issue, repository, session, task, worktree } from "@solow/db";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import type { RequestContext } from "./context.js";
import { taskToDto } from "./mappers.js";
import { attachmentsForTasks, listDeletedTasks, liveTask } from "./task.js";

/**
 * History: every Task closed or deleted inside the retention window, newest first, with what a
 * resume would do to it (spec F02 FR-10, F11; Decision 0025).
 *
 * Two sources, one list. Deleted Tasks come from their mark (`deleted_at`); Done ones from the
 * state and the time they got there — `updated_at`, which nothing writes on a Done Task after
 * the transition itself, since Done has no edits and only one exit (Reopen, which takes it out
 * of this list). Resumability is read off the Sessions and worktree rows the way the
 * orchestrator would read them: an active worktree row plus a recorded harness conversation is
 * a conversation to continue; a Task with a Session but neither is a brief to start from.
 */
export async function listHistory(ctx: RequestContext): Promise<Result<HistoryListDto>> {
  const cutoff = new Date(Date.now() - TASK_RETENTION_MS).toISOString();

  const deleted = await listDeletedTasks(ctx);
  if (!deleted.ok) return deleted;

  const doneRows = await ctx.db
    .select()
    .from(task)
    .where(
      and(
        eq(task.workspaceId, ctx.workspaceId),
        eq(task.state, "done"),
        liveTask(),
        gte(task.updatedAt, cutoff),
      ),
    )
    .orderBy(desc(task.updatedAt));
  const attachments = await attachmentsForTasks(
    ctx,
    doneRows.map((row) => row.id),
  );
  const done: TaskDto[] = doneRows.map((row) => taskToDto(row, attachments.get(row.id) ?? []));

  const all = [
    ...deleted.data.map((t) => ({
      task: t,
      kind: "deleted" as const,
      since: t.deletedAt ?? t.updatedAt,
    })),
    ...done.map((t) => ({ task: t, kind: "done" as const, since: t.updatedAt })),
  ];
  if (all.length === 0) return ok([]);
  const taskIds = all.map((entry) => entry.task.id);

  const [sessions, worktrees, issues, repositories] = await Promise.all([
    ctx.db
      .select({
        taskId: session.taskId,
        harnessSessionId: session.harnessSessionId,
        startedAt: session.startedAt,
      })
      .from(session)
      .where(and(eq(session.workspaceId, ctx.workspaceId), inArray(session.taskId, taskIds)))
      .orderBy(desc(session.startedAt)),
    ctx.db
      .select({ taskId: worktree.taskId })
      .from(worktree)
      .where(
        and(
          eq(worktree.workspaceId, ctx.workspaceId),
          inArray(worktree.taskId, taskIds),
          eq(worktree.status, "active"),
        ),
      ),
    ctx.db
      .select({ id: issue.id, title: issue.title })
      .from(issue)
      .where(
        and(
          eq(issue.workspaceId, ctx.workspaceId),
          inArray(issue.id, [...new Set(all.map((entry) => entry.task.issueId))]),
        ),
      ),
    ctx.db
      .select({ id: repository.id, name: repository.name })
      .from(repository)
      .where(eq(repository.workspaceId, ctx.workspaceId)),
  ]);

  const hasSession = new Set(sessions.map((s) => s.taskId));
  // Newest Session first, so the first id seen per Task is the conversation a relaunch resumes.
  const conversation = new Map<string, string>();
  for (const s of sessions) {
    if (s.harnessSessionId && !conversation.has(s.taskId))
      conversation.set(s.taskId, s.harnessSessionId);
  }
  const hasWorktree = new Set(worktrees.map((w) => w.taskId));
  const issueTitle = new Map(issues.map((i) => [i.id, i.title]));
  const repositoryName = new Map(repositories.map((r) => [r.id, r.name]));

  const entries: HistoryEntryDto[] = all.map((entry) => {
    const id = entry.task.id;
    const resumable: HistoryResumability = !hasSession.has(id)
      ? "none"
      : hasWorktree.has(id) && conversation.has(id)
        ? "conversation"
        : "brief";
    const primary =
      entry.task.repositories.length > 0 ? primaryTaskRepository(entry.task.repositories) : null;
    return {
      task: entry.task,
      kind: entry.kind,
      since: entry.since,
      expiresAt: retentionExpiresAt(entry.since),
      resumable,
      issueTitle: issueTitle.get(entry.task.issueId) ?? null,
      repositoryName: primary ? (repositoryName.get(primary.repositoryId) ?? null) : null,
    };
  });
  entries.sort((a, b) => (a.since < b.since ? 1 : a.since > b.since ? -1 : 0));
  return ok(entries);
}
