/// <reference types="bun-types" />
// Test-only default: the secret store needs a 32-byte base64 key. Real deployments
// supply their own SOLOW_SECRET_KEY; here we set a deterministic dummy so the
// smoke test runs without external configuration. MUST be set before any module that
// reads it (secret-store / env) is imported or invoked below.
if (!process.env.SOLOW_SECRET_KEY) {
  process.env.SOLOW_SECRET_KEY = Buffer.alloc(32, 9).toString("base64"); // test-only
}

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BillingErrorCode } from "@solow/contracts";
import {
  agentCatalog,
  agentProfile,
  encryptSecret,
  executorProfile,
  issue,
  repository,
  secret,
  session,
  task,
  taskRepository,
  workspace,
} from "@solow/db";
import { createTestDb } from "@solow/db/testing";
import { $ } from "bun";
import { FakeAgentRunner } from "../apps/orchestrator/src/agent/runner.js";
import { prepareAgentEnv } from "../apps/orchestrator/src/billing/guard.js";
import {
  loadTaskRunContext,
  setTaskRepositoryResultBranch,
  setTaskState,
} from "../apps/orchestrator/src/data.js";
import { createLocalExecutor } from "../apps/orchestrator/src/executor/local.js";
import {
  cleanupWorktree,
  commitWorktree,
  hasChanges,
  provisionWorktree,
} from "../apps/orchestrator/src/worktree/manager.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`SMOKE FAILED: ${msg}`);
}

async function main(): Promise<void> {
  // Temp directories: a source git repo, plus worktree/cache roots for provisioning.
  const scratch = mkdtempSync(join(tmpdir(), "solow-smoke-"));
  const repoDir = join(scratch, "repo");
  const worktreeRoot = join(scratch, "worktrees");
  const repoCacheRoot = join(scratch, "cache");

  try {
    // 1. Real (local) git repository with an initial commit so HEAD exists.
    await $`git init ${repoDir}`.quiet();
    await $`git -C ${repoDir} config user.email t@e.com`.quiet();
    await $`git -C ${repoDir} config user.name Test`.quiet();
    writeFileSync(join(repoDir, "README.md"), "# smoke fixture\n");
    await $`git -C ${repoDir} add -A`.quiet();
    await $`git -C ${repoDir} commit -m ${"initial"}`.quiet();

    // 2. In-memory DB with all migrations applied.
    const db = createTestDb();

    // 3. Seed the tenant graph. Everything is scoped by workspaceId (Principle V).
    const [ws] = await db
      .insert(workspace)
      .values({ name: "Smoke WS", ownerUserId: "user-smoke" })
      .returning();
    assert(ws, "workspace insert returned a row");
    const workspaceId = ws.id;

    const [sec] = await db
      .insert(secret)
      .values({
        workspaceId,
        name: "anthropic-api-key",
        kind: "api_key",
        ciphertext: encryptSecret("sk-ant-api-key"),
      })
      .returning();
    assert(sec, "secret insert returned a row");

    const [cat] = await db
      .insert(agentCatalog)
      .values({
        workspaceId,
        key: "claude_code",
        displayName: "Claude Code",
        protocol: "claude_code_stream_json",
        command: "claude",
        subscriptionEnvVar: "CLAUDE_CODE_OAUTH_TOKEN",
        meteredEnvVar: "ANTHROPIC_API_KEY",
      })
      .returning();
    assert(cat, "agentCatalog insert returned a row");

    const [ap] = await db
      .insert(agentProfile)
      .values({
        workspaceId,
        name: "Claude (API key)",
        agentCatalogId: cat.id,
        authMode: "api_key",
        secretId: sec.id,
        concurrencyCap: 3,
      })
      .returning();
    assert(ap, "agentProfile insert returned a row");

    const [ep] = await db
      .insert(executorProfile)
      .values({ workspaceId, name: "Local", kind: "local" })
      .returning();
    assert(ep, "executorProfile insert returned a row");

    const [repo] = await db
      .insert(repository)
      .values({
        workspaceId,
        name: "fixture",
        source: "local_path",
        location: repoDir,
      })
      .returning();
    assert(repo, "repository insert returned a row");

    const [iss] = await db
      .insert(issue)
      .values({ workspaceId, title: "Smoke issue", status: "open" })
      .returning();
    assert(iss, "issue insert returned a row");

    const [tk] = await db
      .insert(task)
      .values({
        workspaceId,
        issueId: iss.id,
        title: "Smoke task",
        state: "ready",
        agentProfileId: ap.id,
        executorProfileId: ep.id,
      })
      .returning();
    assert(tk, "task insert returned a row");
    const taskId = tk.id;

    const [attachment] = await db
      .insert(taskRepository)
      .values({
        workspaceId,
        taskId,
        repositoryId: repo.id,
        checkoutBranch: `solow/task-${taskId}`,
        position: 0,
      })
      .returning();
    assert(attachment, "task_repository insert returned a row");

    const [ses] = await db
      .insert(session)
      .values({ workspaceId, taskId, state: "active" })
      .returning();
    assert(ses, "session insert returned a row");

    // 4. Load the composed run context the orchestrator would use to launch a run.
    const ctx = await loadTaskRunContext(db, workspaceId, taskId);
    assert(ctx.task.id === taskId, "run context resolved the task");
    assert(ctx.agentProfile.id === ap.id, "run context resolved the agent profile");
    assert(ctx.repositories.length === 1, "run context resolved one attached repository");
    assert(
      ctx.repositories[0]?.repository.location === repoDir,
      "run context resolved the repository",
    );
    assert(ctx.secretCiphertext, "run context carried the secret ciphertext");

    // 5. Billing/credential guard: api_key mode must inject ANTHROPIC_API_KEY and
    //    must NOT carry a subscription OAuth token (Principle IV billing integrity).
    const envResult = prepareAgentEnv({
      authMode: ctx.agentProfile.authMode,
      secretCiphertext: ctx.secretCiphertext,
      baseEnv: process.env,
      subscriptionEnvVar: ctx.agentCatalog.subscriptionEnvVar,
      meteredEnvVar: ctx.agentCatalog.meteredEnvVar,
    });
    assert(envResult.ok, "prepareAgentEnv returned ok");
    assert(
      envResult.data.ANTHROPIC_API_KEY === "sk-ant-api-key",
      "agent env carries the decrypted ANTHROPIC_API_KEY",
    );
    assert(
      !("CLAUDE_CODE_OAUTH_TOKEN" in envResult.data),
      "agent env must NOT carry CLAUDE_CODE_OAUTH_TOKEN in api_key mode",
    );
    const agentEnv = envResult.data;

    // A missing credential must be reported as a MissingCredential error, not thrown.
    const noCred = prepareAgentEnv({
      authMode: "api_key",
      secretCiphertext: null,
      baseEnv: process.env,
    });
    assert(!noCred.ok, "prepareAgentEnv fails without a credential");
    assert(
      !noCred.ok && noCred.error === BillingErrorCode.MissingCredential,
      "missing credential is reported as MissingCredential",
    );

    // 6. Provision an isolated worktree for the task (Principle II).
    // Every host interaction goes through the Executor (issue #1) — the smoke run exercises
    // the same path the orchestrator uses rather than a shortcut around it.
    const executor = createLocalExecutor(worktreeRoot);
    const wt = await provisionWorktree(executor, {
      taskId,
      repository: {
        source: ctx.repositories[0].repository.source,
        location: ctx.repositories[0].repository.location,
      },
      worktreeRoot,
      repoCacheRoot,
    });
    assert(existsSync(wt.path), "worktree directory was created");
    assert(wt.branch === `solow/task-${taskId}`, "worktree branch is deterministic");

    // Fresh worktree has no changes yet.
    assert(!(await hasChanges(executor, wt.path)), "worktree starts clean");

    // 7. Demonstrate the runner interface with the deterministic fake, then simulate the
    //    agent's real effect: an edit written into the worktree (where a real Claude Code
    //    run over ACP would mutate the working tree).
    const events: string[] = [];
    const runner = new FakeAgentRunner([
      { kind: "tool_use", name: "edit_file" },
      { kind: "stdout", channel: "assistant", text: "applied change" },
    ]);
    const handle = runner.start({
      command: "claude",
      args: ["--task", taskId],
      cwd: wt.path,
      env: agentEnv,
      prompt: `Smoke task ${taskId}`,
      onEvent: (e) => events.push(e.kind),
    });
    const outcome = await handle.outcome;
    assert(outcome.kind === "completed", "fake agent run completed");
    assert(events.includes("tool_use") && events.includes("stdout"), "runner streamed events");

    writeFileSync(join(wt.path, "SMOKE_CHANGE.txt"), `edited by smoke run for task ${taskId}\n`);

    // 8. The edit must show up as a diff, then get committed onto the task branch.
    assert(await hasChanges(executor, wt.path), "worktree has the agent's uncommitted changes");
    await commitWorktree(executor, wt.path, "SoloW smoke");
    assert(!(await hasChanges(executor, wt.path)), "changes committed; worktree clean again");

    // 9. Advance the task to done, recording the result branch on the attachment (issue #7).
    await setTaskState(db, workspaceId, taskId, "done");
    await setTaskRepositoryResultBranch(db, workspaceId, attachment.id, wt.branch);

    // 10. Re-read the persisted task row (via the orchestrator data layer) to confirm
    //     the transition stuck.
    const afterCtx = await loadTaskRunContext(db, workspaceId, taskId);
    const after = afterCtx.task;
    assert(after.state === "done", `task state is done (got ${after.state})`);
    assert(
      afterCtx.repositories[0]?.attachment.resultBranch === wt.branch,
      "attachment resultBranch recorded",
    );

    // 11. Tear down the worktree (as the orchestrator does after review).
    await cleanupWorktree(executor, wt.repoPath, wt.path);
    assert(!existsSync(wt.path), "worktree removed on cleanup");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  console.log("SMOKE OK");
}

await main();
