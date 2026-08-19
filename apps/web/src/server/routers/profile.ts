import "server-only";
import {
  agentCatalogEntryDto,
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
  listAgentCatalog,
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
          summary:
            "Create an Agent Profile: which catalog agent to run, its billing/auth mode, the Secret holding its credential, and its concurrency cap.",
        },
      })
      .input(createAgentProfileInput)
      .output(agentProfileDto)
      .mutation(async ({ ctx, input }) => unwrap(await createAgentProfile(ctx.rctx, input))),
    list: ownerProcedure
      .meta({
        openapi: {
          method: "GET",
          path: "/profile.agent.list",
          tags: ["profile"],
          protect: true,
          summary: "List Agent Profiles available to bind to a Task.",
        },
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
          summary:
            "List the agents this Workspace can run — the catalog an Agent Profile points at. Read-only; rows are seeded per Workspace.",
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
          summary:
            "Create an Executor Profile — where an agent runs, with per-kind typed configuration. Credentials are given as Secret references, never inline values.",
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
          summary: "Update an Executor Profile's name or its per-kind configuration.",
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
          summary: "List Executor Profiles available to bind to a Task.",
        },
      })
      .input(z.object({}))
      .output(z.array(executorProfileDto))
      .query(async ({ ctx }) => unwrap(await listExecutorProfiles(ctx.rctx))),
  }),
});
