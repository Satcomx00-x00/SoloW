/// <reference types="bun-types" />

import { beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { taskCheckoutBranch } from "@solow/core";
import { encryptSecret } from "@solow/db";
import { $ } from "bun";
import type { TaskRepositoryBinding } from "./data.js";
import { DeliveryError, deliverBranch, partialIntegrationNotice } from "./delivery.js";
import { createLocalExecutor } from "./executor/local.js";
import { worktreeNameForTask } from "./harness/claude-code-runner.js";
import { pushWorktreeBranch } from "./worktree/manager.js";

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

describe("deliverBranch — a refused push says why", () => {
  it("shows git's own reason, not the command line that was run", async () => {
    // A 403 or "repository not found" is the one sentence the Owner needs. The argv in front of
    // it (credential helper and all) used to fill the space the message is cut to, leaving it out.
    const repo = await mkdtemp(join(tmpdir(), "solow-deliver-"));
    try {
      await $`git -C ${repo} init -q`.quiet();
      await $`git -C ${repo} -c user.email=t@e.com -c user.name=T commit -q --allow-empty -m init`.quiet();
      const branch = taskCheckoutBranch(TASK_ID);
      await $`git -C ${repo} branch ${branch}`.quiet();
      const target = binding(branch);
      target.repository = { ...target.repository, location: join(repo, "no-such-remote.git") };

      const attempt = deliverBranch({
        binding: target,
        branch,
        title: "t",
        body: "b",
        push: (remoteUrl, credential) =>
          pushWorktreeBranch(createLocalExecutor(repo), repo, remoteUrl, branch, credential),
      });

      await expect(attempt).rejects.toMatchObject({ stage: "push" });
      const message = await attempt.catch((cause: Error) => cause.message);
      expect(message).toContain("does not appear to be a git repository");
      expect(message).toContain("Could not read from remote repository");
      expect(message).not.toContain("credential.");
      expect(message).not.toContain("--no-verify");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

/**
 * The session-log line for an approval that integrated only part of a Task (issue #70 AC-4) — and
 * that, for the parts it did integrate, may already have pushed and opened requests (A1). A notice
 * that named only the commits told the reviewer "decide by hand" about branches that were in fact
 * already up for review on the provider, or that had silently failed to get there.
 */
describe("partialIntegrationNotice", () => {
  const base = {
    integrated: ["solow/task-1"],
    failed: [{ branch: "solow/task-1-docs", error: "commit refused" }],
  };

  it("names the requests already opened for the repositories that did integrate", () => {
    const text = partialIntegrationNotice({
      ...base,
      delivered: ["gate: pull request #7 opened (https://forge.example/acme/gate/pull/7)"],
      undelivered: [],
    });
    expect(text).toContain("Committed and recorded: solow/task-1.");
    expect(text).toContain("Not integrated: solow/task-1-docs (commit refused).");
    expect(text).toContain("pull request #7 opened");
  });

  it("names a committed branch that could not be shipped, and why", () => {
    const text = partialIntegrationNotice({
      ...base,
      delivered: [],
      undelivered: [{ branch: "solow/task-1", error: "Could not push solow/task-1 to acme/gate." }],
    });
    expect(text).toContain("Committed but not shipped: solow/task-1");
    expect(text).toContain("Could not push");
  });

  it("says nothing about shipping when nothing had a remote", () => {
    const text = partialIntegrationNotice({ ...base, delivered: [], undelivered: [] });
    expect(text).not.toContain("hipped");
  });
});
