import "server-only";
import {
  agentCatalogEntryDto,
  agentProfileDto,
  createAgentProfileInput,
  createExecutorProfileInput,
  executorProfileDto,
} from "@gatecontrol/contracts";
import { z } from "zod";
import {
  createAgentProfile,
  createExecutorProfile,
  listAgentCatalog,
  listAgentProfiles,
  listExecutorProfiles,
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
  /** The agent catalog (issue #10) — read-only from the API today; rows are seeded per Workspace. */
  agentCatalog: router({
    list: ownerProcedure
      .meta({
        openapi: {
          method: "GET",
          path: "/profile.agentCatalog.list",
          tags: ["profile"],
          protect: true,
        },
      })
      .input(z.object({}))
      .output(z.array(agentCatalogEntryDto))
      .query(async ({ ctx }) => unwrap(await listAgentCatalog(ctx.rctx))),
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
