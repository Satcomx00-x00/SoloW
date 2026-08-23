import { z } from "zod";

/**
 * What an integration provider *is*, as far as anything outside `@gatecontrol/scm` is concerned
 * (F21, [Decision 0016](../../../docs/decisions/0016-integration-provider-registry.md)).
 *
 * The set of providers used to be a `z.enum(["github", "gitlab"])` in `scm.ts`, and adding a
 * third meant editing eight files that had no reason to know about each other. Worse, the one
 * interface behind that enum assumed a single host answers every question — true of Gitea, false
 * of a tracker like Jira, which has issues and labels and no repositories at all. A flat
 * interface would have a Jira driver implement four methods that throw and every caller learn
 * which providers are safe to call them on, which is the per-provider domain the neutral "change
 * request" vocabulary exists to prevent.
 *
 * So a provider declares a **manifest** naming what it can do, and callers ask for a capability
 * rather than for a provider. What lives here is only the part that crosses a boundary: the
 * capability names, the id grammar, and the descriptor the settings UI draws its picker and its
 * connect form from. The registry itself is pure logic in `@gatecontrol/core`, and the drivers
 * are in `@gatecontrol/scm` — the same three-way split `contribution.ts` already uses.
 */

/**
 * What a provider can answer questions about. Closed on purpose, unlike the set of providers:
 * a capability is a shape the product has code for, and one nothing consumes is not a capability
 * but a plan. Adding one is a deliberate change here plus the callers that use it.
 */
export const integrationCapabilitySchema = z.enum(["issues", "repositories", "changeRequests"]);
export type IntegrationCapability = z.infer<typeof integrationCapabilitySchema>;

export const INTEGRATION_CAPABILITIES = integrationCapabilitySchema.options;

/**
 * A provider id: lowercase segments joined by `.` or `-` — `github`, `gitlab`, `gitea`,
 * `acme.internal-forge`.
 *
 * Deliberately the same grammar as `contributionIdSchema`, and for the same reason: this is a
 * compatibility surface, not an internal handle. It is written into `integration.provider` and
 * into `issue.source`, so renaming one orphans every row that carries it (F21 FR-2).
 */
export const providerIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/);
export type ProviderId = z.infer<typeof providerIdSchema>;

/**
 * One field a provider needs in order to connect.
 *
 * The connect form used to be written once, with GitHub's and GitLab's needs merged into it —
 * which is why it offered a base URL to hosts that have no such concept and labelled it with two
 * example URLs. A provider that needs an account email as well as a token cannot be expressed
 * that way at all. So the form is built from this list (F21 FR-6).
 *
 * `secret` is the kind that matters: a field marked secret is stored as a `Secret` row and never
 * travels in a DTO afterwards (Principle IV). Everything else is ordinary configuration and is
 * readable back.
 */
export const providerFieldSchema = z.object({
  /** Key under which the value is stored on the integration. */
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-zA-Z0-9]*$/),
  label: z.string().min(1).max(80),
  /** Shown under the field. The place to say what a value is for, not to repeat the label. */
  help: z.string().max(200).optional(),
  placeholder: z.string().max(200).optional(),
  required: z.boolean().default(false),
  /** Stored as a Secret and never read back. Exactly one field per provider should be one. */
  secret: z.boolean().default(false),
});
export type ProviderField = z.infer<typeof providerFieldSchema>;

/**
 * A provider as the client sees it — what the settings picker lists and the connect form is
 * built from.
 *
 * Sent over the wire rather than compiled into the web app, because "which providers does this
 * build have" is a question about the running orchestrator, and the whole point of the registry
 * is that the answer can differ between builds. It is also why `openapi.json` no longer
 * enumerates the valid providers for `integration.connect`: the document describes the id
 * grammar, and this endpoint describes what is actually installed.
 */
export const providerManifestDto = z.object({
  id: providerIdSchema,
  /** How the provider is spelled where a person reads it: "GitHub", "GitLab", "Gitea". */
  name: z.string().min(1).max(80),
  capabilities: z.array(integrationCapabilitySchema).min(1),
  fields: z.array(providerFieldSchema).max(12),
  /**
   * The provider's own word for a change request — "pull request", "merge request". For display
   * only, and only where a person is being pointed at the provider's own UI. The domain says
   * change request everywhere else (F21 FR-8), which is what stops a per-provider vocabulary
   * leaking back in through a label.
   */
  changeRequestNoun: z.string().max(40).optional(),
});
export type ProviderManifestDto = z.infer<typeof providerManifestDto>;

export const providerManifestListDto = z.array(providerManifestDto);
export type ProviderManifestListDto = z.infer<typeof providerManifestListDto>;

export const listProvidersInput = z.object({
  /** Narrow to providers that can do this. Omitted, every installed provider is listed. */
  capability: integrationCapabilitySchema.optional(),
});
export type ListProvidersInput = z.infer<typeof listProvidersInput>;
