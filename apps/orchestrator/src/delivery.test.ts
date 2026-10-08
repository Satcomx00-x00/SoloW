/// <reference types="bun-types" />

import { beforeAll, describe, expect, it } from "bun:test";
import { taskCheckoutBranch } from "@solow/core";
import { encryptSecret } from "@solow/db";
import type { TaskRepositoryBinding } from "./data.js";
import { DeliveryError, deliverBranch } from "./delivery.js";
import { worktreeNameForTask } from "./harness/claude-code-runner.js";

/**
 * Delivery's one write to someone else's server is a forced push, so which branch it may name is
 * the whole of its safety. These pin that rule; the push itself is `manager.integration.test.ts`.
 */

const TASK_ID = "t-deliver";

beforeAll(() => {
  // Set here rather than inherited: delivery decrypts the Integration's token.
  process.env.SOLOW_SECRET_KEY ??= Buffer.alloc(32, 3).toString("base64");
});

function binding(checkoutBranch: string): TaskRepositoryBinding {
  return {
    attachment: {
      id: "tr-1",
      workspaceId: "ws-1",
      taskId: TASK_ID,
      repositoryId: "repo-1",
      baseRef: null,
      checkoutBranch,
      resultBranch: null,
      changeRequestUrl: null,
      changeRequestNumber: null,
      position: 0,
      createdAt: "2026-10-08T00:00:00.000Z",
      updatedAt: "2026-10-08T00:00:00.000Z",
    },
    repository: {
      id: "repo-1",
      workspaceId: "ws-1",
      name: "app",
      source: "remote_url",
      location: "https://github.com/acme/app.git",
      externalFullName: "acme/app",
    } as TaskRepositoryBinding["repository"],
    scmClone: { provider: "github", secretCiphertext: encryptSecret("ghp_token"), baseUrl: null },
  };
}

/** A push that records what it was asked to do and then fails, so no provider is ever called. */
function recordingPush() {
  const calls: string[] = [];
  return {
    calls,
    push: async (remoteUrl: string) => {
      calls.push(remoteUrl);
      throw new Error("fatal: stop here");
    },
  };
}

describe("deliverBranch — which branch it may push", () => {
  it("refuses a branch the Task does not own, before anything reaches the remote", async () => {
    // An attachment's checkout branch is the Owner's to name — `main`, or one another Task also
    // works on — and a forced push to it would rewrite history nobody asked SoloW to touch.
    for (const branch of ["main", "feature/shared", taskCheckoutBranch("another-task")]) {
      const { calls, push } = recordingPush();
      const attempt = deliverBranch({
        binding: binding(branch),
        branch,
        title: "t",
        body: "b",
        push,
      });

      await expect(attempt).rejects.toBeInstanceOf(DeliveryError);
      await expect(attempt).rejects.toMatchObject({ stage: "push" });
      await expect(attempt).rejects.toThrow(/only pushes the branch it created for this task/);
      expect(calls).toEqual([]);
    }
  });

  it("pushes the Task's own branch, whether SoloW or the harness made the worktree", async () => {
    for (const branch of [
      taskCheckoutBranch(TASK_ID),
      `worktree-${worktreeNameForTask(TASK_ID)}`,
    ]) {
      const { calls, push } = recordingPush();
      const attempt = deliverBranch({
        binding: binding(taskCheckoutBranch(TASK_ID)),
        branch,
        title: "t",
        body: "b",
        push,
      });

      await expect(attempt).rejects.toThrow(/stop here/);
      expect(calls).toEqual(["https://github.com/acme/app.git"]);
    }
  });
});
