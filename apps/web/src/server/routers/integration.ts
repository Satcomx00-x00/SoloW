import "server-only";
import {
  changeRequestDto,
  connectIntegrationInput,
  externalIssuePreviewDto,
  importIssuesInput,
  integrationDto,
  issueDto,
  linkRepositoryInput,
  listExternalIssuesInput,
  repositoryBranchDto,
  repositoryDto,
  syncRepositorySignalsInput,
} from "@gatecontrol/contracts";
import { z } from "zod";
import {
  connectIntegration,
  importIssues,
  linkRepository,
  listExternalIssues,
  listIntegrations,
  syncRepositorySignals,
} from "../dal/integration.js";
import { integrationsProcedure, router, unwrap } from "../trpc.js";

/** SCM integrations (issue #15) — connect GitHub/GitLab, link Repositories, import and sync. */
export const integrationRouter = router({
  connect: integrationsProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/integration.connect",
        tags: ["integration"],
        protect: true,
      },
    })
    .input(connectIntegrationInput)
    .output(integrationDto)
    .mutation(async ({ ctx, input }) => unwrap(await connectIntegration(ctx.rctx, input))),
  list: integrationsProcedure
    .meta({
      openapi: { method: "GET", path: "/integration.list", tags: ["integration"], protect: true },
    })
    .input(z.object({}))
    .output(z.array(integrationDto))
    .query(async ({ ctx }) => unwrap(await listIntegrations(ctx.rctx))),
  linkRepository: integrationsProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/integration.linkRepository",
        tags: ["integration"],
        protect: true,
      },
    })
    .input(linkRepositoryInput)
    .output(repositoryDto)
    .mutation(async ({ ctx, input }) => unwrap(await linkRepository(ctx.rctx, input))),
  listExternalIssues: integrationsProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/integration.listExternalIssues",
        tags: ["integration"],
        protect: true,
      },
    })
    .input(listExternalIssuesInput)
    .output(z.array(externalIssuePreviewDto))
    .query(async ({ ctx, input }) => unwrap(await listExternalIssues(ctx.rctx, input))),
  importIssues: integrationsProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/integration.importIssues",
        tags: ["integration"],
        protect: true,
      },
    })
    .input(importIssuesInput)
    .output(z.array(issueDto))
    .mutation(async ({ ctx, input }) => unwrap(await importIssues(ctx.rctx, input))),
  syncRepositorySignals: integrationsProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/integration.syncRepositorySignals",
        tags: ["integration"],
        protect: true,
      },
    })
    .input(syncRepositorySignalsInput)
    .output(
      z.object({
        changeRequests: z.array(changeRequestDto),
        branches: z.array(repositoryBranchDto),
      }),
    )
    .mutation(async ({ ctx, input }) => unwrap(await syncRepositorySignals(ctx.rctx, input))),
});
