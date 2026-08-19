import "server-only";
import { connectRepositoryInput, repositoryDto } from "@gatecontrol/contracts";
import { z } from "zod";
import { connectRepository, listRepositories } from "../dal/repository.js";
import { ownerProcedure, router, unwrap } from "../trpc.js";

export const repositoryRouter = router({
  connect: ownerProcedure
    .meta({
      openapi: { method: "POST", path: "/repository.connect", tags: ["repository"], protect: true },
    })
    .input(connectRepositoryInput)
    .output(repositoryDto)
    .mutation(async ({ ctx, input }) => unwrap(await connectRepository(ctx.rctx, input))),
  list: ownerProcedure
    .meta({
      openapi: { method: "GET", path: "/repository.list", tags: ["repository"], protect: true },
    })
    .input(z.object({}))
    .output(z.array(repositoryDto))
    .query(async ({ ctx }) => unwrap(await listRepositories(ctx.rctx))),
});
