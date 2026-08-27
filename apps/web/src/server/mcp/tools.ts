import "server-only";
import type { ZodTypeAny } from "zod";
import { createSchema } from "zod-openapi";
import { appRouter } from "../routers/index.js";

/**
 * MCP tool definitions, derived from the tRPC procedures (issue #16 AC-2).
 *
 * There is no second definition of any operation anywhere in this file: the name, the input
 * schema, and the read/write classification are all read off the router that already serves the
 * SPA and already generates `openapi.json`. Adding a procedure adds a tool; changing its input
 * changes the tool's schema. That is the whole point — the OpenAPI document and the MCP tool
 * list are two renderings of one contract set (issue #16's second-order effect on row 88).
 */

/**
 * Procedure namespaces deliberately withheld from the MCP surface.
 *
 * This is a narrowing of *which* contracts are exposed, not a redefinition of any of them:
 *
 * - `secret` — an MCP token is held by software running outside SoloW, and Principle IV
 *   keeps credentials on a narrower path than ordinary data. A read_write token is a grant to
 *   manage work, not a grant to plant a credential the orchestrator will later inject into an
 *   agent process. Secrets stay a first-party, signed-in action.
 * - `stream` — issues a WebSocket ticket for the SPA's live channel. An MCP client has no such
 *   channel, so the tool would be an unusable one that only widens the surface.
 * - `mcpToken` — token administration. Being behind `mcpProcedure` is *not* protection here:
 *   `ff-mcp` is by definition enabled whenever anything is talking MCP, so exposing these would
 *   let a token mint further tokens and revoke its own revocation — turning a scoped, revocable
 *   grant into an unbounded, unrevocable one. Issuing a token stays a signed-in, first-party act.
 * - `preference` — one person's arrangement of their own interface (issue #3). A token is held
 *   by software, which has no interface to arrange; exposing it would let a tool rearrange a
 *   human's shell, which is not work management by any reading.
 * - `workflow` — the Workflow definition *and* the Step cursor of every Task following one
 *   (issue #5). `workflow.advanceTask` is the call that opens a Task's gates, and the party
 *   holding an MCP token is the agent whose work those gates exist to hold: letting it report its
 *   own Step finished, and claim its own Step produced nothing to look at, is asking the subject
 *   of a review to sign it off. `workflow.delete` and `workflow.deleteStep` are on the same
 *   surface and would let a token rewrite the pipeline rather than run it.
 *
 *   This is not "MCP never drives a Workflow" — issue #86 is exactly that, and it needs the run
 *   loop that produces one Session per Step, so a completion report can be attributed to the Step
 *   it came from and checked against it. Until then the namespace is withheld by decision rather
 *   than admitted by omission, which is what the rest of this list records.
 * - `review` — its only procedure is `decide`, which is the review gate itself. The paragraph
 *   above rejected `workflow.advanceTask` for letting a token sign off its own Step; this is the
 *   same act, one level down and more directly: approving the change an agent just wrote. The
 *   gate exists because the party that did the work is not the party that rules on it
 *   (Principle I), and a gate the subject can open is not a gate.
 *
 *   Withheld now, while it is still only latent — the orchestrator hands its agents no MCP
 *   configuration at all today (`packages/acp/src/session.ts` sends `mcpServers: []`), so nothing
 *   has ever been able to reach this. Issue #75's task-scoped surface is the change that would
 *   make it reachable, and a rule added *with* that surface is a rule written after the fact. An
 *   agent may now report how its run ended — `task_complete` in `widget.ts` — which is the half
 *   of this it should have. `task` stays exposed: `task.create`, `task.list` and `task.launch`
 *   are the work management this surface exists for, and withholding the namespace to reach
 *   `task.move` would take all of it.
 */
const WITHHELD_NAMESPACES = new Set([
  "secret",
  "stream",
  "mcpToken",
  "preference",
  "workflow",
  "review",
]);

export interface McpToolDefinition {
  /** MCP tool name — the tRPC path with `.` swapped for `_` (`issue.get` → `issue_get`). */
  name: string;
  /** The tRPC path this tool calls, kept so dispatch never has to reverse the name by guesswork. */
  procedurePath: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Queries are readable with any token; mutations need a `read_write` one. */
  readOnly: boolean;
}

/** tRPC's internal procedure shape, narrowed to the parts this module reads. */
interface ProcedureDef {
  _def?: {
    type?: string;
    inputs?: unknown[];
    meta?: { openapi?: { summary?: string; description?: string; tags?: string[] } };
  };
}

export function toolNameFor(procedurePath: string): string {
  return procedurePath.replaceAll(".", "_");
}

/**
 * JSON Schema for a procedure's input, via the same `zod-openapi` conversion that backs
 * `openapi.json`. A procedure with no input still needs an object schema — MCP clients send an
 * `arguments` object either way, and omitting the schema makes some clients refuse the tool.
 */
function inputSchemaFor(inputs: unknown[]): Record<string, unknown> {
  const empty = { type: "object", properties: {}, additionalProperties: false };
  if (inputs.length === 0) return empty;

  const schemas = inputs.map(
    (input) => createSchema(input as ZodTypeAny).schema as Record<string, unknown>,
  );
  const [first] = schemas;
  if (!first) return empty;
  // tRPC allows chained `.input()` calls, which compose by intersection. None of the current
  // procedures do, but expressing it as `allOf` keeps that from silently dropping an input.
  return schemas.length === 1 ? first : { allOf: schemas };
}

/**
 * A description an agent can actually choose from. Prefers the procedure's own OpenAPI
 * `summary`/`description` so the text lives with the contract; falls back to naming the
 * operation rather than inventing behaviour it might not have.
 */
function describe(procedurePath: string, type: string, meta: ProcedureDef["_def"]): string {
  const openapi = meta?.meta?.openapi;
  const written = openapi?.summary ?? openapi?.description;
  const verb = type === "query" ? "Read" : "Write";
  return written ?? `${verb} operation \`${procedurePath}\` on SoloW.`;
}

/** Every procedure the MCP surface exposes, in stable path order. */
export function listMcpTools(): McpToolDefinition[] {
  const procedures = (
    appRouter as unknown as { _def: { procedures: Record<string, ProcedureDef> } }
  )._def.procedures;

  return Object.entries(procedures)
    .filter(([path]) => !WITHHELD_NAMESPACES.has(path.split(".")[0] ?? ""))
    .filter(([, proc]) => proc._def?.type === "query" || proc._def?.type === "mutation")
    .map(([path, proc]) => ({
      name: toolNameFor(path),
      procedurePath: path,
      description: describe(path, proc._def?.type ?? "query", proc._def),
      inputSchema: inputSchemaFor(proc._def?.inputs ?? []),
      readOnly: proc._def?.type === "query",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Look up one tool by its MCP name; undefined when the client asked for something withheld. */
export function findMcpTool(name: string): McpToolDefinition | undefined {
  return listMcpTools().find((tool) => tool.name === name);
}
