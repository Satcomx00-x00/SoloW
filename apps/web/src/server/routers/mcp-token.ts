import "server-only";
import {
  issuedMcpTokenDto,
  issueMcpTokenInput,
  mcpTokenDto,
  revokeMcpTokenInput,
} from "@gatecontrol/contracts";
import { z } from "zod";
import { issueMcpToken, listMcpTokens, revokeMcpToken } from "../dal/mcp-token.js";
import { mcpProcedure, rateLimit, router, unwrap } from "../trpc.js";

/**
 * MCP token administration (issue #16 AC-4/AC-5).
 *
 * These procedures are *about* the MCP surface but are deliberately not part of it: they are
 * named in `WITHHELD_NAMESPACES` in `mcp/tools.ts`. Living behind `mcpProcedure` is no protection
 * on its own — `ff-mcp` is enabled by definition whenever anything is speaking MCP — so without
 * that entry a token could mint further tokens and undo its own revocation.
 */
export const mcpTokenRouter = router({
  list: mcpProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/mcpToken.list",
        tags: ["mcp"],
        protect: true,
        summary:
          "List issued MCP tokens as metadata only — label, scope, prefix, last use, revocation. Token values are never returned by a read.",
      },
    })
    .input(z.object({}))
    .output(z.array(mcpTokenDto))
    .query(async ({ ctx }) => unwrap(await listMcpTokens(ctx.rctx))),

  issue: mcpProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/mcpToken.issue",
        tags: ["mcp"],
        protect: true,
        summary:
          "Issue a scoped MCP token. The value is returned exactly once, in this response, and is not recoverable afterwards.",
      },
    })
    // Same rate class as `secret.set`: this mints a credential, and an unbounded mint loop is
    // how a scoped-token design quietly becomes an unscoped one.
    .use(rateLimit("secret.set"))
    .input(issueMcpTokenInput)
    .output(issuedMcpTokenDto)
    .mutation(async ({ ctx, input }) => unwrap(await issueMcpToken(ctx.rctx, input))),

  revoke: mcpProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/mcpToken.revoke",
        tags: ["mcp"],
        protect: true,
        summary:
          "Revoke an MCP token. Takes effect on the token's next request; the row is kept so the audit trail survives.",
      },
    })
    .input(revokeMcpTokenInput)
    .output(mcpTokenDto)
    .mutation(async ({ ctx, input }) => unwrap(await revokeMcpToken(ctx.rctx, input.id))),
});
