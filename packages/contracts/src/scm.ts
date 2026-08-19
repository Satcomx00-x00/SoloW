import { z } from "zod";
import { idSchema, timestampsSchema } from "./common.js";

/**
 * SCM integrations (issue #15, spec F12). One `integration` per connected GitHub or GitLab
 * account, and everything imported from it — Issues, change requests, branches — carries a
 * reference back to the integration that produced it (AC-3, AC-6).
 *
 * Scope is deliberately narrow: GitHub and GitLab only (Jira/Linear/Sentry/Slack are
 * `wont-do`), and the domain speaks of a **change request**, never a "pull request" or "merge
 * request" — GitHub and GitLab each translate their own noun onto this shape at the driver
 * boundary in `@gatecontrol/scm`, so the domain never has to know which provider it is talking
 * to.
 */

export const scmProviderSchema = z.enum(["github", "gitlab"]);
export type ScmProvider = z.infer<typeof scmProviderSchema>;

/** Where an Issue came from. Existing rows predating this feature read as "local". */
export const issueSourceSchema = z.enum(["local", "github", "gitlab"]);
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

/** Bind a connected Repository to a specific `owner/repo` (or GitLab `namespace/path`) on an Integration. */
export const linkRepositoryInput = z.object({
  repositoryId: idSchema,
  integrationId: idSchema,
  externalFullName: z.string().min(1).max(300),
});
export type LinkRepositoryInput = z.infer<typeof linkRepositoryInput>;

/**
 * A repository the connected token can actually see, for the link picker.
 *
 * Linking used to take `externalFullName` as free text, which made a typo indistinguishable from
 * a repository the token simply cannot reach: both surfaced as a 404 later, at first sync, far
 * from the form that caused it. Offering the real list turns that class of error into something
 * the UI cannot express.
 */
export const externalRepositoryDto = z.object({
  fullName: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  defaultBranch: z.string().nullable(),
  isPrivate: z.boolean(),
  url: z.string(),
  /** True when some Repository in this Workspace is already linked to this provider repo. */
  alreadyLinked: z.boolean(),
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
