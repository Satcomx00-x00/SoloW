import "server-only";
import {
  connectRepositoryInput,
  listRepositoriesInput,
  listRepositoryLabelsInput,
  repositoryDto,
  repositoryLabelDto,
  repositoryListDto,
  seedDefaultLabelsInput,
  seedDefaultLabelsResult,
  updateRepositorySetupInput,
} from "@solow/contracts";
import { z } from "zod";
import {
  connectRepository,
  listRepositories,
  listRepositoryLabels,
  seedDefaultLabels,
  updateRepositorySetup,
} from "../dal/repository.js";
import { integrationsProcedure, ownerProcedure, router, unwrap } from "../trpc.js";

export const repositoryRouter = router({
  connect: ownerProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/repository.connect",
        tags: ["repository"],
        protect: true,
        summary:
          "Connect a Git repository to the Workspace, by local path or remote URL, so Tasks can run against it.",
      },
    })
    .input(connectRepositoryInput)
    .output(repositoryDto)
    .mutation(async ({ ctx, input }) => unwrap(await connectRepository(ctx.rctx, input))),
  list: ownerProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/repository.list",
        tags: ["repository"],
        protect: true,
        summary: "List connected Repositories, including which Integration each is linked to.",
      },
    })
    .input(listRepositoriesInput)
    .output(repositoryListDto)
    .query(async ({ ctx, input }) => unwrap(await listRepositories(ctx.rctx, input))),
  updateSetup: ownerProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/repository.updateSetup",
        tags: ["repository"],
        protect: true,
        summary:
          "Replace the allowlist of files copied from the Repository into every new worktree, such as a .env the agent needs to run the test suite.",
      },
    })
    .input(updateRepositorySetupInput)
    .output(repositoryDto)
    .mutation(async ({ ctx, input }) => unwrap(await updateRepositorySetup(ctx.rctx, input))),
  // `integrationsProcedure`, not `ownerProcedure` — despite living in the repository router,
  // this decrypts a credential and calls out to a provider, exactly the class of endpoint
  // `ff-integrations`-gated procedures already are.
  listLabels: integrationsProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/repository.listLabels",
        tags: ["repository"],
        protect: true,
        summary:
          "Fetch a linked Repository's real labels from its GitHub/GitLab Integration, for the Issue label picker.",
      },
    })
    .input(listRepositoryLabelsInput)
    .output(z.array(repositoryLabelDto))
    .query(async ({ ctx, input }) =>
      unwrap(await listRepositoryLabels(ctx.rctx, input.repositoryId)),
    ),
  // `integrationsProcedure`, same reasoning as `listLabels` just above: this writes to whichever
  // provider the Repository is linked to.
  seedDefaultLabels: integrationsProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/repository.seedDefaultLabels",
        tags: ["repository"],
        protect: true,
        summary:
          "Create SoloW's default label taxonomy (type/, prio/, size/, status/, area/) on a linked Repository's GitHub/GitLab, leaving any label it already has untouched.",
      },
    })
    .input(seedDefaultLabelsInput)
    .output(seedDefaultLabelsResult)
    .mutation(async ({ ctx, input }) =>
      unwrap(await seedDefaultLabels(ctx.rctx, input.repositoryId)),
    ),
});
