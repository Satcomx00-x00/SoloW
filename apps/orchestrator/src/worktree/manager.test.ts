import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { taskCheckoutBranch } from "@solow/core";
import { $ } from "bun";
import { createLocalExecutor } from "../executor/local.js";
import type { ExecOpts, ExecResult, Executor } from "../executor/types.js";
import {
  cleanupWorktree,
  commitWorktree,
  prepareRepository,
  provisionWorktree,
  publishWorktreeBranch,
  taskRepositoryPath,
  worktreeBranch,
  worktreePath,
} from "./manager.js";

describe("worktree naming", () => {
  it("branch and path are deterministic and task-scoped", () => {
    expect(worktreeBranch("t1")).toBe("solow/task-t1");
    expect(worktreePath("/wt", "t1")).toBe("/wt/t1");
    expect(worktreeBranch("a")).not.toBe(worktreeBranch("b"));
  });

  it("delegates the branch name to core, so three call sites cannot disagree", () => {
    // The DAL derives this when an attachment names no branch and the 0010 migration wrote it;
    // a second copy of the template here would be a silent divergence waiting to happen.
    expect(worktreeBranch("t1")).toBe(taskCheckoutBranch("t1"));
  });

  it("gives a secondary attachment its own sibling directory (issue #7)", () => {
    // Keyed on the attachment, not the repository: a future second branch of the *same*
    // repository already has a directory of its own, and no Owner-authored text — a repository
    // called `../../etc` — ever reaches the path.
    expect(worktreePath("/wt", "t1", "att-2")).toBe("/wt/t1--att-2");
    expect(worktreePath("/wt", "t1", "att-2")).not.toBe(worktreePath("/wt", "t1", "att-3"));
    // And the primary keeps exactly the path a single-Repository Task has always had.
    expect(worktreePath("/wt", "t1", undefined)).toBe(worktreePath("/wt", "t1"));
  });

  it("names a Task's own repository by the same rule, under the cache root (issue #96)", () => {
    // One directory per *attachment*, so the repository and the worktree of one attachment are
    // named by one rule, and two Tasks on one Repository can never be handed one directory —
    // which is the whole of what the container mount set rests on.
    expect(taskRepositoryPath("/cache", "t1")).toBe("/cache/tasks/t1");
    expect(taskRepositoryPath("/cache", "t1", "att-2")).toBe("/cache/tasks/t1--att-2");
    expect(taskRepositoryPath("/cache", "t1")).not.toBe(taskRepositoryPath("/cache", "t2"));
    // And never the directory a *shared* clone lands in: those are named for the URL, which
    // always carries a `%` or a `:` after encoding.
    expect(taskRepositoryPath("/cache", "t1")).not.toBe(
      join("/cache", encodeURIComponent("https://git.test/a.git")),
    );
  });
});

const TOKEN = "glpat-do-not-leak-me";

interface Call {
  cmd: string[];
  opts: ExecOpts;
}

/**
 * An Executor that records commands instead of running them. Enough to assert the *shape* of the
 * clone — which is where the credential handling lives — without standing up an authenticating
 * git server.
 */
function recordingExecutor(calls: Call[], cacheExists = false, taskCloneExists = false): Executor {
  return {
    async exec(cmd: string[], opts: ExecOpts = {}): Promise<ExecResult> {
      calls.push({ cmd, opts });
      // `test -f <cache>/.git/HEAD` decides whether a clone is needed at all.
      const isCacheProbe = cmd[0] === "test";
      // `git -C <own> rev-parse --verify -q HEAD` is the same question about a Task's own
      // repository: it resolves only once the fetch *and* the checkout have finished. The
      // near-identical probe for `refs/heads/<branch>` is a different question and answers yes.
      const isCloneProbe = cmd.includes("rev-parse") && cmd.includes("--verify");
      const missing =
        (isCacheProbe && !cacheExists) ||
        (isCloneProbe && cmd.includes("HEAD") && !taskCloneExists);
      // What the shared repository has checked out, which is what a Task's own clone is put on.
      const stdout = cmd.includes("symbolic-ref") && cmd.includes("--short") ? "main\n" : "";
      return { stdout, stderr: "", exitCode: missing ? 1 : 0 };
    },
    spawn: () => {
      throw new Error("not used");
    },
    baseEnv: async () => ({}),
    fs: {
      exists: async () => false,
      readFile: async () => "",
      writeFile: async () => {},
      list: async () => [],
      copy: async () => {},
    },
    forward: async () => ({ url: "", close: async () => {} }),
    metrics: async () => ({
      cpuPercent: null,
      memPercent: null,
      diskPercent: null,
      loadAverage: [],
    }),
    dispose: async () => {},
  };
}

const remoteParams = {
  taskId: "t1",
  repository: { source: "remote_url" as const, location: "https://gitlab.com/acme/gate.git" },
  worktreeRoot: "/wt",
  repoCacheRoot: "/cache",
};

describe("cloning an imported repository", () => {
  it("passes the token through the environment, never through the command line", async () => {
    const calls: Call[] = [];
    await prepareRepository(recordingExecutor(calls), {
      ...remoteParams,
      cloneCredential: { username: "oauth2", token: TOKEN },
    });

    const clone = calls.find((c) => c.cmd.includes("clone"));
    expect(clone).toBeDefined();

    // The whole point: `ps` shows argv to every user on the box, so the token must not be there.
    // It also must not reach the URL, which git would write into .git/config permanently.
    expect(clone?.cmd.join(" ")).not.toContain(TOKEN);
    expect(clone?.cmd).toContain("https://gitlab.com/acme/gate.git");
    expect(clone?.opts.env?.SOLOW_SCM_TOKEN).toBe(TOKEN);
  });

  it("clears any host credential helper before installing its own", async () => {
    const calls: Call[] = [];
    await prepareRepository(recordingExecutor(calls), {
      ...remoteParams,
      cloneCredential: { username: "x-access-token", token: TOKEN },
    });

    const args = calls.find((c) => c.cmd.includes("clone"))?.cmd ?? [];
    const helpers = args.filter((a) => a.startsWith("credential.helper="));
    // The empty one first, so a credential cached on the host cannot win over this
    // Integration's token; then the helper that reads the environment variable.
    expect(helpers[0]).toBe("credential.helper=");
    expect(helpers[1]).toContain("username=x-access-token");
    expect(helpers[1]).toContain("$SOLOW_SCM_TOKEN");
  });

  it("disables git's terminal prompt so a bad token fails instead of hanging", async () => {
    const calls: Call[] = [];
    await prepareRepository(recordingExecutor(calls), {
      ...remoteParams,
      cloneCredential: { username: "oauth2", token: TOKEN },
    });

    // Without this git blocks on a username prompt no one is there to answer, and the Task
    // waits forever rather than reporting that the credential is wrong.
    expect(calls.find((c) => c.cmd.includes("clone"))?.opts.env?.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("clones a public repository with no credential arguments at all", async () => {
    const calls: Call[] = [];
    await prepareRepository(recordingExecutor(calls), remoteParams);

    const clone = calls.find((c) => c.cmd.includes("clone"));
    expect(clone?.cmd).toEqual([
      "git",
      "clone",
      "https://gitlab.com/acme/gate.git",
      "/cache/https%3A%2F%2Fgitlab.com%2Facme%2Fgate.git",
    ]);
    expect(clone?.opts.env).toBeUndefined();
  });

  it("does not clone again when the repository is already in the cache", async () => {
    const calls: Call[] = [];
    await prepareRepository(recordingExecutor(calls, true), {
      ...remoteParams,
      cloneCredential: { username: "oauth2", token: TOKEN },
    });

    expect(calls.some((c) => c.cmd.includes("clone"))).toBe(false);
  });

  it("never reaches for a credential for its own clone of an imported repository", async () => {
    // The Integration's token authenticates one fetch: the shared clone, from the provider. The
    // Task's own copy is made from that clone, over a path, so the token has no business being
    // anywhere near it — and on a containerised run this is the only place the token could have
    // ended up inside the container at all, since that clone now runs on the host.
    const calls: Call[] = [];
    await prepareRepository(recordingExecutor(calls, true), {
      ...remoteParams,
      ownClone: true,
      cloneCredential: { username: "oauth2", token: TOKEN },
    });

    expect(calls.some((c) => c.cmd.includes("fetch"))).toBe(true);
    expect(JSON.stringify(calls)).not.toContain(TOKEN);
  });

  it("never reaches for a credential for a local path", async () => {
    const calls: Call[] = [];
    await prepareRepository(recordingExecutor(calls), {
      taskId: "t1",
      repository: { source: "local_path", location: "/srv/repos/gate" },
      worktreeRoot: "/wt",
      repoCacheRoot: "/cache",
      cloneCredential: { username: "oauth2", token: TOKEN },
    });

    expect(calls.some((c) => c.cmd.includes("clone"))).toBe(false);
    expect(JSON.stringify(calls)).not.toContain(TOKEN);
  });
});

/**
 * A Task that runs somewhere the shared repository must not be reachable from gets a copy of it
 * (issue #96 round 2, Principle II).
 *
 * These pin the *shape* — which repository each command is aimed at, and what the refspecs say.
 * The section after them asks git the questions a fake cannot answer.
 */
describe("a Task's own clone (ownClone)", () => {
  const ownParams = {
    taskId: "t1",
    repository: { source: "local_path" as const, location: "/srv/gate" },
    worktreeRoot: "/wt",
    repoCacheRoot: "/cache",
    ownClone: true,
  };

  /** Every command aimed at a repository, as `[repoPath, ...rest]`. */
  function against(calls: Call[], repoPath: string): string[][] {
    return calls
      .filter((c) => c.cmd[0] === "git" && c.cmd[1] === "-C" && c.cmd[2] === repoPath)
      .map((c) => c.cmd.slice(3));
  }

  it("builds it in place with init and fetch, never with clone", async () => {
    const calls: Call[] = [];
    await prepareRepository(recordingExecutor(calls), ownParams);

    // `git clone` refuses a destination that is not empty, and this one is a directory the
    // container driver created as a bind source and a killed attempt may have half-filled —
    // so a clone would fail on every retry, and the repair (remove it and clone again) would
    // leave the running container's bind mount pointing at the deleted inode.
    expect(calls.some((c) => c.cmd.includes("clone"))).toBe(false);
    expect(calls.map((c) => c.cmd).find((cmd) => cmd.includes("init"))).toEqual([
      "git",
      "init",
      "-q",
      "/cache/tasks/t1",
    ]);
  });

  it("copies every upstream head to a local head, so a base ref still means what it meant", async () => {
    const calls: Call[] = [];
    await prepareRepository(recordingExecutor(calls), ownParams);

    // Not `+refs/heads/*:refs/remotes/origin/*`. With remote-tracking refs only,
    // `worktree add -B solow/task-t1 <path> feature-1` does not fail — it DWIMs `feature-1`
    // into a new local branch, drops the `-B`, and the Task commits onto the *Owner's* branch.
    const fetch = against(calls, "/cache/tasks/t1").find((cmd) => cmd[0] === "fetch");
    expect(fetch).toEqual([
      "fetch",
      "/srv/gate",
      "+refs/heads/*:refs/heads/*",
      "+refs/tags/*:refs/tags/*",
    ]);
    // git refuses to fetch into the branch HEAD names even when it does not exist yet, which is
    // every fresh `init` — so HEAD is parked outside `refs/heads/` until the checkout below.
    expect(against(calls, "/cache/tasks/t1")).toContainEqual([
      "symbolic-ref",
      "HEAD",
      "refs/solow/unborn",
    ]);
    expect(against(calls, "/cache/tasks/t1")).toContainEqual(["checkout", "-f", "main"]);
  });

  it("touches the shared repository only to read it", async () => {
    const calls: Call[] = [];
    await prepareRepository(recordingExecutor(calls), ownParams);
    await provisionWorktree(recordingExecutor(calls), ownParams);

    // The property behind the mount set: everything that writes is aimed at this Task's own
    // directory, and the shared repository is asked two questions and told nothing. A container
    // that could write here rewrote a peer Task's result branch (G4).
    expect(against(calls, "/srv/gate")).toEqual([
      ["rev-parse", "--git-dir"],
      ["symbolic-ref", "--short", "-q", "HEAD"],
      ["symbolic-ref", "--short", "-q", "HEAD"],
    ]);
    expect(against(calls, "/cache/tasks/t1").some((cmd) => cmd[0] === "worktree")).toBe(true);
  });

  it("adds the worktree to the Task's own repository, and reports it as the parent", async () => {
    const calls: Call[] = [];
    const wt = await provisionWorktree(recordingExecutor(calls), ownParams);

    // `repoPath` is what cleanup and publication are later given, so a Task that provisioned
    // against its own clone must not report the shared repository as its parent.
    expect(wt).toEqual({
      path: "/wt/t1",
      branch: taskCheckoutBranch("t1"),
      repoPath: "/cache/tasks/t1",
    });
  });

  it("reuses the copy it already made rather than fetching on every attempt", async () => {
    const calls: Call[] = [];
    await prepareRepository(recordingExecutor(calls, false, true), ownParams);

    expect(calls.some((c) => c.cmd.includes("fetch"))).toBe(false);
    expect(calls.some((c) => c.cmd.includes("init"))).toBe(false);
  });

  it("still fails an unusable location before making a copy of it", async () => {
    // AC-3: a location that is not a repository is a condition no retry can change, and it has
    // to be reported as one. Asked of the *shared* repository, before the fetch — a fetch that
    // failed would look like a flake and be retried until the Task's attempts ran out.
    const calls: Call[] = [];
    const executor: Executor = {
      ...recordingExecutor(calls),
      async exec(cmd: string[]): Promise<ExecResult> {
        calls.push({ cmd, opts: {} });
        const isRepoQuestion = cmd.includes("--git-dir");
        return { stdout: "", stderr: "", exitCode: isRepoQuestion ? 128 : 0 };
      },
    };

    expect(prepareRepository(executor, ownParams)).rejects.toThrow(/not a git repository/);
    expect(calls.some((c) => c.cmd.includes("fetch"))).toBe(false);
  });

  it("publishes one branch, named by SoloW, into the shared repository", async () => {
    const calls: Call[] = [];
    await publishWorktreeBranch(
      recordingExecutor(calls),
      "/cache/tasks/t1",
      "/srv/gate",
      "solow/task-t1",
    );

    // The only write to the shared repository in the whole lifecycle, and a `fetch` rather than
    // a `push` so no hook of the Task's repository can run in it. One refspec, one name.
    expect(calls.map((c) => c.cmd)).toEqual([
      [
        "git",
        "-C",
        "/srv/gate",
        "fetch",
        "--no-tags",
        "/cache/tasks/t1",
        "+refs/heads/solow/task-t1:refs/heads/solow/task-t1",
      ],
    ]);
  });

  it("publishes nothing when the Task worked in the shared repository itself", async () => {
    const calls: Call[] = [];
    await publishWorktreeBranch(recordingExecutor(calls), "/srv/gate", "/srv/gate/", "b");
    expect(calls).toEqual([]);
  });

  it("removes the copy with the worktree, and only when it is the Task's own", async () => {
    const shared: Call[] = [];
    await cleanupWorktree(recordingExecutor(shared), "/srv/gate", "/wt/t1");
    expect(shared.some((c) => c.cmd[0] === "rm")).toBe(false);

    const own: Call[] = [];
    await cleanupWorktree(recordingExecutor(own), "/cache/tasks/t1", "/wt/t1", {
      ownRepository: true,
    });
    // Left behind it would be a copy of the repository per Task, holding the Task's committed
    // work — including a discarded round's — long after the Task is over.
    expect(own.map((c) => c.cmd).at(-1)).toEqual(["rm", "-rf", "--", "/cache/tasks/t1"]);
  });
});

/**
 * The same feature, asked of git rather than of a fake (the reviewer's rule: a fake agrees with
 * whatever the driver says). These run the real commands against throwaway repositories on the
 * host; what a *container* can reach is proved separately, against a live daemon.
 */
describe("a Task's own clone, against real git", () => {
  const dirs: string[] = [];
  const scratch = (prefix: string): string => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  };
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  /** A repository with a commit on `main` and a second branch an Owner might base a Task on. */
  async function upstream(): Promise<string> {
    const dir = scratch("gc-own-up-");
    await $`git -C ${dir} init -q -b main`.quiet();
    await $`git -C ${dir} config user.email t@e.com`.quiet();
    await $`git -C ${dir} config user.name Test`.quiet();
    writeFileSync(join(dir, "README.md"), "shared\n");
    await $`git -C ${dir} add -A`.quiet();
    await $`git -C ${dir} commit -q -m init`.quiet();
    await $`git -C ${dir} branch feature-1`.quiet();
    return dir;
  }

  it("branches from a base ref onto the Task's own branch, not the Owner's", async () => {
    const location = await upstream();
    const worktreeRoot = scratch("gc-own-wt-");
    const repoCacheRoot = scratch("gc-own-cache-");
    const executor = createLocalExecutor(worktreeRoot);

    const wt = await provisionWorktree(executor, {
      taskId: "t-base",
      repository: { source: "local_path", location },
      baseRef: "feature-1",
      worktreeRoot,
      repoCacheRoot,
      ownClone: true,
    });

    // The trap this is here for: with a `git clone`, `feature-1` exists only as
    // `origin/feature-1`, and `worktree add -B solow/task-t-base <path> feature-1` quietly
    // creates and checks out `feature-1` instead — the Task then commits onto the Owner's
    // branch. Verified on git 2.47.
    expect(wt.branch).toBe(taskCheckoutBranch("t-base"));
    const branch = await $`git -C ${wt.path} rev-parse --abbrev-ref HEAD`.quiet();
    expect(branch.stdout.toString().trim()).toBe(taskCheckoutBranch("t-base"));
    expect(wt.repoPath).toBe(taskRepositoryPath(repoCacheRoot, "t-base"));
  });

  it("keeps the Task's commits out of the shared repository until they are published", async () => {
    const location = await upstream();
    const worktreeRoot = scratch("gc-own-wt-");
    const repoCacheRoot = scratch("gc-own-cache-");
    const executor = createLocalExecutor(worktreeRoot);
    const params = {
      taskId: "t-pub",
      repository: { source: "local_path" as const, location },
      worktreeRoot,
      repoCacheRoot,
      ownClone: true,
    };

    const wt = await provisionWorktree(executor, params);
    writeFileSync(join(wt.path, "work.txt"), "the agent's change\n");
    await $`git -C ${wt.path} config user.email a@e.com`.quiet();
    await $`git -C ${wt.path} config user.name Agent`.quiet();
    await commitWorktree(executor, wt.path, "SoloW: task t-pub");

    // Before the review decision the shared repository has heard nothing at all — not the
    // branch, not the objects. That is the isolation; the publication below is what makes it
    // survivable for a reviewer.
    const beforeBranch = await $`git -C ${location} rev-parse --verify -q ${wt.branch}`
      .quiet()
      .nothrow();
    expect(beforeBranch.exitCode).not.toBe(0);
    const tip = (await $`git -C ${wt.path} rev-parse HEAD`.quiet()).stdout.toString().trim();
    const beforeObject = await $`git -C ${location} cat-file -e ${tip}`.quiet().nothrow();
    expect(beforeObject.exitCode).not.toBe(0);

    await publishWorktreeBranch(executor, wt.repoPath, location, wt.branch);

    // And afterwards the Owner has exactly what F08 promises: the Task's branch, in their own
    // repository, with the work on it.
    const published = await $`git -C ${location} rev-parse ${wt.branch}`.quiet();
    expect(published.stdout.toString().trim()).toBe(tip);
    const content = await $`git -C ${location} show ${wt.branch}:work.txt`.quiet();
    expect(content.stdout.toString()).toContain("the agent's change");

    // Publishing again is what a second review round does, and it must not need the branch to
    // have moved forward in a way git approves of.
    await publishWorktreeBranch(executor, wt.repoPath, location, wt.branch);

    await cleanupWorktree(executor, wt.repoPath, wt.path, { ownRepository: true });
    const gone = await $`test -e ${wt.repoPath}`.quiet().nothrow();
    expect(gone.exitCode).not.toBe(0);
    // The branch outlives the copy it was made in, which is the point of publishing it.
    expect(
      (await $`git -C ${location} rev-parse ${wt.branch}`.quiet()).stdout.toString().trim(),
    ).toBe(tip);
  });

  it("gives two Tasks on one Repository no directory in common", async () => {
    const location = await upstream();
    const worktreeRoot = scratch("gc-own-wt-");
    const repoCacheRoot = scratch("gc-own-cache-");
    const executor = createLocalExecutor(worktreeRoot);
    const paramsFor = (taskId: string) => ({
      taskId,
      repository: { source: "local_path" as const, location },
      worktreeRoot,
      repoCacheRoot,
      ownClone: true,
    });

    const a = await provisionWorktree(executor, paramsFor("t-a"));
    const b = await provisionWorktree(executor, paramsFor("t-b"));
    writeFileSync(join(b.path, "secret.txt"), "task B\n");
    await $`git -C ${b.path} config user.email b@e.com`.quiet();
    await $`git -C ${b.path} config user.name B`.quiet();
    await commitWorktree(executor, b.path, "task B work");

    // Not "A cannot see B" — the mount set is what decides that, and this is the arithmetic
    // underneath it: no directory either Task is given is the other's, or contains it.
    const mine = [a.path, a.repoPath];
    const theirs = [b.path, b.repoPath];
    for (const one of mine) {
      for (const other of theirs) {
        expect(one === other || other.startsWith(`${one}/`)).toBe(false);
        expect(other === one || one.startsWith(`${other}/`)).toBe(false);
      }
    }
    // And B's work is in B's repository and nowhere else: A's holds neither the branch nor the
    // objects, so a container with A's mounts has nothing to read even with git in its hands.
    const tip = (await $`git -C ${b.path} rev-parse HEAD`.quiet()).stdout.toString().trim();
    const inMine = await $`git -C ${a.repoPath} cat-file -e ${tip}`.quiet().nothrow();
    expect(inMine.exitCode).not.toBe(0);
    const inShared = await $`git -C ${location} cat-file -e ${tip}`.quiet().nothrow();
    expect(inShared.exitCode).not.toBe(0);
  });
});
