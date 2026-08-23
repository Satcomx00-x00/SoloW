/**
 * Feature flag registry (constitution: Feature flags; task TASK-001).
 *
 * Every user-facing feature ships behind a flag named `ff-<feature>`, default OFF, with a kill
 * switch. Flags are read on every tRPC entry point and at orchestrator run start. Granularity is
 * per-Workspace (v1: single Workspace → effectively local-global).
 *
 * It lives in `@gatecontrol/db`, beside the `enabled_flags` column it describes, rather than in
 * the web app: the operator script (`scripts/flag.ts`), the API and the DAL all need the same
 * list, and the one time it lived in only one of them the script drifted to a stale hardcoded
 * subset and refused to enable flags the UI was already offering. Anything that can reach the
 * flag column can now reach the registry, so there is nothing to keep in sync.
 */

export type FlagKey =
  | "ff-core-program"
  | "ff-integrations"
  | "ff-mcp"
  | "ff-workflows"
  | "ff-agent-widgets";

export interface FlagDefinition {
  key: FlagKey;
  description: string;
  default: boolean;
  granularity: "workspace";
}

export const FLAGS: Record<FlagKey, FlagDefinition> = {
  "ff-core-program": {
    key: "ff-core-program",
    description: "Core end-to-end Task loop (Issue → run agent → review → approve).",
    default: false,
    granularity: "workspace",
  },
  "ff-integrations": {
    key: "ff-integrations",
    description:
      "GitHub/GitLab integrations — connect, import Issues, sync branches and change requests (issue #15).",
    default: false,
    granularity: "workspace",
  },
  "ff-mcp": {
    key: "ff-mcp",
    description:
      "External MCP server — drive GateControl from outside agents over a scoped token (issue #16).",
    default: false,
    granularity: "workspace",
  },
  "ff-workflows": {
    key: "ff-workflows",
    description:
      "Agentic workflows — multi-step pipelines with a different agent per Step (issue #5).",
    default: false,
    granularity: "workspace",
  },
  "ff-agent-widgets": {
    key: "ff-agent-widgets",
    description:
      "Agent widgets — teach the agent to emit tappable questions, diagrams and checklists, and draw them in the transcript.",
    default: false,
    granularity: "workspace",
  },
};

/** Every registered flag key — the one list callers should iterate or validate against. */
export function flagKeys(): FlagKey[] {
  return Object.keys(FLAGS) as FlagKey[];
}

/** Whether `key` names a registered flag, narrowing an arbitrary string for callers. */
export function isFlagKey(key: string): key is FlagKey {
  return Object.hasOwn(FLAGS, key);
}

export interface FlagContext {
  workspaceId: string;
  /** Per-Workspace overrides (e.g. enabled for the local Owner's Workspace). */
  overrides?: Partial<Record<FlagKey, boolean>>;
}

/** Evaluate a flag for a Workspace; defaults to the registry default (OFF). */
export function isEnabled(key: FlagKey, ctx: FlagContext): boolean {
  const override = ctx.overrides?.[key];
  if (typeof override === "boolean") return override;
  return FLAGS[key].default;
}
