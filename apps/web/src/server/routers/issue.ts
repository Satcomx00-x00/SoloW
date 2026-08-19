import "server-only";
import { getIssueInput, issueDto, issueListDto, listIssuesInput } from "@gatecontrol/contracts";
import { getIssueById, listIssues } from "../dal/issue.js";
import { ownerProcedure, router, unwrap } from "../trpc.js";

/**
 * No `create` procedure (issue #15 product decision, 2026-08-19): every Issue is imported from
 * a connected GitHub or GitLab account via `integration.importIssues`, never typed in by hand.
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
          "List Issues in the Workspace, newest first. Issues are imported from a connected GitHub/GitLab repository — there is no way to create one directly.",
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
});
