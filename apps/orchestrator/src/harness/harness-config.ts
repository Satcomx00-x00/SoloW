import { configHarnessFor, type HarnessProtocol, type Result } from "@solow/contracts";
import { type HarnessConfigLaunch, resolveHarnessConfigLaunch } from "@solow/core";
import { type Db, type HarnessConfigForRun, loadHarnessConfigForRun } from "@solow/db";

export interface ProfileHarnessConfig {
  /** The stored row, or null when the Profile selects none (or it has since been deleted). */
  config: HarnessConfigForRun | null;
  /** What it adds to the launch, or why it cannot be used. */
  launch: Result<HarnessConfigLaunch, string>;
}

/**
 * The Harness Config a Profile launches with (Decision 0028), resolved against the harness it
 * actually runs and that harness's own credential variables — one answer for a Task's round, a
 * probe and an explain, so none of them can test a configuration the others do not use.
 */
export async function profileHarnessConfig(
  db: Db,
  workspaceId: string,
  profile: { harnessConfigId: string | null },
  catalog: {
    protocol: HarnessProtocol;
    key: string;
    command: string;
    subscriptionEnvVar: string;
    meteredEnvVar: string;
  },
): Promise<ProfileHarnessConfig> {
  const config = await loadHarnessConfigForRun(db, workspaceId, profile.harnessConfigId);
  return {
    config,
    launch: resolveHarnessConfigLaunch(config, configHarnessFor(catalog), [
      catalog.subscriptionEnvVar,
      catalog.meteredEnvVar,
    ]),
  };
}
