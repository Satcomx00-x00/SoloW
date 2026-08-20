import "server-only";
import {
  connectRepositoryInput,
  listRepositoryLabelsInput,
  repositoryDto,
  repositoryLabelDto,
  updateRepositorySetupInput,
} from "@gatecontrol/contracts";
import { z } from "zod";
import {
  connectRepository,
  listRepositories,
  listRepositoryLabels,
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
    .input(z.object({}))
    .output(z.array(repositoryDto))
    .query(async ({ ctx }) => unwrap(await listRepositories(ctx.rctx))),
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
});
