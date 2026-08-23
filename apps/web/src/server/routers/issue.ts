import "server-only";
import {
  createIssueInput,
  deleteIssueInput,
  getIssueInput,
  IssueErrorCode,
  issueDeletionImpactDto,
  issueDeletionImpactInput,
  issueDto,
  issueLabelListDto,
  issueListDto,
  listIssuesInput,
  setIssueStatusInput,
  updateIssueInput,
} from "@gatecontrol/contracts";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  createIssue,
  deleteIssue,
  getIssueById,
  issueDeletionImpact,
  listIssueLabels,
  listIssues,
  runningTasksForIssue,
  setIssueStatus,
  updateIssue,
} from "../dal/issue.js";
import { orchestrator } from "../orchestrator-client.js";
import { ownerProcedure, router, unwrap } from "../trpc.js";

/**
 * Issue CRUD (issue #15 reversal, 2026-08-20): `create`/`update`/`delete` sit alongside
 * `integration.importIssues` as a second way an Issue enters GateControl — see `issue.ts`'s
 * header comment in `@gatecontrol/contracts` for the full reasoning. `update` refuses a
 * title/description change on anything but a locally created Issue (spec F01 FR-3); `delete`
 * refuses while the Issue still has Tasks rather than cascading, unless the caller passes
 * `force` — which stops any running Task through the orchestrator first, then cascades.
 *
 * `setStatus` is the other side of the derived status (spec F01 FR-7/FR-9): the list and detail
 * views read a status computed from the Issue's Tasks, and this is the one call that lets a
 * person disagree with it — or close an Issue outright, which it refuses over active Tasks
 * unless asked twice.
 */
export const issueRouter = router({
  list: ownerProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/issue.list",
        tags: ["issue"],
        protect: true,
        summary:
          "List Issues in the Workspace, newest first. An Issue is either imported from a connected GitHub/GitLab repository or created directly.",
      },
    })
    .input(listIssuesInput)
    .output(issueListDto)
    .query(async ({ ctx, input }) => unwrap(await listIssues(ctx.rctx, input))),
  get: ownerProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/issue.get",
        tags: ["issue"],
        protect: true,
        summary: "Fetch one Issue by id, including how many Tasks sit under it.",
      },
    })
    .input(getIssueInput)
    .output(issueDto)
    .query(async ({ ctx, input }) => unwrap(await getIssueById(ctx.rctx, input.id))),
  labels: ownerProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/issue.labels",
        tags: ["issue"],
        protect: true,
        summary:
          "Every distinct label in use on the Workspace's Issues, sorted — the vocabulary the list filter offers.",
      },
    })
    .input(z.object({}))
    .output(issueLabelListDto)
    .query(async ({ ctx }) => unwrap(await listIssueLabels(ctx.rctx))),
  setStatus: ownerProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/issue.setStatus",
        tags: ["issue"],
        protect: true,
        summary:
          "Set an Issue's status by hand, overriding the one derived from its Tasks, or pass `status: null` to follow the Tasks again. Closing is refused while Tasks are still active unless `force` is set.",
      },
    })
    .input(setIssueStatusInput)
    .output(issueDto)
    .mutation(async ({ ctx, input }) => unwrap(await setIssueStatus(ctx.rctx, input))),
  create: ownerProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/issue.create",
        tags: ["issue"],
        protect: true,
        summary: "Create a local Issue directly, without importing it from a provider.",
      },
    })
    .input(createIssueInput)
    .output(issueDto)
    .mutation(async ({ ctx, input }) => unwrap(await createIssue(ctx.rctx, input))),
  update: ownerProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/issue.update",
        tags: ["issue"],
        protect: true,
        summary:
          "Edit an Issue's title, description or labels. Title/description are refused for an Issue imported from a provider — they are owned by the source.",
      },
    })
    .input(updateIssueInput)
    .output(issueDto)
    .mutation(async ({ ctx, input }) => unwrap(await updateIssue(ctx.rctx, input))),
  deletionImpact: ownerProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/issue.deletionImpact",
        tags: ["issue"],
        protect: true,
        summary:
          "Count what a force delete of this Issue would destroy — Tasks, sessions and active worktrees — so the confirmation can state it.",
      },
    })
    .input(issueDeletionImpactInput)
    .output(issueDeletionImpactDto)
    .query(async ({ ctx, input }) => unwrap(await issueDeletionImpact(ctx.rctx, input.id))),
  delete: ownerProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/issue.delete",
        tags: ["issue"],
        protect: true,
        summary:
          "Delete an Issue. Refused while it still has Tasks unless `force` is set, which stops any running Task and then deletes the Issue together with its Tasks, sessions and worktree records.",
      },
    })
    .input(deleteIssueInput)
    .output(z.object({ id: z.string(), deletedTaskCount: z.number().int().nonnegative() }))
    .mutation(async ({ ctx, input }) => {
      // Stopping happens here rather than in the DAL: reaching a running agent is an
      // orchestrator hand-off, and the DAL is the one layer that stays pure database (it
      // re-checks the same condition inside its transaction, which is what makes this safe
      // rather than merely polite).
      if (input.force) {
        const running = await runningTasksForIssue(ctx.rctx, input.id);
        for (const { taskId, sessionId } of running) {
          try {
            await orchestrator.stopTaskRun({
              workspaceId: ctx.rctx.workspaceId,
              taskId,
              sessionId,
            });
          } catch (cause) {
            // Nothing has been deleted at this point, so refusing leaves the Issue exactly as
            // it was — the one outcome that cannot orphan a running agent.
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: IssueErrorCode.StopFailed,
              cause,
            });
          }
        }
      }
      return unwrap(await deleteIssue(ctx.rctx, input));
    }),
});
