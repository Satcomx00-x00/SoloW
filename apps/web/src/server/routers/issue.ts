import "server-only";
import {
  createIssueInput,
  getIssueInput,
  issueDto,
  issueListDto,
  listIssuesInput,
} from "@gatecontrol/contracts";
import { createIssueRecord, getIssueById, listIssues } from "../dal/issue.js";
import { ownerProcedure, router, unwrap } from "../trpc.js";

export const issueRouter = router({
  create: ownerProcedure
    .meta({ openapi: { method: "POST", path: "/issue.create", tags: ["issue"], protect: true } })
    .input(createIssueInput)
    .output(issueDto)
    .mutation(async ({ ctx, input }) => unwrap(await createIssueRecord(ctx.rctx, input))),
  list: ownerProcedure
    .meta({ openapi: { method: "GET", path: "/issue.list", tags: ["issue"], protect: true } })
    .input(listIssuesInput)
    .output(issueListDto)
    .query(async ({ ctx, input }) => unwrap(await listIssues(ctx.rctx, input))),
  get: ownerProcedure
    .meta({ openapi: { method: "GET", path: "/issue.get", tags: ["issue"], protect: true } })
    .input(getIssueInput)
    .output(issueDto)
    .query(async ({ ctx, input }) => unwrap(await getIssueById(ctx.rctx, input.id))),
});
