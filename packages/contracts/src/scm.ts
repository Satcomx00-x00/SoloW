import { z } from "zod";
import { idSchema, timestampsSchema } from "./common.js";
import { providerIdSchema } from "./integration-provider.js";

/**
 * SCM integrations (issue #15, spec F12). One `integration` per connected GitHub or GitLab
 * account, and everything imported from it — Issues, change requests, branches — carries a
 * reference back to the integration that produced it (AC-3, AC-6).
 *
 * The domain speaks of a **change request**, never a "pull request" or "merge request" — each
 * driver translates its provider's own noun onto this shape at the boundary in
 * `@gatecontrol/scm`, so the domain never has to know which provider it is talking to.
 *
 * Which providers exist is no longer stated here. It was, as a closed `z.enum`, and that enum
 * was one of eight places a third provider had to be added to (F21, Decision 0016). It is now a
 * registry, and these two schemas take the id grammar instead.
 */

/**
 * The provider an Integration connects to.
 *
 * A pattern rather than an enum, which is a real trade and worth naming. The enum guaranteed
 * every stored value was one this build understands — by refusing to parse anything else, which
 * in practice meant a Workspace restored into an older build failed to render its Issues page
 * rather than showing one unfamiliar badge. The pattern gives that guarantee up on purpose: an
 * id with no registered provider behind it is readable, inert, and cannot be synced through
 * (F21 FR-7). An unfamiliar badge is a better failure than a page that will not load.
 */
export const scmProviderSchema = providerIdSchema;
export type ScmProvider = z.infer<typeof scmProviderSchema>;

/**
 * Where an Issue came from. `local` is the one reserved value — an Issue typed into GateControl,
 * belonging to no provider — and everything else is a provider id. Rows predating integrations
 * read as `local`.
 *
 * Reserved rather than registered: no driver may claim `local`, because it is the absence of one.
 */
export const LOCAL_ISSUE_SOURCE = "local";
export const issueSourceSchema = z.union([z.literal(LOCAL_ISSUE_SOURCE), providerIdSchema]);
export type IssueSource = z.infer<typeof issueSourceSchema>;

export const changeRequestStateSchema = z.enum(["open", "closed", "merged"]);
export type ChangeRequestState = z.infer<typeof changeRequestStateSchema>;

/**
 * Connect an Integration. `secretId` references an already-stored `scm_pat` Secret — the token
 * itself is never part of this input (Principle IV, AC-1). `baseUrl` is for GitHub Enterprise
 * Server or a self-managed GitLab instance; omit it for the public SaaS host.
 */
export const connectIntegrationInput = z.object({
  provider: scmProviderSchema,
  secretId: idSchema,
  baseUrl: z.string().url().max(500).optional(),
  /** Opt-in (AC-4): off by default, since writing back to someone's tracker is not implicit. */
  writeBackEnabled: z.boolean().default(false),
});
export type ConnectIntegrationInput = z.infer<typeof connectIntegrationInput>;

export const integrationDto = z
  .object({
    id: idSchema,
    provider: scmProviderSchema,
    secretId: idSchema,
    baseUrl: z.string().nullable(),
    writeBackEnabled: z.boolean(),
  })
  .merge(timestampsSchema);
export type IntegrationDto = z.infer<typeof integrationDto>;

/**
 * One Repository's outcome inside `connect`'s automatic sync (issue #15's "connecting an
 * Integration should automatically fetch all its repositories"). A per-repository row rather
 * than a single pass/fail for the whole batch, because the batch is explicitly allowed to
 * partially fail — one bad repository must not hide whether the other nineteen landed.
 *
 * `repositoryId`/`issuesImported` are only present when `status` is `"imported"`; `error` is
 * only present when it is `"failed"`. `"skipped_over_cap"` carries neither — the operator's next
 * step for those is the existing manual `listExternalRepositories` / `importRepository`, not a
 * reason to read.
 */
export const autoSyncedRepositoryDto = z.object({
  externalFullName: z.string(),
  status: z.enum(["imported", "failed", "skipped_over_cap"]),
  repositoryId: idSchema.optional(),
  /** Issues auto-imported for this Repository. Present only when `status` is `"imported"`. */
  issuesImported: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});
export type AutoSyncedRepositoryDto = z.infer<typeof autoSyncedRepositoryDto>;

/**
 * `connect`'s result: the Integration itself, plus what its automatic Repository (and, per
 * Repository, Issue) sync did. Auto-sync failures are reported *inside* this payload rather than
 * failing the mutation — the Integration is connected either way, so a caller checking `.ok`
 * alone still sees the correct, successful outcome; reading `autoSyncedRepositories` is how an
 * operator finds out whether anything needs a manual follow-up.
 */
export const connectIntegrationResultDto = z.object({
  integration: integrationDto,
  autoSyncedRepositories: z.array(autoSyncedRepositoryDto),
});
export type ConnectIntegrationResultDto = z.infer<typeof connectIntegrationResultDto>;

/**
 * Import a repository from an Integration: pick one the token can see, and GateControl creates
 * the Repository for it, already bound to the provider.
 *
 * This replaced a two-step "connect a local clone, then link it to a provider repo" flow. The
 * old shape asked the user to have the repository on disk *first*, which made the common case —
 * "I want to work on this GitHub repo" — the one the product could not express. Nothing is
 * cloned here: the location recorded is the provider's clone URL, and the orchestrator clones it
 * into its cache the first time a Task needs it, the same way it already handles any remote URL.
 *
 * `name` is optional because the provider already has one; it exists for the case where two
 * Integrations expose repositories that would otherwise be called the same thing.
 */
export const importRepositoryInput = z.object({
  integrationId: idSchema,
  externalFullName: z.string().min(1).max(300),
  name: z.string().min(1).max(120).optional(),
});
export type ImportRepositoryInput = z.infer<typeof importRepositoryInput>;

/**
 * A repository the connected token can actually see, for the import picker.
 *
 * Importing takes a pick from this list rather than a typed `owner/repo`, which is what makes a
 * typo impossible to express: a name that is not here is a repository the token cannot reach,
 * and that used to surface as a 404 much later, at first sync, far from the form that caused it.
 */
export const externalRepositoryDto = z.object({
  fullName: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  defaultBranch: z.string().nullable(),
  isPrivate: z.boolean(),
  /** The provider's web page — for a human to open. `cloneUrl` is what git is given. */
  url: z.string(),
  /** The https URL a Repository imported from here will be cloned from. Never carries a token. */
  cloneUrl: z.string(),
  /** True when this Workspace already imported this provider repo through this Integration. */
  alreadyImported: z.boolean(),
});
export type ExternalRepositoryDto = z.infer<typeof externalRepositoryDto>;

export const listExternalRepositoriesInput = z.object({
  integrationId: idSchema,
});
export type ListExternalRepositoriesInput = z.infer<typeof listExternalRepositoriesInput>;

/** A provider issue not yet imported, or already imported (`alreadyImported` true) — the Import dialog's row shape. */
export const externalIssuePreviewDto = z.object({
  externalId: z.string(),
  number: z.number().int(),
  title: z.string(),
  description: z.string().nullable(),
  state: z.enum(["open", "closed"]),
  url: z.string(),
  alreadyImported: z.boolean(),
});
export type ExternalIssuePreviewDto = z.infer<typeof externalIssuePreviewDto>;

export const listExternalIssuesInput = z.object({
  repositoryId: idSchema,
});
export type ListExternalIssuesInput = z.infer<typeof listExternalIssuesInput>;

/**
 * Import selected external issues as GateControl Issues (AC-2). Idempotent on
 * `(workspaceId, integrationId, externalId)` — importing an id already imported is a no-op that
 * still returns the existing Issue, so a second import is visibly not a duplicate.
 */
export const importIssuesInput = z.object({
  repositoryId: idSchema,
  externalIds: z.array(z.string()).min(1).max(200),
});
export type ImportIssuesInput = z.infer<typeof importIssuesInput>;

export const syncRepositorySignalsInput = z.object({
  repositoryId: idSchema,
});
export type SyncRepositorySignalsInput = z.infer<typeof syncRepositorySignalsInput>;

export const changeRequestDto = z
  .object({
    id: idSchema,
    repositoryId: idSchema,
    number: z.number().int(),
    title: z.string(),
    state: changeRequestStateSchema,
    url: z.string(),
    headRef: z.string(),
    baseRef: z.string(),
    authorLogin: z.string().nullable(),
    syncedAt: z.string(),
  })
  .merge(timestampsSchema);
export type ChangeRequestDto = z.infer<typeof changeRequestDto>;

export const repositoryBranchDto = z.object({
  id: idSchema,
  repositoryId: idSchema,
  name: z.string(),
  isDefault: z.boolean(),
  headSha: z.string(),
  headCommittedAt: z.string().nullable(),
  syncedAt: z.string(),
});
export type RepositoryBranchDto = z.infer<typeof repositoryBranchDto>;

/**
 * Disconnect an Integration and drop what only existed because of it.
 *
 * Deliberately not a full cascade. Branches and change requests are a cache of the provider's
 * state — once the credential is gone they can never be refreshed again, so keeping them would
 * leave the UI showing data it can no longer verify. Imported Issues are the opposite: they are
 * GateControl work items that Tasks point at (`task.issue_id` is NOT NULL), so they are kept and
 * detached rather than deleted, and the Repositories are unlinked rather than removed.
 */
export const deleteIntegrationInput = z.object({ id: idSchema });
export type DeleteIntegrationInput = z.infer<typeof deleteIntegrationInput>;

/** What the disconnect actually touched, so the UI can report it rather than claim it. */
export const deleteIntegrationResultDto = z.object({
  id: idSchema,
  repositoriesUnlinked: z.number().int().nonnegative(),
  branchesDeleted: z.number().int().nonnegative(),
  changeRequestsDeleted: z.number().int().nonnegative(),
  /** Kept, with their link to this Integration cleared. Never deleted. */
  issuesDetached: z.number().int().nonnegative(),
});
export type DeleteIntegrationResultDto = z.infer<typeof deleteIntegrationResultDto>;
