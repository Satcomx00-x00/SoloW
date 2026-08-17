import "server-only";
import { createIssueInput, getIssueInput, listIssuesInput } from "@gatecontrol/contracts";
import { ownerProcedure, router, unwrap } from "../trpc.js";
import { createIssueRecord, getIssueById, listIssues } from "../dal/issue.js";

export const issueRouter = router({
  create: ownerProcedure
    .input(createIssueInput)
    .mutation(async ({ ctx, input }) => unwrap(await createIssueRecord(ctx.rctx, input))),
  list: ownerProcedure
    .input(listIssuesInput)
    .query(async ({ ctx, input }) => unwrap(await listIssues(ctx.rctx, input))),
  get: ownerProcedure
    .input(getIssueInput)
    .query(async ({ ctx, input }) => unwrap(await getIssueById(ctx.rctx, input.id))),
});
