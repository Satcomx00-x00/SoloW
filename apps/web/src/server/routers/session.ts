import "server-only";
import {
  getSessionInput,
  getTaskSessionsInput,
  type SessionDto,
  type SessionSummaryDto,
  sessionCursorDto,
  sessionDetailDto,
  sessionDto,
  sessionEventDto,
  sessionEventRangeInput,
  sessionEventsFromInput,
  sessionForkCursorInput,
  type TaskDiffDto,
  taskDiffDto,
} from "@solow/contracts";
import { z } from "zod";
import { getReviewForSession } from "../dal/review.js";
import {
  getSessionById,
  listSessionEvents,
  listSessionEventsFrom,
  listSessionEventsInRange,
  listSessionSummaries,
  listSessionsForTask,
  sessionCursorOf,
  sessionForkCursor,
  type TypedSessionEvent,
} from "../dal/session.js";
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
 * being torn down. Still parsed rather than trusted even though the payload is now typed — a
 * `diff` row written before the union existed reaches this function through the compatibility
 * mapping, and a shape that no longer matches degrades to "no diff" instead of breaking the
 * review page. `taskDiffDto` is non-strict, so the payload's own `kind` key is simply dropped.
 */
function latestDiffPerRepository(
  events: Array<{ kind: string; payload: unknown }>,
  attachmentOrder: readonly string[],
): TaskDiffDto[] {
  // Keyed on the repository so a later review round replaces that repository's group rather
  // than appending a second one; an event written before multi-repository Tasks existed carries
  // no repository and shares the empty key, which is exactly the old "latest diff" behaviour.
  const byRepository = new Map<string, TaskDiffDto>();
  for (const event of events) {
    if (event.kind !== "diff") continue;
    const parsed = taskDiffDto.safeParse(event.payload);
    if (!parsed.success) continue;
    byRepository.set(parsed.data.repositoryId ?? "", parsed.data);
  }

  // A log can hold both shapes at once: a Task sitting at the review gate across an orchestrator
  // upgrade keeps the memoized legacy capture from the round before it and gains a named one
  // from the round after. The unlabelled entry is then a superseded copy of a capture that now
  // has a name, so it is dropped rather than shown beside it as a second, stale group — a Task
  // that only ever had one repository must not grow an "Unnamed repository" section. It survives
  // only when nothing in the log is named at all, which is the pre-#7 Session this exists for.
  if (byRepository.size > 1) byRepository.delete("");

  // Ordered by attachment position, not by which repository the orchestrator happened to capture
  // first: each capture is wrapped in its own try/catch, so a round where the primary's capture
  // failed and a secondary's succeeded would otherwise put the secondary first — and `diff`,
  // which every legacy consumer reads as "the primary Repository's change", is `diffs[0]`.
  const rank = new Map(attachmentOrder.map((id, index) => [id, index]));
  const unknown = attachmentOrder.length;
  return [...byRepository.values()]
    .map((diff, index) => ({ diff, index, rank: rank.get(diff.repositoryId ?? "") ?? unknown }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.diff);
}

export const sessionRouter = router({
  /** All Sessions for a Task, newest first. */
  listForTask: ownerProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/session.listForTask",
        tags: ["session"],
        protect: true,
        summary: "List every agent Session recorded for a Task, newest first.",
      },
    })
    .input(getTaskSessionsInput)
    .output(z.array(sessionDto))
    .query(async ({ ctx, input }) => {
      // Ownership: the Task must belong to this Workspace.
      unwrap(await getTaskById(ctx.rctx, input.taskId));
      const rows = unwrap(await listSessionsForTask(ctx.rctx, input.taskId));
      return rows.map((r) => toSessionDto(r as SessionRow));
    }),

  /** One Session with its event log, its summarised ranges and any recorded review decision. */
  get: ownerProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/session.get",
        tags: ["session"],
        protect: true,
        summary:
          "Fetch one Session with its event log — minus any range a compaction summary stands in for, which session.eventRange reads back — the diff captured at the review gate for each Repository the Task works in, and any recorded decision.",
      },
    })
    .input(getSessionInput)
    .output(sessionDetailDto)
    .query(async ({ ctx, input }) => {
      const session = unwrap(await getSessionById(ctx.rctx, input.sessionId));
      const events = unwrap(await listSessionEvents(ctx.rctx, input.sessionId));
      const summaries = unwrap(await listSessionSummaries(ctx.rctx, input.sessionId));
      const review = unwrap(await getReviewForSession(ctx.rctx, input.sessionId));
      // The Task is read for its attachment order alone — position 0 is what "primary" means,
      // and the event log records capture order, which is not the same question.
      const task = unwrap(await getTaskById(ctx.rctx, session.taskId));
      const diffs = latestDiffPerRepository(
        events,
        task.repositories.map((attachment) => attachment.repositoryId),
      );
      // The head fork point, so a caller reading a Session already holds something it can fork
      // from without a second round trip (issue #2, AC-4). Null while the log is still empty.
      // Minted from the rows already in hand: re-reading the log to hash it would make the one
      // endpoint a long run has to survive scan the whole table twice per request.
      const cursor = sessionCursorOf(input.sessionId, events);
      // What compaction bought. A summarised range is answered by its summary and nothing else;
      // the events it stands for are still there and still readable through `eventRange` (AC-2),
      // but a response that carried them anyway would leave the log growing without bound on the
      // wire and in the DOM, which is the problem this issue names. The diffs and the cursor
      // above are computed from the *whole* log, so nothing a reviewer decides on is elided.
      const summarised = (seq: number) => summaries.some((s) => seq >= s.fromSeq && seq <= s.toSeq);
      return {
        session: toSessionDto(session as SessionRow),
        diffs,
        // The primary Repository's change, for a caller that only ever wanted "the diff".
        diff: diffs[0] ?? null,
        events: events.filter((e) => !summarised(e.seq)).map(toEventDto),
        summaries: summaries.map(toSummaryDto),
        cursor,
        review,
      };
    }),

  /**
   * The events one summarised range stands in for (issue #2, AC-3).
   *
   * The other half of eliding them from `session.get`: compaction never deleted anything, so a
   * collapsed range can always be expanded back into the log underneath it — one range at a
   * time, when an operator asks, rather than on every load of the workspace.
   */
  eventRange: ownerProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/session.eventRange",
        tags: ["session"],
        protect: true,
        summary:
          "Read the events inside one closed seq range of a Session's log — what a compaction summary stands in for.",
      },
    })
    .input(sessionEventRangeInput)
    .output(z.array(sessionEventDto))
    .query(async ({ ctx, input }) => {
      unwrap(await getSessionById(ctx.rctx, input.sessionId));
      const events = unwrap(await listSessionEventsInRange(ctx.rctx, input));
      return events.map(toEventDto);
    }),

  /**
   * A fork point another run can start from (issue #2, AC-4; unblocks #9).
   *
   * Minted rather than stored: the hash covers every event up to `seq`, so it is computed from
   * the log as it is now and works identically on Sessions recorded before the typed union
   * existed. `NOT_FOUND` when the Session has no such point.
   */
  forkCursor: ownerProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/session.forkCursor",
        tags: ["session"],
        protect: true,
        summary:
          "Mint a content-addressed fork cursor for a Session, at a given seq or at the head of its log.",
      },
    })
    .input(sessionForkCursorInput)
    .output(sessionCursorDto)
    .query(async ({ ctx, input }) => {
      unwrap(await getSessionById(ctx.rctx, input.sessionId));
      return unwrap(await sessionForkCursor(ctx.rctx, input.sessionId, input.seq));
    }),

  /**
   * Everything recorded after a fork point — refused when the history behind it changed.
   *
   * This is the half that makes a cursor worth having: resuming from a transcript that was
   * rewritten underneath the cursor would continue from a history nobody promised, so a stale
   * hash is a refusal (`SESSION_CURSOR_STALE`) rather than a best effort.
   */
  eventsFrom: ownerProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/session.eventsFrom",
        tags: ["session"],
        protect: true,
        summary:
          "Read the events recorded after a fork cursor, refusing a cursor whose hash no longer matches the log.",
      },
    })
    .input(sessionEventsFromInput)
    .output(z.array(sessionEventDto))
    .query(async ({ ctx, input }) => {
      unwrap(await getSessionById(ctx.rctx, input.sessionId));
      const events = unwrap(await listSessionEventsFrom(ctx.rctx, input));
      return events.map(toEventDto);
    }),
});

const toEventDto = (e: TypedSessionEvent) => ({
  id: e.id,
  sessionId: e.sessionId,
  seq: e.seq,
  kind: e.kind,
  payload: e.payload,
  at: e.at,
});

const toSummaryDto = (s: {
  id: string;
  sessionId: string;
  fromSeq: number;
  toSeq: number;
  eventCount: number;
  text: string;
  at: string;
}): SessionSummaryDto => ({
  id: s.id,
  sessionId: s.sessionId,
  fromSeq: s.fromSeq,
  toSeq: s.toSeq,
  eventCount: s.eventCount,
  text: s.text,
  at: s.at,
});
