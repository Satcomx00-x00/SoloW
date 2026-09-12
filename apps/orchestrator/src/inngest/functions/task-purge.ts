import { resolve } from "node:path";
import { TASK_PURGE_REQUESTED, taskPurgeRequestedData } from "@solow/contracts";
import { orchestratorEnv } from "../../env.js";
import { createLocalExecutor } from "../../executor/local.js";
import { removeTaskFiles } from "../../retention.js";
import { inngest } from "../client.js";

/**
 * `task.purge.requested` (Decision 0025): the web app deleted a Task's rows outright — an
 * Issue went with its Tasks — and asks for the files those rows pointed at to go too.
 *
 * The retention sweep removes a Task's directories *before* it cascades the rows, because
 * once the rows are gone nothing remembers the paths. The web app cannot do that: it never
 * touches the filesystem, and the delete is one transaction. So it reads the paths first,
 * deletes, and sends them here — the same removal the sweep runs, on the same host.
 */
export const taskPurge = inngest.createFunction(
  { id: "task-purge", retries: 2, triggers: [{ event: TASK_PURGE_REQUESTED }] },
  async ({ event, step }) => {
    const data = taskPurgeRequestedData.parse(event.data);
    const removed = await step.run("remove-task-files", async () => {
      const gone = await removeTaskFiles(
        createLocalExecutor(process.cwd()),
        resolve(orchestratorEnv().SOLOW_WORKTREE_ROOT),
        data.taskId,
        data.worktrees,
        (message, cause) => console.error(`[solow/orchestrator] ${message}`, cause ?? ""),
      );
      return [...gone];
    });
    return { taskId: data.taskId, removed };
  },
);
