import "server-only";
import {
  agentProfileDto,
  createAgentProfileInput,
  createExecutorProfileInput,
  executorProfileDto,
  updateExecutorProfileInput,
} from "@gatecontrol/contracts";
import { z } from "zod";
import {
  createAgentProfile,
  createExecutorProfile,
  listAgentProfiles,
  listExecutorProfiles,
  updateExecutorProfile,
} from "../dal/profile.js";
import { ownerProcedure, router, unwrap } from "../trpc.js";

export const profileRouter = router({
  agent: router({
    create: ownerProcedure
      .meta({
        openapi: {
          method: "POST",
          path: "/profile.agent.create",
          tags: ["profile"],
          protect: true,
        },
      })
      .input(createAgentProfileInput)
      .output(agentProfileDto)
      .mutation(async ({ ctx, input }) => unwrap(await createAgentProfile(ctx.rctx, input))),
    list: ownerProcedure
      .meta({
        openapi: { method: "GET", path: "/profile.agent.list", tags: ["profile"], protect: true },
      })
      .input(z.object({}))
      .output(z.array(agentProfileDto))
      .query(async ({ ctx }) => unwrap(await listAgentProfiles(ctx.rctx))),
  }),
  executor: router({
    create: ownerProcedure
      .meta({
        openapi: {
          method: "POST",
          path: "/profile.executor.create",
          tags: ["profile"],
          protect: true,
        },
      })
      .input(createExecutorProfileInput)
      .output(executorProfileDto)
      .mutation(async ({ ctx, input }) => unwrap(await createExecutorProfile(ctx.rctx, input))),
    update: ownerProcedure
      .meta({
        openapi: {
          method: "POST",
          path: "/profile.executor.update",
          tags: ["profile"],
          protect: true,
        },
      })
      .input(updateExecutorProfileInput)
      .output(executorProfileDto)
      .mutation(async ({ ctx, input }) => unwrap(await updateExecutorProfile(ctx.rctx, input))),
    list: ownerProcedure
      .meta({
        openapi: {
          method: "GET",
          path: "/profile.executor.list",
          tags: ["profile"],
          protect: true,
        },
      })
      .input(z.object({}))
      .output(z.array(executorProfileDto))
      .query(async ({ ctx }) => unwrap(await listExecutorProfiles(ctx.rctx))),
  }),
});
