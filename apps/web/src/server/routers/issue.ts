import "server-only";
import {
  createdProviderIssueDto,
  createIssueCommentInput,
  createIssueInput,
  createProviderIssueInput,
  deleteIssueInput,
  getIssueInput,
  IssueErrorCode,
  issueCommentListDto,
  issueDeletionImpactDto,
  issueDeletionImpactInput,
  issueDetailDto,
  issueDetailInput,
  issueDto,
  issueLabelColorListDto,
  issueLabelListDto,
  issueListDto,
  listIssuesInput,
  setIssueStatusInput,
  updateExternalIssueInput,
  updateIssueInput,
} from "@solow/contracts";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  createIssue,
  deleteIssue,
  getIssueById,
  issueDeletionImpact,
  listIssueLabelColors,
  listIssueLabels,
  listIssues,
  runningTasksForIssue,
  setIssueStatus,
  updateIssue,
} from "../dal/issue.js";
import { createProviderIssue } from "../dal/issue-create.js";
import {
  createIssueComment,
  listIssueComments,
  readIssueDetail,
  updateExternalIssue,
} from "../dal/issue-write.js";
import { orchestrator } from "../orchestrator-client.js";
import { ownerProcedure, router, unwrap } from "../trpc.js";

/**
 * Issue CRUD (issue #15 reversal, 2026-08-20): `create`/`update`/`delete` sit alongside
 * `integration.importIssues` as a second way an Issue enters SoloW — see `issue.ts`'s
 * header comment in `@solow/contracts` for the full reasoning. `update` refuses a
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

  /**
   * The same vocabulary **with the provider's colours** — what a table needs to paint a label.
   *
   * Its own route because it costs one provider call per linked Repository, where `labels` above
   * is a single database read. A caller that only wants names must not pay for the network.
   */
  labelColors: ownerProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/issue.labelColors",
        tags: ["issue"],
        protect: true,
        summary:
          "Every label the linked Repositories define, with the colour its provider gives it. Null where the provider reports none.",
      },
    })
    .input(z.object({}))
    .output(issueLabelColorListDto)
    .query(async ({ ctx }) => unwrap(await listIssueLabelColors(ctx.rctx))),

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

  /**
   * One imported Issue as its provider holds it *now*, with the vocabularies an editor needs.
   *
   * Live rather than from the mirror. A form built from the last poll opens on a title someone
   * else changed an hour ago and saves over it with neither party seeing a conflict.
   */
  detail: ownerProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/issue.detail",
        tags: ["issue"],
        protect: true,
        summary:
          "One imported Issue read live from its provider, with the labels, people and milestones that provider will accept — and which fields it will accept a change to at all.",
      },
    })
    .input(issueDetailInput)
    .output(issueDetailDto)
    .query(async ({ ctx, input }) => unwrap(await readIssueDetail(ctx.rctx, input))),

  /**
   * Change an imported Issue **on its provider** (spec F23 FR-13, Decision 0019).
   *
   * Distinct from `issue.update`, which edits a SoloW-owned Issue and still refuses to
   * touch an imported one's title (`IssueErrorCode.SourceOwned`). That refusal is not
   * contradicted here: editing the *copy* remains wrong. This edits the original and re-mirrors
   * whatever the provider answers.
   */
  updateExternal: ownerProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/issue.updateExternal",
        tags: ["issue"],
        protect: true,
        summary:
          "Change an imported Issue on the provider that owns it. A field absent from the request is not changed; the answer is what the provider now holds, never what was sent.",
      },
    })
    .input(updateExternalIssueInput)
    .output(issueDetailDto)
    .mutation(async ({ ctx, input }) => unwrap(await updateExternalIssue(ctx.rctx, input))),

  /**
   * Originate an Issue **on the provider** (spec F23a Flow A).
   *
   * The third `create` on this router, and the three are genuinely different acts: `create` makes
   * a local Issue that will never have a provider, `integration.importIssues` adopts one that
   * already exists, and this one brings a new issue into being on GitHub or GitLab and then
   * mirrors it back. The answer is the provider's — its number, its URL, its title — with the id
   * of the row that mirror produced, so the table can select and scroll to it (Action 5).
   */
  createOnProvider: ownerProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/issue.createOnProvider",
        tags: ["issue"],
        protect: true,
        summary: "Create an Issue on the connected provider (GitHub/GitLab) and mirror it back.",
      },
    })
    .input(createProviderIssueInput)
    .output(createdProviderIssueDto)
    .mutation(async ({ ctx, input }) => unwrap(await createProviderIssue(ctx.rctx, input))),

  /** The discussion on one imported Issue, read live from its provider. */
  comments: ownerProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/issue.comments",
        tags: ["issue"],
        protect: true,
        summary:
          "The comments on one imported Issue, oldest first, read live from its provider. A provider's activity entries are not comments and are not included.",
      },
    })
    .input(issueDetailInput)
    .output(issueCommentListDto)
    .query(async ({ ctx, input }) => unwrap(await listIssueComments(ctx.rctx, input))),

  /** Post a comment, and answer with the thread as it now stands. */
  comment: ownerProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/issue.comment",
        tags: ["issue"],
        protect: true,
        summary:
          "Post a comment on an imported Issue. Answers with the whole thread as the provider now holds it, never with the text that was sent.",
      },
    })
    .input(createIssueCommentInput)
    .output(issueCommentListDto)
    .mutation(async ({ ctx, input }) => unwrap(await createIssueComment(ctx.rctx, input))),
});
