import "server-only";
import {
  CommonErrorCode,
  type CreateIssueInput,
  type DeleteIssueInput,
  err,
  type IssueDeletionImpactDto,
  type IssueDto,
  IssueErrorCode,
  type IssueLabelColorListDto,
  type IssueLabelListDto,
  type IssueListDto,
  type ListIssuesInput,
  ok,
  type Result,
  type SetIssueStatusInput,
  type TaskState,
  type UpdateIssueInput,
} from "@solow/contracts";
import { activeTaskCount, deriveIssueStatus } from "@solow/core";
import {
  attachIssueToLocalProjects,
  issue,
  projectItem,
  projectValue,
  repository,
  session,
  task,
  worktree,
} from "@solow/db";
import { and, eq, inArray, like, notInArray, or } from "drizzle-orm";
import type { RequestContext } from "./context.js";
import { driverWith, loadCredential } from "./integration.js";
import { type IssueRollup, issueToDto, NO_TASKS } from "./mappers.js";
import { encodeCursor, pageAfter, pageLimit, pageOrder, pageProbe, toPage } from "./page.js";
import { cascadeDeleteTasks } from "./task-cascade.js";

/**
 * The Task states belonging to each of the given Issues, keyed by Issue id.
 *
 * One query for the whole page rather than one per row: this feeds both the Task count and the
 * derived status, and doing it per Issue made the list N+1.
 */
async function taskStatesByIssue(
  ctx: RequestContext,
  issueIds: string[],
): Promise<Map<string, TaskState[]>> {
  const byIssue = new Map<string, TaskState[]>(issueIds.map((id) => [id, []]));
  if (issueIds.length === 0) return byIssue;

  const rows = await ctx.db
    .select({ issueId: task.issueId, state: task.state })
    .from(task)
    .where(and(eq(task.workspaceId, ctx.workspaceId), inArray(task.issueId, issueIds)));

  for (const row of rows) byIssue.get(row.issueId)?.push(row.state);
  return byIssue;
}

/**
 * What an Issue's Tasks add up to (spec FR-006). The stored `status_override` column, when set,
 * beats all of this — `issueToDto` applies it — but the derived answer travels either way, so a
 * manual status can be shown *as* an override of what the Tasks actually say.
 */
function rollupOf(states: TaskState[]): IssueRollup {
  return {
    taskCount: states.length,
    activeTaskCount: activeTaskCount(states),
    derivedStatus: deriveIssueStatus(states),
  };
}

export async function getIssueById(
  ctx: RequestContext,
  id: string,
): Promise<Result<IssueDto, typeof CommonErrorCode.NotFound>> {
  const [row] = await ctx.db
    .select()
    .from(issue)
    .where(and(eq(issue.workspaceId, ctx.workspaceId), eq(issue.id, id)))
    .limit(1);
  if (!row) return err(CommonErrorCode.NotFound);
  const states = (await taskStatesByIssue(ctx, [row.id])).get(row.id) ?? [];
  return ok(issueToDto(row, rollupOf(states)));
}

export async function listIssues(
  ctx: RequestContext,
  input: ListIssuesInput,
): Promise<Result<IssueListDto>> {
  const conditions = [eq(issue.workspaceId, ctx.workspaceId)];
  if (input.query) {
    const needle = `%${input.query}%`;
    // "#42" and "42" both mean the provider's issue 42 — the number people actually say out
    // loud for an imported Issue, and one nothing else on the row would match.
    const asNumber = Number.parseInt(input.query.trim().replace(/^#/, ""), 10);
    const matches = [like(issue.title, needle), like(issue.description, needle)];
    if (Number.isSafeInteger(asNumber)) matches.push(eq(issue.externalNumber, asNumber));
    const match = or(...matches);
    if (match) conditions.push(match);
  }
  if (input.source) conditions.push(eq(issue.source, input.source));
  // Narrows the Task-creation picker to the Issues that belong to the Repository the Owner just
  // picked — no new query shape, one more `and()` clause on the same workspace-scoped read.
  if (input.repositoryId) conditions.push(eq(issue.repositoryId, input.repositoryId));

  /*
   * Project membership, as a subquery on `project_item` rather than a join.
   *
   * A join would multiply the row for an Issue that sits in two Projects, and the roll-up below
   * counts Tasks per Issue — a duplicated row would count them twice and report a status derived
   * from work that does not exist. `inArray` over the membership table asks the question the
   * screen is actually asking ("is this Issue in that Project") and answers it once per Issue.
   *
   * `projectId` and `unassigned` together are a contradiction, and the honest answer to a
   * contradiction is nothing: both clauses are applied, and an Issue cannot be both in a Project
   * and in none. Silently dropping one would answer a question nobody asked.
   */
  if (input.projectId) {
    conditions.push(
      inArray(
        issue.id,
        ctx.db
          .select({ id: projectItem.issueId })
          .from(projectItem)
          .where(
            and(
              eq(projectItem.workspaceId, ctx.workspaceId),
              eq(projectItem.projectId, input.projectId),
            ),
          ),
      ),
    );
  }
  if (input.unassigned) {
    conditions.push(
      notInArray(
        issue.id,
        ctx.db
          .select({ id: projectItem.issueId })
          .from(projectItem)
          .where(eq(projectItem.workspaceId, ctx.workspaceId)),
      ),
    );
  }

  /*
   * Paged in a loop rather than in one read, because two of this list's filters cannot be
   * expressed in SQL.
   *
   * `status` is derived from the Issue's Tasks (a `where status = …` would match a column no
   * caller ever sees), and `labels` is a JSON array, where SQL matching means substring-matching
   * the serialized text — `api` would match `api-gateway`. Both therefore run after mapping, and
   * a page that filtered afterwards would be a page shorter than it claimed, handing back a
   * cursor whose next page might also be empty. So the read walks until it has a full page or the
   * table is exhausted, and the cursor it returns names a row that really is the boundary.
   *
   * The ceiling is the same honesty device `PROJECT_ITEM_CEILING` is: a filter that matches
   * almost nothing must not turn one list call into a full-table scan, and stopping early while
   * still returning a cursor is a shorter page, not a wrong one.
   */
  const wanted = input.labels;
  const keep = (dto: IssueDto) =>
    (!input.status || dto.status === input.status) &&
    (!wanted?.length || wanted.every((label) => dto.labels.includes(label)));

  const collected: IssueDto[] = [];
  let cursor = input.cursor;
  let scanned = 0;
  let nextCursor: string | null = null;

  const limit = pageLimit(input.limit);
  while (collected.length < limit && scanned < ISSUE_SCAN_CEILING) {
    const after = pageAfter(cursor, issue.createdAt, issue.id);
    const rows = await ctx.db
      .select()
      .from(issue)
      .where(and(...conditions, ...(after ? [after] : [])))
      .orderBy(...pageOrder(issue.createdAt, issue.id))
      .limit(pageProbe(limit));
    if (rows.length === 0) break;
    scanned += rows.length;

    const states = await taskStatesByIssue(
      ctx,
      rows.map((r) => r.id),
    );
    const page = toPage(rows, limit, (r) => ({ createdAt: r.createdAt, id: r.id }));
    for (const row of page.items) {
      const dto = issueToDto(row, rollupOf(states.get(row.id) ?? []));
      if (keep(dto)) collected.push(dto);
    }
    nextCursor = page.nextCursor;
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }

  // Trimmed rather than allowed to overshoot: a round of the loop admits a whole SQL page, and
  // the last one can carry the page past `limit`. The cursor is re-derived from the row that
  // ends up last, so the next page starts exactly where this one stopped.
  if (collected.length > limit) {
    const kept = collected.slice(0, limit);
    const last = kept.at(-1);
    return ok({
      items: kept,
      nextCursor: last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
    });
  }
  return ok({ items: collected, nextCursor });
}

/**
 * How many rows one filtered read will walk before it stops and answers with what it has.
 *
 * A ceiling rather than a promise: `status` and `labels` are matched in memory, so a filter that
 * admits almost nothing would otherwise turn one list call into a full-table scan. The cursor
 * still comes back, so a caller that wants the rest can ask for it.
 */
const ISSUE_SCAN_CEILING = 2000;

/**
 * Every label in use in the Workspace, sorted, for the list filter to offer.
 *
 * Read from the Issues rather than kept as its own table: a label exists exactly as long as an
 * Issue carries it (schema.ts explains why labels are a JSON column and not a join table), so a
 * label vocabulary stored separately would immediately start including tags nothing wears.
 */
export async function listIssueLabels(ctx: RequestContext): Promise<Result<IssueLabelListDto>> {
  const rows = await ctx.db
    .select({ labels: issue.labels })
    .from(issue)
    .where(eq(issue.workspaceId, ctx.workspaceId));

  const seen = new Set<string>();
  for (const row of rows) for (const label of row.labels) seen.add(label);
  return ok([...seen].sort((a, b) => a.localeCompare(b)));
}

/**
 * Every label the Workspace's linked Repositories define, with the colour its provider gives it.
 *
 * Asked of the providers rather than read from the mirror: `issue.labels` stores names only, so a
 * table that wanted to paint a label had nowhere to get the colour from and drew every one of
 * them grey.
 *
 * One repository failing costs its own vocabulary and nothing else — a token that expired on one
 * connection must not blank the labels of every other. Later definitions win on a name collision,
 * which is arbitrary and harmless: two repositories that both define `bug` in different colours
 * disagree at the source, and no answer here is more correct than the other.
 */
export async function listIssueLabelColors(
  ctx: RequestContext,
): Promise<Result<IssueLabelColorListDto>> {
  const repositories = await ctx.db
    .select({
      id: repository.id,
      integrationId: repository.integrationId,
      externalFullName: repository.externalFullName,
    })
    .from(repository)
    .where(eq(repository.workspaceId, ctx.workspaceId));

  const byName = new Map<string, string | null>();
  for (const repo of repositories) {
    if (!repo.integrationId || !repo.externalFullName) continue;
    try {
      const credential = await loadCredential(ctx, repo.integrationId);
      if (!credential.ok) continue;
      const driver = driverWith(credential.data.row.provider, "issues");
      if (!driver.ok) continue;
      for (const label of await driver.data.listLabels(
        credential.data.credential,
        repo.externalFullName,
      )) {
        byName.set(label.name, label.color ?? null);
      }
    } catch {
      // See the note above: one repository's failure is its own.
    }
  }

  return ok(
    [...byName.entries()]
      .map(([name, color]) => ({ name, color }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
}

/**
 * Set or clear an Issue's manual status (spec F01 FR-7), recording who did it and when.
 *
 * Closing is the one status that can strand work, so it is refused while Tasks under the Issue
 * are still active (FR-9) unless the caller passes `force`. The check is deliberately a warning
 * the user can overrule rather than a wall like `deleteIssue`'s: nothing is destroyed by
 * closing, and an Issue whose remaining Tasks are abandoned is a real thing to want to close.
 *
 * `null` clears the override and hands the Issue back to `deriveIssueStatus`. The recording
 * columns are cleared with it — a timestamp for an override that no longer exists would be
 * read, eventually, as one that does.
 */
export async function setIssueStatus(
  ctx: RequestContext,
  input: SetIssueStatusInput,
): Promise<
  Result<IssueDto, typeof CommonErrorCode.NotFound | typeof IssueErrorCode.HasActiveTasks>
> {
  const [existing] = await ctx.db
    .select({ id: issue.id })
    .from(issue)
    .where(and(eq(issue.workspaceId, ctx.workspaceId), eq(issue.id, input.id)))
    .limit(1);
  if (!existing) return err(CommonErrorCode.NotFound);

  const states = (await taskStatesByIssue(ctx, [input.id])).get(input.id) ?? [];
  if (input.status === "closed" && !input.force && activeTaskCount(states) > 0) {
    return err(IssueErrorCode.HasActiveTasks);
  }

  const now = new Date().toISOString();
  const [row] = await ctx.db
    .update(issue)
    .set({
      statusOverride: input.status,
      statusOverrideAt: input.status === null ? null : now,
      statusOverrideBy: input.status === null ? null : ctx.userId,
      updatedAt: now,
    })
    .where(and(eq(issue.workspaceId, ctx.workspaceId), eq(issue.id, input.id)))
    .returning();
  if (!row) return err(CommonErrorCode.NotFound);
  return ok(issueToDto(row, rollupOf(states)));
}

/**
 * Create a local Issue (issue #15 reversal). `repositoryId` is verified against this Workspace
 * before the insert — trusting an id the client sent without checking it belongs here would be
 * a tenancy hole with a Repository's location and setup files on the other side of it
 * (Principle V).
 */
export async function createIssue(
  ctx: RequestContext,
  input: CreateIssueInput,
): Promise<Result<IssueDto, typeof CommonErrorCode.NotFound>> {
  const [repo] = await ctx.db
    .select({ id: repository.id })
    .from(repository)
    .where(and(eq(repository.workspaceId, ctx.workspaceId), eq(repository.id, input.repositoryId)))
    .limit(1);
  if (!repo) return err(CommonErrorCode.NotFound);

  const [row] = await ctx.db
    .insert(issue)
    .values({
      workspaceId: ctx.workspaceId,
      title: input.title,
      description: input.description ?? null,
      repositoryId: input.repositoryId,
      labels: input.labels,
      // source defaults to "local" at the column — this is exactly the case that value means.
    })
    .returning();
  if (!row) return err(CommonErrorCode.NotFound);

  // A local Project registered under this Repository must gain this Issue immediately — F23's
  // "nothing is imported by hand", applied to the local case (user request 2026-08-27).
  await attachIssueToLocalProjects(ctx.db, ctx.workspaceId, {
    issueId: row.id,
    repositoryId: input.repositoryId,
  });

  return ok(issueToDto(row, NO_TASKS));
}

/**
 * Edit an Issue. `title`/`description` are refused for anything but a locally created Issue
 * (spec F01 FR-3: an imported Issue's canonical fields are the provider's own) — `labels` is
 * exempt, since it never belonged to that rule and is the one field every Issue owns regardless
 * of where it came from.
 */
export async function updateIssue(
  ctx: RequestContext,
  input: UpdateIssueInput,
): Promise<Result<IssueDto, typeof CommonErrorCode.NotFound | typeof IssueErrorCode.SourceOwned>> {
  const [existing] = await ctx.db
    .select()
    .from(issue)
    .where(and(eq(issue.workspaceId, ctx.workspaceId), eq(issue.id, input.id)))
    .limit(1);
  if (!existing) return err(CommonErrorCode.NotFound);

  const editsCanonicalFields = input.title !== undefined || input.description !== undefined;
  if (editsCanonicalFields && existing.source !== "local") {
    return err(IssueErrorCode.SourceOwned);
  }

  const [row] = await ctx.db
    .update(issue)
    .set({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.labels !== undefined ? { labels: input.labels } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(issue.workspaceId, ctx.workspaceId), eq(issue.id, input.id)))
    .returning();
  if (!row) return err(CommonErrorCode.NotFound);

  const states = (await taskStatesByIssue(ctx, [row.id])).get(row.id) ?? [];
  return ok(issueToDto(row, rollupOf(states)));
}

/**
 * Delete an Issue. Refuses rather than cascades while it has Tasks (spec F01 States & Rules) —
 * `task.issue_id` is NOT NULL, so a cascade would silently take the Tasks with it; the user is
 * told to move or remove them first instead.
 *
 * `input.force` is the deliberate override: it takes the Tasks and everything hanging off them
 * on purpose. It is a separate flag rather than a second function because the guard and the
 * cascade must not drift apart — both run against the same rows, in the same transaction.
 *
 * The has-Tasks check and the delete run inside one `ctx.db.transaction()` (matching task.ts /
 * workflow.ts) rather than as two independent statements: without it, a Task created for this
 * Issue in the window between the SELECT and the DELETE turns the DELETE into a raw FK-constraint
 * violation instead of the intended IssueErrorCode.HasTasks the UI knows how to show. Wrapping
 * both in the same transaction makes the check and the act atomic, so that race can't happen.
 *
 * Callers passing `force` are expected to have stopped the running Tasks already (the router
 * does, through the orchestrator). This refuses with `HasRunningTasks` if any are still running
 * when it gets here, so a direct DAL caller cannot skip that step: dropping a `task` row while
 * its agent process is alive would orphan the process with nothing left referencing it.
 */
export async function deleteIssue(
  ctx: RequestContext,
  input: DeleteIssueInput,
): Promise<
  Result<
    { id: string; deletedTaskCount: number },
    | typeof CommonErrorCode.NotFound
    | typeof IssueErrorCode.HasTasks
    | typeof IssueErrorCode.HasRunningTasks
  >
> {
  return ctx.db.transaction((tx) => {
    const [existing] = tx
      .select({ id: issue.id })
      .from(issue)
      .where(and(eq(issue.workspaceId, ctx.workspaceId), eq(issue.id, input.id)))
      .limit(1)
      .all();
    if (!existing) return err(CommonErrorCode.NotFound);

    const tasks = tx
      .select({ id: task.id, state: task.state })
      .from(task)
      .where(and(eq(task.workspaceId, ctx.workspaceId), eq(task.issueId, input.id)))
      .all();

    if (tasks.length > 0 && !input.force) return err(IssueErrorCode.HasTasks);

    if (tasks.length > 0) {
      const taskIds = tasks.map((t) => t.id);

      // Re-checked inside the transaction rather than trusting the caller's earlier stop: a Task
      // can enter `running` between the router's stop and this delete, and that is exactly the
      // row whose agent would be orphaned.
      const sessionRows = tx
        .select({ id: session.id, state: session.state })
        .from(session)
        .where(and(eq(session.workspaceId, ctx.workspaceId), inArray(session.taskId, taskIds)))
        .all();
      const stillRunning =
        tasks.some((t) => t.state === "running") || sessionRows.some((r) => r.state === "active");
      if (stillRunning) return err(IssueErrorCode.HasRunningTasks);

      cascadeDeleteTasks(tx, ctx.workspaceId, taskIds);
    }

    // The rows this Issue occupies in any planning project go with it (F23 / #121 AC-6). The
    // *projects* do not: a project is a mirror of something on the provider, and deleting one
    // Issue out of it is not a reason to forget the mirror. Before the FK below, this would have
    // refused the delete outright.
    tx.delete(projectValue)
      .where(
        and(
          eq(projectValue.workspaceId, ctx.workspaceId),
          inArray(
            projectValue.itemId,
            tx
              .select({ id: projectItem.id })
              .from(projectItem)
              .where(
                and(
                  eq(projectItem.workspaceId, ctx.workspaceId),
                  eq(projectItem.issueId, input.id),
                ),
              ),
          ),
        ),
      )
      .run();
    tx.delete(projectItem)
      .where(and(eq(projectItem.workspaceId, ctx.workspaceId), eq(projectItem.issueId, input.id)))
      .run();

    tx.delete(issue)
      .where(and(eq(issue.workspaceId, ctx.workspaceId), eq(issue.id, input.id)))
      .run();
    return ok({ id: input.id, deletedTaskCount: tasks.length });
  });
}

/**
 * What a force delete of this Issue would destroy, for the confirmation dialog to state.
 *
 * Counted rather than listed: the dialog needs numbers, and an Issue with a long Task history
 * would otherwise ship rows nothing renders. `worktreeCount` counts only `active` rows — a
 * `removed` worktree has no directory left to warn about.
 */
export async function issueDeletionImpact(
  ctx: RequestContext,
  issueId: string,
): Promise<Result<IssueDeletionImpactDto, typeof CommonErrorCode.NotFound>> {
  const [existing] = await ctx.db
    .select({ id: issue.id })
    .from(issue)
    .where(and(eq(issue.workspaceId, ctx.workspaceId), eq(issue.id, issueId)))
    .limit(1);
  if (!existing) return err(CommonErrorCode.NotFound);

  const tasks = await ctx.db
    .select({ id: task.id, state: task.state })
    .from(task)
    .where(and(eq(task.workspaceId, ctx.workspaceId), eq(task.issueId, issueId)));

  if (tasks.length === 0) {
    return ok({ taskCount: 0, runningTaskCount: 0, sessionCount: 0, worktreeCount: 0 });
  }

  const taskIds = tasks.map((t) => t.id);
  const sessions = await ctx.db
    .select({ id: session.id, taskId: session.taskId, state: session.state })
    .from(session)
    .where(and(eq(session.workspaceId, ctx.workspaceId), inArray(session.taskId, taskIds)));
  const worktrees = await ctx.db
    .select({ id: worktree.id })
    .from(worktree)
    .where(
      and(
        eq(worktree.workspaceId, ctx.workspaceId),
        inArray(worktree.taskId, taskIds),
        eq(worktree.status, "active"),
      ),
    );

  const runningTaskIds = new Set(tasks.filter((t) => t.state === "running").map((t) => t.id));
  for (const row of sessions) if (row.state === "active") runningTaskIds.add(row.taskId);

  return ok({
    taskCount: tasks.length,
    runningTaskCount: runningTaskIds.size,
    sessionCount: sessions.length,
    worktreeCount: worktrees.length,
  });
}

/**
 * The Tasks under this Issue that still have an agent to stop, with the session to stop them on.
 * The router walks this before a force delete; `deleteIssue` re-checks the same condition inside
 * its transaction, so this is the hand-off list, not the safety net.
 */
export async function runningTasksForIssue(
  ctx: RequestContext,
  issueId: string,
): Promise<Array<{ taskId: string; sessionId: string }>> {
  const tasks = await ctx.db
    .select({ id: task.id, state: task.state })
    .from(task)
    .where(and(eq(task.workspaceId, ctx.workspaceId), eq(task.issueId, issueId)));
  if (tasks.length === 0) return [];

  const taskIds = tasks.map((t) => t.id);
  const sessions = await ctx.db
    .select({ id: session.id, taskId: session.taskId, state: session.state })
    .from(session)
    .where(and(eq(session.workspaceId, ctx.workspaceId), inArray(session.taskId, taskIds)));

  const runningTaskIds = new Set(tasks.filter((t) => t.state === "running").map((t) => t.id));
  const out: Array<{ taskId: string; sessionId: string }> = [];
  for (const row of sessions) {
    if (row.state === "active" || runningTaskIds.has(row.taskId)) {
      out.push({ taskId: row.taskId, sessionId: row.id });
    }
  }
  return out;
}
