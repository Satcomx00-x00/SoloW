import "server-only";
import {
  CommonErrorCode,
  err,
  ok,
  type Result,
  type ReviewBriefDto,
  type SessionEventPayload,
} from "@solow/contracts";
import { buildReviewBrief, type Check, checkKindOf, cwdOf, verdictOf } from "@solow/core";
import { worktree } from "@solow/db";
import { and, desc, eq } from "drizzle-orm";
import type { RequestContext } from "./context.js";
import { getIssueById } from "./issue.js";
import { getSessionById, listSessionEvents } from "./session.js";
import { getTaskById } from "./task.js";

/**
 * Gather the three sources the brief is read from — the Issue, the harness's last checklist,
 * and every verification it ran — and hand them to `buildReviewBrief` (review analysis, point 1).
 *
 * The whole log, unscoped and uncompacted: a check that ran in an earlier Step is still the
 * evidence for a criterion the last Step claims, and a summary standing in for a range would
 * hide the one `bun test` a reviewer needs to see. Tool results are paired to their calls by
 * `callId`, which is how the verdict travels; a call with no result is a check that never came
 * back and is reported as such rather than dropped.
 */
export async function getReviewBrief(
  ctx: RequestContext,
  sessionId: string,
): Promise<Result<ReviewBriefDto, typeof CommonErrorCode.NotFound>> {
  const session = await getSessionById(ctx, sessionId);
  if (!session.ok) return err(CommonErrorCode.NotFound);
  const task = await getTaskById(ctx, session.data.taskId, { includeDeleted: true });
  if (!task.ok) return err(CommonErrorCode.NotFound);
  const issue = await getIssueById(ctx, task.data.issueId);
  const events = await listSessionEvents(ctx, sessionId);
  if (!events.ok) return err(CommonErrorCode.NotFound);

  const [wt] = await ctx.db
    .select({ path: worktree.path })
    .from(worktree)
    .where(and(eq(worktree.workspaceId, ctx.workspaceId), eq(worktree.taskId, task.data.id)))
    .orderBy(desc(worktree.updatedAt))
    .limit(1);
  const worktreePath = wt?.path ?? null;

  let steps: ReadonlyArray<{
    id: string;
    label: string;
    state: "todo" | "active" | "done" | "blocked";
    note?: string | undefined;
  }> = [];
  const files = new Map<string, true>();
  const results = new Map<string, Extract<SessionEventPayload, { kind: "tool_result" }>>();
  const calls: Array<{ payload: Extract<SessionEventPayload, { kind: "tool_call" }>; at: string }> =
    [];
  for (const event of events.data) {
    const payload = event.payload as SessionEventPayload;
    if (payload.kind === "widget" && payload.widget.kind === "step_card")
      steps = payload.widget.steps;
    else if (payload.kind === "diff") for (const file of payload.files) files.set(file.path, true);
    else if (payload.kind === "tool_call") calls.push({ payload, at: event.at });
    else if (payload.kind === "tool_result" && payload.callId) results.set(payload.callId, payload);
  }

  const checks: Check[] = [];
  for (const { payload, at } of calls) {
    const command = payload.input?.command ?? payload.input?.cmd ?? null;
    if (!command) continue;
    const kind = checkKindOf(command);
    if (!kind) continue;
    const result = payload.callId ? results.get(payload.callId) : undefined;
    const verdict = result
      ? verdictOf(result.output, result.ok)
      : { verdict: "no result", passed: null };
    checks.push({ kind, command, cwd: cwdOf(command), ...verdict, at });
  }

  const brief = buildReviewBrief({
    description: issue.ok ? (issue.data.description ?? null) : null,
    steps,
    files: [...files.keys()],
    checks,
  });
  return ok({
    sessionId,
    worktreePath,
    criteria: brief.criteria,
    unmatched: brief.unmatched,
    checks: brief.checks.map((check) => ({
      ...check,
      // A verification run somewhere other than the worktree is one the reviewer should know
      // about: the harness of the Task this was written for ran its suite from a copy in /tmp.
      elsewhere:
        check.cwd !== null &&
        worktreePath !== null &&
        !check.cwd.startsWith(worktreePath) &&
        !check.cwd.startsWith("$(") &&
        !check.cwd.startsWith('"$('),
    })),
  });
}
