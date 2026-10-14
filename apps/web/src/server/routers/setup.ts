import "server-only";
import { connectClaudeInput, connectClaudeResultDto, setupTestResultDto } from "@solow/contracts";
import { z } from "zod";
import { connectClaude, runSetupTest } from "../dal/setup.js";
import { ownerProcedure, rateLimit, router, unwrap } from "../trpc.js";
import { resumeTasksBlockedBy } from "./secret.js";

/**
 * The guided setup's two writes (roadmap E1). Its read is `workspace.setup`, which stays on
 * `sessionProcedure` so it can still say the core loop is off; these are core-loop writes and sit
 * behind it like every other.
 *
 * Both are withheld from the MCP surface (`mcp/tools.ts`): one stores a credential, the other
 * spends the Owner's tokens on their behalf, and neither is work management.
 */
export const setupRouter = router({
  /**
   * Store the credential and everything that hangs off it in one step. Limited like `secret.set`,
   * which it is a superset of, and resumes the Tasks a replaced credential had paused, as that
   * does — re-running the setup with a fresh token is a natural way to renew an expired one.
   */
  connectClaude: ownerProcedure
    .use(rateLimit("secret.set"))
    .input(connectClaudeInput)
    .output(connectClaudeResultDto)
    .mutation(async ({ ctx, input }) => {
      const { result, secretId } = unwrap(await connectClaude(ctx.rctx, input));
      return { ...result, resumedTaskCount: await resumeTasksBlockedBy(ctx.rctx, secretId) };
    }),

  /**
   * One real prompt to the agent a new Task would use. A mutation, not a query: it spawns a
   * process and spends tokens, so no client may cache or retry it on its own. Limited because a
   * looping client would spend them for nothing.
   */
  test: ownerProcedure
    .use(rateLimit("setup.test"))
    .input(z.object({}).optional())
    .output(setupTestResultDto)
    .mutation(async ({ ctx }) => runSetupTest(ctx.rctx)),
});
