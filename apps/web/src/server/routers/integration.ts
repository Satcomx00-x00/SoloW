import "server-only";
import {
  changeRequestDto,
  connectIntegrationInput,
  connectIntegrationResultDto,
  deleteIntegrationInput,
  deleteIntegrationResultDto,
  externalIssuePreviewDto,
  externalRepositoryDto,
  importIssuesInput,
  importRepositoryInput,
  integrationDto,
  issueDto,
  listExternalIssuesInput,
  listExternalRepositoriesInput,
  listProvidersInput,
  providerManifestListDto,
  repositoryBranchDto,
  repositoryDto,
  syncRepositorySignalsInput,
} from "@solow/contracts";
import { listProviderManifests } from "@solow/scm";
import { z } from "zod";
import {
  connectIntegration,
  deleteIntegration,
  importIssues,
  importRepository,
  listExternalIssues,
  listExternalRepositories,
  listIntegrations,
  syncRepositorySignals,
} from "../dal/integration.js";
import { integrationsProcedure, router, unwrap } from "../trpc.js";

/** SCM integrations (issue #15) — connect a provider, link Repositories, import and sync. */
export const integrationRouter = router({
  /**
   * Which providers this build actually has (F21).
   *
   * An endpoint rather than a constant compiled into the web app, because that is the whole
   * point of the registry: the answer belongs to the running server and can differ between
   * builds. It is also why `openapi.json` no longer enumerates the valid providers for
   * `connect` — the document describes the id grammar, and this describes what is installed.
   */
  providers: integrationsProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/integration.providers",
        tags: ["integration"],
        protect: true,
        summary:
          "Every integration provider this build has a driver for, with the capabilities it offers and the fields its connect form needs. Optionally narrowed to providers offering one capability.",
      },
    })
    .input(listProvidersInput)
    .output(providerManifestListDto)
    .query(({ input }) => listProviderManifests(input.capability)),
  connect: integrationsProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/integration.connect",
        tags: ["integration"],
        protect: true,
        summary:
          "Connect a GitHub or GitLab account using a stored Personal Access Token Secret. The token is verified against the provider before the Integration is recorded, then every Repository the token can see is imported automatically (capped; partial failures are reported per Repository, not raised as a mutation error), each with its own Issues.",
      },
    })
    .input(connectIntegrationInput)
    .output(connectIntegrationResultDto)
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
  delete: integrationsProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/integration.delete",
        tags: ["integration"],
        protect: true,
        summary:
          "Disconnect an Integration. Its Repositories are unlinked and the branches and change requests synced from it are removed, since nothing can refresh them once the credential is gone. Imported Issues are kept and detached — Tasks point at them.",
      },
    })
    .input(deleteIntegrationInput)
    .output(deleteIntegrationResultDto)
    .mutation(async ({ ctx, input }) => unwrap(await deleteIntegration(ctx.rctx, input))),
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
  importRepository: integrationsProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/integration.importRepository",
        tags: ["integration"],
        protect: true,
        summary:
          "Import a repository from an Integration, creating the Repository already bound to it and then importing its Issues automatically. Records the provider's clone URL; the orchestrator clones it the first time a Task needs it. Importing the same repository twice returns the existing Repository.",
      },
    })
    .input(importRepositoryInput)
    .output(repositoryDto)
    .mutation(async ({ ctx, input }) => unwrap(await importRepository(ctx.rctx, input))),
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
          "Import selected external issues as SoloW Issues. Idempotent per Repository — re-importing the same ids is a visible no-op, not a duplicate.",
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
          "Refresh a linked Repository's change requests (pull/merge requests) and branches from its provider. On-demand pull; SoloW never creates or modifies anything on the provider here.",
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
