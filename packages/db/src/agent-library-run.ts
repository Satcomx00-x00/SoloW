import {
  type AgentLibraries,
  AgentLibraryErrorCode,
  err,
  type McpConfigValue,
  ok,
  type ResolvedMcpServer,
  type Result,
} from "@solow/contracts";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "./index.js";
import { mcpServer, secret, skill, workflowStep } from "./schema.js";
import { decryptForAgentRun } from "./secret-store.js";

/**
 * What one agent run loads from the libraries (spec F24): every enabled item, plus the ones its
 * Workflow Step names, with every Secret an MCP server references decrypted.
 *
 * In `@solow/db` for the reason `workflow-run.ts` is: only the orchestrator calls it, and the
 * orchestrator cannot import the web DAL. It decrypts, so it must be called *inside* the durable
 * step that spawns the agent and its result must never be memoized — the same rule as the
 * Agent Profile's credential (`loadAgentProbeContext`), and for the same Principle IV reason.
 *
 * A Secret that is gone is an error by name rather than a server started without its token:
 * that server would fail on its first call with a message about the wrong thing, from inside
 * the agent, after the run has already been paid for.
 */
export async function loadAgentLibrariesForRun(
  db: Db,
  workspaceId: string,
  stepId: string | null,
): Promise<Result<AgentLibraries, AgentLibraryErrorCode>> {
  let stepMcpIds: string[] = [];
  let stepSkillIds: string[] = [];
  if (stepId) {
    const [step] = await db
      .select({ mcpServerIds: workflowStep.mcpServerIds, skillIds: workflowStep.skillIds })
      .from(workflowStep)
      .where(and(eq(workflowStep.workspaceId, workspaceId), eq(workflowStep.id, stepId)))
      .limit(1);
    stepMcpIds = step?.mcpServerIds ?? [];
    stepSkillIds = step?.skillIds ?? [];
  }

  const servers = await db.select().from(mcpServer).where(eq(mcpServer.workspaceId, workspaceId));
  const skills = await db.select().from(skill).where(eq(skill.workspaceId, workspaceId));

  // Enabled everywhere, or named by this Step. Sorted by name so the agent sees one order.
  const chosenServers = servers
    .filter((row) => row.enabled || stepMcpIds.includes(row.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  const chosenSkills = skills
    .filter((row) => row.enabled || stepSkillIds.includes(row.id))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Every referenced Secret, read once, Workspace-scoped — a Secret of another tenant does not
  // resolve here even if its id is known (Principle V).
  const secretIds = new Set<string>();
  for (const row of chosenServers) {
    const values =
      row.transport.kind === "stdio"
        ? Object.values(row.transport.env)
        : Object.values(row.transport.headers);
    for (const value of values) if (value.kind === "secret") secretIds.add(value.secretId);
  }
  const ciphertexts = new Map<string, string>();
  if (secretIds.size > 0) {
    const rows = await db
      .select({ id: secret.id, ciphertext: secret.ciphertext })
      .from(secret)
      .where(and(eq(secret.workspaceId, workspaceId), inArray(secret.id, [...secretIds])));
    for (const row of rows) ciphertexts.set(row.id, row.ciphertext);
  }
  const resolve = (value: McpConfigValue): string | null => {
    if (value.kind === "literal") return value.value;
    const ciphertext = ciphertexts.get(value.secretId);
    return ciphertext === undefined
      ? null
      : `${value.prefix ?? ""}${decryptForAgentRun(ciphertext)}`;
  };

  const mcpServers: ResolvedMcpServer[] = [];
  for (const row of chosenServers) {
    if (row.transport.kind === "stdio") {
      const env: Record<string, string> = {};
      for (const [name, value] of Object.entries(row.transport.env)) {
        const resolved = resolve(value);
        if (resolved === null) return err(AgentLibraryErrorCode.SecretMissing);
        env[name] = resolved;
      }
      mcpServers.push({
        name: row.name,
        transport: { kind: "stdio", command: row.transport.command, args: row.transport.args, env },
      });
    } else {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(row.transport.headers)) {
        const resolved = resolve(value);
        if (resolved === null) return err(AgentLibraryErrorCode.SecretMissing);
        headers[name] = resolved;
      }
      mcpServers.push({
        name: row.name,
        transport: { kind: "http", url: row.transport.url, headers },
      });
    }
  }

  return ok({
    mcpServers,
    skills: chosenSkills.map((row) => ({
      name: row.name,
      description: row.description,
      source: row.source,
    })),
  });
}
