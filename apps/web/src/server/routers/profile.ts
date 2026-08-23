import "server-only";
import {
  agentCatalogEntryDto,
  agentProfileDto,
  createAgentCatalogEntryInput,
  createAgentProfileInput,
  createExecutorProfileInput,
  deleteAgentProfileInput,
  executorProfileDto,
  updateAgentProfileInput,
  updateExecutorProfileInput,
} from "@gatecontrol/contracts";
import { z } from "zod";
import {
  createAgentCatalogEntry,
  createAgentProfile,
  createExecutorProfile,
  deleteAgentProfile,
  listAgentCatalog,
  listAgentProfiles,
  listExecutorProfiles,
  updateAgentProfile,
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
          summary:
            "List Agent Profiles available to bind to a Task, with how many Tasks, Workflow Steps and Sessions each is used by.",
        },
      })
      .input(z.object({}))
      .output(z.array(agentProfileDto))
      .query(async ({ ctx }) => unwrap(await listAgentProfiles(ctx.rctx))),
    update: ownerProcedure
      .meta({
        openapi: {
          method: "POST",
          path: "/profile.agent.update",
          tags: ["profile"],
          protect: true,
          summary:
            "Edit an Agent Profile's name, concurrency cap or permission mode. The agent it runs and the credential it runs on are fixed at creation — changing those would rewrite what its finished runs meant.",
        },
      })
      .input(updateAgentProfileInput)
      .output(agentProfileDto)
      .mutation(async ({ ctx, input }) => unwrap(await updateAgentProfile(ctx.rctx, input))),
    delete: ownerProcedure
      .meta({
        openapi: {
          method: "POST",
          path: "/profile.agent.delete",
          tags: ["profile"],
          protect: true,
          summary:
            "Delete an Agent Profile. Refused while a Task, a Workflow Step, or a Session's usage record still references it.",
        },
      })
      .input(deleteAgentProfileInput)
      .output(agentProfileDto)
      .mutation(async ({ ctx, input }) => unwrap(await deleteAgentProfile(ctx.rctx, input))),
  }),
  /**
   * The agent catalog (issue #10) — every Workspace starts with one seeded row
   * (`claude_code`, `claude_code_stream_json`); `create` is what lets an Owner add another,
   * most importantly one on the `acp` protocol. ACP already has a full runner
   * (`acp-runner.ts`) implementing `session/request_permission` — the elicitation widget
   * reads from it — but until a row exists to name it, no Agent Profile can ever point at it.
   */
  agentCatalog: router({
    list: ownerProcedure
      .meta({
        openapi: {
          method: "GET",
          path: "/profile.agentCatalog.list",
          tags: ["profile"],
          protect: true,
          summary:
            "List the agents this Workspace can run — the catalog an Agent Profile points at.",
        },
      })
      .input(z.object({}))
      .output(z.array(agentCatalogEntryDto))
      .query(async ({ ctx }) => unwrap(await listAgentCatalog(ctx.rctx))),
    create: ownerProcedure
      .meta({
        openapi: {
          method: "POST",
          path: "/profile.agentCatalog.create",
          tags: ["profile"],
          protect: true,
          summary:
            "Declare a new agent this Workspace can run: which protocol it speaks, the command that starts it, and the two environment variables billing integrity depends on.",
        },
      })
      .input(createAgentCatalogEntryInput)
      .output(agentCatalogEntryDto)
      .mutation(async ({ ctx, input }) => unwrap(await createAgentCatalogEntry(ctx.rctx, input))),
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
