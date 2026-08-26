import "server-only";
import {
  clearProviderIdentityInput,
  projectIdentityDto,
  projectIdentityInput,
  providerIdentityDto,
  setProviderIdentityInput,
} from "@gatecontrol/contracts";
import { z } from "zod";
import {
  clearProviderIdentity,
  listProviderIdentities,
  providerIdentityForProject,
  setProviderIdentity,
} from "../dal/identity.js";
import { integrationsProcedure, ownerProcedure, router, unwrap } from "../trpc.js";

/**
 * Who the signed-in user is on each connected provider (spec F23 FR-11, `assignee:@me`).
 *
 * No procedure takes a user id. The person is read from the session inside the DAL (Principle
 * V), which is what makes "my login" mean the same thing on every device and stops any client
 * from rewriting somebody else's mapping.
 *
 * Two kill switches, deliberately. Stating a mapping belongs beside the Integration it is about,
 * so it is off when integrations are off — there would be nothing to map. Resolving one is the
 * planning table asking a question of the local mirror, which must keep working when the SCM
 * feature is off: the answer is already stored here, and a `My items` tab that silently emptied
 * itself because a flag moved would be the exact failure this table was added to fix.
 */
export const identityRouter = router({
  list: integrationsProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/identity.list",
        tags: ["identity"],
        protect: true,
        summary:
          "The signed-in user's provider login on each connected Integration. Mappings whose Integration has been disconnected are not listed.",
      },
    })
    .input(z.object({}))
    .output(z.array(providerIdentityDto))
    .query(async ({ ctx }) => unwrap(await listProviderIdentities(ctx.rctx))),

  set: integrationsProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/identity.set",
        tags: ["identity"],
        protect: true,
        summary:
          "State the signed-in user's login on one Integration's provider — what `assignee:@me` resolves to on the projects that Integration owns. Stated rather than read from the token: the token is the Workspace's, so it names whoever issued it.",
      },
    })
    .input(setProviderIdentityInput)
    .output(providerIdentityDto)
    .mutation(async ({ ctx, input }) => unwrap(await setProviderIdentity(ctx.rctx, input))),

  clear: integrationsProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/identity.clear",
        tags: ["identity"],
        protect: true,
        summary:
          "Forget the signed-in user's login on one Integration. `@me` then matches nothing on that Integration's projects, and the table says the mapping is missing.",
      },
    })
    .input(clearProviderIdentityInput)
    .output(z.object({ integrationId: z.string() }))
    .mutation(async ({ ctx, input }) => unwrap(await clearProviderIdentity(ctx.rctx, input))),

  forProject: ownerProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/identity.forProject",
        tags: ["identity"],
        protect: true,
        summary:
          "What `@me` resolves to on one Project — the signed-in user's login on the provider that Project belongs to. `login` is null when no mapping has been stated, which the table states rather than rendering as an empty result.",
      },
    })
    .input(projectIdentityInput)
    .output(projectIdentityDto)
    .query(async ({ ctx, input }) => unwrap(await providerIdentityForProject(ctx.rctx, input))),
});
