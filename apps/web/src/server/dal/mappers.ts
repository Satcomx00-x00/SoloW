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
} from "@gatecontrol/contracts";
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
} from "@gatecontrol/db";

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
 * What an Issue's Tasks add up to. Computed by the DAL (`@gatecontrol/core`'s
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
    syncedAt: row.syncedAt,
    labels: row.labels,
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
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function repositoryToDto(row: RepositoryRow): RepositoryDto {
  return {
    id: row.id,
    name: row.name,
    source: row.source,
    location: row.location,
    integrationId: row.integrationId,
    externalFullName: row.externalFullName,
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
