import "server-only";
import type {
  ChangeRequestDto,
  IntegrationDto,
  IssueDto,
  IssueStatus,
  McpTokenDto,
  RepositoryBranchDto,
  RepositoryDto,
  SecretRefDto,
  SecretUsageDto,
  TaskDto,
  TaskRepositoryDto,
} from "@solow/contracts";
import type {
  changeRequest,
  integration,
  issue,
  mcpToken,
  repository,
  repositoryBranch,
  secret,
  task,
  taskRepository,
} from "@solow/db";

type IssueRow = typeof issue.$inferSelect;
type TaskRow = typeof task.$inferSelect;
type TaskRepositoryRow = typeof taskRepository.$inferSelect;
type RepositoryRow = typeof repository.$inferSelect;
type SecretRow = typeof secret.$inferSelect;
type IntegrationRow = typeof integration.$inferSelect;
type RepositoryBranchRow = typeof repositoryBranch.$inferSelect;
type ChangeRequestRow = typeof changeRequest.$inferSelect;
type McpTokenRow = typeof mcpToken.$inferSelect;

/**
 * Row → DTO mappers. Explicit field selection only — no spread of the raw row, so a
 * new sensitive column can never leak into a DTO by accident. The `secret` row has NO
 * DTO mapper that includes `ciphertext` (Principle IV).
 */

/**
 * What an Issue's Tasks add up to. Computed by the DAL (`@solow/core`'s
 * `deriveIssueStatus`/`activeTaskCount`) and handed here, so this file stays pure row → DTO
 * mapping with no rules of its own.
 */
export interface IssueRollup {
  taskCount: number;
  activeTaskCount: number;
  derivedStatus: IssueStatus;
}

/** An Issue with no Tasks yet — what a create or an import returns before anything is cut from it. */
export const NO_TASKS: IssueRollup = { taskCount: 0, activeTaskCount: 0, derivedStatus: "open" };

export function issueToDto(row: IssueRow, rollup: IssueRollup): IssueDto {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    // The override is the answer whenever someone set one (spec F01 FR-7); otherwise the Issue
    // says whatever its Tasks say. Both halves travel, so the UI can show one as the other's
    // override rather than silently replacing it.
    status: row.statusOverride ?? rollup.derivedStatus,
    derivedStatus: rollup.derivedStatus,
    statusOverride: row.statusOverride,
    statusOverrideAt: row.statusOverrideAt,
    taskCount: rollup.taskCount,
    activeTaskCount: rollup.activeTaskCount,
    source: row.source,
    repositoryId: row.repositoryId,
    externalNumber: row.externalNumber,
    externalUrl: row.externalUrl,
    externalId: row.externalId,
    externalParentId: row.externalParentId,
    syncedAt: row.syncedAt,
    labels: row.labels,
    // The provider's own links, mirrored and never authored here (F23 FR-8, issue #128).
    linkedChangeRequests: row.linkedChangeRequests,
    // Mirrored the same way, and coalesced for the same reason `setupFilePatterns` is elsewhere:
    // a row written before this column existed reads back `[]`/`null`, and the DTO promises both.
    assignees: row.assignees ?? [],
    milestone: row.milestone ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function taskRepositoryToDto(row: TaskRepositoryRow): TaskRepositoryDto {
  return {
    id: row.id,
    repositoryId: row.repositoryId,
    baseRef: row.baseRef,
    checkoutBranch: row.checkoutBranch,
    resultBranch: row.resultBranch,
    position: row.position,
  };
}

/**
 * The attachments are passed in rather than read here (issue #7): this module maps rows, not
 * joins, and the board hydrates a whole page of Tasks with one workspace-scoped query instead of
 * one query per card.
 *
 * Sorted here rather than trusted from the caller. `repositories[0]` is the primary attachment —
 * the worktree the agent is started in — so position order is a promise the DTO makes, and the
 * write paths get their rows from `INSERT … RETURNING`, whose order SQLite documents as
 * undefined. One sort at the single point every Task DTO is built beats a sort at each caller,
 * one of which would eventually be forgotten.
 */
export function taskToDto(row: TaskRow, attachments: readonly TaskRepositoryRow[]): TaskDto {
  return {
    id: row.id,
    issueId: row.issueId,
    title: row.title,
    state: row.state,
    agentProfileId: row.agentProfileId,
    executorProfileId: row.executorProfileId,
    repositories: [...attachments].sort((a, b) => a.position - b.position).map(taskRepositoryToDto),
    failureReason: row.failureReason,
    completedAt: row.completedAt,
    completedOutcome: row.completedOutcome,
    completedSummary: row.completedSummary,
    // Straight off the row (issue #5 AC-6): both are columns on `task`, so the board places a
    // card in its Step column with no join and no per-tile query. `workflowStepId` is a Step id
    // rather than an ordinal on purpose — see the column comments in `schema.ts`.
    workflowId: row.workflowId,
    workflowStepId: row.workflowStepId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * What only a caller who already joined `integration` (and counted `issue`) can supply — this
 * module maps rows, not joins (user request 2026-08-27, see `repositoryDto`'s own comment on why
 * a picker needs to tell same-provider Integrations apart).
 *
 * Defaulted to "unknown" (`null`/`0`) rather than required, so every existing call site that has
 * no reason to pay for the join keeps working unchanged.
 */
export interface RepositoryEnrichment {
  provider: string | null;
  integrationBaseUrl: string | null;
  issueCount: number;
}

const NO_ENRICHMENT: RepositoryEnrichment = {
  provider: null,
  integrationBaseUrl: null,
  issueCount: 0,
};

export function repositoryToDto(
  row: RepositoryRow,
  enrichment: RepositoryEnrichment = NO_ENRICHMENT,
): RepositoryDto {
  return {
    id: row.id,
    name: row.name,
    source: row.source,
    location: row.location,
    integrationId: row.integrationId,
    externalFullName: row.externalFullName,
    provider: enrichment.provider,
    integrationBaseUrl: enrichment.integrationBaseUrl,
    issueCount: enrichment.issueCount,
    // Coalesced because the column was added to a populated table (issue #52): a row written
    // before the migration reads back as null, and the DTO promises a list.
    setupFilePatterns: row.setupFilePatterns ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Secret metadata only — the ciphertext is deliberately excluded. `usedBy` is supplied by the
 * caller rather than read here: it comes from other tables, and this module maps rows, not joins.
 */
export function secretToRef(
  row: Pick<SecretRow, "id" | "name" | "kind">,
  usedBy: SecretUsageDto[] = [],
): SecretRefDto {
  return { id: row.id, name: row.name, kind: row.kind, usedBy };
}

export function integrationToDto(row: IntegrationRow): IntegrationDto {
  return {
    id: row.id,
    provider: row.provider,
    secretId: row.secretId,
    baseUrl: row.baseUrl,
    writeBackEnabled: row.writeBackEnabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function repositoryBranchToDto(row: RepositoryBranchRow): RepositoryBranchDto {
  return {
    id: row.id,
    repositoryId: row.repositoryId,
    name: row.name,
    isDefault: row.isDefault,
    headSha: row.headSha,
    headCommittedAt: row.headCommittedAt,
    syncedAt: row.syncedAt,
  };
}

export function changeRequestToDto(row: ChangeRequestRow): ChangeRequestDto {
  return {
    id: row.id,
    repositoryId: row.repositoryId,
    number: row.number,
    title: row.title,
    state: row.state,
    url: row.url,
    headRef: row.headRef,
    baseRef: row.baseRef,
    authorLogin: row.authorLogin,
    syncedAt: row.syncedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * MCP token row → DTO. `tokenHash` is deliberately absent: the same discipline as `secretToRef`,
 * enforced by explicit field selection rather than by remembering to strip it (Principle IV).
 */
export function mcpTokenToDto(row: McpTokenRow): McpTokenDto {
  return {
    id: row.id,
    label: row.label,
    scope: row.scope,
    prefix: row.prefix,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
