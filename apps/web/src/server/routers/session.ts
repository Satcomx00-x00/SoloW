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
} from "@solow/contracts";
import { z } from "zod";
import { getReviewForSession, listReviewsForSession } from "../dal/review.js";
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
import { latestDiffPerRepository, sessionRounds } from "./session-rounds.js";

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

export const sessionRouter = router({
  /** All Sessions for a Task, newest first. */
  listForTask: ownerProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/session.listForTask",
        tags: ["session"],
        protect: true,
        summary: "List every harness Session recorded for a Task, newest first.",
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
          "Fetch one Session with its event log — minus any range a compaction summary stands in for, which session.eventRange reads back — the diff captured at the review gate for each Repository the Task works in, and any recorded decision. Pass workflowStepId to narrow the events to one Workflow Step.",
      },
    })
    .input(getSessionInput)
    .output(sessionDetailDto)
    .query(async ({ ctx, input }) => {
      const session = unwrap(await getSessionById(ctx.rctx, input.sessionId));
      const events = unwrap(await listSessionEvents(ctx.rctx, input.sessionId));
      /*
       * The Step filter narrows the transcript and nothing else.
       *
       * `diffs` and `cursor` below are computed from the whole log on purpose: the fork cursor
       * hashes every event up to its `seq`, so one taken over a Step's slice would be a promise
       * about a history that does not exist, and the review gate's captures are picked out of
       * wherever in the run they landed. So the unfiltered read above stays, and a scoped request
       * pays one extra query rather than making the Session's own facts depend on which Step the
       * caller happened to be looking at. Unscoped — every request the app makes today — issues
       * exactly the one query it always did.
       */
      const scoped = input.workflowStepId
        ? unwrap(
            await listSessionEvents(ctx.rctx, input.sessionId, {
              workflowStepId: input.workflowStepId,
            }),
          )
        : events;
      const summaries = unwrap(await listSessionSummaries(ctx.rctx, input.sessionId));
      const review = unwrap(await getReviewForSession(ctx.rctx, input.sessionId));
      const reviews = unwrap(await listReviewsForSession(ctx.rctx, input.sessionId));
      // The Task is read for its attachment order alone — position 0 is what "primary" means,
      // and the event log records capture order, which is not the same question.
      const task = unwrap(await getTaskById(ctx.rctx, session.taskId));
      const attachmentOrder = task.repositories.map((attachment) => attachment.repositoryId);
      const diffs = latestDiffPerRepository(events, attachmentOrder);
      // Every round so far, read back out of the same log (F10 FR-7) — the whole log, for the
      // reason `diffs` uses it: a round is a fact about the Session, not about one Step of it.
      const rounds = sessionRounds(events, reviews, attachmentOrder);
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
        events: scoped.filter((e) => !summarised(e.seq)).map(toEventDto),
        summaries: summaries.map(toSummaryDto),
        cursor,
        review,
        rounds,
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
  workflowStepId: e.workflowStepId,
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
