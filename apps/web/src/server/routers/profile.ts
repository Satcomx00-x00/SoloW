import "server-only";
import {
  createAgentProfileInput,
  createExecutorProfileInput,
} from "@gatecontrol/contracts";
import { ownerProcedure, router, unwrap } from "../trpc.js";
import {
  createAgentProfile,
  createExecutorProfile,
  listAgentProfiles,
  listExecutorProfiles,
} from "../dal/profile.js";

export const profileRouter = router({
  agent: router({
    create: ownerProcedure
      .input(createAgentProfileInput)
      .mutation(async ({ ctx, input }) => unwrap(await createAgentProfile(ctx.rctx, input))),
    list: ownerProcedure.query(async ({ ctx }) => unwrap(await listAgentProfiles(ctx.rctx))),
  }),
  executor: router({
    create: ownerProcedure
      .input(createExecutorProfileInput)
      .mutation(async ({ ctx, input }) => unwrap(await createExecutorProfile(ctx.rctx, input))),
    list: ownerProcedure.query(async ({ ctx }) => unwrap(await listExecutorProfiles(ctx.rctx))),
  }),
});
