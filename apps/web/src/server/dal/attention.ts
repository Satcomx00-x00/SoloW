import "server-only";
import { type AttentionItemDto, type AttentionListDto, ok, type Result } from "@solow/contracts";
import {
  attentionDueAt,
  type RunAttentionInput,
  runAttention,
  STRANDED_REVIEW_REASON,
} from "@solow/core";
import { session, sessionEvent, task } from "@solow/db";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import type { RequestContext } from "./context.js";
import { liveTask } from "./task.js";

/**
 * The Tasks that need a person because their run failed or stopped moving (FINDINGS F3).
 *
 * The rule is `runAttention` in `@solow/core`, the same thresholds the orchestrator's sweep acts
 * on; this only gathers what the rule reads. Workspace-wide, like the status bar that shows it.
 */

/** Enough for any real backlog of failures; past it the list says it was cut. */
const ATTENTION_LIMIT = 100;

export async function listRunsNeedingAttention(
  ctx: RequestContext,
  now: () => Date = () => new Date(),
): Promise<Result<AttentionListDto>> {
  const nowMs = now().getTime();
  // Only states the rule can flag. `review` only with the stranded-decision reason: a Task waiting
  // at the gate for a person is the gate working.
  const rows = await ctx.db
    .select({
      id: task.id,
      title: task.title,
      state: task.state,
      failureReason: task.failureReason,
      updatedAt: task.updatedAt,
    })
    .from(task)
    .where(
      and(
        eq(task.workspaceId, ctx.workspaceId),
        liveTask(),
        or(
          inArray(task.state, ["failed", "running", "parked"]),
          and(eq(task.state, "review"), eq(task.failureReason, STRANDED_REVIEW_REASON)),
        ),
      ),
    );

  const items: AttentionItemDto[] = [];
  let recheckAt: number | null = null;
  for (const row of rows) {
    const input: RunAttentionInput = {
      state: row.state,
      failureReason: row.failureReason,
      updatedAt: row.updatedAt,
      lastActivityAt: row.updatedAt,
      sessionState: null,
    };
    // The run's own log only matters where the clock decides, which is the two live states; a
    // failed or stranded-review row is judged from the row alone.
    if (row.state === "running" || row.state === "parked") {
      Object.assign(input, await newestSignOfLife(ctx, row.id, row.updatedAt));
    }

    const verdict = runAttention(input, nowMs);
    if (verdict) {
      items.push({
        taskId: row.id,
        title: row.title,
        state: row.state,
        failureReason: row.failureReason,
        ...verdict,
      });
      continue;
    }
    const due = attentionDueAt(input);
    if (due !== null && (recheckAt === null || due < recheckAt)) recheckAt = due;
  }

  items.sort((a, b) => b.since.localeCompare(a.since));
  return ok({
    items: items.slice(0, ATTENTION_LIMIT),
    truncated: items.length > ATTENTION_LIMIT,
    recheckAt: recheckAt === null ? null : new Date(recheckAt).toISOString(),
  });
}

/**
 * The newest Session's state and the newest thing it produced, falling back to its start and then
 * to the Task row — the same fallbacks the sweep's `latestActivity` takes.
 */
async function newestSignOfLife(
  ctx: RequestContext,
  taskId: string,
  updatedAt: string,
): Promise<Pick<RunAttentionInput, "lastActivityAt" | "sessionState">> {
  const [newest] = await ctx.db
    .select({ id: session.id, state: session.state, startedAt: session.startedAt })
    .from(session)
    .where(and(eq(session.workspaceId, ctx.workspaceId), eq(session.taskId, taskId)))
    .orderBy(desc(session.startedAt))
    .limit(1);
  if (!newest) return { lastActivityAt: updatedAt, sessionState: null };
  const [event] = await ctx.db
    .select({ at: sessionEvent.at })
    .from(sessionEvent)
    .where(eq(sessionEvent.sessionId, newest.id))
    .orderBy(desc(sessionEvent.at))
    .limit(1);
  return { lastActivityAt: event?.at ?? newest.startedAt, sessionState: newest.state };
}
