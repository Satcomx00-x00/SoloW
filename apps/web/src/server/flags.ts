/**
 * Feature flag registry (constitution: Feature flags; task TASK-001).
 *
 * Every user-facing feature ships behind a flag named `ff-<feature>`, default OFF,
 * with a kill switch. Flags are read on every tRPC entry point and at orchestrator run
 * start. Granularity is per-Workspace (v1: single Workspace → effectively local-global).
 */

export type FlagKey = "ff-core-program" | "ff-integrations";

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
};

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
