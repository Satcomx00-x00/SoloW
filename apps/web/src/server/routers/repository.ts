import "server-only";
import { connectRepositoryInput } from "@gatecontrol/contracts";
import { ownerProcedure, router, unwrap } from "../trpc.js";
import { connectRepository, listRepositories } from "../dal/repository.js";

export const repositoryRouter = router({
  connect: ownerProcedure
    .input(connectRepositoryInput)
    .mutation(async ({ ctx, input }) => unwrap(await connectRepository(ctx.rctx, input))),
  list: ownerProcedure.query(async ({ ctx }) => unwrap(await listRepositories(ctx.rctx))),
});
