/**
 * Feature flag registry (constitution: Feature flags; task TASK-001).
 *
 * Every user-facing feature ships behind a flag named `ff-<feature>`, **default ON**, with a kill
 * switch. Flags are read on every tRPC entry point and at orchestrator run start. Granularity is
 * per-Workspace (v1: single Workspace → effectively local-global).
 *
 * **The default was OFF until 2026-09-24, and flipping it is a product decision, not a tidy-up.**
 * Default-OFF is the right posture for a service where a flag is how a team dark-launches to
 * users who did not ask for the feature. SoloW is not that: it is installed deliberately by the
 * person who will use it, and shipping every capability switched off meant a fresh install
 * arrived inert — the board refused to run a Task, Settings hid most of itself, and the only way
 * out was a terminal command on the machine hosting it. The flag's remaining job is the one that
 * was always the more useful half: a **kill switch** an operator reaches for when a feature is
 * misbehaving, which it still is.
 *
 * What did *not* change: a flag is still per-Workspace, still read on every entry point, and
 * still stored as an explicit `true`/`false` in `workspace.enabled_flags` — so "off" remains a
 * value the column can hold, rather than the absence of one. That is what keeps the kill switch
 * working now that absence means on.
 *
 * It lives in `@solow/db`, beside the `enabled_flags` column it describes, rather than in
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
  | "ff-agent-widgets"
  | "ff-agent-libraries"
  | "ff-workspace-controls";

export interface FlagDefinition {
  key: FlagKey;
  description: string;
  default: boolean;
  granularity: "workspace";
}

export const FLAGS: Record<FlagKey, FlagDefinition> = {
  "ff-core-program": {
    key: "ff-core-program",
    description: "Core end-to-end Task loop (Issue → run harness → review → approve).",
    default: true,
    granularity: "workspace",
  },
  "ff-integrations": {
    key: "ff-integrations",
    description:
      "GitHub/GitLab integrations — connect, import Issues, sync branches and change requests (issue #15).",
    default: true,
    granularity: "workspace",
  },
  "ff-mcp": {
    key: "ff-mcp",
    description:
      "External MCP server — drive SoloW from outside agents over a scoped token (issue #16).",
    default: true,
    granularity: "workspace",
  },
  "ff-workflows": {
    key: "ff-workflows",
    description:
      "Agentic workflows — multi-step pipelines with a different harness per Step (issue #5).",
    default: true,
    granularity: "workspace",
  },
  "ff-agent-widgets": {
    key: "ff-agent-widgets",
    description:
      "Harness widgets — teach the harness to emit tappable questions, diagrams and checklists, and draw them in the transcript.",
    default: true,
    granularity: "workspace",
  },
  "ff-agent-libraries": {
    key: "ff-agent-libraries",
    description:
      "Harness libraries — MCP servers and Skills kept in one place, loaded into every harness or into the Workflow Steps that name them (spec F24).",
    default: true,
    granularity: "workspace",
  },
  "ff-workspace-controls": {
    key: "ff-workspace-controls",
    description:
      "Workspace controls — emptying the database from Settings, and the per-user theme and new-Task defaults it writes (spec F16).",
    default: true,
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
