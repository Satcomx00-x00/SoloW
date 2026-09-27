import "server-only";
import {
  renameWorkspaceInput,
  resetWorkspaceInput,
  syncRequestDto,
  syncStatusDto,
  workspaceDto,
  workspaceResetDto,
  workspaceSetupDto,
} from "@solow/contracts";
import {
  getSyncStatus,
  getWorkspace,
  getWorkspaceSetup,
  renameWorkspace,
  requestWorkspaceSync,
  resetWorkspaceData,
} from "../dal/workspace.js";
import {
  rateLimit,
  router,
  sessionProcedure,
  unwrap,
  workspaceControlsProcedure,
} from "../trpc.js";

/**
 * The Workspace as a thing an Owner can see and act on (2026-08-28).
 *
 * On `sessionProcedure`, not `ownerProcedure`, for the same reason `flag.ts` is: every
 * flag-gated procedure needs `ff-core-program` ON, and an operator can turn it off. The setup
 * checklist is what tells an Owner the core loop is off and offers to turn it back on, so gating
 * it behind that flag would hide the one screen that can fix it. Tenancy is untouched — the Workspace is always the
 * session's own, never named by the caller (Principle V).
 */
export const workspaceRouter = router({
  get: sessionProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/workspace.get",
        tags: ["workspace"],
        protect: true,
        summary: "The caller's own Workspace: id, name and when it was created.",
      },
    })
    .input(workspaceDto.pick({}).optional())
    .output(workspaceDto)
    .query(async ({ ctx }) => unwrap(await getWorkspace(ctx.rctx))),

  rename: sessionProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/workspace.rename",
        tags: ["workspace"],
        protect: true,
        summary: "Rename the caller's own Workspace.",
      },
    })
    .input(renameWorkspaceInput)
    .output(workspaceDto)
    .mutation(async ({ ctx, input }) => unwrap(await renameWorkspace(ctx.rctx, input))),

  /**
   * What this Workspace still needs before it can run anything, derived from the rows that
   * exist. A query rather than something stored: see `getWorkspaceSetup` for why a remembered
   * "completed" would be a checklist that lies the moment a Secret is deleted.
   */
  setup: sessionProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/workspace.setup",
        tags: ["workspace"],
        protect: true,
        summary:
          "What this Workspace still needs before it can run anything — a credential, a Harness Profile, an Executor, a Repository and the core loop — derived from what it actually has.",
      },
    })
    .input(workspaceDto.pick({}).optional())
    .output(workspaceSetupDto)
    .query(async ({ ctx }) => unwrap(await getWorkspaceSetup(ctx.rctx))),

  /**
   * How current the mirror is. A local read — no provider is contacted to answer it, which is
   * what lets a status bar ask for it without becoming the thing that costs the rate limit.
   */
  syncStatus: sessionProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/workspace.syncStatus",
        tags: ["workspace"],
        protect: true,
        summary:
          "How current this Workspace's mirror is: how many Repositories are linked, the oldest watermark among them, and how many are behind. Derived from the stored rows — no provider is contacted.",
      },
    })
    .input(workspaceDto.pick({}).optional())
    .output(syncStatusDto)
    .query(async ({ ctx }) => unwrap(await getSyncStatus(ctx.rctx))),

  /**
   * Sync everything now: the same durable pass the five-minute cron runs, forced.
   *
   * A mutation because it changes the world outside this process, and it answers on the handoff
   * rather than on the read — see `requestWorkspaceSync`.
   */
  syncNow: sessionProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/workspace.syncNow",
        tags: ["workspace"],
        protect: true,
        summary:
          "Ask the poll to run now across every linked Repository, ignoring its watermarks. Answers as soon as the durable engine has accepted the request, not when the providers have been read; `accepted: false` means there was no engine to hand it to.",
      },
    })
    .input(workspaceDto.pick({}).optional())
    .output(syncRequestDto)
    .mutation(async ({ ctx }) => unwrap(await requestWorkspaceSync(ctx.rctx))),

  /**
   * Empty this Workspace (spec F16).
   *
   * Behind its own flag rather than `ff-core-program`, because this is the surface an Owner
   * reaches for when the core loop has left the Workspace in a state they want gone — see
   * `workspaceControlsProcedure`. Rate limited for the reason `secret.set` is, and then some:
   * it is the only write in the product with no undo, so a client stuck in a retry loop must
   * run out of attempts rather than keep succeeding.
   *
   * The name is checked against the server's copy inside the DAL, not here, so the check and
   * the delete read the same row.
   */
  reset: workspaceControlsProcedure
    .use(rateLimit("workspace.reset"))
    .meta({
      openapi: {
        method: "POST",
        path: "/workspace.reset",
        tags: ["workspace"],
        protect: true,
        summary:
          "Delete this Workspace's data. `work-data` removes Projects, Issues, Tasks and Sessions and keeps the setup; `everything` additionally removes Repositories, Profiles, Secrets, Integrations, libraries and preferences. The Workspace row, the account and the harness catalog always survive. `confirmName` must equal the Workspace's current name. There is no undo.",
      },
    })
    .input(resetWorkspaceInput)
    .output(workspaceResetDto)
    .mutation(async ({ ctx, input }) => unwrap(await resetWorkspaceData(ctx.rctx, input))),
});
