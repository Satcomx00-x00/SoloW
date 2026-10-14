import { createDb } from "@solow/db";
import { createLogger } from "@solow/observability";
import { orchestratorEnv } from "../../../env.js";
import { createExecutorFor, probeExecutorFor } from "../../../executor/factory.js";
import { harnessRegistry } from "../../../harness/registry.js";
import { createHarnessRunner } from "../../../harness/runners.js";
import {
  adoptWorktree,
  cleanupWorktree,
  commitWorktree,
  diffWorktree,
  discardWorktreeChanges,
  hasChanges,
  prepareRepository,
  provisionWorktree,
  publishWorktreeBranch,
  pushWorktreeBranch,
} from "../../../worktree/manager.js";
import { seedSetupFiles } from "../../../worktree/setup-files.js";
import { hub } from "../../../ws/hub.js";
import type { TaskRunDeps } from "./types.js";

/** Production wiring. */
export function defaultDeps(): TaskRunDeps {
  const env = orchestratorEnv();
  return {
    db: createDb(),
    // The executor is no longer built here (issue #96). It cannot be: the Executor Profile
    // belongs to the Task, and no Task exists yet at this point — which is exactly why every
    // consumer below now takes one rather than closing over one.
    executorFor: createExecutorFor,
    preflight: probeExecutorFor,
    runner: (protocol, settings, executor) =>
      createHarnessRunner(protocol, {
        executor,
        permissionMode: settings.permissionMode,
        ...(settings.model ? { model: settings.model } : {}),
        ...(settings.modeId ? { modeId: settings.modeId } : {}),
        ...(settings.checkpoints ? { checkpoints: settings.checkpoints } : {}),
        ...(settings.version ? { version: settings.version } : {}),
        ...(settings.autoApprove ? { autoApprove: true } : {}),
        unattendedPermissionPosture: env.SOLOW_ACP_UNATTENDED_PERMISSION,
      }),
    worktreeRoot: env.SOLOW_WORKTREE_ROOT,
    repoCacheRoot: env.SOLOW_REPO_CACHE_ROOT,
    logger: createLogger({ service: "orchestrator" }),
    worktree: (executor) => ({
      prepare: (params) => prepareRepository(executor, params),
      provision: (params) => provisionWorktree(executor, params),
      adopt: (repoPath, reportedPath) => adoptWorktree(executor, repoPath, reportedPath),
      seed: (params) => seedSetupFiles(executor, params),
      commit: (path, message, patterns) => commitWorktree(executor, path, message, patterns),
      discard: (path) => discardWorktreeChanges(executor, path),
      publish: (repoPath, upstreamPath, branch) =>
        publishWorktreeBranch(executor, repoPath, upstreamPath, branch),
      push: (upstreamPath, remoteUrl, branch, credential) =>
        pushWorktreeBranch(executor, upstreamPath, remoteUrl, branch, credential),
      cleanup: (repoPath, worktree, ownRepository) =>
        cleanupWorktree(executor, repoPath, worktree, { ownRepository }),
      hasChanges: (path, patterns) => hasChanges(executor, path, patterns),
      diff: (path, patterns) => diffWorktree(executor, path, patterns),
    }),
    hub,
    registry: harnessRegistry,
  };
}
