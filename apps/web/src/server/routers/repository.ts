import "server-only";
import { connectRepositoryInput, repositoryDto } from "@gatecontrol/contracts";
import { z } from "zod";
import { connectRepository, listRepositories } from "../dal/repository.js";
import { ownerProcedure, router, unwrap } from "../trpc.js";

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
});
