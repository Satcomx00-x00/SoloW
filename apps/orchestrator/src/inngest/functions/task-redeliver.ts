import { TASK_REDELIVER_REQUESTED, taskRedeliverRequestedData } from "@solow/contracts";
import { createDb } from "@solow/db";
import { captureException, createLogger } from "@solow/observability";
import { orchestratorEnv } from "../../env.js";
import { createLocalExecutor } from "../../executor/local.js";
import { redeliverTask } from "../../redelivery.js";
import { pushWorktreeBranch } from "../../worktree/manager.js";
import { hub } from "../../ws/hub.js";
import { inngest } from "../client.js";

/**
 * `task.redeliver.requested` (A1): Ship again for an approval that committed and did not ship.
 *
 * One step, because the work is one idempotent act: the push is a force of the same ref and the
 * request upsert finds the one it opened, so a retried step repeats nothing anyone can see.
 * Limited to one at a time per Task, so a double click cannot interleave two sets of notices.
 *
 * The push runs on the host, the same as an approval's push for a containerised Task: the branch
 * lives in the Repository the deployment holds, and no harness is involved.
 */
export const taskRedeliver = inngest.createFunction(
  {
    id: "task-redeliver",
    retries: 2,
    triggers: [{ event: TASK_REDELIVER_REQUESTED }],
    concurrency: [{ key: "event.data.taskId", limit: 1 }],
  },
  async ({ event, step }) => {
    const data = taskRedeliverRequestedData.parse(event.data);
    const result = await step.run("redeliver", () => {
      const log = createLogger({ service: "orchestrator" });
      const host = createLocalExecutor(process.cwd());
      return redeliverTask(
        {
          db: createDb(),
          repoCacheRoot: orchestratorEnv().SOLOW_REPO_CACHE_ROOT,
          push: (upstreamPath, remoteUrl, branch, credential) =>
            pushWorktreeBranch(host, upstreamPath, remoteUrl, branch, credential),
          announce: (workspaceId, taskId, state) => {
            const message = {
              kind: "status" as const,
              taskId,
              state,
              at: new Date().toISOString(),
            };
            hub.publish(hub.boardChannel(workspaceId), message);
            hub.publish(hub.taskChannel(workspaceId, taskId), message);
          },
          report: (cause) => captureException(log, cause, { stage: "redelivery" }),
        },
        data,
      );
    });
    return { taskId: data.taskId, result };
  },
);
