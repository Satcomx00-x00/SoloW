import "server-only";
import {
  createExecutorProfileInput,
  createHarnessCatalogEntryInput,
  createHarnessProfileInput,
  deleteExecutorProfileInput,
  deleteHarnessProfileInput,
  executorProfileDto,
  executorProfileListDto,
  harnessCatalogEntryDto,
  harnessProbeReport,
  harnessProfileDto,
  harnessProfileListDto,
  listProfilesInput,
  updateExecutorProfileInput,
  updateHarnessProfileInput,
} from "@solow/contracts";
import { z } from "zod";
import {
  createExecutorProfile,
  createHarnessCatalogEntry,
  createHarnessProfile,
  deleteExecutorProfile,
  deleteHarnessProfile,
  listExecutorProfiles,
  listHarnessCatalog,
  listHarnessProfiles,
  updateExecutorProfile,
  updateHarnessProfile,
} from "../dal/profile.js";
import { orchestrator } from "../orchestrator-client.js";
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
            "Create a Harness Profile: which catalog harness to run, its billing/auth mode, the Secret holding its credential, and its concurrency cap.",
        },
      })
      .input(createHarnessProfileInput)
      .output(harnessProfileDto)
      .mutation(async ({ ctx, input }) => unwrap(await createHarnessProfile(ctx.rctx, input))),
    list: ownerProcedure
      .meta({
        openapi: {
          method: "GET",
          path: "/profile.agent.list",
          tags: ["profile"],
          protect: true,
          summary:
            "List Harness Profiles available to bind to a Task, with how many Tasks, Workflow Steps and Sessions each is used by.",
        },
      })
      .input(listProfilesInput)
      .output(harnessProfileListDto)
      .query(async ({ ctx, input }) => unwrap(await listHarnessProfiles(ctx.rctx, input))),
    update: ownerProcedure
      .meta({
        openapi: {
          method: "POST",
          path: "/profile.agent.update",
          tags: ["profile"],
          protect: true,
          summary:
            "Edit a Harness Profile's name, concurrency cap or permission mode. The harness it runs and the credential it runs on are fixed at creation — changing those would rewrite what its finished runs meant.",
        },
      })
      .input(updateHarnessProfileInput)
      .output(harnessProfileDto)
      .mutation(async ({ ctx, input }) => unwrap(await updateHarnessProfile(ctx.rctx, input))),
    delete: ownerProcedure
      .meta({
        openapi: {
          method: "POST",
          path: "/profile.agent.delete",
          tags: ["profile"],
          protect: true,
          summary:
            "Delete a Harness Profile. Refused while a Task, a Workflow Step, or a Session's usage record still references it.",
        },
      })
      .input(deleteHarnessProfileInput)
      .output(harnessProfileDto)
      .mutation(async ({ ctx, input }) => unwrap(await deleteHarnessProfile(ctx.rctx, input))),
    /**
     * Start this Profile's harness, ask it what it is, and stop it — before a Task depends on it.
     *
     * A mutation rather than a query despite reading nothing: it spawns a process and refreshes
     * the catalog's capability cache, so it must never be retried or cached on a client's whim.
     */
    probe: ownerProcedure
      .meta({
        openapi: {
          method: "POST",
          path: "/profile.agent.probe",
          tags: ["profile"],
          protect: true,
          summary:
            "Test a Harness Profile: launch its harness with its credential, complete the protocol handshake, and report whether it works and what models and modes it advertises.",
        },
      })
      .input(z.object({ agentProfileId: z.string().min(1) }))
      .output(harnessProbeReport)
      .mutation(async ({ ctx, input }) =>
        orchestrator.probeHarnessProfile({
          workspaceId: ctx.rctx.workspaceId,
          agentProfileId: input.agentProfileId,
        }),
      ),
  }),
  /**
   * The harness catalog (issue #10) — every Workspace starts with one seeded row
   * (`claude_code`, `claude_code_stream_json`); `create` is what lets an Owner add another,
   * most importantly one on the `acp` protocol. ACP already has a full runner
   * (`acp-runner.ts`) implementing `session/request_permission` — the elicitation widget
   * reads from it — but until a row exists to name it, no Harness Profile can ever point at it.
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
            "List the harnesses this Workspace can run — the catalog a Harness Profile points at.",
        },
      })
      .input(z.object({}))
      .output(z.array(harnessCatalogEntryDto))
      .query(async ({ ctx }) => unwrap(await listHarnessCatalog(ctx.rctx))),
    create: ownerProcedure
      .meta({
        openapi: {
          method: "POST",
          path: "/profile.agentCatalog.create",
          tags: ["profile"],
          protect: true,
          summary:
            "Declare a new harness this Workspace can run: which protocol it speaks, the command that starts it, and the two environment variables billing integrity depends on.",
        },
      })
      .input(createHarnessCatalogEntryInput)
      .output(harnessCatalogEntryDto)
      .mutation(async ({ ctx, input }) => unwrap(await createHarnessCatalogEntry(ctx.rctx, input))),
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
            "Create an Executor Profile — where a harness runs, with per-kind typed configuration. Credentials are given as Secret references, never inline values.",
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
    delete: ownerProcedure
      .meta({
        openapi: {
          method: "POST",
          path: "/profile.executor.delete",
          tags: ["profile"],
          protect: true,
          summary:
            "Delete an Executor Profile no Task names. Refused while one still does — a finished run has to keep being able to say which machine produced it.",
        },
      })
      .input(deleteExecutorProfileInput)
      .output(executorProfileDto)
      .mutation(async ({ ctx, input }) => unwrap(await deleteExecutorProfile(ctx.rctx, input))),
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
      .input(listProfilesInput)
      .output(executorProfileListDto)
      .query(async ({ ctx, input }) => unwrap(await listExecutorProfiles(ctx.rctx, input))),
  }),
});
