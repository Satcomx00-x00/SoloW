/// <reference types="bun-types" />
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * E2E fixture layout and preparation (tasks TASK-025 / TASK-026).
 *
 * Everything the run touches lives under one scratch root so a run is reproducible and leaves
 * nothing behind: the SQLite database, the git repository the agent works on, the worktree root
 * and the repo cache. The Playwright config prepares this *before* the servers start, so both
 * the web app and the orchestrator harness see the same, already-migrated database.
 */

// Resolved from git rather than a module-relative path: this file is loaded both by Bun (ESM,
// `import.meta`) and by the Playwright runner (transpiled to CJS, `__dirname`), and neither
// idiom works in both.
export const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();
export const SCRATCH = join(ROOT, ".solow", "e2e");

export const PATHS = {
  db: join(SCRATCH, "e2e.db"),
  repo: join(SCRATCH, "fixture-repo"),
  /** A second repository, so the isolation suite can drive a multi-repository Task (issue #7). */
  repo2: join(SCRATCH, "fixture-shared-lib"),
  worktrees: join(SCRATCH, "worktrees"),
  repoCache: join(SCRATCH, "repos"),
} as const;

export const PORTS = { web: 5050, orchestrator: 5051, ws: 5052 } as const;

/**
 * Spelled out rather than imported from `@solow/db` — the Playwright runner is Node, and that
 * package pulls in `bun:sqlite`. Kept in step with `e2e/support/seed-cli.ts`, which creates them.
 * `A` is the id a real local install bootstraps to, so the suite starts where an install does.
 */
export const SEED_WORKSPACE_A = "11111111-1111-4111-8111-111111111111";
export const SEED_WORKSPACE_B = "22222222-2222-4222-8222-222222222222";

/** Deterministic test-only values — never used by a real deployment. */
export const E2E_ENV = {
  SOLOW_SQLITE_PATH: PATHS.db,
  SOLOW_DB_DRIVER: "sqlite",
  SOLOW_SECRET_KEY: Buffer.alloc(32, 7).toString("base64"),
  SOLOW_AUTH_SECRET: "e2e-auth-secret-padded-to-thirty-two-chars",
  SOLOW_STREAM_SECRET: "e2e-stream-secret",
  SOLOW_DEV_OWNER: "on",
  SOLOW_WEB_URL: `http://127.0.0.1:${PORTS.web}`,
  SOLOW_WS_URL: `ws://127.0.0.1:${PORTS.ws}`,
  SOLOW_WS_PORT: String(PORTS.ws),
  SOLOW_ORCHESTRATOR_URL: `http://127.0.0.1:${PORTS.orchestrator}`,
  SOLOW_WORKTREE_ROOT: PATHS.worktrees,
  SOLOW_REPO_CACHE_ROOT: PATHS.repoCache,
} as const;

const git = (args: string[], cwd?: string) =>
  execFileSync("git", args, { cwd: cwd ?? ROOT, stdio: "pipe" });

/** A throwaway git repository with one commit, holding exactly one distinguishing file. */
function initRepo(dir: string, file: string, contents: string): void {
  git(["init", "--initial-branch=main", dir]);
  git(["config", "user.email", "e2e@solow.test"], dir);
  git(["config", "user.name", "SoloW E2E"], dir);
  writeFileSync(join(dir, file), contents);
  git(["add", "-A"], dir);
  git(["commit", "-m", "initial"], dir);
}

/**
 * Rebuild the scratch root from scratch: fresh git fixture, fresh database, both tenants.
 * Starting clean matters — a stale Task left Running by an earlier run would make the happy
 * path assert against the wrong row.
 */
export function prepareFixture(): void {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(PATHS.repo, { recursive: true });
  mkdirSync(PATHS.repo2, { recursive: true });
  mkdirSync(PATHS.worktrees, { recursive: true });
  mkdirSync(PATHS.repoCache, { recursive: true });

  // Two repositories, each with a file only it has: that is what makes "no worktree can see
  // another's files" checkable for a Task that spans both (issue #7 AC-5).
  initRepo(PATHS.repo, "README.md", "# gate firmware fixture\n");
  initRepo(PATHS.repo2, "LIB.md", "# shared library fixture\n");

  const env = { ...process.env, ...E2E_ENV };
  execFileSync("bun", ["run", "db:migrate"], { cwd: ROOT, env, stdio: "pipe" });
  // The suite's own tenants, not the product's: SoloW ships with one empty Workspace now,
  // and the second one exists purely so the isolation suite has a boundary to test across.
  execFileSync("bun", ["run", "e2e/support/seed-cli.ts", "tenants"], {
    cwd: ROOT,
    env,
    stdio: "pipe",
  });
}
