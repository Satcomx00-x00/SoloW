import { z } from "zod";
import { projectFieldTypeSchema } from "./project.js";

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
export const integrationCapabilitySchema = z.enum([
  "issues",
  /**
   * Writing an issue back: its title, body, state, assignees, labels, milestone.
   *
   * Separate from `issues` on purpose. Reading a tracker and writing to it are different
   * permissions and, for some providers, different products entirely — a read-only mirror of a
   * tracker nobody here may edit is a coherent integration, and folding the write into `issues`
   * would make it unexpressible. The registry's whole job is that this stays a question with an
   * answer rather than an assumption (F21, Decision 0016).
   */
  "issueWrites",
  "repositories",
  "changeRequests",
  "projects",
]);
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
/**
 * Which project field types a provider can hold, and why not for the rest.
 *
 * `expresses` and `cannot` are deliberately both required and deliberately disjoint: a type in
 * neither is a provider that has not answered, and a table cannot render a column it has no
 * answer for. Validated as disjoint rather than trusted, because the failure is silent — a type
 * in both would render editable *and* carry a reason it cannot be edited.
 */
/**
 * The parts of an issue a provider may be asked to change.
 *
 * Closed, like the project field types and for the same reason: an editor has to *render* a
 * control, and a control needs a kind rather than whatever the provider calls the field.
 */
export const issueFieldSchema = z.enum([
  "title",
  "description",
  "state",
  "assignees",
  "labels",
  "milestone",
]);
export type IssueField = z.infer<typeof issueFieldSchema>;
export const ISSUE_FIELDS = issueFieldSchema.options;

/**
 * Which parts of an issue a provider can write, and why not for the rest.
 *
 * Same shape and same two rules as `projectFieldSupport`: both required, disjoint, and together
 * exhaustive. A field in neither is a provider that has not answered, and an editor must not
 * offer a control whose fate it cannot state. A field in both would render editable *and* carry
 * the sentence saying it is not — the silent contradiction the refinements exist to catch.
 */
export const issueWriteSupportSchema = z
  .object({
    writes: z.array(issueFieldSchema),
    /** Field → the sentence shown where its control would have been. */
    cannot: z.record(issueFieldSchema, z.string().min(1).max(200)),
  })
  .refine(
    (v) => v.writes.every((f) => !(f in v.cannot)),
    "an issue field cannot be both writable and not",
  )
  .refine(
    (v) => issueFieldSchema.options.every((f) => v.writes.includes(f) || f in v.cannot),
    "every issue field must be either writable or explained",
  );
export type IssueWriteSupport = z.infer<typeof issueWriteSupportSchema>;

export const projectFieldSupportSchema = z
  .object({
    expresses: z.array(projectFieldTypeSchema),
    /** Type → the sentence shown where its column would have been editable. */
    cannot: z.record(projectFieldTypeSchema, z.string().min(1).max(200)),
  })
  .refine(
    (v) => v.expresses.every((t) => !(t in v.cannot)),
    "a field type cannot be both expressible and not",
  )
  .refine(
    (v) => projectFieldTypeSchema.options.every((t) => v.expresses.includes(t) || t in v.cannot),
    "every field type must be either expressible or refused with a reason",
  );
export type ProjectFieldSupport = z.infer<typeof projectFieldSupportSchema>;

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
  /**
   * What this provider can hold, for a provider that declares `projects` (Decision 0018).
   *
   * A capability alone would be a lie here. GitHub Projects v2 is a general typed-field store;
   * GitLab has scoped labels, and — on paid tiers only — iterations and weights. Declaring
   * "supports projects" and leaving the caller to discover the difference is how the table ends
   * up asking "is this GitHub", which is the branch #122 exists to prevent.
   *
   * So a provider states the field types it can *express*, and for each one it cannot, the
   * sentence a person reads instead of an input that would fail to save. The reason is prose on
   * purpose: "GitLab weights need a paid tier" is actionable; a boolean is not.
   */
  projectFields: projectFieldSupportSchema.optional(),
  /** Present exactly when the provider declares `issueWrites`. */
  issueWrites: issueWriteSupportSchema.optional(),
});
export type ProviderManifestDto = z.infer<typeof providerManifestDto>;

export const providerManifestListDto = z.array(providerManifestDto);
export type ProviderManifestListDto = z.infer<typeof providerManifestListDto>;

export const listProvidersInput = z.object({
  /** Narrow to providers that can do this. Omitted, every installed provider is listed. */
  capability: integrationCapabilitySchema.optional(),
});
export type ListProvidersInput = z.infer<typeof listProvidersInput>;
