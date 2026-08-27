import { z } from "zod";
import { idSchema, timestampsSchema } from "./common.js";
import { providerIdSchema } from "./integration-provider.js";

/**
 * Who the signed-in user is **on a provider** (spec F23 FR-11, `assignee:@me`).
 *
 * A SoloW account name and a provider login are two different names for one person, and
 * nothing makes them agree: `satcom` here is `satcomx00` on the host, and an account created
 * from an email address shares no characters with either. The planning table's `My items` tab
 * filters on the login the provider mirrored onto the row, so without a stated mapping `@me`
 * compares a SoloW name against a provider login and matches on coincidence alone.
 *
 * The mapping is per **Integration**, not per provider id: the same person is a different login
 * on a company GitHub Enterprise host than on github.com, and both can be connected at once.
 */

/**
 * A login as a provider writes it. Trimmed, because a pasted one arrives with a space; not
 * lowercased, because the comparison is already case-insensitive and rewriting what someone
 * typed makes the field look like it lost the value.
 */
export const providerLoginSchema = z.string().trim().min(1).max(100);
export type ProviderLogin = z.infer<typeof providerLoginSchema>;

/** One Integration's mapping for the signed-in user. Absent means "not stated", never "none". */
export const providerIdentityDto = z
  .object({
    integrationId: idSchema,
    /** Carried so the settings list can name the connection without a second lookup. */
    provider: providerIdSchema,
    login: providerLoginSchema,
  })
  .merge(timestampsSchema);
export type ProviderIdentityDto = z.infer<typeof providerIdentityDto>;

/**
 * State (or correct) your login on one Integration. No `userId`: the person is a fact about the
 * session, so there is no argument a client could send that would rewrite someone else's mapping
 * (Principle V).
 */
export const setProviderIdentityInput = z.object({
  integrationId: idSchema,
  login: providerLoginSchema,
});
export type SetProviderIdentityInput = z.infer<typeof setProviderIdentityInput>;

export const clearProviderIdentityInput = z.object({ integrationId: idSchema });
export type ClearProviderIdentityInput = z.infer<typeof clearProviderIdentityInput>;

export const projectIdentityInput = z.object({ projectId: idSchema });
export type ProjectIdentityInput = z.infer<typeof projectIdentityInput>;

/**
 * What `@me` resolves to on one Project, answered server-side.
 *
 * `login: null` is the whole reason this is a DTO rather than a string: "we do not know who you
 * are on this provider" has to reach the table as a fact it can state, because the alternative —
 * an empty result set — looks exactly like a project where nothing is assigned to you.
 */
export const projectIdentityDto = z.object({
  projectId: idSchema,
  /**
   * The Integration the Project belongs to; the mapping to state, when there is none. Null for a
   * local Project (user request 2026-08-27) — there is no provider to have an identity on, and
   * `@me` there resolves to nothing (`login: null`) for exactly the same reason an unmapped
   * mirrored Project does: matching nothing is the honest answer, not everything.
   */
  integrationId: idSchema.nullable(),
  login: z.string().nullable(),
});
export type ProjectIdentityDto = z.infer<typeof projectIdentityDto>;
