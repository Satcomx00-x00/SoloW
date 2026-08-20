import "server-only";
import {
  CommonErrorCode,
  err,
  type FlagDto,
  ok,
  type Result,
  type SetFlagInput,
} from "@gatecontrol/contracts";
import { FLAGS, type FlagKey, setWorkspaceFlag } from "@gatecontrol/db";
import type { RequestContext } from "./context.js";
import { getWorkspaceFlags } from "./workspace.js";

/**
 * Request-context-scoped surface over the flag registry (issue #21).
 *
 * `@gatecontrol/db`'s `FLAGS` registry is the single source of truth for which flags exist,
 * their description and their default — this module never invents a second list. It only merges
 * that static registry with the caller's own Workspace's stored overrides (via
 * `dal/workspace.ts`'s `getWorkspaceFlags`, already scoped to one Workspace, unlike
 * `@gatecontrol/db`'s `listWorkspaceFlags` which returns every Workspace).
 */

function isFlagKey(key: string): key is FlagKey {
  return key in FLAGS;
}

/** Every known flag, with the value currently in effect for the caller's Workspace. */
export async function listFlags(ctx: RequestContext): Promise<Result<FlagDto[]>> {
  const overrides = await getWorkspaceFlags(ctx.db, ctx.workspaceId);
  const flags = Object.values(FLAGS).map((definition) => ({
    key: definition.key,
    description: definition.description,
    default: definition.default,
    enabled: overrides[definition.key] ?? definition.default,
  }));
  return ok(flags);
}

/**
 * Turn one flag on or off for the caller's own Workspace (Principle V — `workspaceId` always
 * comes from `ctx`, never from `input`, unlike `scripts/flag.ts`'s optional CLI argument which
 * is allowed to target any Workspace because it runs on the operator's machine, not a request).
 */
export async function setFlag(ctx: RequestContext, input: SetFlagInput): Promise<Result<FlagDto>> {
  if (!isFlagKey(input.key)) return err(CommonErrorCode.ValidationFailed);

  await setWorkspaceFlag(ctx.db, input.key, input.enabled, ctx.workspaceId);
  const definition = FLAGS[input.key];
  return ok({
    key: definition.key,
    description: definition.description,
    default: definition.default,
    enabled: input.enabled,
  });
}
