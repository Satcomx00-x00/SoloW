import "server-only";
import {
  getSessionInput,
  getTaskSessionsInput,
  type SessionDto,
  sessionDetailDto,
  sessionDto,
  type TaskDiffDto,
  taskDiffDto,
} from "@gatecontrol/contracts";
import { z } from "zod";
import { getReviewForSession } from "../dal/review.js";
import { getSessionById, listSessionEvents, listSessionsForTask } from "../dal/session.js";
import { getTaskById } from "../dal/task.js";
import { ownerProcedure, router, unwrap } from "../trpc.js";

type SessionRow = SessionDto & { workspaceId: string };

function toSessionDto(row: SessionRow): SessionDto {
  return {
    id: row.id,
    taskId: row.taskId,
    state: row.state,
    diffRef: row.diffRef,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
  };
}

/**
 * The diff the orchestrator captured at the review gate, pulled back out of the event log.
 *
 * Stored as a `diff` session event rather than a column: it arrives on the same append-only log
 * as everything else the run produced, so it replays with the rest and survives the worktree
 * being torn down. Parsed rather than trusted — the payload column is untyped JSON, and a shape
 * that no longer matches degrades to "no diff" instead of breaking the review page.
 */
function latestDiff(events: Array<{ kind: string; payload: unknown }>): TaskDiffDto | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.kind !== "diff") continue;
    const parsed = taskDiffDto.safeParse(event.payload);
    if (parsed.success) return parsed.data;
  }
  return null;
}

export const sessionRouter = router({
  /** All Sessions for a Task, newest first. */
  listForTask: ownerProcedure
    .meta({
      openapi: { method: "GET", path: "/session.listForTask", tags: ["session"], protect: true },
    })
    .input(getTaskSessionsInput)
    .output(z.array(sessionDto))
    .query(async ({ ctx, input }) => {
      // Ownership: the Task must belong to this Workspace.
      unwrap(await getTaskById(ctx.rctx, input.taskId));
      const rows = unwrap(await listSessionsForTask(ctx.rctx, input.taskId));
      return rows.map((r) => toSessionDto(r as SessionRow));
    }),

  /** One Session with its full event log and any recorded review decision. */
  get: ownerProcedure
    .meta({ openapi: { method: "GET", path: "/session.get", tags: ["session"], protect: true } })
    .input(getSessionInput)
    .output(sessionDetailDto)
    .query(async ({ ctx, input }) => {
      const session = unwrap(await getSessionById(ctx.rctx, input.sessionId));
      const events = unwrap(await listSessionEvents(ctx.rctx, input.sessionId));
      const review = unwrap(await getReviewForSession(ctx.rctx, input.sessionId));
      return {
        session: toSessionDto(session as SessionRow),
        diff: latestDiff(events),
        events: events.map((e) => ({
          id: e.id,
          sessionId: e.sessionId,
          seq: e.seq,
          kind: e.kind,
          payload: e.payload,
          at: e.at,
        })),
        review,
      };
    }),
});
