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
export const SCRATCH = join(ROOT, ".gatecontrol", "e2e");

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
 * Spelled out rather than imported from `@gatecontrol/db` — the Playwright runner is Node, and
 * that package pulls in `bun:sqlite`. Kept in step with `packages/db/src/seed.ts`.
 */
export const SEED_WORKSPACE_A = "11111111-1111-4111-8111-111111111111";
export const SEED_WORKSPACE_B = "22222222-2222-4222-8222-222222222222";

/** Deterministic test-only values — never used by a real deployment. */
export const E2E_ENV = {
  GATECONTROL_SQLITE_PATH: PATHS.db,
  GATECONTROL_DB_DRIVER: "sqlite",
  GATECONTROL_SECRET_KEY: Buffer.alloc(32, 7).toString("base64"),
  GATECONTROL_AUTH_SECRET: "e2e-auth-secret-padded-to-thirty-two-chars",
  GATECONTROL_STREAM_SECRET: "e2e-stream-secret",
  GATECONTROL_DEV_OWNER: "on",
  GATECONTROL_WEB_URL: `http://127.0.0.1:${PORTS.web}`,
  GATECONTROL_WS_URL: `ws://127.0.0.1:${PORTS.ws}`,
  GATECONTROL_WS_PORT: String(PORTS.ws),
  GATECONTROL_ORCHESTRATOR_URL: `http://127.0.0.1:${PORTS.orchestrator}`,
  GATECONTROL_WORKTREE_ROOT: PATHS.worktrees,
  GATECONTROL_REPO_CACHE_ROOT: PATHS.repoCache,
} as const;

const git = (args: string[], cwd?: string) =>
  execFileSync("git", args, { cwd: cwd ?? ROOT, stdio: "pipe" });

/** A throwaway git repository with one commit, holding exactly one distinguishing file. */
function initRepo(dir: string, file: string, contents: string): void {
  git(["init", "--initial-branch=main", dir]);
  git(["config", "user.email", "e2e@gatecontrol.test"], dir);
  git(["config", "user.name", "GateControl E2E"], dir);
  writeFileSync(join(dir, file), contents);
  git(["add", "-A"], dir);
  git(["commit", "-m", "initial"], dir);
}

/**
 * Rebuild the scratch root from scratch: fresh git fixture, fresh database, seeded tenants.
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
  execFileSync("bun", ["run", "db:seed"], { cwd: ROOT, env, stdio: "pipe" });
}
