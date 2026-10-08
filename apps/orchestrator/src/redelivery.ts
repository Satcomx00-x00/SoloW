import type { SessionEventPayload, TaskState } from "@solow/contracts";
import { DELIVERY_FAILED_REASON } from "@solow/core";
import type { Db } from "@solow/db";
import {
  appendSessionEvent,
  loadTaskDeliveryContext,
  nextSessionEventSeq,
  setTaskState,
} from "./data.js";
import {
  changeRequestBody,
  deliveryFailedNotice,
  type ShipResult,
  shipAttachment,
  shippedNotice,
} from "./delivery.js";
import { repositoryHostPath } from "./inngest/functions/task-run/prepare.js";
import type { CloneCredential } from "./worktree/manager.js";

/**
 * Ship again (A1): push an approved Task's committed branches and open or find their requests,
 * and nothing else.
 *
 * An approval that committed but could not ship used to say "approve again", which nothing could
 * do: the Task was `failed`, and only `review` takes a decision. Retry was the only control left,
 * and it starts a whole harness round over work a person already approved. This is the missing
 * piece — the remote half of the approval on its own, from the branch the approval already
 * recorded on each attachment.
 *
 * The Task stays `failed` (with `delivery_failed`) while it waits, rather than gaining a state of
 * its own: the reason already tells it apart on the board and the page, and a new lifecycle state
 * would be a schema, a column and an edge in every exhaustive table for one way out.
 */

export interface RedeliveryDeps {
  db: Db;
  repoCacheRoot: string;
  /** Push `branch` from the repository at `upstreamPath`; git runs where the orchestrator runs. */
  push(
    upstreamPath: string,
    remoteUrl: string,
    branch: string,
    credential: CloneCredential,
  ): Promise<void>;
  /** Tell open boards and pages the Task moved. */
  announce?(workspaceId: string, taskId: string, state: TaskState): void;
  report?(cause: unknown): void;
}

export type RedeliveryResult = "done" | typeof DELIVERY_FAILED_REASON | "not_applicable";

export async function redeliverTask(
  deps: RedeliveryDeps,
  input: { workspaceId: string; taskId: string },
): Promise<RedeliveryResult> {
  const { db } = deps;
  const { workspaceId, taskId } = input;
  const ctx = await loadTaskDeliveryContext(db, workspaceId, taskId);
  // Re-read, not trusted from the request: the Task may have shipped, been kept local or been
  // retried between the click and now, and pushing for any of those would be wrong.
  if (
    !ctx ||
    ctx.task.deletedAt !== null ||
    ctx.task.state !== "failed" ||
    ctx.task.failureReason !== DELIVERY_FAILED_REASON
  ) {
    return "not_applicable";
  }

  const delivered: string[] = [];
  const undelivered: Extract<ShipResult, { kind: "failed" }>[] = [];
  for (const binding of ctx.repositories) {
    const branch = binding.attachment.resultBranch;
    // An attachment the approval did not commit has nothing to ship.
    if (!branch) continue;
    const shipped = await shipAttachment(db, workspaceId, {
      binding,
      branch,
      title: ctx.issue.title,
      body: changeRequestBody(taskId, ctx.issue.description),
      push: (remoteUrl, credential) =>
        deps.push(
          repositoryHostPath(deps.repoCacheRoot, binding.repository),
          remoteUrl,
          branch,
          credential,
        ),
      ...(deps.report ? { report: deps.report } : {}),
    });
    if (shipped.kind === "shipped") delivered.push(shipped.line);
    if (shipped.kind === "failed") undelivered.push(shipped);
  }

  const log = async (payload: SessionEventPayload) => {
    if (!ctx.sessionId) return;
    await appendSessionEvent(db, workspaceId, {
      sessionId: ctx.sessionId,
      seq: await nextSessionEventSeq(db, workspaceId, ctx.sessionId),
      workflowStepId: ctx.task.workflowStepId,
      payload,
    });
  };

  if (undelivered.length > 0) {
    await log({ kind: "notice", text: deliveryFailedNotice({ undelivered, delivered }) });
    deps.announce?.(workspaceId, taskId, "failed");
    return DELIVERY_FAILED_REASON;
  }

  if (delivered.length > 0) await log({ kind: "notice", text: shippedNotice(delivered) });
  await setTaskState(db, workspaceId, taskId, "done", { failureReason: null });
  await log({ kind: "state", from: "failed", to: "done" });
  deps.announce?.(workspaceId, taskId, "done");
  return "done";
}
