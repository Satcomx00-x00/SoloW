import "server-only";
import type {
  ChangeRequestDto,
  IntegrationDto,
  IssueDto,
  McpTokenDto,
  RepositoryBranchDto,
  RepositoryDto,
  SecretRefDto,
  SecretUsageDto,
  TaskDto,
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
} from "@gatecontrol/db";

type IssueRow = typeof issue.$inferSelect;
type TaskRow = typeof task.$inferSelect;
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

export function issueToDto(row: IssueRow, taskCount: number, status = row.status): IssueDto {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    // Derived from the Issue's Tasks by the DAL (spec FR-006); the column is only a fallback.
    status,
    taskCount,
    source: row.source,
    repositoryId: row.repositoryId,
    externalNumber: row.externalNumber,
    externalUrl: row.externalUrl,
    syncedAt: row.syncedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function taskToDto(row: TaskRow): TaskDto {
  return {
    id: row.id,
    issueId: row.issueId,
    title: row.title,
    state: row.state,
    agentProfileId: row.agentProfileId,
    executorProfileId: row.executorProfileId,
    repositoryId: row.repositoryId,
    baseRef: row.baseRef,
    resultBranch: row.resultBranch,
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
