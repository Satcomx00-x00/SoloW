import "server-only";
import {
  AgentLibraryErrorCode,
  CommonErrorCode,
  type CreateMcpServerInput,
  type CreateSkillInput,
  err,
  type ImportSkillsInput,
  type ImportSkillsOutput,
  type McpServerDto,
  type McpServerListDto,
  type McpServerTransport,
  ok,
  type Result,
  type ScanSkillsInput,
  type ScanSkillsOutput,
  type SkillDto,
  type SkillListDto,
  type UnpackSkillsInput,
  type UpdateMcpServerInput,
  type UpdateSkillInput,
} from "@solow/contracts";
import { mcpServer, secret, skill, workflowStep } from "@solow/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { skillsRoot } from "../env.js";
import {
  holdsSkill,
  type ImportError,
  resolveImportRoot,
  scanSkillDirectories,
  unpackSkillArchive,
} from "../skill-import.js";
import type { RequestContext } from "./context.js";

/**
 * The agent libraries (spec F24): MCP servers and Skills, one table each, one DAL.
 *
 * Every statement is filtered on `ctx.workspaceId` (Principle V), and every id an item references
 * — a Secret, from an MCP server's env — is resolved through a workspace-scoped read before it is
 * written, for the reason `addWorkflowStep` resolves an Agent Profile: a foreign key proves the
 * row exists somewhere, which is not the question tenancy asks.
 *
 * What is *not* here: any value behind a Secret. The DTOs carry `{ kind: "secret", secretId }` and
 * nothing more; decryption happens in `loadAgentLibrariesForRun` (`@solow/db`), inside the run
 * loop, at the moment the agent starts (Principle IV).
 */

type NotFound = typeof CommonErrorCode.NotFound;
type LibraryError = NotFound | typeof CommonErrorCode.ValidationFailed | AgentLibraryErrorCode;
type McpServerRow = typeof mcpServer.$inferSelect;
type SkillRow = typeof skill.$inferSelect;
type Tx = Parameters<Parameters<RequestContext["db"]["transaction"]>[0]>[0];

const now = () => new Date().toISOString();

function mcpServerToDto(row: McpServerRow): McpServerDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    transport: row.transport,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function skillToDto(row: SkillRow): SkillDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    source: row.source,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The Secret ids a transport references, whichever shape it has. */
function referencedSecretIds(transport: McpServerTransport): string[] {
  const values = transport.kind === "stdio" ? transport.env : transport.headers;
  return Object.values(values).flatMap((v) => (v.kind === "secret" ? [v.secretId] : []));
}

/** Every referenced Secret must be one of this Workspace's, or the transport is refused. */
function checkSecrets(
  tx: Tx,
  ctx: RequestContext,
  transport: McpServerTransport,
): Result<void, AgentLibraryErrorCode> {
  const ids = [...new Set(referencedSecretIds(transport))];
  if (ids.length === 0) return ok(undefined);
  const found = tx
    .select({ id: secret.id })
    .from(secret)
    .where(and(eq(secret.workspaceId, ctx.workspaceId), inArray(secret.id, ids)))
    .all();
  return found.length === ids.length ? ok(undefined) : err(AgentLibraryErrorCode.NotInWorkspace);
}

/**
 * Is this item named by any Step of the Workspace? Read in JS over the Steps' id arrays: the
 * arrays are short, the Workspace's Steps are few, and a `LIKE '%"id"%'` over JSON would be a
 * query that is right by coincidence.
 */
function namedByAStep(tx: Tx, ctx: RequestContext, kind: "mcp" | "skill", id: string): boolean {
  const steps = tx
    .select({ mcpServerIds: workflowStep.mcpServerIds, skillIds: workflowStep.skillIds })
    .from(workflowStep)
    .where(eq(workflowStep.workspaceId, ctx.workspaceId))
    .all();
  return steps.some((step) => (kind === "mcp" ? step.mcpServerIds : step.skillIds).includes(id));
}

// ---- MCP servers ----

export async function listMcpServers(ctx: RequestContext): Promise<Result<McpServerListDto>> {
  const rows = await ctx.db
    .select()
    .from(mcpServer)
    .where(eq(mcpServer.workspaceId, ctx.workspaceId))
    .orderBy(asc(mcpServer.name));
  return ok(rows.map(mcpServerToDto));
}

export async function createMcpServer(
  ctx: RequestContext,
  input: CreateMcpServerInput,
): Promise<Result<McpServerDto, LibraryError>> {
  return ctx.db.transaction(
    (tx): Result<McpServerDto, LibraryError> => {
      const [taken] = tx
        .select({ id: mcpServer.id })
        .from(mcpServer)
        .where(and(eq(mcpServer.workspaceId, ctx.workspaceId), eq(mcpServer.name, input.name)))
        .limit(1)
        .all();
      if (taken) return err(AgentLibraryErrorCode.NameTaken);
      const secrets = checkSecrets(tx, ctx, input.transport);
      if (!secrets.ok) return err(secrets.error);

      const [row] = tx
        .insert(mcpServer)
        .values({
          workspaceId: ctx.workspaceId,
          name: input.name,
          description: input.description ?? null,
          transport: input.transport,
          enabled: input.enabled,
        })
        .returning()
        .all();
      return row ? ok(mcpServerToDto(row)) : err(CommonErrorCode.ValidationFailed);
    },
    { behavior: "immediate" },
  );
}

export async function updateMcpServer(
  ctx: RequestContext,
  input: UpdateMcpServerInput,
): Promise<Result<McpServerDto, LibraryError>> {
  return ctx.db.transaction(
    (tx): Result<McpServerDto, LibraryError> => {
      const [row] = tx
        .select()
        .from(mcpServer)
        .where(and(eq(mcpServer.workspaceId, ctx.workspaceId), eq(mcpServer.id, input.id)))
        .limit(1)
        .all();
      if (!row) return err(CommonErrorCode.NotFound);

      if (input.name !== undefined && input.name !== row.name) {
        const [taken] = tx
          .select({ id: mcpServer.id })
          .from(mcpServer)
          .where(and(eq(mcpServer.workspaceId, ctx.workspaceId), eq(mcpServer.name, input.name)))
          .limit(1)
          .all();
        if (taken) return err(AgentLibraryErrorCode.NameTaken);
      }
      if (input.transport) {
        const secrets = checkSecrets(tx, ctx, input.transport);
        if (!secrets.ok) return err(secrets.error);
      }

      const [updated] = tx
        .update(mcpServer)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.transport !== undefined ? { transport: input.transport } : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          updatedAt: now(),
        })
        .where(and(eq(mcpServer.workspaceId, ctx.workspaceId), eq(mcpServer.id, input.id)))
        .returning()
        .all();
      return updated ? ok(mcpServerToDto(updated)) : err(CommonErrorCode.NotFound);
    },
    { behavior: "immediate" },
  );
}

/**
 * Refused while a Step names the server: the Step would otherwise keep an id that resolves to
 * nothing, and the run loop would load a pipeline missing a server nobody removed on purpose.
 */
export async function deleteMcpServer(
  ctx: RequestContext,
  id: string,
): Promise<Result<void, NotFound | AgentLibraryErrorCode>> {
  return ctx.db.transaction(
    (tx): Result<void, NotFound | AgentLibraryErrorCode> => {
      const [row] = tx
        .select({ id: mcpServer.id })
        .from(mcpServer)
        .where(and(eq(mcpServer.workspaceId, ctx.workspaceId), eq(mcpServer.id, id)))
        .limit(1)
        .all();
      if (!row) return err(CommonErrorCode.NotFound);
      if (namedByAStep(tx, ctx, "mcp", id)) return err(AgentLibraryErrorCode.InUse);
      tx.delete(mcpServer)
        .where(and(eq(mcpServer.workspaceId, ctx.workspaceId), eq(mcpServer.id, id)))
        .run();
      return ok(undefined);
    },
    { behavior: "immediate" },
  );
}

// ---- Skills ----

export async function listSkills(ctx: RequestContext): Promise<Result<SkillListDto>> {
  const rows = await ctx.db
    .select()
    .from(skill)
    .where(eq(skill.workspaceId, ctx.workspaceId))
    .orderBy(asc(skill.name));
  return ok(rows.map(skillToDto));
}

export async function createSkill(
  ctx: RequestContext,
  input: CreateSkillInput,
): Promise<Result<SkillDto, LibraryError>> {
  return ctx.db.transaction(
    (tx): Result<SkillDto, LibraryError> => {
      const [taken] = tx
        .select({ id: skill.id })
        .from(skill)
        .where(and(eq(skill.workspaceId, ctx.workspaceId), eq(skill.name, input.name)))
        .limit(1)
        .all();
      if (taken) return err(AgentLibraryErrorCode.NameTaken);
      const [row] = tx
        .insert(skill)
        .values({
          workspaceId: ctx.workspaceId,
          name: input.name,
          description: input.description,
          source: input.source,
          enabled: input.enabled,
        })
        .returning()
        .all();
      return row ? ok(skillToDto(row)) : err(CommonErrorCode.ValidationFailed);
    },
    { behavior: "immediate" },
  );
}

export async function updateSkill(
  ctx: RequestContext,
  input: UpdateSkillInput,
): Promise<Result<SkillDto, LibraryError>> {
  return ctx.db.transaction(
    (tx): Result<SkillDto, LibraryError> => {
      const [row] = tx
        .select()
        .from(skill)
        .where(and(eq(skill.workspaceId, ctx.workspaceId), eq(skill.id, input.id)))
        .limit(1)
        .all();
      if (!row) return err(CommonErrorCode.NotFound);
      if (input.name !== undefined && input.name !== row.name) {
        const [taken] = tx
          .select({ id: skill.id })
          .from(skill)
          .where(and(eq(skill.workspaceId, ctx.workspaceId), eq(skill.name, input.name)))
          .limit(1)
          .all();
        if (taken) return err(AgentLibraryErrorCode.NameTaken);
      }
      const [updated] = tx
        .update(skill)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.source !== undefined ? { source: input.source } : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          updatedAt: now(),
        })
        .where(and(eq(skill.workspaceId, ctx.workspaceId), eq(skill.id, input.id)))
        .returning()
        .all();
      return updated ? ok(skillToDto(updated)) : err(CommonErrorCode.NotFound);
    },
    { behavior: "immediate" },
  );
}

/**
 * Every Skill under a directory or in a repository, ready to import (spec F24). Marks the ones
 * whose name the library already holds rather than dropping them: the picker says why they are
 * unticked, and an operator who renamed one on disk can see what they collided with.
 */
export async function scanSkills(
  ctx: RequestContext,
  input: ScanSkillsInput,
): Promise<Result<ScanSkillsOutput, ImportError>> {
  const root = await resolveImportRoot(input.source, skillsRoot());
  if (!root.ok) return root;
  return ok(await scanned(ctx, root.data));
}

/**
 * A dropped `.zip`, unpacked into the skills directory and scanned like any other directory.
 * The archive arrives as base64 inside the JSON body — see `unpackSkillsInput` for why.
 */
export async function unpackSkills(
  ctx: RequestContext,
  input: UnpackSkillsInput,
): Promise<Result<ScanSkillsOutput, ImportError>> {
  const bytes = new Uint8Array(Buffer.from(input.zipBase64, "base64"));
  const root = await unpackSkillArchive(input.fileName, bytes, skillsRoot());
  if (!root.ok) return root;
  return ok(await scanned(ctx, root.data));
}

async function scanned(ctx: RequestContext, root: string): Promise<ScanSkillsOutput> {
  const found = await scanSkillDirectories(root);
  const existing = new Set(
    ctx.db
      .select({ name: skill.name })
      .from(skill)
      .where(eq(skill.workspaceId, ctx.workspaceId))
      .all()
      .map((r) => r.name),
  );
  return { root, skills: found.map((s) => ({ ...s, existing: existing.has(s.name) })) };
}

/**
 * The import itself: each picked Skill becomes a `path` source pointing at its directory, so
 * what sits beside the SKILL.md — scripts, references, assets — is what the agent gets. Checked
 * at the moment of writing, not the moment of scanning: a name taken since, or a directory
 * emptied since, is skipped by name rather than failing the rest of the batch.
 */
export async function importSkills(
  ctx: RequestContext,
  input: ImportSkillsInput,
): Promise<Result<ImportSkillsOutput>> {
  const present = new Map<string, boolean>();
  for (const s of input.skills) present.set(s.path, await holdsSkill(s.path));
  return ctx.db.transaction(
    (tx): Result<ImportSkillsOutput> => {
      const taken = new Set(
        tx
          .select({ name: skill.name })
          .from(skill)
          .where(eq(skill.workspaceId, ctx.workspaceId))
          .all()
          .map((r) => r.name),
      );
      const imported: SkillDto[] = [];
      const skipped: string[] = [];
      for (const entry of input.skills) {
        if (taken.has(entry.name) || !present.get(entry.path)) {
          skipped.push(entry.name);
          continue;
        }
        const [row] = tx
          .insert(skill)
          .values({
            workspaceId: ctx.workspaceId,
            name: entry.name,
            description: entry.description,
            source: { kind: "path", path: entry.path },
            enabled: input.enabled,
          })
          .returning()
          .all();
        if (!row) return err(CommonErrorCode.ValidationFailed);
        taken.add(entry.name);
        imported.push(skillToDto(row));
      }
      return ok({ imported, skipped });
    },
    { behavior: "immediate" },
  );
}

export async function deleteSkill(
  ctx: RequestContext,
  id: string,
): Promise<Result<void, NotFound | AgentLibraryErrorCode>> {
  return ctx.db.transaction(
    (tx): Result<void, NotFound | AgentLibraryErrorCode> => {
      const [row] = tx
        .select({ id: skill.id })
        .from(skill)
        .where(and(eq(skill.workspaceId, ctx.workspaceId), eq(skill.id, id)))
        .limit(1)
        .all();
      if (!row) return err(CommonErrorCode.NotFound);
      if (namedByAStep(tx, ctx, "skill", id)) return err(AgentLibraryErrorCode.InUse);
      tx.delete(skill)
        .where(and(eq(skill.workspaceId, ctx.workspaceId), eq(skill.id, id)))
        .run();
      return ok(undefined);
    },
    { behavior: "immediate" },
  );
}

/**
 * Do these ids all name items of this Workspace? Called by the Workflow DAL before it writes a
 * Step's selection, so a Step can never point at another tenant's server or at nothing.
 */
export function checkStepTools(
  tx: Tx,
  ctx: RequestContext,
  mcpServerIds: readonly string[] | undefined,
  skillIds: readonly string[] | undefined,
): boolean {
  const mcpIds = [...new Set(mcpServerIds ?? [])];
  if (mcpIds.length > 0) {
    const found = tx
      .select({ id: mcpServer.id })
      .from(mcpServer)
      .where(and(eq(mcpServer.workspaceId, ctx.workspaceId), inArray(mcpServer.id, mcpIds)))
      .all();
    if (found.length !== mcpIds.length) return false;
  }
  const skillIdList = [...new Set(skillIds ?? [])];
  if (skillIdList.length > 0) {
    const found = tx
      .select({ id: skill.id })
      .from(skill)
      .where(and(eq(skill.workspaceId, ctx.workspaceId), inArray(skill.id, skillIdList)))
      .all();
    if (found.length !== skillIdList.length) return false;
  }
  return true;
}
