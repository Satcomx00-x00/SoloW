import "server-only";
import {
  changeRequestDto,
  connectIntegrationInput,
  externalIssuePreviewDto,
  externalRepositoryDto,
  importIssuesInput,
  integrationDto,
  issueDto,
  linkRepositoryInput,
  listExternalIssuesInput,
  listExternalRepositoriesInput,
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
  listExternalRepositories,
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
        summary:
          "Connect a GitHub or GitLab account using a stored Personal Access Token Secret. The token is verified against the provider before the Integration is recorded.",
      },
    })
    .input(connectIntegrationInput)
    .output(integrationDto)
    .mutation(async ({ ctx, input }) => unwrap(await connectIntegration(ctx.rctx, input))),
  list: integrationsProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/integration.list",
        tags: ["integration"],
        protect: true,
        summary: "List connected GitHub/GitLab Integrations.",
      },
    })
    .input(z.object({}))
    .output(z.array(integrationDto))
    .query(async ({ ctx }) => unwrap(await listIntegrations(ctx.rctx))),
  listExternalRepositories: integrationsProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/integration.listExternalRepositories",
        tags: ["integration"],
        protect: true,
        summary:
          "List the repositories this Integration's token can actually see, flagging the ones already linked. Backs the link picker so a repository is chosen from real options rather than typed.",
      },
    })
    .input(listExternalRepositoriesInput)
    .output(z.array(externalRepositoryDto))
    .query(async ({ ctx, input }) => unwrap(await listExternalRepositories(ctx.rctx, input))),
  linkRepository: integrationsProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/integration.linkRepository",
        tags: ["integration"],
        protect: true,
        summary:
          "Bind a connected Repository to a specific owner/repo (GitHub) or namespace/project (GitLab) on an Integration.",
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
        summary:
          "Preview the issues on a linked Repository's provider, flagging which have already been imported.",
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
        summary:
          "Import selected external issues as GateControl Issues. Idempotent per Repository — re-importing the same ids is a visible no-op, not a duplicate.",
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
        summary:
          "Refresh a linked Repository's change requests (pull/merge requests) and branches from its provider. On-demand pull; GateControl never creates or modifies anything on the provider here.",
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
